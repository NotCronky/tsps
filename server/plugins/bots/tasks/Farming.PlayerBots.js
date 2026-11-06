"use strict";

const Supplies = require("../lib/Supplies.PlayerBots");
const { canGet, itemId, level, no, ok } = require("./Common.PlayerBots");
const { createTravelToAction } = require("../brain/actions/TravelTo.PlayerBots");
const { createTendPatchAction, patchState } = require("../brain/actions/TendPatch.PlayerBots");

/**
 * Farming: a herb run, as players do it, round the herb patches it can walk to (Falador, Catherby,
 * Ardougne): each one picked when grown, cleared when dead, raked and planted with the best herb
 * seed it has banked for its level, through the Farming plugin. It comes up only when a patch is
 * ready for it (grown, dead, empty, or never planted), so it runs again once the herbs have grown.
 * Tools (rake, seed dibber, spade) are its own or bought; the herbs are banked after.
 */
const MINUTES = [10, 20];
// The herb patches (plugins/skills/data/farming-data.json) on the mainland, without a quest.
const PATCHES = [
  { name: "Falador", id: 8150, x: 3058, y: 3311, z: 0 },
  { name: "Catherby", id: 8151, x: 2813, y: 3463, z: 0 },
  { name: "Ardougne", id: 8152, x: 2670, y: 3374, z: 0 },
];
const TOOLS = ["RAKE", "SEED_DIBBER", "SPADE"].map(itemId);

const data = () => require("../../skills/farming/Data.Farming");

/** Herb seeds it can plant, best (highest level) first: [{ seed, level }]. */
function herbSeeds(player) {
  const farming = level(player, "farming");
  // The crop table is built at server startup; built here first if a check comes earlier.
  if (!data().CROPS?.size) data().initializeFarmingData?.();
  return [...(data().CROPS?.values?.() ?? [])].filter((crop) => crop.type === "HERB" && crop.level <= farming)
    .sort((a, b) => b.level - a.level).map((crop) => ({ seed: crop.seed, level: crop.level }));
}

/** Whether a patch wants it now: never planted, empty, grown or dead (not still growing). */
function ready(player, patch) {
  const farm = player.getAttribute("farming:state");
  if (farm) {
    try {
      require("../../skills/farming/Model.Farming").advanceFarm(farm, Date.now());
    } catch {
      // A model it can't run here: the stored state is what it goes by.
    }
  }
  const state = patchState(player, patch);
  if (!state || !state.crop) return true;
  return state.status === "dead" || state.status === "grown";
}

function herbRunTask() {
  return {
    id: "farming_herbs",
    name: "Farming: herb run",
    shortName: "Herb run",
    group: "Activities",
    subgroup: "Farming",
    skill: "farming",
    level: 9,
    crowd: 20,
    // It travels between the patches as part of the task.
    places: [],
    minutes: MINUTES,
    check(player) {
      if (level(player, "farming") < 9) return no("needs 9 Farming");
      const missing = TOOLS.find((tool) => !canGet(player, tool));
      if (missing !== undefined) return no("needs a rake, seed dibber and spade");
      if (!herbSeeds(player).some(({ seed }) => Supplies.ownedAmount(player, seed) > 0)) return no("needs herb seeds in the bank");
      if (!PATCHES.some((patch) => ready(player, patch))) return no("its herbs are still growing");
      return ok();
    },
    build(player, { registry, world }) {
      const seeds = herbSeeds(player).map(({ seed }) => seed);
      const owned = seeds.filter((seed) => Supplies.ownedAmount(player, seed) > 0);
      if (!owned.length) return null;
      const patches = PATCHES.filter((patch) => ready(player, patch));
      // Seeds for every patch it'll plant: the best first, then the next.
      const withdraw = [];
      let left = patches.length;
      for (const seed of owned) {
        if (left <= 0) break;
        const amount = Math.min(left, Supplies.ownedAmount(player, seed));
        withdraw.push({ item: seed, amount });
        left -= amount;
      }
      const activity = registry.compile({
        id: "task_farming_herbs", mode: "farming", capacity: 100000, repeat: false, failureCooldownSeconds: 60,
        actions: [
          { type: "bank", until: { inventoryFull: false } },
          ...TOOLS.map((tool) => ({ type: "ensureItem", item: tool })),
          { type: "bank", withdraw },
        ],
      });
      // Nearest patch first, then on round the rest.
      const at = player.getLocation();
      const order = [];
      let from = { x: at.getX(), y: at.getY() };
      const rest = patches.slice();
      while (rest.length) {
        rest.sort((a, b) => Math.max(Math.abs(a.x - from.x), Math.abs(a.y - from.y)) - Math.max(Math.abs(b.x - from.x), Math.abs(b.y - from.y)));
        const next = rest.shift();
        order.push(next);
        from = next;
      }
      for (const patch of order) {
        activity.actions.push(createTravelToAction({ x: patch.x, y: patch.y, z: patch.z, radius: 6 }, world), createTendPatchAction({ patch, seeds }, world));
      }
      // The herbs (and leftover seeds) go in the bank at the end.
      activity.actions.push(registry.compile({ id: "farming_bank", mode: "farming", capacity: 1, repeat: false, actions: [{ type: "bank", until: { inventoryFull: false } }] }).actions[0]);
      return activity;
    },
  };
}

function farmingTasks() {
  return [herbRunTask()];
}

module.exports = { farmingTasks };
