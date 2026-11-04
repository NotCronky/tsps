"use strict";

const { canGetTool } = require("../brain/actions/EquipTool.PlayerBots");
const { canGet, itemId, level, no, ok } = require("./Common.PlayerBots");

/**
 * Gathering tasks: one per tier of each skill's activities in
 * data/definitions/bot-activities.json (normal trees ... magic trees, copper and tin ... runite,
 * net ... harpoon), each with its own level, tool and places. A tier added there is a task here.
 * The activity gathers until the inventory is full, then drops, sells, processes (burns logs,
 * smelts ore, cooks fish) or banks the haul.
 */
const MINUTES = [20, 45];
const SKILLS = [
  { mode: "woodcutting", skill: "woodcutting", name: "Woodcutting", tool: () => "axe" },
  { mode: "mining", skill: "mining", name: "Mining", tool: () => "pickaxe" },
  { mode: "fishing", skill: "fishing", name: "Fishing", tool: null },
];
/** How a tier reads in the picker, where its id alone doesn't say it well. */
const NAMES = {
  normal_trees: "Trees",
  copper_tin_rocks: "Copper and tin",
  fish_shrimps: "Shrimps and anchovies",
  fish_sardines: "Sardines and herring",
  fish_mackerel: "Mackerel, cod and bass",
  fish_trout: "Trout and salmon",
  fish_pike: "Pike",
  fish_tuna: "Tuna and swordfish",
  fish_lobsters: "Lobsters",
  fish_sharks: "Sharks",
};
const article = (word) => (/^[aeiou]/.test(word) ? "an" : "a");

function tierName(id) {
  if (NAMES[id]) return NAMES[id];
  const words = id.replace(/_(rocks|trees)$/, (_, kind) => (kind === "trees" ? " trees" : "")).replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One task for one activity tier. */
function tierTask(registry, skill, activity, places) {
  const needed = registry.levelOf(activity.id);
  const fields = registry.fieldsOf(activity.id);
  const toolName = skill.tool?.(fields) ?? null;
  const toolItem = toolName ? null : itemId(fields.tool);
  const baitItem = fields.bait ? itemId(fields.bait) : null;
  return {
    id: activity.id,
    name: `${skill.name}: ${tierName(activity.id)}`,
    shortName: tierName(activity.id),
    group: "Gathering",
    subgroup: skill.name,
    skill: skill.skill,
    level: needed,
    places: places[activity.id] ?? places[skill.mode] ?? [],
    minutes: MINUTES,
    check(player) {
      if (level(player, skill.skill) < needed) return no(`needs ${needed} ${skill.name}`);
      if (toolName && !canGetTool(toolName, player)) return no(`needs ${article(toolName)} ${toolName} or the coins for one`);
      if (toolItem !== null && !canGet(player, toolItem)) return no(`needs ${String(fields.tool).replace(/_/g, " ")} or the coins for one`);
      if (baitItem !== null && !canGet(player, baitItem)) return no(`needs ${String(fields.bait).replace(/_/g, " ")}s or the coins for them`);
      return ok();
    },
    build() {
      return activity;
    },
  };
}

function gatheringTasks(places, registry) {
  const tasks = [];
  for (const skill of SKILLS) {
    const activities = registry.activities
      .filter((activity) => activity.mode === skill.mode && activity.manual !== true && activity.ephemeral !== true)
      .sort((a, b) => registry.levelOf(a.id) - registry.levelOf(b.id));
    for (const activity of activities) tasks.push(tierTask(registry, skill, activity, places));
  }
  return tasks;
}

module.exports = { gatheringTasks, tierName };
