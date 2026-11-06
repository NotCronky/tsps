"use strict";

const { playerState } = require("../ActionState.PlayerBots");
const { approachObject, approachBlockedObject } = require("../../behaviours/navigation/Navigation.PlayerBots");
const { createObjectReachChecker } = require("../../behaviours/navigation/ObjectReach.PlayerBots");

/**
 * Tends one farming patch as a player does, through the Farming plugin's own options: picks a
 * grown crop, clears a dead one, rakes the weeds, then plants the best seed it carries (a seed on
 * the patch, with its dibber). Done once something is growing there, or there's nothing it can do
 * (diseased, no seed); fails when the patch can't be found.
 *
 * Spec: { patch: { id, x, y, z }, seeds: [seed item ids, best first] }
 */
const SEARCH_TILES = 30;
const DIRECT_ROUTE_TILES = 20;
const CLICK_MS = 2400;
// Clicks without the patch changing before it gives up on it.
const FAIL_AFTER = 8;
const FARM_ATTRIBUTE = "farming:state";
const PICK = ["pick", "harvest"];

const chebyshev = (a, b) => Math.max(Math.abs(a.getX() - b.getX()), Math.abs(a.getY() - b.getY()));

/** The plugin's state for a patch (Patches.Farming.js stateFor): undefined before its first visit. */
function patchState(player, patch) {
  return player.getAttribute(FARM_ATTRIBUTE)?.patches?.[`${patch.id}:${patch.x}:${patch.y}:${patch.z}`];
}

function createTendPatchAction(spec, world) {
  const { core } = world;
  const { patch, seeds = [] } = spec;
  const canReach = createObjectReachChecker(core);
  const stateFor = (player) => playerState(action, player, () => ({ clickedAt: 0, tries: 0, last: null }));

  function find(player) {
    const loc = player.getLocation();
    for (const object of world.objectSearch?.findCandidatesByIds?.(player, [patch.id], { regionRadius: 1, z: patch.z, privateArea: null }) ?? []) {
      const at = object.getLocation();
      if (at.getX() === patch.x && at.getY() === patch.y && chebyshev(at, loc) <= SEARCH_TILES) return object;
    }
    return null;
  }

  function options(player, object) {
    return (core.ObjectDefinition.forPlayer?.(object.getId(), player) ?? object.getDefinition?.())?.getInteractions?.()
      ?.map((option) => String(option ?? "").toLowerCase()) ?? [];
  }

  function walkAndDo(player, object, execute, clickType = 1) {
    player.getMovementQueue().walkToObject(object, { execute }, clickType);
  }

  function click(player, object, option) {
    const clickType = options(player, object).indexOf(option) + 1;
    const at = object.getLocation();
    walkAndDo(player, object, () => world.emitObjectInteraction?.({
      player, object, objectId: object.getId(), clickType, definition: core.ObjectDefinition.forPlayer?.(object.getId(), player),
      location: { x: at.getX(), y: at.getY(), z: at.getZ() },
      sourceLocation: { x: player.getLocation().getX(), y: player.getLocation().getY(), z: player.getLocation().getZ() },
      handled: false,
    }), clickType);
  }

  function plant(player, object, seed) {
    const at = object.getLocation();
    walkAndDo(player, object, () => {
      const slot = player.getInventory().getItems().findIndex((item) => item?.getId?.() === seed);
      if (slot < 0) return;
      world.emitItemOnObject?.({
        player, object, objectId: object.getId(), item: player.getInventory().getItems()[slot], itemId: seed,
        itemSlot: slot, interfaceType: 0, location: { x: at.getX(), y: at.getY(), z: at.getZ() }, handled: false,
      });
    });
  }

  const action = {
    id: "tendPatch",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      if (player.getMovementQueue().size() > 0 || nowMs - bot.clickedAt < CLICK_MS) return "running";
      // Raking, picking or clearing under way (the plugin's own loop): a click now would restart it.
      if (require("../../../skills/farming/Patches.Farming").isWorking?.(player)) {
        bot.tries = 0;
        return "running";
      }
      const object = find(player);
      if (!object) return ++bot.tries > FAIL_AFTER ? "failed" : "running";
      if (chebyshev(object.getLocation(), player.getLocation()) > DIRECT_ROUTE_TILES) {
        approachObject(player, object, { nowMs, reason: "brain_farming_approach" });
        return "running";
      }
      if (approachBlockedObject(player, object, { nowMs, reason: "brain_farming_approach", canReach })) return "running";
      // Herb patches share one transmit varbit: shown as this one (the plugin's syncPatch) before
      // its options are read, or it shows the last patch's crop.
      const Patches = require("../../../skills/farming/Patches.Farming");
      const data = require("../../../skills/farming/Data.Farming").CACHE?.patches?.find((entry) => entry.id === patch.id && entry.x === patch.x && entry.y === patch.y);
      if (data) {
        Patches.stateFor?.(player, data);
        Patches.syncPatch?.(player, data);
      }
      const state = patchState(player, patch);
      // The patch changing (weeds raked, a herb picked) is progress.
      const now = JSON.stringify([state?.weeds, state?.crop, state?.status, state?.lives, state?.stage]);
      if (now !== bot.last) {
        bot.last = now;
        bot.tries = 0;
      }
      if (++bot.tries > FAIL_AFTER) return "success";
      const choices = options(player, object);
      bot.clickedAt = nowMs;
      const pick = PICK.find((option) => choices.includes(option));
      if (pick && player.getInventory().getFreeSlots() > 0) return click(player, object, pick), "running";
      if (choices.includes("clear") && state?.status === "dead") return click(player, object, "clear"), "running";
      if (choices.includes("rake")) return click(player, object, "rake"), "running";
      // Empty and weeded: the best seed it carries.
      if (!state?.crop && (state?.weeds ?? 3) <= 0) {
        const seed = seeds.find((id) => player.getInventory().getAmount(id) > 0);
        if (seed === undefined) return "success";
        plant(player, object, seed);
        return "running";
      }
      // Growing (or diseased, with no cure carried): nothing more to do here this run.
      return "success";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.clickedAt = 0;
      bot.tries = 0;
      bot.last = null;
    },
    madeProgress() {
      return true;
    },
    describe() {
      return "tending a farming patch";
    },
  };
  return action;
}

module.exports = { createTendPatchAction, patchState };
