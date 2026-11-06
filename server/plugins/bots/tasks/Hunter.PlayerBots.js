"use strict";

const { ItemIds, NpcIds } = require("../../../src/main/typescript/elvarg/util/IdEnums");
const Supplies = require("../lib/Supplies.PlayerBots");
const { canGet, level, no, ok } = require("./Common.PlayerBots");
const { createTravelToAction } = require("../brain/actions/TravelTo.PlayerBots");
const SPAWNS_FILE = require("path").join(__dirname, "..", "..", "..", "data", "definitions", "npc-spawns.json");

/**
 * Hunter, a task per creature: bird snaring (each bird where it spawns, from the world's NPC spawns),
 * as players train it, with snares it owns or buys. The snares come out of the bank (or the shop)
 * where it is, then it travels to the nearest spot (no bank is near most of them) and hunts till
 * the task's time is up (createHuntTrapsAction): laid, checked, reset, the bones
 * and meat dropped, the feathers kept.
 */
const MINUTES = [20, 40];

// The birds (the Hunter plugin's Data.Hunter.js levels) and the feathers a snare's catch gives.
const BIRDS = [
  { key: "crimson_swift", npc: "CRIMSON_SWIFT", name: "Crimson swifts", level: 1 },
  { key: "golden_warbler", npc: "GOLDEN_WARBLER", name: "Golden warblers", level: 5 },
  { key: "copper_longtail", npc: "COPPER_LONGTAIL", name: "Copper longtails", level: 9 },
  { key: "cerulean_twitch", npc: "CERULEAN_TWITCH", name: "Cerulean twitches", level: 11 },
  { key: "tropical_wagtail", npc: "TROPICAL_WAGTAIL", name: "Tropical wagtails", level: 19 },
];
const SNARE = ItemIds.BIRD_SNARE;
const JUNK = [ItemIds.BONES, ItemIds.RAW_BIRD_MEAT].filter(Number.isInteger);
// What the level allows out at once (the plugin's: one, plus one every 20 levels, five at most).
const trapsFor = (hunter) => Math.min(5, 1 + Math.floor(hunter / 20));

// Not the Wilderness, nor an instance or underground (y 4000 and up).
const usable = (x, y) => y < 4000 && !(x >= 2944 && x <= 3392 && y >= 3520 && y <= 3968);

/** Where an NPC spawns most, from the spawn data: the busiest few 32-tile blocks. */
function spawnSpots(npcId, key) {
  const blocks = new Map();
  for (const spawn of JSON.parse(require("fs").readFileSync(SPAWNS_FILE, "utf8"))) {
    if (spawn.id !== npcId || (spawn.level ?? 0) !== 0 || !usable(spawn.x, spawn.y)) continue;
    const block = `${spawn.x >> 5},${spawn.y >> 5}`;
    const entry = blocks.get(block) ?? { count: 0, xs: 0, ys: 0 };
    entry.count += 1;
    entry.xs += spawn.x;
    entry.ys += spawn.y;
    blocks.set(block, entry);
  }
  return [...blocks.values()].filter((entry) => entry.count >= 3).sort((a, b) => b.count - a.count).slice(0, 4)
    .map((entry, index) => ({ id: `hunt_${key}_${index}`, x: Math.round(entry.xs / entry.count), y: Math.round(entry.ys / entry.count), z: 0 }));
}

const nearestTo = (player, spots) => {
  const at = player.getLocation();
  return spots.slice().sort((a, b) => Math.max(Math.abs(a.x - at.getX()), Math.abs(a.y - at.getY()))
    - Math.max(Math.abs(b.x - at.getX()), Math.abs(b.y - at.getY())))[0] ?? null;
};

function birdTask(bird) {
  let spots = null;
  const spotsOf = () => (spots ??= spawnSpots(NpcIds[bird.npc], bird.key));
  return {
    id: `hunt_${bird.key}`,
    name: `Hunter: ${bird.name}`,
    shortName: bird.name,
    group: "Activities",
    subgroup: "Hunter",
    family: "Bird snaring",
    skill: "hunter",
    crowd: 6,
    level: bird.level,
    // It travels as part of the task, after the snares.
    places: [],
    minutes: MINUTES,
    check(player) {
      if (level(player, "hunter") < bird.level) return no(`needs ${bird.level} Hunter`);
      if (!canGet(player, SNARE)) return no("needs a bird snare");
      return spotsOf().length ? ok() : no("isn't in this world");
    },
    build(player, { registry, world }) {
      const spot = nearestTo(player, spotsOf());
      if (!spot) return null;
      const snares = Math.max(1, Math.min(trapsFor(level(player, "hunter")), Supplies.ownedAmount(player, SNARE) || trapsFor(level(player, "hunter"))));
      const activity = registry.compile({
        id: `task_hunt_${bird.key}`, mode: "hunter", capacity: 100000, repeat: true, failureCooldownSeconds: 60,
        actions: [
          { type: "ensureItem", item: SNARE, amount: snares },
          { type: "huntTraps", item: SNARE, kind: "bird", junk: JUNK },
        ],
      });
      activity.actions.splice(1, 0, createTravelToAction({ ...spot, radius: 3 }, world));
      return activity;
    },
  };
}

function hunterTasks() {
  return BIRDS.map(birdTask);
}

module.exports = { hunterTasks };
