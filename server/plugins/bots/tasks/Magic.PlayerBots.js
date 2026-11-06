"use strict";

const { ItemDefinition } = require("../../../src/main/typescript/elvarg/game/definition/ItemDefinition");
const smithing = require("../../skills/data/smithing.json");
const Supplies = require("../lib/Supplies.PlayerBots");
const { itemId, level, no, ok } = require("./Common.PlayerBots");
const { nameOf, slug } = require("./Making.PlayerBots");

/**
 * Magic tasks, cast on items at a bank with the character's own runes (banked, else bought):
 * - Low and High Level Alchemy: the most valuable of the things it has made and banked (bows,
 *   battlestaves, d'hide, jewellery, smithed armour) turned into coins;
 * - Superheat Item, a task per bar: the ores smelted by the spell (Smithing's levels apply);
 * - Enchanting, a task per piece: each jewellery spell's pieces, from the enchanting plugin's own
 *   table ("magic:enchant-recipes").
 * Every cast goes through the spell's own code (castOnItem: runes, levels, XP).
 */
const MINUTES = [15, 30];
const TRIP = 26;
const MIN_CASTS = 5;

const rune = (name) => itemId(`${name}_RUNE`);

/** Every item the character has banked: [{ id, amount }]. */
function banked(player) {
  const items = [];
  for (let tab = 0; tab < 10; tab++) {
    for (const item of player.getBank?.(tab)?.getItems?.() ?? []) {
      if ((item?.getId?.() ?? -1) > 0 && item.getAmount() > 0) items.push({ id: item.getId(), amount: item.getAmount() });
    }
  }
  return items;
}

/** Runes ([[id, perCast]]) for `casts` casts: banked or affordable. */
function runesFor(player, runes, casts) {
  return runes.every(([id, each]) => Supplies.ownedAmount(player, id) >= each * casts
    || (Supplies.canBuy(id) && Supplies.coins(player) >= Supplies.priceEstimate(id) * each * casts * 2));
}

/** One cast-at-the-bank task: runes and targets out, cast on each, bank, again. */
function castTask({ id, name, shortName, family, magic, extra, runes, targets, withdraw, places }) {
  return {
    id,
    name,
    shortName,
    group: "Processing",
    subgroup: "Magic",
    family,
    skill: "magic",
    level: magic,
    places,
    minutes: MINUTES,
    check(player) {
      if (level(player, "magic") < magic) return no(`needs ${magic} Magic`);
      const more = extra?.(player);
      if (more) return no(more);
      const wanted = withdraw(player);
      if (!wanted || wanted.casts < MIN_CASTS) return no(`needs ${family === "Alchemy" ? "items to alch" : nameOf(targets(player)[0] ?? -1).toLowerCase()} in the bank`);
      if (!runesFor(player, runes, wanted.casts)) return no("needs the runes, or the coins for them");
      return ok();
    },
    build(player, { registry }) {
      const wanted = withdraw(player);
      if (!wanted) return null;
      return registry.compile({
        id: `task_${id}`, mode: "magic", capacity: 100000, repeat: true, failureCooldownSeconds: 60,
        actions: [
          { type: "bank", until: { inventoryFull: false } },
          { type: "obtain", items: runes.map(([rune, each]) => ({ item: rune, amount: each * wanted.casts })) },
          { type: "bank", withdraw: wanted.items },
          { type: "castOnItem", spell: name.replace(/^Magic: /, "").replace(/ \(.*$/, ""), items: targets(player) },
        ],
      });
    },
  };
}

// What a character makes and keeps no use for, worth alching.
const ALCHABLE = /(long|short)bow$|battlestaff$|d'hide|ring$|necklace$|amulet$|bracelet$|platebody$|platelegs$|plateskirt$|full helm$|kiteshield$|2h sword$|chainbody$/i;

/** The alch target: the banked item of the most coins a cast (value), with a few to cast on. */
function alchTarget(player) {
  return banked(player)
    .filter(({ id, amount }) => amount >= MIN_CASTS && ALCHABLE.test(ItemDefinition.forId(id)?.getName?.() ?? "")
      && !ItemDefinition.forId(id)?.isStackable?.())
    .sort((a, b) => (ItemDefinition.forId(b.id)?.getValue?.() ?? 0) - (ItemDefinition.forId(a.id)?.getValue?.() ?? 0))[0] ?? null;
}

function alchemyTasks(places) {
  return [
    ["Low Level Alchemy", 21, [[rune("NATURE"), 1], [rune("FIRE"), 3]]],
    ["High Level Alchemy", 55, [[rune("NATURE"), 1], [rune("FIRE"), 5]]],
  ].map(([spell, magic, runes]) => castTask({
    id: `alch_${slug(spell)}`, name: `Magic: ${spell}`, shortName: spell, family: "Alchemy", magic, runes, places,
    targets: (player) => [alchTarget(player)?.id].filter(Number.isInteger),
    withdraw: (player) => {
      const target = alchTarget(player);
      if (!target) return null;
      const casts = Math.min(TRIP, target.amount);
      return { casts, items: [{ item: target.id, amount: casts }] };
    },
  }));
}

function superheatTasks(places) {
  return smithing.smelting.filter((bar) => !bar.quest && !bar.notInMenu && bar.bar !== "BRONZE_BAR").map((bar) => {
    const ingredients = bar.ingredients.map(([name, amount]) => [itemId(name), amount]);
    const ore = ingredients.find(([id]) => id !== itemId("COAL"))?.[0] ?? ingredients[0][0];
    const perCast = ingredients.reduce((sum, [, amount]) => sum + amount, 0);
    const casts = Math.max(1, Math.floor(TRIP / perCast));
    return castTask({
      id: `superheat_${slug(bar.bar)}`, name: `Magic: Superheat Item (${bar.name.toLowerCase()}s)`,
      shortName: `Superheat ${bar.name.toLowerCase()}s`, family: "Superheat", magic: 43, places,
      runes: [[rune("NATURE"), 1], [rune("FIRE"), 4]],
      extra: (player) => (level(player, "smithing") < bar.level ? `needs ${bar.level} Smithing` : null),
      targets: () => [ore],
      withdraw: (player) => {
        const enough = ingredients.every(([id, amount]) => Supplies.bankedAmount(player, id) >= amount * Math.min(casts, MIN_CASTS));
        if (!enough) return null;
        const trip = Math.min(casts, ...ingredients.map(([id, amount]) => Math.floor(Supplies.bankedAmount(player, id) / amount)));
        return { casts: trip, items: ingredients.map(([id, amount]) => ({ item: id, amount: amount * trip })) };
      },
    });
  });
}

/** The enchanting plugin's pieces, once it has registered (asked lazily, at first check). */
function enchantTasks(places, world) {
  const request = { recipes: [] };
  world?.emitCustomEvent?.("magic:enchant-recipes", request);
  return request.recipes.map((recipe) => castTask({
    id: `enchant_${slug(nameOf(recipe.itemId))}`, name: `Magic: ${recipe.spellName} (${nameOf(recipe.itemId).toLowerCase()})`,
    shortName: `${nameOf(recipe.itemId)} into ${nameOf(recipe.resultId).toLowerCase()}`, family: "Enchanting",
    magic: recipe.level, runes: recipe.runes, places,
    targets: () => [recipe.itemId],
    withdraw: (player) => {
      const held = Supplies.bankedAmount(player, recipe.itemId);
      if (held <= 0) return null;
      const casts = Math.min(TRIP, held);
      return { casts, items: [{ item: recipe.itemId, amount: casts }] };
    },
  }));
}

function magicTasks(places, world) {
  const bank = places.banking ?? [];
  const tasks = [...alchemyTasks(bank), ...superheatTasks(bank), ...enchantTasks(bank, world)];
  const seen = new Set();
  return tasks.filter((task) => !seen.has(task.id) && seen.add(task.id));
}

module.exports = { magicTasks, alchTarget };
