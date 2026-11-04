"use strict";

const fs = require("fs");
const path = require("path");
const { gatheringTasks } = require("./Gathering.PlayerBots");
const { processingTasks } = require("./Processing.PlayerBots");
const { combatTasks } = require("./Combat.PlayerBots");
const { startingTasks } = require("./Starting.PlayerBots");

/**
 * Every task a character can be given, by the brain or picked in bot mode. Adding a task is one
 * entry here and a task object (tasks/Common.PlayerBots.js says what one looks like).
 */
const PLACES_FILE = path.join(__dirname, "..", "data", "places.json");
const TASK_PLACES_FILE = path.join(__dirname, "..", "data", "task-places.json");
const GROUPS = ["Quests", "Gathering", "Processing", "Combat"];

/** `registry` (brain/ActivityRegistry.PlayerBots.js) gives the gathering tiers. */
function createCatalogue(registry) {
  const places = new Map(JSON.parse(fs.readFileSync(PLACES_FILE, "utf8")).places.map((place) => [place.id, place]));
  const byTask = JSON.parse(fs.readFileSync(TASK_PLACES_FILE, "utf8")).places;
  const resolved = Object.fromEntries(Object.entries(byTask).map(([key, ids]) => [key, ids.map((id) => {
    const place = places.get(id);
    if (!place) throw new Error(`[player bots] task-places.json: unknown place '${id}'`);
    return place;
  })]));
  const tasks = [...startingTasks(), ...gatheringTasks(resolved, registry), ...processingTasks(resolved), ...combatTasks(resolved)];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return {
    tasks,
    byId,
    groups: GROUPS,
    places,
    hangAround: resolved.hang_around ?? [],
    get(id) {
      return byId.get(String(id ?? "").toLowerCase()) ?? null;
    },
  };
}

module.exports = { createCatalogue, GROUPS };
