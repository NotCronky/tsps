"use strict";

const pickpocketing = require("../../skills/data/pickpocketing.json");
const { World } = require("../../../src/main/typescript/elvarg/game/World");
const Supplies = require("../lib/Supplies.PlayerBots");
const { itemId, level, no, ok } = require("./Common.PlayerBots");

/**
 * Skills trained out in the world rather than at a bank: Agility (each rooftop and course its own
 * task, run through the Agility plugin's own obstacles) and Thieving (each pickpocket target its
 * own task, through the Thieving plugin's own rolls, stuns and coin pouches).
 */
const MINUTES = [20, 40];

// The courses a player trains on: every rooftop and the Gnome Stronghold, with the Wiki's Agility
// levels, where each lap starts and the quest that opens it. (Ape Atoll, the Pyramid, Werewolf and
// Wilderness courses have extras of their own: greegrees, sticks, PvP.)
const COURSES = [
  { key: "gnome", name: "Gnome Stronghold", level: 1, start: [2474, 3436, 0] },
  { key: "draynor", name: "Draynor Village Rooftop", level: 10, start: [3103, 3279, 0] },
  { key: "alkharid", name: "Al Kharid Rooftop", level: 20, start: [3273, 3195, 0] },
  { key: "varrock", name: "Varrock Rooftop", level: 30, start: [3221, 3414, 0] },
  // In through the pipe from the north (the Agility plugin's shortcut, 35 Agility), and down the
  // ladder off the ledge's platform before the walls.
  { key: "barbarian", name: "Barbarian Outpost", level: 35, start: [2552, 3561, 0],
    entry: { object: 20210, outside: [2552, 3561, 0], inside: [2552, 3558, 0] }, down: { objects: [16682, 42487], before: 5 } },
  { key: "canifis", name: "Canifis Rooftop", level: 40, start: [3508, 3488, 0], quest: { key: "priest_in_peril", name: "Priest in Peril" } },
  { key: "falador", name: "Falador Rooftop", level: 50, start: [3036, 3341, 0] },
  { key: "seers", name: "Seers' Village Rooftop", level: 60, start: [2729, 3489, 0] },
  { key: "pollnivneach", name: "Pollnivneach Rooftop", level: 70, start: [3351, 2961, 0] },
  { key: "rellekka", name: "Rellekka Rooftop", level: 80, start: [2625, 3677, 0] },
  { key: "prifddinas", name: "Prifddinas Agility Course", level: 75, start: [3253, 6109, 0], quest: { key: "song_of_the_elves", name: "Song of the Elves" } },
  { key: "ardougne", name: "Ardougne Rooftop", level: 90, start: [2673, 3298, 0] },
];

/** As the Agility plugin asks: a quest no plugin answers for is no bar. */
function questDone(world, player, key) {
  const request = { player, key, complete: null, started: null };
  world?.emitCustomEvent?.("quest:is-complete", request);
  return request.complete !== false;
}

function agilityTasks() {
  return COURSES.map((course) => ({
    id: `agility_${course.key}`,
    name: `Agility: ${course.name}`,
    shortName: course.name,
    group: "Activities",
    subgroup: "Agility",
    skill: "agility",
    // A course is single file: a handful at a time.
    crowd: 6,
    level: course.level,
    places: [{ id: `course_${course.key}`, name: course.name, x: course.start[0], y: course.start[1], z: course.start[2] }],
    minutes: MINUTES,
    check(player, ctx = {}) {
      if (level(player, "agility") < course.level) return no(`needs ${course.level} Agility`);
      if (course.quest && !questDone(ctx.world, player, course.quest.key)) return no(`needs ${course.quest.name}`);
      return ok();
    },
    build(player, { registry }) {
      return registry.compile({
        id: `task_agility_${course.key}`, mode: "agility", capacity: 100000, repeat: true, failureCooldownSeconds: 60,
        actions: [{ type: "runCourse", course: course.key, entry: course.entry, down: course.down }],
      });
    },
  }));
}

const ARDOUGNE_MARKET = { id: "ardougne_market", name: "Ardougne market", x: 2662, y: 3306, z: 0 };

// Food a pickpocket eats when stunned too often: what players cook and buy, best last.
const FOOD = ["BREAD", "COOKED_MEAT", "COOKED_CHICKEN", "SHRIMPS", "ANCHOVIES", "SARDINE", "HERRING", "CAKE", "TROUT",
  "SALMON", "TUNA", "LOBSTER", "SWORDFISH", "MONKFISH", "SHARK"].map(itemId).filter(Number.isInteger);
const FOOD_TRIP = 10;
// Targets that hit this hard need food along.
const HARD_HITTER = 2;
const NAMES = {
  man: "Men and women", farmer: "Farmers", warrior: "Warriors", rogue: "Rogues", master_farmer: "Master farmers",
  guard: "Guards", knight: "Knights of Ardougne", paladin: "Paladins", hero: "Heroes", wealthy_citizen: "Wealthy citizens",
};
// Not in the Wilderness: a pickpocket doesn't go there for its marks.
const inWilderness = (x, y) => x >= 2944 && x <= 3392 && y >= 3520 && y <= 3968;

/** Where `names` spawn: the busiest few spots, found once from the world's own NPCs. */
function spawnPlaces(key, names, { prefix = "pickpocket", name = NAMES[key] ?? key } = {}) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const blocks = new Map();
  for (const npc of World.getNpcs?.() ?? []) {
    const name = String(npc?.getDefinition?.()?.getName?.() ?? "").toLowerCase();
    if (!wanted.has(name)) continue;
    const at = npc.getSpawnPosition?.() ?? npc.getLocation?.();
    if (!at || inWilderness(at.getX(), at.getY())) continue;
    const block = `${at.getX() >> 5},${at.getY() >> 5},${at.getZ()}`;
    const entry = blocks.get(block) ?? { count: 0, x: at.getX(), y: at.getY(), z: at.getZ() };
    entry.count += 1;
    blocks.set(block, entry);
  }
  return [...blocks.values()].sort((a, b) => b.count - a.count).slice(0, 3)
    .map((entry, index) => ({ id: `${prefix}_${key}_${index}`, name, x: entry.x, y: entry.y, z: entry.z }));
}

function bestFood(player) {
  return [...FOOD].reverse().find((id) => Supplies.bankedAmount(player, id) >= 5) ?? null;
}

function thievingTasks() {
  return pickpocketing.targets
    .filter((target) => !target.quest && NAMES[target.key])
    .map((target) => {
      const damage = Math.max(...[target.stunDamage ?? 1].flat());
      let places = null;
      return {
        id: `pickpocket_${target.key}`,
        name: `Thieving: Pickpocket ${NAMES[target.key].toLowerCase()}`,
        shortName: NAMES[target.key],
        group: "Activities",
        subgroup: "Thieving",
        family: "Pickpocketing",
        skill: "thieving",
        crowd: 5,
        level: target.level,
        // Found from the world once it has its NPCs; none yet (a test world): it stays put.
        get places() {
          if (places === null || places.length === 0) places = spawnPlaces(target.key, target.npcs);
          return places;
        },
        minutes: MINUTES,
        check(player) {
          if (level(player, "thieving") < target.level) return no(`needs ${target.level} Thieving`);
          if (damage >= HARD_HITTER && bestFood(player) === null) return no("needs food in the bank");
          return ok();
        },
        build(player, { registry }) {
          const food = bestFood(player);
          const actions = [{ type: "bank", until: { inventoryFull: false } }];
          if (food !== null) actions.push({ type: "bank", withdraw: [{ item: food, amount: FOOD_TRIP }] });
          actions.push({ type: "pickpocket", npcs: target.npcs, food: FOOD, pouch: target.coinPouch?.id ?? null });
          return registry.compile({
            id: `task_pickpocket_${target.key}`, mode: "thieving", capacity: 100000, repeat: true, failureCooldownSeconds: 60, actions,
          });
        },
      };
    });
}

// Stalls players train on, with their Thieving levels (the Thieving plugin's) and where they stand.
const STALLS = [
  { name: "Tea stall", level: 5, place: { id: "varrock_east", name: "Varrock east", x: 3268, y: 3414, z: 0 } },
  { name: "Baker's stall", level: 5, place: ARDOUGNE_MARKET },
  { name: "Silk stall", level: 20, place: ARDOUGNE_MARKET },
  { name: "Fur stall", level: 35, place: ARDOUGNE_MARKET },
  { name: "Silver stall", level: 50, place: ARDOUGNE_MARKET },
  { name: "Spice stall", level: 65, place: ARDOUGNE_MARKET },
  { name: "Gem stall", level: 75, place: ARDOUGNE_MARKET },
];

/**
 * Stall thieving, a task per stall: steal until the pack is full (the Thieving plugin's own
 * rolls, guards and respawns), bank the takings, back for more.
 */
function stallTasks() {
  return STALLS.map((stall) => ({
    id: `steal_${stall.name.toLowerCase().replace(/[^a-z]+/g, "_").replace(/_+$/, "")}`,
    name: `Thieving: ${stall.name}`,
    shortName: stall.name,
    group: "Activities",
    subgroup: "Thieving",
    family: "Stalls",
    skill: "thieving",
    // A stall or two of each kind: a few thieves each.
    crowd: 4,
    level: stall.level,
    places: [stall.place],
    minutes: MINUTES,
    check(player) {
      return level(player, "thieving") < stall.level ? no(`needs ${stall.level} Thieving`) : ok();
    },
    build(player, { registry }) {
      return registry.compile({
        id: `task_steal_${stall.level}_${stall.name}`, mode: "thieving", capacity: 100000, repeat: true, failureCooldownSeconds: 60,
        actions: [
          { type: "bank", until: { inventoryFull: false } },
          { type: "interactObject", catalog: "stall", tier: stall.name, option: "Steal-from", until: { inventoryFull: true }, stallSeconds: 180 },
        ],
      });
    },
  }));
}

function activityTasks() {
  return [...agilityTasks(), ...thievingTasks(), ...stallTasks()];
}

module.exports = { activityTasks, COURSES, spawnPlaces };
