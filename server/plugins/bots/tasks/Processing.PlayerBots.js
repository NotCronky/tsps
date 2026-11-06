"use strict";

const Smithing = require("../../skills/Smithing.plugin");
const cookingData = require("../../skills/data/cooking.json");
const smithingData = require("../../skills/data/smithing.json");
const Supplies = require("../lib/Supplies.PlayerBots");
const { resolve, nameOf } = require("./Making.PlayerBots");
const { pretty } = require("./Artisan.PlayerBots");
const { canGet, itemId, level, no, ok } = require("./Common.PlayerBots");
const { wintertodtTask } = require("./Wintertodt.PlayerBots");

/**
 * Processing tasks work through what the character has banked, as a player does after a
 * gathering trip: empty the inventory at a bank, take out a load (logs, raw fish, ores, bars),
 * burn, cook, smelt or smith it, and go again. The task ends when the bank runs out (the
 * withdrawal fails), so a character only processes what it gathered or bought itself. Every
 * material is its own task: each kind of log, each fish, each bar, each metal at the anvil.
 */
const MINUTES = [15, 35];
const INVENTORY = 28;
const TINDERBOX = itemId("tinderbox");
const HAMMER = itemId("hammer");
// Less than this banked doesn't open a task.
const MIN_BANKED = 10;

/** A repeating activity, compiled from the registry's own action types. */
function compile(registry, id, mode, actions) {
  return registry.compile({ id, mode, capacity: 100000, repeat: true, failureCooldownSeconds: 60, actions });
}

const emptyInventory = { type: "bank", until: { inventoryFull: false } };

// The logs a player burns, with their Firemaking levels (Wiki).
const LOGS = [
  ["LOGS", 1], ["OAK_LOGS", 15], ["WILLOW_LOGS", 30], ["TEAK_LOGS", 35], ["MAPLE_LOGS", 45],
  ["MAHOGANY_LOGS", 50], ["YEW_LOGS", 60], ["MAGIC_LOGS", 75], ["REDWOOD_LOGS", 90],
];

function firemaking(places) {
  return LOGS.map(([log, needed]) => {
    const logId = itemId(log);
    return {
      id: `burn_${log.toLowerCase()}`,
      name: `Firemaking: Burn ${pretty(log).toLowerCase()}`,
      shortName: pretty(log),
      group: "Processing",
      subgroup: "Firemaking",
      skill: "firemaking",
      level: needed,
      places,
      minutes: MINUTES,
      check(player) {
        if (!Number.isInteger(logId)) return no("isn't in this game");
        if (level(player, "firemaking") < needed) return no(`needs ${needed} Firemaking`);
        if (Supplies.bankedAmount(player, logId) < MIN_BANKED) return no(`needs ${pretty(log).toLowerCase()} in the bank`);
        if (!canGet(player, TINDERBOX)) return no("needs a tinderbox");
        return ok();
      },
      build(player, { registry }) {
        return compile(registry, `task_burn_${log.toLowerCase()}`, "firemaking", [
          emptyInventory,
          { type: "ensureItem", item: TINDERBOX },
          { type: "bank", withdraw: [{ item: logId, amount: INVENTORY - 1 }] },
          { type: "lightFire" },
        ]);
      },
    };
  });
}

// Food cooked on a fire or range that a player trains on: raw fish and meat, not minigame food.
function cookables() {
  return (cookingData.cookables ?? []).filter((food) => !food.rangeOnly && /^raw_/.test(food.raw) && !food.quest);
}

function cooking(places) {
  return cookables().map((food) => {
    const raw = resolve(food.raw);
    return {
      id: `cook_${food.raw.replace(/^raw_/, "")}`,
      get name() { return `Cooking: ${this.shortName}`; },
      // By the raw food: "Beef" and "Rat meat" both cook to meat.
      get shortName() {
        const name = Number.isInteger(raw) ? nameOf(raw) : pretty(food.raw);
        const bare = name.replace(/^raw /i, "");
        return bare.charAt(0).toUpperCase() + bare.slice(1);
      },
      group: "Processing",
      subgroup: "Cooking",
      skill: "cooking",
      level: food.level,
      places,
      minutes: MINUTES,
      check(player) {
        if (!Number.isInteger(raw)) return no("isn't in this game");
        if (level(player, "cooking") < food.level) return no(`needs ${food.level} Cooking`);
        if (Supplies.bankedAmount(player, raw) < MIN_BANKED) return no(`needs ${nameOf(raw).toLowerCase()} in the bank`);
        if (!canGet(player, TINDERBOX)) return no("needs a tinderbox");
        return ok();
      },
      build(player, { registry }) {
        return compile(registry, `task_cook_${food.raw}`, "cooking", [
          emptyInventory,
          { type: "ensureItem", item: TINDERBOX },
          { type: "bank", withdraw: [{ item: raw, amount: INVENTORY - 1 }] },
          { type: "cook" },
        ]);
      },
    };
  });
}

// Bars a player smelts at an ordinary furnace (not quest bars or ones without a menu entry).
function smeltable() {
  return (smithingData.smelting ?? []).filter((bar) => !bar.quest && !bar.notInMenu && Array.isArray(bar.ingredients));
}

function smelting(places) {
  return smeltable().map((bar) => {
    const ingredients = bar.ingredients.map(([name, amount]) => [itemId(name), amount]);
    const perBar = ingredients.reduce((sum, [, amount]) => sum + amount, 0);
    const bars = Math.floor(INVENTORY / Math.max(1, perBar));
    const barId = itemId(bar.bar);
    return {
      id: `smelt_${bar.bar.toLowerCase()}`,
      name: `Smithing: Smelt ${bar.name.toLowerCase()}s`,
      shortName: `Smelt ${bar.name.toLowerCase()}s`,
      group: "Processing",
      subgroup: "Smithing",
      family: "Smelting",
      skill: "smithing",
      level: bar.level,
      places,
      minutes: MINUTES,
      check(player) {
        if (!Number.isInteger(barId) || ingredients.some(([id]) => !Number.isInteger(id))) return no("isn't in this game");
        if (level(player, "smithing") < bar.level) return no(`needs ${bar.level} Smithing`);
        const short = ingredients.find(([id, amount]) => Supplies.bankedAmount(player, id) < amount * Math.min(bars, 5));
        return short ? no(`needs ${nameOf(short[0]).toLowerCase()} in the bank`) : ok();
      },
      build(player, { registry }) {
        return compile(registry, `task_smelt_${bar.bar.toLowerCase()}`, "smithing", [
          emptyInventory,
          { type: "bank", withdraw: ingredients.map(([id, amount]) => ({ item: id, amount: amount * bars })) },
          { type: "smelt", barId },
        ]);
      },
    };
  });
}

// The metals an anvil works, with the lowest level each is smithed at (Wiki).
const ANVIL_METALS = [
  ["BRONZE_BAR", 1], ["IRON_BAR", 15], ["STEEL_BAR", 30], ["MITHRIL_BAR", 50], ["ADAMANTITE_BAR", 70], ["RUNITE_BAR", 85],
];

/** The best product the character can smith from a bar: the highest level, no quest needed. */
function bestAnvilProduct(player, barId) {
  const levelNow = level(player, "smithing");
  return (Smithing.anvilProducts?.(barId) ?? [])
    .filter((product) => product.level <= levelNow && !product.quest && product.bars <= INVENTORY - 1)
    .sort((a, b) => b.level - a.level || b.bars - a.bars)[0] ?? null;
}

function anvilSmithing(places) {
  return ANVIL_METALS.map(([bar, needed]) => {
    const barId = itemId(bar);
    const metal = pretty(bar).replace(/ bar$/, "").replace(/^Adamantite$/, "Adamant").replace(/^Runite$/, "Rune");
    return {
      id: `smith_${metal.toLowerCase()}`,
      name: `Smithing: ${metal} at the anvil`,
      shortName: `${metal} items`,
      group: "Processing",
      subgroup: "Smithing",
      family: "Anvil",
      skill: "smithing",
      level: needed,
      places,
      minutes: MINUTES,
      check(player) {
        if (!Number.isInteger(barId)) return no("isn't in this game");
        if (level(player, "smithing") < needed) return no(`needs ${needed} Smithing`);
        const product = bestAnvilProduct(player, barId);
        if (!product) return no(`can't smith anything from ${metal.toLowerCase()} yet`);
        if (Supplies.bankedAmount(player, barId) < product.bars * 3) return no(`needs ${metal.toLowerCase()} bars in the bank`);
        if (!canGet(player, HAMMER)) return no("needs a hammer");
        return ok();
      },
      build(player, { registry }) {
        const product = bestAnvilProduct(player, barId);
        if (!product) return null;
        return compile(registry, `task_smith_${metal.toLowerCase()}`, "smithing", [
          emptyInventory,
          { type: "ensureItem", item: HAMMER },
          { type: "bank", withdraw: [{ item: barId, amount: Math.floor((INVENTORY - 1) / product.bars) * product.bars }] },
          { type: "smithAnvil", itemId: product.itemId, barId, bars: product.bars },
        ]);
      },
    };
  });
}

function processingTasks(places) {
  return [
    ...firemaking(places.firemaking), wintertodtTask(), ...cooking(places.cooking),
    ...smelting(places.smelting), ...anvilSmithing(places.anvil ?? places.smelting),
  ];
}

module.exports = { processingTasks };
