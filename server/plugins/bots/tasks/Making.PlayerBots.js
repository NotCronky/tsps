"use strict";

const { ItemDefinition } = require("../../../src/main/typescript/elvarg/game/definition/ItemDefinition");
const { CacheDefinitions } = require("../../../src/main/typescript/elvarg/game/cache/CacheDefinitions");
const Supplies = require("../lib/Supplies.PlayerBots");
const { canGet, itemId, level, no, ok } = require("./Common.PlayerBots");

/**
 * Tasks that make one product at a bank, as a player does: empty the inventory, take out the tool
 * and a load of materials, make the product (Make: one item used on another, "All" in the make
 * menu; or Click: an item's own option, burying or cleaning), bank, and go again until the bank
 * runs out. Every product is its own task (oak longbows, guam potions, sapphires), so a skill
 * has as many tasks as it has things to make, each with its own level.
 *
 * Materials come from the bank: what the character gathered, made or bought. Cheap shop
 * consumables (feathers, vials of water, thread) are bought when the bank has none, with the
 * character's own coins.
 *
 * A recipe: { id, name, shortName, subgroup, family, skill, level, tool, materials, output, places }
 *   tool: item ids that work as the tool (the first owned is used), or null;
 *   materials: [[item, amount per make], ...], names resolved like item ids, or cache names.
 */
const MINUTES = [15, 35];
const INVENTORY = 28;
// The fewest makes worth a trip for: less than this banked doesn't open the task.
const MIN_SETS = 5;
// A load when everything stacks (arrows, darts): this many makes a trip.
const STACKED_SETS = 150;
// Shop consumables this cheap are bought when none are banked.
const BUY_PRICE = 50;

/** An item id from an ItemIds name, a cache name ("guam_leaf"), or an id. */
function resolve(name) {
  if (Number.isInteger(name)) return name;
  const byName = itemId(name);
  if (Number.isInteger(byName)) return byName;
  const byCache = CacheDefinitions.getObjId?.(String(name).toLowerCase());
  return Number.isInteger(byCache) && byCache >= 0 ? byCache : null;
}

function nameOf(id) {
  const name = ItemDefinition.forId(id)?.getName?.();
  return typeof name === "string" && name && name !== "null" ? name : `item ${id}`;
}

const stacks = (id) => ItemDefinition.forId(id)?.isStackable?.() === true;
const buyable = (id) => Supplies.canBuy(id) && Supplies.priceEstimate(id) <= BUY_PRICE;
const emptyInventory = { type: "bank", until: { inventoryFull: false } };

/** Makes per trip: what fits beside the tool, stackables taking one slot each. */
function setsPerTrip(tool, materials) {
  let free = INVENTORY - (tool !== null && !stacks(tool) ? 1 : 0);
  let perSet = 0;
  for (const [id, amount] of materials) {
    if (stacks(id)) free -= 1;
    else perSet += amount;
  }
  return perSet === 0 ? STACKED_SETS : Math.max(1, Math.floor(free / perSet));
}

/**
 * One make (or click) task. `kind` "make" uses `use` on `on` (the tool on the first material,
 * or the first material on the second); "click" clicks the first material. A `held` tool (a
 * crossbow's hammer) is only carried: the first material goes on the second.
 */
function makingTask(recipe) {
  const { id, subgroup, family = null, skill, places = [], kind = "make" } = recipe;
  const needed = recipe.level ?? 1;
  let resolved = null;
  const parts = () => {
    if (resolved) return resolved;
    const tools = (recipe.tool ?? []).map(resolve).filter(Number.isInteger);
    const materials = recipe.materials.map(([name, amount]) => [resolve(name), amount]);
    const output = resolve(recipe.output);
    const valid = materials.every(([item]) => Number.isInteger(item)) && (kind === "click" || Number.isInteger(output)) &&
      (recipe.tool == null || tools.length > 0) && (kind === "click" || (recipe.tool != null && !recipe.held) || materials.length >= 2);
    resolved = { valid, tools, materials, output };
    return resolved;
  };
  const toolOf = (player) => {
    const { tools } = parts();
    if (tools.length === 0) return null;
    return Supplies.bestOwned(player, tools)?.id ?? tools.find((tool) => canGet(player, tool)) ?? null;
  };
  const shortName = recipe.shortName ?? null;
  return {
    id,
    get name() { return recipe.name ?? `${subgroup}: ${this.shortName}`; },
    get shortName() { return shortName ?? (parts().valid ? nameOf(parts().output ?? parts().materials[0][0]) : id); },
    group: "Processing",
    subgroup,
    family,
    skill,
    level: needed,
    places,
    minutes: MINUTES,
    check(player) {
      const { valid, tools, materials } = parts();
      if (!valid) return no("isn't in this game");
      if (level(player, skill) < needed) return no(`needs ${needed} ${subgroup}`);
      if (tools.length > 0 && toolOf(player) === null) return no(`needs ${article(nameOf(tools[0]))} ${nameOf(tools[0]).toLowerCase()}`);
      const sets = Math.min(MIN_SETS, setsPerTrip(toolOf(player), materials));
      for (const [item, amount] of materials) {
        if (Supplies.ownedAmount(player, item) >= amount * sets) continue;
        if (buyable(item) && Supplies.coins(player) >= Supplies.priceEstimate(item) * amount * sets * 3) continue;
        return no(`needs ${nameOf(item).toLowerCase()} in the bank`);
      }
      return ok();
    },
    build(player, { registry }) {
      const { valid, materials, output } = parts();
      if (!valid) return null;
      const tool = toolOf(player);
      const sets = setsPerTrip(tool, materials);
      const want = materials.map(([item, amount]) => ({ item, amount: amount * sets }));
      const bought = want.filter((entry) => buyable(entry.item) && Supplies.bankedAmount(player, entry.item) < entry.amount);
      const banked = want.filter((entry) => !bought.includes(entry));
      const actions = [emptyInventory];
      if (tool !== null) actions.push({ type: "ensureItem", item: tool });
      if (bought.length > 0) actions.push({ type: "obtain", items: bought });
      if (banked.length > 0) actions.push({ type: "bank", withdraw: banked });
      if (kind === "click") {
        actions.push({ type: "clickItem", items: [materials[0][0]] });
      } else {
        const [use, on] = tool !== null && !recipe.held ? [tool, materials[0][0]] : [materials[0][0], materials[1][0]];
        actions.push({ type: "make", use, on, output });
      }
      return registry.compile({ id: `task_${id}`, mode: skill, capacity: 100000, repeat: true, failureCooldownSeconds: 60, actions });
    },
  };
}

const article = (word) => (/^[aeiou]/i.test(word) ? "an" : "a");
const slug = (text) => String(text).toLowerCase().replace(/\+/g, "_plus").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

module.exports = { makingTask, resolve, nameOf, slug, setsPerTrip };
