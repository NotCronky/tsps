"use strict";

const crafting = require("../../skills/data/crafting.json");
const Supplies = require("../lib/Supplies.PlayerBots");
const { canGet, level, no, ok } = require("./Common.PlayerBots");
const { resolve, nameOf, slug } = require("./Making.PlayerBots");

/**
 * Crafting at a station, every product its own task, from the Crafting plugin's own data:
 * jewellery at a furnace (each gold and silver piece: a bar, its gem, the mould kept), spinning
 * at a wheel (balls of wool, bow strings, ...), weaving at a loom (cloth, sacks, baskets, ...), and pottery (shaped at a potter's wheel, then
 * fired in the oven). A load comes out of the bank, the station makes it (the plugin's own menus
 * and checks), and the load is banked; the task ends when the bank runs out of materials.
 */
const MINUTES = [15, 35];
const INVENTORY = 28;
const MIN_SETS = 5;

/**
 * One station task. `materials` [[name, amount]] come out of the bank each trip; `tool` (ids) is
 * carried and kept; `steps` are the station actions, in order (with `material`/`output` names).
 */
function stationTask({ id, name, shortName, family, level: needed, tool = null, materials, steps, places }) {
  let parts = null;
  const resolved = () => {
    if (parts) return parts;
    const tools = (tool ?? []).map(resolve).filter(Number.isInteger);
    const items = materials.map(([item, amount]) => [resolve(item), amount]);
    const valid = items.every(([item]) => Number.isInteger(item)) && (tool === null || tools.length > 0)
      && steps.every((step) => Number.isInteger(resolve(step.material)) && Number.isInteger(resolve(step.output)));
    parts = { valid, tools, items };
    return parts;
  };
  const toolOf = (player) => {
    const { tools } = resolved();
    if (tools.length === 0) return null;
    return Supplies.bestOwned(player, tools)?.id ?? tools.find((candidate) => canGet(player, candidate)) ?? null;
  };
  const sets = (player) => {
    const free = INVENTORY - (toolOf(player) === null ? 0 : 1);
    const perSet = resolved().items.reduce((sum, [, amount]) => sum + amount, 0);
    return Math.max(1, Math.floor(free / Math.max(1, perSet)));
  };
  return {
    id,
    name: name ?? `Crafting: ${shortName}`,
    shortName,
    group: "Processing",
    subgroup: "Crafting",
    family,
    skill: "crafting",
    level: needed,
    places,
    minutes: MINUTES,
    check(player) {
      const { valid, tools, items } = resolved();
      if (!valid) return no("isn't in this game");
      if (level(player, "crafting") < needed) return no(`needs ${needed} Crafting`);
      if (tools.length > 0 && toolOf(player) === null) return no(`needs ${nameOf(tools[0]).toLowerCase()}`);
      const short = items.find(([item, amount]) => Supplies.ownedAmount(player, item) < amount * Math.min(MIN_SETS, sets(player)));
      return short ? no(`needs ${nameOf(short[0]).toLowerCase()} in the bank`) : ok();
    },
    build(player, { registry }) {
      const { valid, items } = resolved();
      if (!valid) return null;
      const tool = toolOf(player);
      const loads = sets(player);
      const actions = [{ type: "bank", until: { inventoryFull: false } }];
      if (tool !== null) actions.push({ type: "ensureItem", item: tool });
      actions.push({ type: "bank", withdraw: items.map(([item, amount]) => ({ item, amount: amount * loads })) });
      for (const step of steps) {
        actions.push({ type: "station", ...step, material: resolve(step.material), output: resolve(step.output), use: step.use ? resolve(step.use) : undefined });
      }
      return registry.compile({ id: `task_${id}`, mode: "crafting", capacity: 100000, repeat: true, failureCooldownSeconds: 60, actions });
    },
  };
}

function pretty(key) {
  const text = String(key).toLowerCase().replace(/_u_$/, " (u)").replace(/_/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function jewelleryTasks(places) {
  const tasks = [];
  const gems = crafting.gold.gems;
  for (const type of crafting.gold.types) {
    type.products.forEach(([item, needed], index) => {
      const gem = gems[index];
      tasks.push(stationTask({
        id: `jewel_${slug(item)}`, shortName: pretty(item), family: "Gold jewellery", level: needed,
        tool: [type.mould], materials: gem ? [["GOLD_BAR", 1], [gem, 1]] : [["GOLD_BAR", 1]],
        steps: [{ catalog: "furnace", use: "GOLD_BAR", event: "crafting:furnace-make", material: "GOLD_BAR", output: item }],
        places,
      }));
    });
  }
  for (const product of crafting.silver.products) {
    const extra = product.extra ?? [];
    tasks.push(stationTask({
      id: `jewel_${slug(product.item)}`, shortName: pretty(product.item), family: "Silver", level: product.level,
      tool: [product.mould], materials: [["SILVER_BAR", 1], ...extra.map((item) => [item, 1])],
      steps: [{ catalog: "furnace", use: "SILVER_BAR", event: "crafting:furnace-make", material: "SILVER_BAR", output: product.item }],
      places,
    }));
  }
  return tasks;
}

function spinningTasks(places) {
  return crafting.spinning.recipes.map((recipe) => {
    const material = recipe.materials[0];
    return stationTask({
      id: `spin_${slug(recipe.item)}`, shortName: pretty(recipe.item), family: "Spinning", level: recipe.level,
      materials: [[material, recipe.amount ?? 1]],
      steps: [{ catalog: "spinning wheel", option: "Spin", material, output: recipe.item }],
      places,
    });
  });
}

function weavingTasks(places) {
  return crafting.weaving.recipes.map((recipe) => {
    const material = recipe.materials[0];
    return stationTask({
      id: `weave_${slug(recipe.item)}`, shortName: pretty(recipe.item), family: "Weaving", level: recipe.level,
      materials: [[material, recipe.amount ?? 1]],
      steps: [{ catalog: "loom", option: "Weave", material, output: recipe.item }],
      places,
    });
  });
}

function potteryTasks(places) {
  return crafting.pottery.recipes.filter((recipe) => !recipe.quest).map((recipe) => stationTask({
    id: `pottery_${slug(recipe.fired)}`, shortName: pretty(recipe.fired), family: "Pottery", level: recipe.level,
    materials: [["SOFT_CLAY", 1]],
    steps: [
      { catalog: "potter's wheel", option: "Use", material: "SOFT_CLAY", output: recipe.unfired },
      { catalog: "pottery oven", option: "Fire", material: recipe.unfired, output: recipe.unfired },
    ],
    places,
  }));
}

function stationTasks(places) {
  const furnaces = places.smelting ?? [];
  const stations = places.crafting_stations ?? [];
  const tasks = [...jewelleryTasks(furnaces), ...spinningTasks(stations), ...weavingTasks(places.loom ?? []), ...potteryTasks(stations)];
  const seen = new Set();
  return tasks.filter((task) => !seen.has(task.id) && seen.add(task.id));
}

module.exports = { stationTasks };
