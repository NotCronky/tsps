"use strict";

/**
 * Scouts: find the ways in and out the transport table doesn't have, by trying them on this
 * server (docs/playerbots.md, "Travel everywhere"). A scout is a maxed bot with every quest done
 * and a kit of the usual requirement items. It stands beside an object with a travel-like option
 * (Climb, Enter, Squeeze-through ...), clicks it through the same listener a client's click runs,
 * answers any dialogue, and records where it ends up. A landing on another floor, far away, or on
 * ground the last reach flood hadn't reached becomes a discovered transport
 * (Transports.SppBots.js).
 *
 * Work goes in rounds: candidates next to reached ground, then a new reach flood with what was
 * found, then the candidates that opened up, until a round finds nothing new.
 */

const { readDiscovered, writeDiscovered } = require("./Transports.SppBots");
const { lastReach, runReach } = require("./Reach.SppBots");
const { createBotPlayer, resetMovementState } = require("./Imports.SppBots");
const { answerDialogue } = require("./Dialogue.SppBots");

const TRAVEL_OPTION = /^(climb|climb-up|climb-down|climb-over|climb-through|climb-into|climb-on|enter|exit|leave|go-through|go-down|go-up|go-in|go-out|squeeze-through|squeeze-past|squeeze-under|squeeze|crawl-through|crawl-under|crawl-down|crawl|jump|jump-over|jump-down|jump-up|jump-across|jump-from|jump-in|jump-on|cross|pass|pass-through|walk-across|walk-through|walk-down|walk-up|walk-into|walk-along|descend|ascend|board|travel|swing|swing-on|swing-across|balance|balance-across|vault|step-over|step-across|tightrope|dive|swim|swim-across|ride|slide|slide-down|shortcut|pick-lock|picklock|unlock|navigate|teleport|use|walk|run-across|hop-across|grab|vine|ladder|investigate|search|open)$/i;
/** Search, Investigate and Use only lead somewhere on these: a hidden passage, not a bookcase. */
const VAGUE_OPTION = /^(search|investigate|use)$/i;
const PASSAGE_NAME = /wall|passage|rock|tunnel|cave|crack|crevice|hole|boulder|entrance|trapdoor|grate|grill|drain|pipe|statue|stone|altar|portal|gap|vent|ladder|stair|rope|vine|tree|bush|hedge|log|bridge|plank|fence|door|gate|barrier|portcullis/i;
/** Openable doors the planner already walks through (its doorAt). */
const PLAIN_DOOR = /door|gate|curtain/i;
const DOOR_OPTIONS = /^(open|close)$/i;

const KIT = [
  ["ROPE", 5], ["LIT_TORCH", 1], ["LIT_CANDLE", 1], ["TINDERBOX", 1], ["KNIFE", 1], ["SPADE", 1], ["MACHETE", 1],
  ["CHISEL", 1], ["HAMMER", 1], ["DRAGON_AXE", 1], ["DRAGON_PICKAXE", 1], ["CLIMBING_ROPE", 1], ["COINS", 10_000_000],
];
const SCOUT_PREFIX = "Sppscout";
const PLACE_RADIUS = 2;
const WATCH_TICKS = 20;
const QUIET_TICKS = 5;
// However much a scout is still moving (an agility course, a conveyor), a click is watched no longer.
const MAX_WATCH_TICKS = 60;
// A candidate whose scouts keep leaving the world (logged out, kicked) is given up after this many.
const MAX_LOST = 2;
const MAX_ANSWERS = 10;
const MAX_CHAIN = 2;
const SAVE_EVERY = 25;
const CANDIDATES_PER_SLICE_MS = 40;

const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const tileOf = (location) => ({ x: location.getX(), y: location.getY(), z: location.getZ() });
const triedKey = (candidate, option) => `${candidate.id}@${candidate.x},${candidate.y},${candidate.z}|${option.toLowerCase()}`;

class Scouting {
  constructor({ api, log }) {
    this.api = api;
    this.log = log;
    this.definitions = new Map();
    this.state = "idle";
    this.round = 0;
    this.queue = [];
    this.scouts = [];
    this.found = 0;
    this.tried = 0;
    this.nextScout = 0;
    this.discovered = null;
    this.sinceSave = 0;
    this.listener = null;
    this.onMessage = () => {};
  }

  /** Travel-like options of an object id (cached), or [] for one a scout leaves alone. */
  optionsOf(id) {
    if (this.definitions.has(id)) return this.definitions.get(id);
    const definition = this.api.core.ObjectDefinition.forId(id);
    const name = definition?.getName?.() ?? "";
    let options = (definition?.getInteractions?.() ?? []).filter((option) => option && TRAVEL_OPTION.test(option));
    // Plain doors are already walked through; a door with Pick-lock or Squeeze is not.
    if (PLAIN_DOOR.test(name)) options = options.filter((option) => !DOOR_OPTIONS.test(option));
    if (!PASSAGE_NAME.test(name)) options = options.filter((option) => !VAGUE_OPTION.test(option));
    const entry = { name, options };
    this.definitions.set(id, entry.options.length ? entry : null);
    return this.definitions.get(id);
  }

  start(count, onMessage) {
    if (this.state !== "idle") return false;
    this.onMessage = onMessage ?? (() => {});
    this.discovered = readDiscovered();
    this.scoutCount = Math.max(1, Math.min(20, count));
    this.listener = new this.api.core.ObjectActionPacketListener();
    this.beginRound();
    return true;
  }

  stop() {
    for (const scout of this.scouts) this.retire(scout);
    this.scouts = [];
    this.queue = [];
    if (this.discovered) writeDiscovered(this.discovered);
    this.state = "idle";
  }

  status() {
    return `scouting ${this.state}, round ${this.round}: ${this.queue.length} queued, ${this.scouts.filter((s) => s.job).length}/${this.scouts.length} scouts busy, ${this.tried} tried, ${this.found} found this run`;
  }

  /** A reach flood (with everything found so far), then the candidates next to its ground. */
  beginRound() {
    this.round += 1;
    this.state = "flooding";
    const { World } = this.api.core;
    runReach(this.api.core, { x: 3222, y: 3218, z: 0 }, (report) => {
      this.onMessage(`round ${this.round}: ${report.tiles.forward} tiles reachable, ${report.npcs.cut} NPCs cut off.`);
      this.state = "collecting";
      this.collect(() => {
        if (this.queue.length === 0) {
          this.onMessage(`round ${this.round}: nothing left to try. Scouting done (${this.found} found).`);
          this.stop();
          return;
        }
        this.onMessage(`round ${this.round}: ${this.queue.length} objects to try.`);
        this.roundFound = 0;
        this.state = "scouting";
      });
    }, (error) => {
      this.onMessage(`reach failed: ${error?.message ?? error}`);
      this.stop();
    });
    void World;
  }

  /** Every untried object with a travel option standing next to reached ground. */
  collect(done) {
    const { RegionManager, readTemplateRegion } = this.api.core;
    const reach = lastReach();
    const regionIds = [...RegionManager.regions.keys()];
    const covered = this.coveredByTable();
    let cursor = 0;
    const slice = () => {
      const until = performance.now() + CANDIDATES_PER_SLICE_MS;
      while (cursor < regionIds.length && performance.now() < until) {
        const regionId = regionIds[cursor++];
        const template = readTemplateRegion(regionId);
        if (!template) continue;
        const baseX = (regionId >> 8) * 64;
        const baseY = (regionId & 255) * 64;
        for (const chunk of template.chunks) {
          for (const loc of chunk) {
            const entry = this.optionsOf(loc.id);
            if (!entry) continue;
            const bridge = template.settings[(1 << 12) | (loc.localX << 6) | loc.localY] & 2;
            const z = loc.plane - (bridge ? 1 : 0);
            if (z < 0 || z > 3) continue;
            const candidate = { id: loc.id, name: entry.name, x: baseX + loc.localX, y: baseY + loc.localY, z };
            if (covered(candidate)) continue;
            if (!this.besideReached(reach, candidate)) continue;
            const options = entry.options.filter((option) => !(triedKey(candidate, option) in this.discovered.tried));
            for (const option of options) this.queue.push({ ...candidate, option });
          }
        }
      }
      if (cursor < regionIds.length) setImmediate(slice);
      else done();
    };
    setImmediate(slice);
  }

  /** An object the table (or an earlier scout) already has a row for, clicked from within 3 tiles. */
  coveredByTable() {
    const { transportData } = require("./Transports.SppBots");
    const data = transportData();
    const byId = new Map();
    for (const rows of Object.values(data.transports)) {
      for (const row of rows) {
        if (!byId.has(row[3])) byId.set(row[3], []);
        byId.get(row[3]).push(row[0]);
      }
    }
    return (candidate) => (byId.get(candidate.id) ?? []).some(([x, y, z]) =>
      z === candidate.z && Math.abs(x - candidate.x) <= 3 && Math.abs(y - candidate.y) <= 3);
  }

  besideReached(reach, candidate) {
    for (let dx = -PLACE_RADIUS; dx <= PLACE_RADIUS + 1; dx++) {
      for (let dy = -PLACE_RADIUS; dy <= PLACE_RADIUS + 1; dy++) {
        if (reach.forward.has(this.index(candidate.x + dx, candidate.y + dy, candidate.z))) return true;
      }
    }
    return false;
  }

  index(x, y, z) {
    return (z * 8192 + x) * 16384 + y;
  }

  /** A reached, walkable tile beside the object, nearest first. */
  standTile(candidate) {
    const reach = lastReach();
    const { getFlag } = reach.view;
    let best = null;
    for (let dx = -PLACE_RADIUS; dx <= PLACE_RADIUS + 1; dx++) {
      for (let dy = -PLACE_RADIUS; dy <= PLACE_RADIUS + 1; dy++) {
        const tile = { x: candidate.x + dx, y: candidate.y + dy, z: candidate.z };
        if (!reach.forward.has(this.index(tile.x, tile.y, tile.z))) continue;
        if (getFlag(tile.x, tile.y, tile.z) & 0x200100) continue;
        const distance = chebyshev(tile, candidate);
        if (!best || distance < best.distance) best = { ...tile, distance };
      }
    }
    return best;
  }

  /** A maxed scout with every quest done, never saved. */
  spawnScout(slot) {
    const { Location, Skill, ItemIds, PlayerRights } = this.api.core;
    // Names cycle through 1-99 so a scout still logging out is never reused at once.
    const name = `${SCOUT_PREFIX}${(slot % 99) + 1}`;
    const player = createBotPlayer(name, new Location(3222, 3218, 0), { api: this.api, loadPersistence: false, saveRandomizedAppearance: false });
    if (!player) return null;
    player.setPlayerBot(true);
    player.setAttribute("bot-skip-persistence", true);
    player.setRights(PlayerRights.NONE);
    return { player, slot, ready: false, job: null, away: 0 };
  }

  /** First tick in the world: 99s, quests, kit. */
  prepare(scout) {
    const { Skill, ItemIds } = this.api.core;
    const { QuestRuntime } = require("./Imports.SppBots");
    const skills = scout.player.getSkillManager();
    for (const skill of Skill.values()) {
      skills.setCurrentLevel(skill, 99, false).setMaxLevels(skill, 99, false).setExperiences(skill, 13_034_431, false);
    }
    for (const quest of QuestRuntime.getRegisteredQuests()) {
      try {
        quest.complete(scout.player, { scroll: false, announce: false });
      } catch {
        // A quest whose reward code needs more than a scout has; the scout does without it.
      }
    }
    this.api.core.Bank.depositItems(scout.player, scout.player.getInventory(), true);
    for (const [key, amount] of KIT) {
      if (Number.isInteger(ItemIds[key])) scout.player.getInventory().adds(ItemIds[key], amount);
    }
    for (const skill of Skill.values()) skills.setCurrentLevel(skill, 99, false).setMaxLevels(skill, 99, false);
    scout.ready = true;
  }

  /** Logs a scout out and frees its place; a new one (with a new name) takes it next tick. */
  replace(scout) {
    this.retire(scout);
    this.scouts = this.scouts.filter((other) => other !== scout);
  }

  retire(scout) {
    try {
      scout.player.getDialogueManager?.().reset?.();
      scout.player.requestLogout?.();
    } catch (error) {
      this.log("spp_bots_scout_retire_failed", { error: String(error?.message ?? error) });
    }
  }

  tick() {
    if (this.state !== "scouting") return;
    while (this.scouts.length < this.scoutCount) {
      const scout = this.spawnScout(this.nextScout++);
      if (!scout) break;
      this.scouts.push(scout);
    }
    for (const scout of [...this.scouts]) {
      if (!scout.player.isRegistered?.()) {
        // Gone from the world mid-job (logged out, kicked on death): its job goes back, it's replaced.
        if (++scout.away > 10) {
          if (scout.job) this.requeue(scout, "left the world");
          this.scouts = this.scouts.filter((other) => other !== scout);
        }
        continue;
      }
      scout.away = 0;
      try {
        if (!scout.ready) this.prepare(scout);
        else this.work(scout);
      } catch (error) {
        this.log("spp_bots_scout_failed", { scout: scout.player.getUsername(), error: String(error?.stack ?? error) });
        if (scout.job) this.finish(scout, "error");
      }
    }
    if (this.queue.length === 0 && this.scouts.every((scout) => !scout.job)) {
      writeDiscovered(this.discovered);
      this.onMessage(`round ${this.round}: ${this.roundFound} new ways found.`);
      if (this.roundFound === 0) {
        this.onMessage(`Scouting done: nothing new in round ${this.round}. ${this.found} found this run.`);
        this.stop();
        return;
      }
      this.beginRound();
    }
  }

  work(scout) {
    const player = scout.player;
    if (!scout.job) {
      const next = this.queue.shift();
      if (!next) return;
      const stand = this.standTile(next);
      if (!stand) {
        this.discovered.tried[triedKey(next, next.option)] = "no-stand-tile";
        return;
      }
      scout.job = { candidate: next, id: next.id, option: next.option, stand, phase: "place", ticks: 0, answers: [], chain: 0 };
    }
    const job = scout.job;
    job.ticks += 1;
    const { Location } = this.api.core;
    if (job.phase === "place") {
      player.getDialogueManager().reset();
      player.getPacketSender().sendInterfaceRemoval();
      resetMovementState(player);
      if (player.getPrivateArea?.()) {
        // Left in an instance by an earlier click: this job goes back for another scout, and
        // this one is replaced rather than pulled out.
        this.requeue(scout, "left in an instance");
        this.replace(scout);
        return;
      }
      player.moveTo(new Location(job.stand.x, job.stand.y, job.stand.z));
      job.phase = "click";
      return;
    }
    if (job.phase === "click") {
      job.from = tileOf(player.getLocation());
      this.listener.executeAction(player, job.id, job.candidate.x, job.candidate.y, 0, job.option);
      job.clickedAt = job.ticks;
      job.phase = "watch";
      job.lastMove = job.ticks;
      job.last = job.from;
      return;
    }
    // Watching what the click did.
    const here = tileOf(player.getLocation());
    if (player.getHitpoints?.() <= 0) {
      this.finish(scout, "died");
      return;
    }
    if (player.getPrivateArea?.()) {
      this.record(scout, here, "instance");
      this.finish(scout, "instance");
      this.replace(scout);
      return;
    }
    const dialogue = player.getDialogueManager();
    if (dialogue.isActive() && job.answers.length < MAX_ANSWERS) {
      job.answers.push(answerDialogue(dialogue));
      job.lastMove = job.ticks;
      return;
    }
    if (job.ticks - job.clickedAt >= MAX_WATCH_TICKS) {
      const away = here.z !== job.from.z || chebyshev(here, job.from) >= 2;
      if (away) this.record(scout, here, "moved");
      this.finish(scout, away ? "moved" : "timeout");
      return;
    }
    if (here.x !== job.last.x || here.y !== job.last.y || here.z !== job.last.z) {
      job.last = here;
      job.lastMove = job.ticks;
      return;
    }
    const moved = here.z !== job.from.z || chebyshev(here, job.from) >= 2;
    const settled = job.ticks - job.lastMove >= 2;
    if (moved && settled) {
      this.record(scout, here, "moved");
      this.finish(scout, "moved");
      return;
    }
    if (job.ticks - job.clickedAt >= QUIET_TICKS && !moved) {
      // An "Open" that changed the object (a trapdoor opening): try the new object's way through.
      const swapped = this.objectAt(job.candidate);
      if (swapped && swapped !== job.id && job.chain < MAX_CHAIN) {
        const entry = this.optionsOf(swapped);
        const option = entry?.options.find((value) => !/^open$/i.test(value));
        if (option) {
          job.chain += 1;
          job.id = swapped;
          job.option = option;
          job.phase = "click";
          return;
        }
      }
      if (here.x !== job.from.x || here.y !== job.from.y) {
        this.record(scout, here, "moved");
        this.finish(scout, "moved");
      } else {
        this.finish(scout, job.answers.length ? "dialogue-only" : "nothing");
      }
      return;
    }
    if (job.ticks >= WATCH_TICKS + QUIET_TICKS) this.finish(scout, "timeout");
  }

  objectAt(candidate) {
    const { MapObjects } = this.api.core;
    for (const object of MapObjects.mapObjects.get(MapObjects.getHash(candidate.x, candidate.y, candidate.z)) ?? []) {
      const at = object.getLocation();
      if (at.getX() === candidate.x && at.getY() === candidate.y) return object.getId();
    }
    return null;
  }

  /** A way somewhere new: another floor, a long way off, or ground the reach flood didn't have. */
  record(scout, landed, outcome) {
    const job = scout.job;
    const reach = lastReach();
    const newGround = !reach.forward.has(this.index(landed.x, landed.y, landed.z));
    const meaningful = outcome === "instance" || landed.z !== job.from.z || chebyshev(landed, job.from) > 10 || newGround;
    const name = this.optionsOf(job.id)?.name ?? job.candidate.name;
    const finding = {
      outcome, object: { id: job.id, name, x: job.candidate.x, y: job.candidate.y, z: job.candidate.z }, option: job.option,
      from: [job.from.x, job.from.y, job.from.z], to: [landed.x, landed.y, landed.z], ticks: job.ticks - job.clickedAt,
      answers: job.answers, newGround, meaningful,
    };
    this.discovered.findings.push(finding);
    if (!meaningful || outcome === "instance") return;
    const menu = `${job.option} ${name}`;
    this.discovered.rows.push([finding.from, finding.to, menu, job.id, null, null, null, null, null, Math.max(1, finding.ticks),
      `discovered by a maxed scout${job.answers.length ? `; answers: ${job.answers.join(", ")}` : ""}`]);
    this.found += 1;
    this.roundFound = (this.roundFound ?? 0) + 1;
    this.log("spp_bots_scout_found", { menu, from: finding.from, to: finding.to, newGround });
  }

  /** Puts a scout's job back for another scout, or gives it up once it has lost MAX_LOST of them. */
  requeue(scout, why) {
    const candidate = scout.job.candidate;
    candidate.lost = (candidate.lost ?? 0) + 1;
    if (candidate.lost >= MAX_LOST) {
      this.log("spp_bots_scout_lost", { why, object: `${candidate.name ?? candidate.id} ${candidate.option}`, at: [candidate.x, candidate.y, candidate.z] });
      this.finish(scout, "scout-lost");
      return;
    }
    this.queue.unshift(candidate);
    scout.job = null;
  }

  finish(scout, outcome) {
    const job = scout.job;
    if (job) this.discovered.tried[triedKey(job.candidate, job.candidate.option)] = outcome;
    scout.job = null;
    this.tried += 1;
    if (++this.sinceSave >= SAVE_EVERY) {
      this.sinceSave = 0;
      writeDiscovered(this.discovered);
    }
  }
}

module.exports = { Scouting, TRAVEL_OPTION };
