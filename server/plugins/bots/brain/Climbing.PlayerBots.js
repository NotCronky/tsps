"use strict";

const { RegionManager } = require("../../../src/main/typescript/elvarg/game/collision/RegionManager");
const { MapObjects } = require("../../../src/main/typescript/elvarg/game/entity/impl/object/MapObjects");
const { ObjectDefinition } = require("../../../src/main/typescript/elvarg/game/definition/ObjectDefinition");
const { PathFinder } = require("../../../src/main/typescript/elvarg/game/model/movement/path/PathFinder");
const { planRoute } = require("../behaviours/navigation/LongRoutePlanner.PlayerBots");
const ClimbLinks = require("../../objects/ClimbLinks");

/**
 * Walks to another floor: a movement request whose `z` differs from the bot's plane
 * goes by the stairs/ladder that leads there, found in the map like the climb
 * handlers find the other end (ClimbLinks, cache backed, no coordinate lists).
 * The walk is pointed at the stairs (`request.climbVia`); once they are in reach
 * the bot clicks the climb option and the walk carries on from the new floor.
 *
 * Underground (6400 tiles north, plane 0: dungeons, cellars, sewers) counts as the layer below
 * the ground floor: a walk there goes by the ladder or trapdoor down nearest the goal's spot on
 * the surface (a closed trapdoor opened first), and back up the same way.
 */

// Stairs are looked for this far around the destination and around the bot.
const SEARCH_RADIUS = 24;
const CLIMB_COOLDOWN_MS = 3000;
const CACHE_TTL_MS = 10 * 60 * 1000;
// Past this many cached answers, expired ones are swept.
const MAX_CACHED = 2000;
// Floors a chain of stairs may span (ground to top floor).
const MAX_HOPS = 3;
// Within this, a path (doors allowed) must exist; further is the long-route planner's job.
const LOCAL_TILES = 60;
// Underground lies this far north of the surface above it (ClimbLinks' UNDERGROUND_OFFSET).
const UNDERGROUND_OFFSET = 6400;
// A dungeon's entrance can be well off the spot above where the walk is going.
const UNDERGROUND_SEARCH_RADIUS = 64;
const OPEN_OPTIONS = ["open"];
// A way into (or out of) the underground leads where it's going only if it lands this near: the
// rest of the walk can't be checked from the map that far, and dungeons are local.
const CROSSING_LANDING_TILES = 160;
/** The layer a tile is on: underground -1, else its plane. */
const layerOf = (tile) => (tile.y >= UNDERGROUND_OFFSET && tile.z === 0 ? -1 : tile.z);
/** `goal` moved onto `here`'s side of the surface: its spot above (or below) it. */
function projected(goal, here) {
  const dy = layerOf(goal) === -1 && layerOf(here) !== -1 ? -UNDERGROUND_OFFSET
    : layerOf(here) === -1 && layerOf(goal) !== -1 ? UNDERGROUND_OFFSET : 0;
  return { x: goal.x, y: goal.y + dy, z: here.z };
}
const UP_OPTIONS = ["climb-up", "climb up", "walk-up", "ascend", "top-floor"];
const DOWN_OPTIONS = ["climb-down", "climb down", "walk-down", "descend", "bottom-floor"];

// "bot area>goal area" -> { object, at }: stairs are map data, the same for every bot there.
const stairsByGoal = new Map();

const chebyshev = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

/** The 1-based option that climbs `direction`, preferring an explicit Climb-up/down over "Climb". */
function climbOption(objectId, direction) {
  const options = (ObjectDefinition.forId(objectId)?.getInteractions?.() ?? []).map((option) => String(option ?? "").toLowerCase());
  const wanted = direction === ClimbLinks.UP ? UP_OPTIONS : DOWN_OPTIONS;
  const exact = options.findIndex((option) => wanted.includes(option));
  const index = exact >= 0 ? exact : options.indexOf("climb");
  return index >= 0 ? index + 1 : 0;
}

let isClosedDoor = null;
/** Door-aware: can a player on `from` get next to `to` on that plane (closed doors count as open)? */
function pathExists(from, to) {
  // Far away, only the ground floor is one connected world; an upper floor is one building,
  // so Varrock's stairs are never the way down from Lumbridge castle's middle floor.
  if (chebyshev(from.x, from.y, to.x, to.y) > LOCAL_TILES) return from.z === 0;
  isClosedDoor ??= require("./DoorOpening.PlayerBots").isClosedDoor;
  const isDoor = (x, y, z) => (MapObjects.mapObjects.get(MapObjects.getHash(x, y, z)) ?? []).some((object) => {
    const loc = object.getLocation();
    return loc.getX() === x && loc.getY() === y && isClosedDoor(object, null);
  });
  return planRoute({
    from, to: { x: to.x, y: to.y }, exactOnly: true,
    getFlag: (x, y, z) => RegionManager.getClipping(x, y, z, null), isDoor,
  }) !== null;
}

/** A closed trapdoor (its Open option), which climbs down once opened. */
function opens(objectId) {
  const options = (ObjectDefinition.forId(objectId)?.getInteractions?.() ?? []).map((option) => String(option ?? "").toLowerCase());
  return /trapdoor/i.test(ObjectDefinition.forId(objectId)?.getName?.() ?? "") && options.some((option) => OPEN_OPTIONS.includes(option));
}

/** Where climbing it lands (a closed trapdoor: where it will, once opened, from the ladder below). */
function landingOf(object, direction, from) {
  if (!opens(object.getId())) return ClimbLinks.destination(object, direction, from, null);
  const end = ClimbLinks.otherEnd(object, direction);
  if (!end) return null;
  const shift = end.getLocation().getY() - object.getLocation().getY();
  return ClimbLinks.landingTile(end, { x: from.getX(), y: from.getY() + (Math.abs(shift) >= UNDERGROUND_OFFSET / 2 ? shift : 0) }, null);
}

/** Stairs on plane `z` within `radius` of `centre` that climb `direction` (or a trapdoor to open, going down). */
function stairsAround(centre, z, direction, into, radius = SEARCH_RADIUS) {
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (const object of MapObjects.mapObjects.get(MapObjects.getHash(centre.x + dx, centre.y + dy, z)) ?? []) {
        const loc = object.getLocation();
        if (loc.getX() !== centre.x + dx || loc.getY() !== centre.y + dy) continue;
        if ((ClimbLinks.climbs(object.getId(), direction) && climbOption(object.getId(), direction) > 0)
          || (direction === ClimbLinks.DOWN && opens(object.getId()))) into.add(object);
      }
    }
  }
}

/**
 * Stairs on `here`'s plane that climb toward `goal`, nearest the way there, that the
 * bot can get to and whose landing really leads on: to the goal, or (a floor short)
 * to more stairs that do. A tower ladder up to a separate top room is passed over.
 */
function findStairs(here, goal, direction, nowMs, hops = MAX_HOPS) {
  const key = `${here.x >> 3},${here.y >> 3},${here.z}>${goal.x >> 3},${goal.y >> 3},${goal.z}`;
  if (stairsByGoal.size > MAX_CACHED) {
    for (const [stale, entry] of stairsByGoal) if (nowMs - entry.at >= CACHE_TTL_MS) stairsByGoal.delete(stale);
  }
  const cached = stairsByGoal.get(key);
  if (cached && nowMs - cached.at < CACHE_TTL_MS) return cached.object;
  const crossing = (layerOf(goal) === -1) !== (layerOf(here) === -1);
  const above = projected(goal, here);
  RegionManager.loadMapFiles(goal.x, goal.y);
  RegionManager.loadMapFiles(above.x, above.y);
  RegionManager.loadMapFiles(here.x, here.y);
  // Near the destination (going up to a bank) and near the bot (going down to a far mine);
  // into or out of the underground, around the goal's spot on this side, further out.
  const found = new Set();
  const radius = crossing ? UNDERGROUND_SEARCH_RADIUS : SEARCH_RADIUS;
  stairsAround(above, here.z, direction, found, radius);
  stairsAround(here, here.z, direction, found, radius);
  const score = (object) => {
    const loc = object.getLocation();
    return chebyshev(here.x, here.y, loc.getX(), loc.getY()) + chebyshev(loc.getX(), loc.getY(), above.x, above.y);
  };
  let best = null;
  for (const object of [...found].sort((a, b) => score(a) - score(b))) {
    const loc = object.getLocation();
    if (!pathExists(here, { x: loc.getX(), y: loc.getY() })) continue;
    const landing = landingOf(object, direction, loc);
    if (!landing) continue;
    const at = { x: landing.getX(), y: landing.getY(), z: landing.getZ() };
    if (layerOf(at) !== layerOf(here) + direction) continue;
    if (crossing && layerOf(goal) === -1 && layerOf(at) === -1 && chebyshev(at.x, at.y, goal.x, goal.y) > CROSSING_LANDING_TILES) continue;
    const leadsOn = layerOf(at) === layerOf(goal)
      ? pathExists(at, goal)
      : hops > 1 && findStairs(at, goal, direction, nowMs, hops - 1) !== null;
    if (leadsOn) {
      best = object;
      break;
    }
  }
  stairsByGoal.set(key, { object: best, at: nowMs });
  return best;
}

function inReach(player, object) {
  const def = ObjectDefinition.forId(object.getId());
  const loc = object.getLocation();
  return PathFinder.reachedObject(player, loc.getX(), loc.getY(), def.getSizeX(), def.getSizeY(),
    object.getFace(), object.getType(), def.getBlockingMask()) === true;
}

/**
 * For a request on another floor: points the walk at the stairs (`request.climbVia`),
 * and climbs them once in reach. True when it clicked (the dispatch waits this tick).
 */
function maybeClimb({ player, state, world, request }) {
  const loc = player?.getLocation?.();
  const here = loc ? { x: loc.getX(), y: loc.getY(), z: loc.getZ() } : null;
  const goal = request ? { x: request.x, y: request.y, z: Number.isFinite(request.z) ? request.z : here?.z } : null;
  if (!loc || !request || !Number.isFinite(goal.z) || layerOf(goal) === layerOf(here) || player.getPrivateArea?.()) {
    if (request) request.climbVia = undefined;
    return false;
  }
  const nowMs = Date.now();
  const direction = layerOf(goal) > layerOf(here) ? ClimbLinks.UP : ClimbLinks.DOWN;
  const stairs = findStairs(here, goal, direction, nowMs);
  if (!stairs) {
    request.climbVia = undefined;
    return false;
  }
  const at = stairs.getLocation();
  // Walk to a tile the stairs can be used from (their open side), not just near them.
  const stand = ClimbLinks.landingTile(stairs, here, null) ?? at;
  if (request.climbVia?.x !== stand.getX() || request.climbVia?.y !== stand.getY() || request.climbVia?.z !== here.z) {
    request.climbVia = { x: stand.getX(), y: stand.getY(), z: here.z };
  }
  if (!inReach(player, stairs) || nowMs < (state?.climbAt ?? 0)) return false;
  if (state) state.climbAt = nowMs + CLIMB_COOLDOWN_MS;
  // A closed trapdoor: opened (it turns into one that climbs down), then found again.
  const opening = climbOption(stairs.getId(), direction) <= 0 && opens(stairs.getId());
  if (opening) stairsByGoal.clear();
  const options = (ObjectDefinition.forId(stairs.getId())?.getInteractions?.() ?? []).map((option) => String(option ?? "").toLowerCase());
  world.emitObjectInteraction?.({
    player,
    object: stairs,
    objectId: stairs.getId(),
    clickType: opening ? options.findIndex((option) => OPEN_OPTIONS.includes(option)) + 1 : climbOption(stairs.getId(), direction),
    location: { x: at.getX(), y: at.getY(), z: at.getZ() },
    sourceLocation: { ...here },
    handled: false,
  });
  request.climbVia = undefined;
  return true;
}

module.exports = { maybeClimb, findStairs, climbOption };
