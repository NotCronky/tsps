"use strict";

const Firemaking = require("../../skills/Firemaking.plugin");
const Cooking = require("../../skills/Cooking.plugin");
const Smithing = require("../../skills/Smithing.plugin");
const Supplies = require("../lib/Supplies.PlayerBots");
const { canGet, itemId, level, no, ok } = require("./Common.PlayerBots");
const { wintertodtTask } = require("./Wintertodt.PlayerBots");

/**
 * Processing tasks work through what the character has banked, as a player does after a
 * gathering trip: empty the inventory at a bank, take out a load (logs, raw fish, ores), burn,
 * cook or smelt it, and go again. The task ends when the bank runs out (the withdrawal fails),
 * so a character only processes what it gathered or bought itself.
 */
const MINUTES = [15, 35];
const INVENTORY = 28;
const TINDERBOX = itemId("tinderbox");

/** A repeating activity, compiled from the registry's own action types. */
function compile(registry, id, mode, actions) {
  return registry.compile({ id, mode, capacity: 100000, repeat: true, failureCooldownSeconds: 60, actions });
}

const emptyInventory = { type: "bank", until: { inventoryFull: false } };

/** The best item of `candidates` ({ id, level }) the character banked enough of and has the level for. */
function bestBanked(player, candidates, skill, minimum) {
  const levelNow = level(player, skill);
  return candidates
    .filter((entry) => entry.level <= levelNow && Supplies.bankedAmount(player, entry.id) >= minimum)
    .sort((a, b) => b.level - a.level)[0] ?? null;
}

function firemaking(places) {
  const logs = () => (Firemaking.LIGHTABLE_LOGS ?? [])
    .filter((log) => /logs$/i.test(log.name ?? ""))
    .map((log) => ({ id: log.itemId, level: log.requiredLevel }));
  return {
    id: "firemaking",
    name: "Firemaking: Burn logs",
    shortName: "Burn logs",
    group: "Processing",
    subgroup: "Firemaking",
    skill: "firemaking",
    level: 1,
    places,
    minutes: MINUTES,
    check(player) {
      if (!bestBanked(player, logs(), "firemaking", 10)) return no("needs logs in the bank");
      if (!canGet(player, TINDERBOX)) return no("needs a tinderbox");
      return ok();
    },
    build(player, { registry }) {
      const log = bestBanked(player, logs(), "firemaking", 1);
      if (!log) return null;
      return compile(registry, "task_firemaking", "firemaking", [
        emptyInventory,
        { type: "ensureItem", item: TINDERBOX },
        { type: "bank", withdraw: [{ item: log.id, amount: INVENTORY - 1 }] },
        { type: "lightFire" },
      ]);
    },
  };
}

function cooking(places) {
  const raws = () => [...(Cooking.COOKABLE_BY_RAW?.values?.() ?? [])]
    .filter((food) => !food.rangeOnly)
    .map((food) => ({ id: food.raw, level: food.level }));
  return {
    id: "cooking",
    name: "Cooking",
    shortName: "Cook banked food",
    group: "Processing",
    subgroup: "Cooking",
    skill: "cooking",
    places,
    minutes: MINUTES,
    check(player) {
      if (!bestBanked(player, raws(), "cooking", 10)) return no("needs raw food in the bank");
      if (!canGet(player, TINDERBOX)) return no("needs a tinderbox");
      return ok();
    },
    build(player, { registry }) {
      const raw = bestBanked(player, raws(), "cooking", 1);
      if (!raw) return null;
      return compile(registry, "task_cooking", "cooking", [
        emptyInventory,
        { type: "ensureItem", item: TINDERBOX },
        { type: "bank", withdraw: [{ item: raw.id, amount: INVENTORY - 1 }] },
        { type: "cook" },
      ]);
    },
  };
}

function smelting(places) {
  // The ores for one bar, and how many bars an inventory holds.
  const recipes = () => (Smithing.SMELTING_RECIPES ?? [])
    .filter((recipe) => !recipe.quest && !recipe.notInMenu && Array.isArray(recipe.ingredients))
    .map((recipe) => {
      const perBar = recipe.ingredients.reduce((sum, [, amount]) => sum + amount, 0);
      return { recipe, level: Number(recipe.level ?? 1), bars: Math.floor(INVENTORY / Math.max(1, perBar)) };
    });
  const affordable = (player) => {
    const levelNow = level(player, "smithing");
    return recipes()
      .filter(({ recipe, level: needed, bars }) => needed <= levelNow && bars > 0 &&
        recipe.ingredients.every(([id, amount]) => Supplies.bankedAmount(player, id) >= amount * Math.min(bars, 5)))
      .sort((a, b) => b.level - a.level)[0] ?? null;
  };
  return {
    id: "smelting",
    name: "Smithing: Smelt bars",
    shortName: "Smelt bars",
    group: "Processing",
    subgroup: "Smithing",
    skill: "smithing",
    places,
    minutes: MINUTES,
    check(player) {
      return affordable(player) ? ok() : no("needs ores in the bank");
    },
    build(player, { registry }) {
      const chosen = affordable(player);
      if (!chosen) return null;
      const { recipe, bars } = chosen;
      return compile(registry, "task_smelting", "smithing", [
        emptyInventory,
        { type: "bank", withdraw: recipe.ingredients.map(([id, amount]) => ({ item: id, amount: amount * bars })) },
        { type: "smelt", barId: recipe.barId },
      ]);
    },
  };
}

function processingTasks(places) {
  return [firemaking(places.firemaking), wintertodtTask(), cooking(places.cooking), smelting(places.smelting)];
}

module.exports = { processingTasks };
