// Run after `yarn build`: node --test tests/gauntlet-bots.test.cjs
//
// A bot plays a whole Gauntlet run through the Gauntlet plugin's own code ("gauntlet:play"):
// into the maze from the lobby, rooms lit, monsters killed and their drops taken, resources
// gathered, gear sung at the bowl and worn, prayer up against the monsters, through the barrier
// before the timer with its raw fish (stashed by the range on its trips home) cooked and its
// tools dropped, the Hunllef fought, and back in the lobby when the run is over.
const assert = require("node:assert/strict");
const root = require("node:path").resolve(__dirname, "..");
const { before, after, test } = require("node:test");
require(root + "/dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require(root + "/dist/game/cache/CachePipeline");
const { PluginManager: PM } = require(root + "/dist/plugins/PluginManager");
const { Player } = require(root + "/dist/game/entity/impl/player/Player");
const { PlayerSession } = require(root + "/dist/net/PlayerSession");

let core, Run, Items;
before(async () => {
  await CachePipeline.initialize(root);
  PM.loadFromDirectory(root + "/plugins");
  core = PM.getCoreApi();
  core.RegionManager.init();
  PM.emitServerStartup({});
  Run = require(root + "/plugins/minigames/gauntlet/RunState.Gauntlet");
  Items = require(root + "/plugins/minigames/gauntlet/Items.Gauntlet");
});
after(() => PM.emitServerShutdown({}));

test("a bot plays a Gauntlet run from the lobby to the Hunllef and back", { timeout: 600000 }, (t) => {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setUsername("gauntletbot");
  player.setLocation(new core.Location(3032, 6125, 1));
  player.needsPlacement = false;
  assert.equal(core.World.getPlayers().add(player), true);
  t.after(() => core.World.getPlayers().removes(player));
  for (const skill of ["ATTACK", "STRENGTH", "DEFENCE", "RANGED", "MAGIC", "HITPOINTS", "PRAYER", "AGILITY", "COOKING"]) {
    player.getSkillManager().setMaxLevels(core.Skill[skill], 85, false).setCurrentLevel(core.Skill[skill], 85, false);
  }
  player.getInventory().adds(core.ItemIdentifiers.COINS, 100);
  const request = { player, controller: null };
  PM.emitCustomEvent("gauntlet:play", request);
  const bot = request.controller;
  assert.equal(typeof bot?.tick, "function", "the Gauntlet plugin plays it");

  const I = Items.itemsFor("regular");
  const seen = { started: false, lit: 0, kills: 0, prayed: false, gear: false, passed: false, fought: false, food: 0, tools: true, leftovers: true, prepOffensive: false, phases: [], weapons: null };
  const Monsters = require(root + "/plugins/minigames/gauntlet/Monsters.Gauntlet");
  const P = core.PrayerHandler;
  const OFFENSIVE = [P.SHARP_EYE, P.HAWK_EYE, P.EAGLE_EYE, P.RIGOUR, P.MYSTIC_WILL, P.MYSTIC_LORE, P.MYSTIC_MIGHT, P.AUGURY];
  for (let tick = 0; tick < 1800; tick++) {
    bot.tick();
    core.World.process();
    const run = Run.runOf(player);
    if (!run) {
      if (seen.started) break;
      continue;
    }
    seen.started = true;
    seen.lit = run.map.rooms.flat().filter((room) => room.lit).length;
    seen.kills = run.kills.weak + run.kills.strong + run.kills.demi;
    seen.prayed ||= player.getAttribute("combat:autopray") === true;
    seen.gear ||= [...I.staff, ...I.bow].some((id) => player.getEquipment().contains(id));
    // The Wiki's plan, in order: run 1 (the C), home for the staff and vials, run 2 (the rim).
    const phase = (bot.describe().match(/run 1|home after run 1|run 2/) ?? [])[0];
    if (phase && seen.phases[seen.phases.length - 1] !== phase) seen.phases.push(phase);
    if (run.stage === "prep") seen.prepOffensive ||= OFFENSIVE.some((prayer) => P.isActivated(player, prayer));
    if (run.stage === "boss") {
      if (!seen.fought) {
        seen.food = player.getInventory().getAmount(I.paddlefish);
        seen.tools = [I.axe, I.pickaxe, I.harpoon].some((id) => player.getInventory().getAmount(id) > 0);
        seen.weapons = ["staff", "bow", "halberd"].filter((name) => I[name].some((id) => player.getInventory().getAmount(id) > 0 || player.getEquipment().contains(id)));
        seen.leftovers = [I.ore, I.bark, I.linum, I.frame].some((id) => player.getInventory().getAmount(id) > 0);
      }
      seen.fought = true;
      seen.passed ||= run.bossCycle - run.startCycle < Shared().PREP_TICKS.regular;
    }
  }
  assert.ok(seen.started, "into the maze, empty-handed");
  assert.equal(player.getBank(0).getAmount(core.ItemIdentifiers.COINS), 100, "what it carried went into the bank first");
  assert.ok(seen.lit > 4, `rooms lit (${seen.lit})`);
  assert.ok(seen.kills > 0, "monsters killed");
  assert.ok(seen.prayed, "auto-prayer up in the run");
  assert.ok(seen.gear, "a staff or bow sung and wielded");
  assert.ok(seen.fought, "the Hunllef fought");
  assert.ok(seen.food > 0, `cooked fish taken in, the stash by the range picked up (${seen.food})`);
  assert.ok(seen.food <= 17, `no more fish than it takes in (${seen.food})`);
  assert.equal(seen.tools, false, "the tools dropped before the fight");
  assert.equal(seen.leftovers, false, "the leftover materials dropped before the fight");
  assert.deepEqual(seen.phases.filter((phase, i) => seen.phases.indexOf(phase) === i), ["run 1", "home after run 1", "run 2"], `the Wiki's plan in order (${seen.phases.join(", ")})`);
  assert.ok(!seen.weapons.includes("halberd") && seen.weapons.includes("staff"), `the staff, and the bow (${seen.weapons.join(", ")})`);
  assert.equal(seen.prepOffensive, false, "no offensive prayer in the maze, only at the Hunllef");
  assert.ok(seen.passed, "through the barrier before the timer took it there");
  assert.equal(Run.runOf(player), null, "the run is over");
  // After the run: the chest's reward (a death leaves points for a lesser one), the deposit box,
  // and straight into the next run from the lobby, never away from it.
  let again = false;
  for (let tick = 0; tick < 80 && !again; tick++) {
    bot.tick();
    core.World.process();
    const at = player.getLocation();
    const fading = /Gauntlet/.test(player.getArea?.()?.getName?.() ?? "");
    if (!Run.runOf(player) && !fading) assert.ok(at.getZ() === 1 && Math.abs(at.getX() - 3032) < 20 && Math.abs(at.getY() - 6127) < 20, `waits in the lobby (${at})`);
    again = Run.runOf(player) !== null;
  }
  assert.ok(again, "a second run started");
  assert.equal(Rewards().waitingReward(player), null, "the reward taken from the chest");
  // Stopping hands back the character (the run goes on, the player's now) with auto-prayer as it was.
  bot.stop();
  assert.equal(player.getAttribute("combat:autopray"), false, "auto-prayer put back as it was");
  assert.ok(Run.runOf(player), "stopping doesn't end the run");
  Run.runOf(player).end("exit", { fade: false });
});

function Rewards() {
  return require(root + "/plugins/minigames/gauntlet/Rewards.Gauntlet");
}

function Shared() {
  return require(root + "/plugins/minigames/gauntlet/Shared.Gauntlet");
}

test("a bot plays the Corrupted Gauntlet once a Gauntlet is completed", { timeout: 600000 }, (t) => {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setUsername("corruptedbot");
  player.setLocation(new core.Location(3032, 6125, 1));
  player.needsPlacement = false;
  assert.equal(core.World.getPlayers().add(player), true);
  t.after(() => core.World.getPlayers().removes(player));
  // IronCronky's levels (a real account that plays it), not maxed ones.
  const LEVELS = { ATTACK: 92, DEFENCE: 92, STRENGTH: 92, HITPOINTS: 92, RANGED: 90, PRAYER: 85, MAGIC: 96, COOKING: 95, AGILITY: 90 };
  for (const [skill, level] of Object.entries(LEVELS)) {
    player.getSkillManager().setMaxLevels(core.Skill[skill], level, false).setCurrentLevel(core.Skill[skill], level, false);
  }
  const request = { player, corrupted: true, controller: null };
  PM.emitCustomEvent("gauntlet:play", request);
  const bot = request.controller;

  // Not open before a Gauntlet is completed: nothing to play.
  const completed = { player, completed: null };
  PM.emitCustomEvent("gauntlet:completed", completed);
  assert.equal(completed.completed, false);
  assert.equal(bot.tick(), false, "the Corrupted Gauntlet isn't open yet");
  assert.equal(Run.runOf(player), null);

  const stats = Run.statsOf(player);
  stats.completions.regular = 1;
  player.setAttribute(Run.ATTR_STATS, stats);
  PM.emitCustomEvent("gauntlet:completed", completed);
  assert.equal(completed.completed, true);

  const I = Items.itemsFor("corrupted");
  const EGNIOL = [23885, 23884, 23883, 23882];
  const seen = { mode: null, fought: false, result: null, attacks: 0 };
  {
    // Every attack the character makes at the Hunllef, for the report (its rate is its damage).
    const combat = player.getCombat();
    const execute = combat.executeAttack;
    combat.executeAttack = function (...args) {
      const done = execute.apply(this, args);
      if (done && Run.runOf(player)?.stage === "boss") seen.attacks++;
      return done;
    };
  }
  let ended = null;
  const onEnd = (event) => { if (event.player === player) ended = event.reason; };
  PM.createApi("CorruptedBotTest").onCustomEvent("gauntlet:end", onEnd);
  for (let tick = 0; tick < 1800; tick++) {
    bot.tick();
    core.World.process();
    const run = Run.runOf(player);
    if (!run) {
      if (seen.mode) break;
      continue;
    }
    seen.mode = run.mode;
    if (run.stage === "boss" && run.hunllef?.npc) {
      const f = run.hunllef;
      seen.fight = { ticks: (seen.fight?.ticks ?? 0) + 1, hunllefHp: f.npc.getHitpoints(), hunllefMax: f.npc.getDefinition?.()?.getHitpoints?.(), offPrayer: f.taken.offPrayer, avoidable: f.taken.avoidable, wrongStyle: f.wrongStyleHits,
        foodLeft: player.getInventory().getAmount(I.paddlefish), dosesLeft: EGNIOL.reduce((sum, id, i) => sum + player.getInventory().getAmount(id) * (4 - i), 0), prayer: player.getSkillManager().getCurrentLevel(core.Skill.PRAYER) };
    }
    if (run.stage === "boss" && !seen.fought) {
      seen.fought = true;
      const tiers = ["helm", "body", "legs"].map((piece) => Math.max(...I[piece].map((id, i) => (player.getEquipment().contains(id) || player.getInventory().getAmount(id) > 0 ? i + 1 : 0))));
      const weapons = ["staff", "bow", "halberd"].map((name) => {
        const tier = Math.max(...I[name].map((id, i) => (player.getEquipment().contains(id) || player.getInventory().getAmount(id) > 0 ? i + 1 : 0)));
        return tier ? `${name} ${tier}` : null;
      }).filter(Boolean);
      seen.result = {
        armour: tiers.join("/"), weapons: weapons.join(", "), potions: run.made.egniol,
        doses: EGNIOL.reduce((sum, id, i) => sum + player.getInventory().getAmount(id) * (4 - i), 0),
        food: player.getInventory().getAmount(I.paddlefish), prepLeft: run.prepLeft,
        passed: run.bossCycle - run.startCycle < Shared().PREP_TICKS.corrupted,
      };
    }
  }
  if (process.env.GAUNTLET_REPORT) console.log("CORRUPTED", JSON.stringify(seen.result), "FIGHT", JSON.stringify({ ...seen.fight, attacks: seen.attacks, perAttack: +(seen.fight?.ticks / Math.max(1, seen.attacks)).toFixed(2) }), "ended:", ended ?? "?");
  assert.equal(seen.mode, "corrupted", "into the Corrupted Gauntlet");
  assert.ok(seen.fought, "the Corrupted Hunllef fought");
  assert.ok(seen.result.food <= 24, `no more fish than it takes in (${seen.result.food})`);
  assert.ok(seen.result.potions <= 3, `no more than three potions (${seen.result.potions})`);
  Run.runOf(player)?.end("exit", { fade: false });
});
