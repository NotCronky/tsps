"use strict";

/**
 * The Gauntlet as a bot's task (docs/playerbots.md, Boss tasks), remade on spp-bots: what a player
 * does, a click at a time, with what the run gives.
 *
 * Outside: Song of the Elves, everything banked (nothing goes in), to the Gauntlet Portal in
 * Prifddinas, down to the lobby, Bryn once, the reward chest if one waits, "The Gauntlet" Enter.
 * In the lobby already (between runs, the chest's reward in the pack), what it carries goes in
 * the lobby's deposit box, as a player does, not a bank trip back up to the city.
 *
 * Inside, the run is played tick by tick by GauntletPlay.SppBots.js (the strategy of tsps's
 * Gauntlet bot: the "C" round the start room for a frame and shards, the staff, out to the rim and
 * round it for fish, materials, a grym leaf and the demi-bosses' orb and bowstring, then home to
 * sing the bow, perfect both, make the armour and two Egniol potions, and the Hunllef by the 5:1
 * method, dodging its floor and tornadoes). Defence hands it every tick (`play`), so the bot's own
 * fight steps stand aside for the run.
 *
 * Afterwards the reward chest and done. A death or a run that ends any other way ends the task.
 *
 * `corrupted`: the Corrupted Gauntlet, the same task through the entrance's Enter-corrupted (open
 * once a Gauntlet has been completed) and the controller's corrupted plan (attuned armour, three
 * Egniol potions, 24 fish). Its levels are tsps's (CORRUPTED_LEVELS): the hits are harder.
 */

const PRIFDDINAS_PORTAL = { x: 3227, y: 6114, z: 0 };
const STEP_MS = 15000;
// The lobby's deposit box (tsps's DEPOSIT_BOX): its id and tile.
const DEPOSIT_BOX = { id: 36086, x: 3038, y: 6129, z: 1 };
// What each mode asks before it sets off: the regular one combat 70; the Corrupted one tsps's levels.
const REQUIRES = {
  regular: { quests: ["song_of_the_elves"], combat: 70 },
  corrupted: { quests: ["song_of_the_elves"], levels: { ranged: 80, magic: 80, defence: 75, hitpoints: 80, prayer: 70 } },
};

const lower = (value) => String(value ?? "").toLowerCase();
const chebyshev = (a, b) => Math.max(Math.abs(a.getX() - b.getX()), Math.abs(a.getY() - b.getY()));

function createGauntletTask({ api, entry, log = () => {}, onDone = () => {}, corrupted = false }) {
  const mode = corrupted ? "corrupted" : "regular";
  const core = api.core;
  const { GAUNTLET } = require("./Imports.SppBots");
  const { createBankVisit, createTravelAction, createMap } = require("./Travel.SppBots");
  const { unmetRequirement } = require("./CombatTask.SppBots");
  const map = createMap(core);
  const state = { phase: "prepare", since: Date.now() };
  let finished = false;
  const finish = (result, why) => {
    if (finished) return;
    finished = true;
    state.result = result;
    state.why = why;
    if (entry.combatTask === hooks) entry.combatTask = null;
    log("spp_bots_gauntlet", { name: entry.bot.name, mode, result, why, killed: Boolean(state.killed) });
    onDone(result, state);
  };
  // Defence: a fight outside the run (on the way) is the bot's own; inside, `play` plays the run
  // each tick (GauntletPlay.SppBots.js) and Defence and the brain wait.
  const hooks = {
    task: { monster: corrupted ? "Corrupted Hunllef" : "Crystalline Hunllef", xpStyle: null }, wants: () => true, fled: () => {}, sets: {},
    play: (player) => playTick(player),
  };
  entry.combatTask = hooks;

  /** A tick of the run while the task is at it; false when there's none to play. */
  /** Below half health: what's hurting it, its prayers and food (every 3 s at most), for ::sppbots trip and the log. */
  function lowLog(player, run) {
    const max = player.getSkillManager().getMaxLevel(core.Skill.HITPOINTS);
    if (player.getHitpoints() >= max / 2 || Date.now() - (state.lowAt ?? 0) < 3000) return;
    state.lowAt = Date.now();
    const combat = player.getCombat();
    const foe = run.stage === "boss" ? run.hunllef?.npc : combat.getAttacker?.() ?? combat.getTarget?.();
    const active = (player.getPrayerActive?.() ?? []).flatMap((on, id) => (on ? [id] : []));
    const items = require("../minigames/gauntlet/Items.Gauntlet").itemsFor(run.mode);
    log("spp_bots_gauntlet", {
      name: entry.bot.name, low: player.getHitpoints(), stage: run.stage, prepLeft: run.prepLeft,
      foe: foe?.getCurrentDefinition?.()?.getName?.() ?? null, foeStyle: foe ? require("./Supplies.SppBots").styleOf(core, foe) : null,
      hunllefStyle: run.hunllef?.style ?? null, prayers: active, prayerPoints: player.getSkillManager().getCurrentLevel(core.Skill.PRAYER),
      fish: player.getInventory().getAmount(items.paddlefish), raw: player.getInventory().getAmount(items.rawPaddlefish),
    });
  }

  function playTick(player) {
    if (finished || state.phase !== "play") return false;
    const run = GAUNTLET.run(player);
    if (!run) return false;
    // The run's own mode decides the plan (the entrance chose it).
    state.controller ??= require("./GauntletPlay.SppBots").createController(player, { corrupted: run.mode === "corrupted" });
    const npc = run.hunllef?.npc;
    if (npc) state.hunllef = npc;
    if (state.hunllef && !(state.hunllef.getHitpoints?.() > 0)) state.killed = true;
    state.controller.tick();
    lowLog(player, run);
    // Each new step of the plan (and the fight) logged once, for ::sppbots trip.
    const now = run.stage === "boss" ? "the Hunllef" : state.controller.step();
    if (now && now !== state.playStep) {
      state.playStep = now;
      log("spp_bots_gauntlet", { name: entry.bot.name, play: now, phase: state.controller.phase(), prepLeft: run.prepLeft, toppedUp: state.controller.geared() });
    }
    return true;
  }

  const step = (phase, data = {}) => {
    state.phase = phase;
    state.since = Date.now();
    state.clicked = false;
    log("spp_bots_gauntlet", { name: entry.bot.name, step: phase, ...data });
    return "running";
  };
  const answer = (player) => {
    if (require("./Dialogue.SppBots").answerPrompt(core, player)) return true;
    const dialogue = player.getDialogueManager?.();
    if (!dialogue?.getCurrent?.()) return false;
    require("./Dialogue.SppBots").answerDialogue(dialogue);
    return true;
  };
  const click = (player, object, option) => {
    const at = object.getLocation();
    new core.ObjectActionPacketListener().executeAction(player, object.getId(), at.getX(), at.getY(), 0, option);
  };
  const nameOf = (player, object) => String(core.ObjectDefinition.forPlayer(object.getId(), player)?.getName?.() ?? "");

  function update(ctx) {
    const player = ctx.player;
    const nowMs = Date.now();
    if (finished) return state.result;
    const run = GAUNTLET.run(player);
    switch (state.phase) {
      case "prepare": {
        const unmet = unmetRequirement(api, player, { requires: REQUIRES[mode] });
        if (unmet) return finish("failed", `needs ${unmet}`), "failed";
        if (corrupted && !GAUNTLET.completed(player)) return finish("failed", "needs a Gauntlet completed"), "failed";
        // Nothing on it already (back in the lobby after a run): no bank trip.
        if (!state.visit && GAUNTLET.emptyHanded(player)) return step(GAUNTLET.inLobby(player) ? "lobby" : "travel");
        // In the lobby with something on it: the deposit box there, not the bank.
        if (!state.visit && GAUNTLET.inLobby(player) && !state.noBox) return step("deposit");
        state.visit ??= createBankVisit({ api, depositAll: true, depositWorn: true, log });
        const result = state.visit.update(ctx);
        if (result === "running") return "running";
        state.visit.stop(ctx);
        state.visit = null;
        if (result === "failed") return finish("failed", "bank"), "failed";
        if (!GAUNTLET.emptyHanded(player)) return finish("failed", "couldn't empty the pack and worn slots"), "failed";
        return step("travel");
      }
      case "travel": {
        if (GAUNTLET.inLobby(player)) return step("lobby");
        // Straight for the portal: the spirit trees go to Prifddinas's (Song of the Elves), so a
        // search lands near it from a tree. (A first try went to the south gate outside the city,
        // a walk over the Arandar mountains past the planner's cap: "too far" from Lumbridge.)
        state.travel ??= createTravelAction({ api, goal: PRIFDDINAS_PORTAL, log });
        const result = state.travel.update(ctx);
        if (result === "running") return "running";
        state.travel.stop(ctx);
        state.travel = null;
        if (result === "failed") return finish("failed", "travel"), "failed";
        return step("portal");
      }
      case "portal": {
        if (GAUNTLET.inLobby(player)) return step("lobby");
        if (answer(player)) return "running";
        if (!state.clicked) {
          const portal = map.objectsAt ? findNear(player, /^gauntlet portal$/i) : null;
          if (!portal) return finish("failed", "no Gauntlet Portal"), "failed";
          click(player, portal, "enter");
          state.clicked = true;
        }
        if (nowMs - state.since > STEP_MS) return finish("failed", "portal"), "failed";
        return "running";
      }
      case "lobby": {
        if (run) return step("play", { mode: run.mode });
        if (answer(player)) return "running";
        // Bryn first, once (the entrance turns away anyone who hasn't spoken to him).
        if (!GAUNTLET.spokenToBryn(player)) {
          if (!state.clicked) {
            const bryn = npcNear(player, GAUNTLET.BRYN);
            if (!bryn) return finish("failed", "no Bryn"), "failed";
            const actions = (bryn.getCurrentDefinition?.(player)?.getActions?.() ?? []).map(lower);
            new core.NPCOptionPacketListener().executeOption(player, bryn.getIndex(), actions.indexOf("talk-to") + 1);
            state.clicked = true;
            state.since = nowMs;
          }
          if (nowMs - state.since > STEP_MS) return finish("failed", "Bryn"), "failed";
          return "running";
        }
        if (GAUNTLET.rewardWaiting(player)) {
          const chest = findNear(player, /^reward chest$/i);
          if (chest && nowMs - (state.chestAt ?? 0) > 3000) {
            // Its Open puts the loot in the pack (the pack is empty: there's room).
            click(player, chest, "open");
            state.chestAt = nowMs;
          }
          return "running";
        }
        // Carrying something (the chest's reward): into the deposit box first, nothing goes in.
        if (!GAUNTLET.emptyHanded(player)) {
          state.visit = null;
          return step(state.noBox ? "prepare" : "deposit", { why: "not empty-handed" });
        }
        if (nowMs - (state.enterAt ?? 0) > 5000) {
          const entrance = findNear(player, /^the gauntlet$/i);
          if (!entrance) return finish("failed", "no entrance"), "failed";
          click(player, entrance, corrupted ? "enter-corrupted" : "enter");
          state.enterAt = nowMs;
          state.enterTries = (state.enterTries ?? 0) + 1;
          if (state.enterTries > 4) return finish("failed", "couldn't start a run"), "failed";
        }
        return "running";
      }
      case "deposit": {
        // The box's "Deposit inventory" and "Deposit worn items", from beside it.
        if (GAUNTLET.emptyHanded(player)) return step("lobby");
        if (!state.clicked) {
          const box = core.MapObjects.get(DEPOSIT_BOX.id, new core.Location(DEPOSIT_BOX.x, DEPOSIT_BOX.y, DEPOSIT_BOX.z), null)
            ?? findNear(player, /deposit box/i);
          if (!box) {
            state.noBox = true;
            return step("prepare", { why: "no deposit box" });
          }
          player.getMovementQueue().walkToObject(box, {
            execute: () => {
              for (const container of [player.getInventory(), player.getEquipment()]) {
                if (container.getValidItems().length > 0) core.Bank.depositItems(player, container, true);
                container.refreshItems();
              }
            },
          });
          state.clicked = true;
        }
        // Not emptied (a full bank): the bank trip instead.
        if (nowMs - state.since > STEP_MS) {
          state.noBox = true;
          return step("prepare", { why: "the deposit box left something" });
        }
        return "running";
      }
      case "play": {
        // Played from Defence each tick (playTick); here once the run is over.
        if (run) return "running";
        state.controller?.stop();
        state.controller = null;
        return step("reward", { killed: Boolean(state.killed) });
      }
      case "reward": {
        // Back in the lobby. A kill leaves a reward in the chest: opened, then done. A death leaves
        // a smaller reward too: success only for a Hunllef seen dying.
        if (!GAUNTLET.rewardWaiting(player)) return finish(state.killed ? "success" : "failed", state.killed ? "Hunllef" : "died or left"), state.result;
        if (answer(player)) return "running";
        if (nowMs - (state.chestAt ?? 0) > 3000) {
          const chest = findNear(player, /^reward chest$/i);
          if (chest) click(player, chest, "open");
          state.chestAt = nowMs;
        }
        return "running";
      }
      default:
        return "running";
    }
  }

  function findNear(player, pattern) {
    const here = player.getLocation();
    for (let r = 0; r <= 14; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          for (const object of map.objectsAt(here.getX() + dx, here.getY() + dy, here.getZ())) if (pattern.test(nameOf(player, object))) return object;
        }
      }
    }
    return null;
  }

  function npcNear(player, id) {
    let found = null;
    core.World.getNpcs().forEach((npc) => {
      if (!found && npc?.getId?.() === id && chebyshev(npc.getLocation(), player.getLocation()) <= 15) found = npc;
    });
    return found;
  }

  const action = {
    id: "gauntlet",
    update,
    madeProgress: () => true,
    describe: () => ({
      mode, phase: state.phase, play: state.controller?.describe?.() ?? null,
      hunllef: state.hunllef?.getHitpoints?.() ?? null, prepLeft: GAUNTLET.run(entry.player)?.prepLeft ?? null,
    }),
    stop(ctx) {
      state.controller?.stop();
      state.controller = null;
      state.visit?.stop?.(ctx);
      state.travel?.stop?.(ctx);
      finish("failed", "stopped");
    },
  };
  return {
    id: corrupted ? "task:corrupted_gauntlet" : "task:gauntlet", skill: null, resolver: false, resolves: null, mode: "combat", capacity: 1, repeat: false,
    ephemeral: false, manual: false, failureCooldownMs: 0, requires: [], setup: [], actions: [action],
    describe: () => action.describe(), produces: [], site: null,
  };
}

module.exports = { createGauntletTask };
