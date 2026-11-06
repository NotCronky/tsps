"use strict";

const fs = require("fs");
const path = require("path");
const { gatheringTasks } = require("./Gathering.PlayerBots");
const { processingTasks } = require("./Processing.PlayerBots");
const { artisanTasks } = require("./Artisan.PlayerBots");
const { activityTasks } = require("./Activities.PlayerBots");
const { stationTasks } = require("./Stations.PlayerBots");
const { magicTasks } = require("./Magic.PlayerBots");
const { runecraftTasks } = require("./Runecraft.PlayerBots");
const { hunterTasks } = require("./Hunter.PlayerBots");
const { farmingTasks } = require("./Farming.PlayerBots");
const { PluginManager } = require("../../../src/main/typescript/elvarg/plugins/PluginManager");
const { combatTasks } = require("./Combat.PlayerBots");
const { startingTasks } = require("./Starting.PlayerBots");

/**
 * Every task a character can be given, by the brain or picked in bot mode. Adding a task is one
 * entry here and a task object (tasks/Common.PlayerBots.js says what one looks like).
 */
const PLACES_FILE = path.join(__dirname, "..", "data", "places.json");
const TASK_PLACES_FILE = path.join(__dirname, "..", "data", "task-places.json");
const GROUPS = ["Quests", "Gathering", "Processing", "Activities", "Combat"];

/** `registry` (brain/ActivityRegistry.PlayerBots.js) gives the gathering tiers. */
function createCatalogue(registry) {
  const places = new Map(JSON.parse(fs.readFileSync(PLACES_FILE, "utf8")).places.map((place) => [place.id, place]));
  const byTask = JSON.parse(fs.readFileSync(TASK_PLACES_FILE, "utf8")).places;
  const resolved = Object.fromEntries(Object.entries(byTask).map(([key, ids]) => [key, ids.map((id) => {
    const place = places.get(id);
    if (!place) throw new Error(`[player bots] task-places.json: unknown place '${id}'`);
    return place;
  })]));
  // Plugins answer some task lists (the enchant spells' pieces) only once they've registered,
  // after the bots: refresh() adds what's new then (the plugin calls it at server startup).
  const events = { emitCustomEvent: (name, payload) => PluginManager.emitCustomEvent(name, payload) };
  const tasks = [...startingTasks(), ...gatheringTasks(resolved, registry), ...processingTasks(resolved), ...artisanTasks(resolved),
    ...stationTasks(resolved), ...runecraftTasks(), ...magicTasks(resolved, events), ...activityTasks(), ...hunterTasks(), ...farmingTasks(), ...combatTasks(resolved)];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return {
    tasks,
    byId,
    refresh() {
      for (const task of magicTasks(resolved, events)) {
        if (byId.has(task.id)) continue;
        byId.set(task.id, task);
        // Kept with its skill's other tasks, before Activities and Combat.
        const at = tasks.findIndex((other) => other.group === "Activities" || other.group === "Combat");
        tasks.splice(at < 0 ? tasks.length : at, 0, task);
      }
    },
    groups: GROUPS,
    places,
    hangAround: resolved.hang_around ?? [],
    get(id) {
      return byId.get(String(id ?? "").toLowerCase()) ?? null;
    },
  };
}

module.exports = { createCatalogue, GROUPS };
