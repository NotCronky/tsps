"use strict";

const Woodcutting = require("../../skills/Woodcutting.plugin");
const Mining = require("../../skills/Mining.plugin");
const Smithing = require("../../skills/Smithing.plugin");
const Cooking = require("../../skills/Cooking.plugin");
const {
  CacheDefinitions,
} = require("../../../src/main/typescript/elvarg/game/cache/CacheDefinitions");

const CATALOGS = {
  tree: () =>
    (Woodcutting.TREES ?? []).map((tree) => ({
      name: tree.name,
      objectNames: tree.objectNames ?? [],
      ids: tree.objectIds ?? [],
    })),
  rock: () =>
    (Mining.ROCKS ?? []).map((rock) => ({
      name: rock.objectName,
      objectNames: rock.objectName ? [rock.objectName] : [],
      ids: rock.objectIds ?? [],
    })),
  // Ranges and stoves food is cooked on (fires are runtime objects, found separately).
  range: () => [
    {
      name: "range",
      objectNames: [...(Cooking.COOKABLE_OBJECT_NAMES ?? [])].filter((name) => !Cooking.FIRE_OBJECT_NAMES?.has(name)),
      ids: [],
    },
  ],
  furnace: () => [
    {
      name: "furnace",
      objectNames: ["Furnace"],
      ids: [...(Smithing.FURNACE_OBJECT_IDS ?? [])].filter(Number.isInteger),
    },
  ],
  anvil: () => [{ name: "anvil", objectNames: ["Anvil"], ids: [] }],
  "spinning wheel": () => [{ name: "spinning wheel", objectNames: ["Spinning wheel", "Spinning Wheel"], ids: [] }],
  "potter's wheel": () => [{ name: "potter's wheel", objectNames: ["Potter's Wheel", "Potter's wheel"], ids: [] }],
  "pottery oven": () => [{ name: "pottery oven", objectNames: ["Pottery Oven"], ids: [] }],
  loom: () => [{ name: "loom", objectNames: ["Loom"], ids: [] }],
  // Thieving stalls, by the names the Thieving plugin steals from (a tier is a stall's name).
  stall: () => stallNames().map((name) => ({ name, objectNames: [name], ids: [] })),
  // Agility courses' obstacles, by course key (their ids are the course data's own).
  agility: () => agilityCourses().map((course) => ({
    name: course.key,
    objectNames: [],
    ids: course.obstacles.flatMap((obstacle) => [obstacle.object ?? []].flat()).filter(Number.isInteger),
  })),
  // What a lap takes that isn't one of its obstacles (tasks/Activities.PlayerBots.js): the Barbarian
  // Outpost's pipe in, and the ladder down off its ledge.
  "agility extras": () => [{ name: "barbarian", objectNames: [], ids: [20210, 16682, 42487] }],
};

let stalls = null;
function stallNames() {
  stalls ??= [...require("../../skills/thieving/Stalls.Thieving")._test.STALLS.keys()];
  return stalls;
}

let courses = null;
function agilityCourses() {
  courses ??= require("../../skills/agility/courses/Courses.Agility").COURSES;
  return courses;
}

let idsByName = null;
// Cache options per id: many objects share a resource's name without being one
// (149 of 216 "Tree"s are scenery with no Chop down option).
const optionsById = new Map();

/**
 * The hand-written id lists in the skill plugins can go stale when the cache
 * revision changes (rock ids now point at stumps). Resolve ids by cache object
 * name instead, which is what the plugins' interaction hooks match on.
 */
function buildNameIndex() {
  idsByName = new Map();
  const wanted = new Set();
  for (const load of Object.values(CATALOGS)) {
    for (const entry of load()) {
      for (const name of entry.objectNames) {
        if (name) {
          wanted.add(name);
        }
      }
    }
  }
  try {
    const count = CacheDefinitions.getCounts?.().objects ?? 0;
    for (let id = 0; id < count; id++) {
      const cached = CacheDefinitions.getObject(id);
      const name = cached?.name;
      if (!name || !wanted.has(name)) {
        continue;
      }
      optionsById.set(id, (cached.actions ?? []).filter(Boolean).map((action) => String(action).toLowerCase()));
      const list = idsByName.get(name) ?? [];
      list.push(id);
      idsByName.set(name, list);
    }
  } catch (_) {
    // Fall back to the plugin's own id lists when definitions are unavailable.
  }
}

function normalize(value) {
  return String(value ?? "").toLowerCase();
}

function matchEntry(kind, tier) {
  // A tier list ("copper", "tin") gathers from every listed kind.
  if (Array.isArray(tier)) {
    return tier.flatMap((entry) => matchEntry(kind, entry));
  }
  const load = CATALOGS[kind];
  if (!load) {
    throw new Error(`[bot activities] unknown object catalog '${kind}'`);
  }
  const entries = load().filter(
    (entry) => entry.ids.length > 0 || entry.objectNames.length > 0
  );
  if (!tier) {
    return entries;
  }
  const wanted = normalize(tier);
  const match = entries.find((entry) => {
    const name = normalize(entry.name);
    return (
      name === wanted ||
      name === `${wanted} tree` ||
      name === `${wanted} rocks` ||
      name.startsWith(`${wanted} `)
    );
  });
  return match ? [match] : [];
}

function resolveEntryIds(entry) {
  if (!idsByName) {
    buildNameIndex();
  }
  const resolved = [];
  for (const name of entry.objectNames) {
    resolved.push(...(idsByName.get(name) ?? []));
  }
  return resolved.length > 0 ? resolved : entry.ids;
}

function resolveCatalogObjectIds(spec = {}) {
  if (Array.isArray(spec.objectIds) && spec.objectIds.length > 0) {
    return spec.objectIds.map(Number).filter(Number.isFinite);
  }
  const kind = spec.catalog ?? (spec.treeTier ? "tree" : null);
  if (!kind) {
    return [];
  }
  const entries = matchEntry(kind, spec.tier ?? spec.treeTier ?? null);
  const ids = new Set();
  for (const entry of entries) {
    for (const id of resolveEntryIds(entry)) {
      ids.add(id);
    }
  }
  // Only objects that offer the action's option ("Chop down", "Mine"); ids whose
  // options are unknown (plugin fallback lists without a cache) are kept.
  const option = spec.option ? String(spec.option).toLowerCase() : null;
  return [...ids].filter((id) => !option || !optionsById.has(id) || optionsById.get(id).includes(option));
}

/** Every catalog id, for boot-time index tracking before the dump is built. */
function listCatalogObjectIds() {
  const ids = new Set();
  for (const kind of Object.keys(CATALOGS)) {
    for (const entry of matchEntry(kind, null)) {
      for (const id of resolveEntryIds(entry)) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

module.exports = {
  resolveCatalogObjectIds,
  listCatalogObjectIds,
};
