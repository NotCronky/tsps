"use strict";

/**
 * Brain-owned door/gate opening. A route the strict pather cannot solve is often
 * a closed gate between the bot and its target; the ditch-crossing pattern
 * applies: walk next to the blocking door, click Open through the normal object
 * interaction hook (Doors.plugin), and let the next dispatch re-route through.
 *
 * A door is only clicked when opening it provably helps: its clipping is
 * temporarily removed, the route to the requested target is recomputed, and the
 * clipping restored. Gates that do not improve the route (a pen the path merely
 * passes, a door on another wall) are left alone.
 *
 * The approach is owned here instead of `walkToObject`: that one-shot task gives
 * up (and races a retry) when the reach tile is briefly occupied, which left bots
 * parked next to a closed gate. This walks to a chosen stand tile and clicks on
 * the first tick it is adjacent.
 */

const { MapObjects } = require("../../../src/main/typescript/elvarg/game/entity/impl/object/MapObjects");
const { ObjectDefinition } = require("../../../src/main/typescript/elvarg/game/definition/ObjectDefinition");

// Same names the Doors plugin opens; a matching object whose definition still
// offers "Open" is a closed door or gate.
const DOOR_NAMES = new Set([
  "Door", "Doors", "Large door", "Castle door", "Cell Door", "Cell door",
  "Glass door", "Magic door", "Metal door", "Mind Door", "Tent door",
  "Gate", "Metal gate", "Doorway",
]);
const SEARCH_RADIUS = 25;
const ATTEMPT_COOLDOWN_MS = 2500;
// A door this bot just opened (self-opening doors keep their id) is not reopened.
const REOPEN_COOLDOWN_MS = 30000;
const MAX_TRACKED_DOORS = 32;
const MAX_APPROACH_ROUTES = 6;
// Each candidate costs one route; the nearest few always include the blocking gate.
const MAX_CANDIDATES = 12;
const FULL_BLOCK = 0x200000;
const CLUSTER_OFFSETS = Object.freeze([
  [0, 1], [0, -1], [1, 0], [-1, 0], [-1, -1], [-1, 1], [1, -1], [1, 1],
]);

function doorKey(object) {
  const loc = object.getLocation();
  return `${object.getId()}:${loc.getX()},${loc.getY()},${loc.getZ()}`;
}

const COINS_ID = 995;
const TOLL_OPTION = /^pay-toll\((\d+)gp\)$/i;

/** The object as this player sees it: multi-locs (Al Kharid's toll gate) resolve per player. */
function definitionFor(object, player) {
  try {
    return (player && ObjectDefinition.forPlayer(object.getId(), player)) ?? object?.getDefinition?.();
  } catch {
    return object?.getDefinition?.();
  }
}

/**
 * The click option (1-based) that gets this player through a closed door/gate,
 * or 0. A toll gate uses its "Pay-toll(10gp)" option (its "Open" starts a guard
 * dialogue bots cannot hold); clickDoor provisions the toll, so bots never need money.
 */
function passOption(object, player) {
  const definition = definitionFor(object, player);
  if (!definition || !DOOR_NAMES.has(definition.name)) {
    return 0;
  }
  const options = definition.getInteractions?.() ?? [];
  const tollIndex = options.findIndex((action) => TOLL_OPTION.test(String(action ?? "")));
  if (tollIndex >= 0) {
    return tollIndex + 1;
  }
  // Some gates (60760/60763 in the Lumbridge cow field) offer "Release" instead.
  const openIndex = options.findIndex((action) => /^(open|release)$/i.test(String(action ?? "")));
  return openIndex + 1;
}

function isClosedDoor(object, player) {
  return passOption(object, player) > 0;
}

/** One gate is two panels; opening a candidate must clear its neighbouring panels. */
function closedDoorCluster(object, player) {
  const loc = object.getLocation();
  const cluster = [object];
  const name = definitionFor(object, player)?.name ?? null;
  for (const [dx, dy] of CLUSTER_OFFSETS) {
    const bucket = MapObjects.mapObjects.get(
      MapObjects.getHash(loc.getX() + dx, loc.getY() + dy, loc.getZ())
    );
    for (const other of bucket ?? []) {
      const otherLoc = other.getLocation?.();
      if (!otherLoc || otherLoc.getX() !== loc.getX() + dx || otherLoc.getY() !== loc.getY() + dy) {
        continue;
      }
      if (definitionFor(other, player)?.name === name && isClosedDoor(other, player)) {
        cluster.push(other);
      }
    }
  }
  return cluster;
}

/**
 * Closed doors near the bot or the segment target, nearest to the bot first. No
 * direction filter: a moveNear walk parks the bot on the fence tile closest to the
 * target, which is usually already past the pen's gate (Lumbridge cow fields).
 * findUnblockingDoor's clipping test decides which door actually helps.
 */
function findDoorCandidates(player, state, targetX, targetY, nowMs) {
  const loc = player.getLocation();
  const z = loc.getZ();
  const baseX = loc.getX();
  const baseY = loc.getY();
  const recent = state.recentDoorKeys ?? {};
  const seen = new Set();
  const candidates = [];

  const collectAround = (centerX, centerY) => {
    for (let x = centerX - SEARCH_RADIUS; x <= centerX + SEARCH_RADIUS; x += 1) {
      for (let y = centerY - SEARCH_RADIUS; y <= centerY + SEARCH_RADIUS; y += 1) {
        const bucket = MapObjects.mapObjects.get(MapObjects.getHash(x, y, z));
        if (!bucket) {
          continue;
        }
        for (const object of bucket) {
          if (!isClosedDoor(object, player)) {
            continue;
          }
          // The bucket hash can collide with another map area; only trust the real tile.
          const objectLoc = object.getLocation?.();
          if (!objectLoc || objectLoc.getX() !== x || objectLoc.getY() !== y || objectLoc.getZ() !== z) {
            continue;
          }
          const key = doorKey(object);
          if (seen.has(key) || Number(recent[key] ?? 0) > nowMs) {
            continue;
          }
          seen.add(key);
          candidates.push({ object, distance: (x - baseX) ** 2 + (y - baseY) ** 2 });
        }
      }
    }
  };
  // Doors near the bot start a blocked path; doors near the target end it (and a
  // long approach can sit beyond SEARCH_RADIUS of the bot).
  collectAround(baseX, baseY);
  collectAround(targetX, targetY);

  candidates.sort((left, right) => left.distance - right.distance);
  return candidates.slice(0, MAX_CANDIDATES).map((candidate) => candidate.object);
}

/** One route finder per core implementation; it only holds scratch buffers. */
let routeFinderClass = null;
let routeFinderInstance = null;
function sharedRouteFinder(core) {
  if (routeFinderClass !== core.RsmodRouteFinding) {
    routeFinderClass = core.RsmodRouteFinding;
    routeFinderInstance = new core.RsmodRouteFinding();
  }
  return routeFinderInstance;
}

/**
 * 0 when the target can really be reached (wall-aware entity reach, so a tile
 * touching it across a fence does not count), else 1 + the Chebyshev distance
 * from where a moveNear route gets to.
 */
function routeDistance(routeFinder, player, targetX, targetY) {
  const from = player.getLocation();
  const base = {
    level: from.getZ(), srcX: from.getX(), srcY: from.getY(),
    srcSize: Math.max(1, Math.floor(player.getSize?.() ?? 1)),
    destX: targetX, destY: targetY, destWidth: 1, destLength: 1,
    locAngle: 0, blockAccessFlags: 0,
    maxWaypoints: 25, privateArea: player.getPrivateArea?.() ?? null,
  };
  if (routeFinder.findRoute({ ...base, locShape: -2, moveNear: false }).success) {
    return 0;
  }
  const route = routeFinder.findRoute({ ...base, locShape: -1, moveNear: true });
  if (!route.success) {
    return Number.MAX_SAFE_INTEGER;
  }
  return 1 + Math.max(Math.abs(route.endX - targetX), Math.abs(route.endY - targetY));
}

/** A walkable tile next to the door from which the bot can click it. */
function pickStandTile(core, routeFinder, player, object) {
  const loc = object.getLocation();
  const from = player.getLocation();
  let best = null;
  let bestSteps = Number.MAX_SAFE_INTEGER;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (const [dx, dy] of CLUSTER_OFFSETS) {
    const x = loc.getX() + dx;
    const y = loc.getY() + dy;
    if (core.RegionManager.getClipping(x, y, loc.getZ(), null) & FULL_BLOCK) {
      continue;
    }
    const route = routeFinder.findRoute({
      level: loc.getZ(), srcX: from.getX(), srcY: from.getY(),
      srcSize: Math.max(1, Math.floor(player.getSize?.() ?? 1)),
      destX: x, destY: y, destWidth: 1, destLength: 1,
      locAngle: 0, locShape: -1, moveNear: false, blockAccessFlags: 0,
      maxWaypoints: 25, privateArea: player.getPrivateArea?.() ?? null,
    });
    if (!route.success) {
      continue;
    }
    // Shorter route wins: the near tile of a door can need the long way around.
    const steps = route.waypoints?.length ?? 0;
    const distance = (x - from.getX()) ** 2 + (y - from.getY()) ** 2;
    if (steps < bestSteps || (steps === bestSteps && distance < bestDistance)) {
      bestSteps = steps;
      bestDistance = distance;
      best = { x, y };
    }
  }
  return best;
}

/** The door whose opening gets the route closest to the target, or null. */
function findUnblockingDoor(core, routeFinder, player, candidates, targetX, targetY) {
  const baseline = routeDistance(routeFinder, player, targetX, targetY);
  if (baseline === 0) {
    return null;
  }
  let best = null;
  let bestDistance = baseline;
  for (const object of candidates) {
    const cluster = closedDoorCluster(object, player);
    for (const door of cluster) {
      core.RegionManager.removeObjectClipping(door);
    }
    let distance;
    try {
      distance = routeDistance(routeFinder, player, targetX, targetY);
    } finally {
      for (const door of cluster) {
        core.RegionManager.addObjectClipping(door);
      }
    }
    if (distance < bestDistance) {
      bestDistance = distance;
      best = object;
    }
  }
  if (!best) {
    return null;
  }
  const stand = pickStandTile(core, routeFinder, player, best);
  return stand ? { object: best, stand } : null;
}

function clickDoor(player, state, world, attempt) {
  const object = attempt.object;
  const objectLoc = object.getLocation();
  attempt.done = true;
  state.doorAttempt = null;
  state.recentDoorKeys[attempt.key] = Date.now() + REOPEN_COOLDOWN_MS;
  if (process.env.BOT_BRAIN_DEBUG === "1") {
    world.log?.("bot_brain_door_open", {
      username: player.getUsername?.(),
      object: attempt.key,
    });
  }
  // The option that passes it (Open/Release, or Pay-toll at a toll gate) and the
  // definition this player sees, so the object's plugin handler matches the click.
  const definition = definitionFor(object, player);
  const clickType = passOption(object, player);
  const toll = TOLL_OPTION.exec(String(definition?.getInteractions?.()?.[clickType - 1] ?? ""));
  if (toll) {
    // Simulated bots are provisioned like their tools and food: top up the toll.
    const inventory = player.getInventory();
    const missing = Number(toll[1]) - inventory.getAmount(COINS_ID);
    if (missing > 0) inventory.adds(COINS_ID, missing);
  }
  world.emitObjectInteraction?.({
    player,
    object,
    definition,
    objectId: object.getId(),
    clickType,
    location: {
      x: objectLoc.getX(),
      y: objectLoc.getY(),
      z: objectLoc.getZ(),
    },
    sourceLocation: {
      x: player.getLocation().getX(),
      y: player.getLocation().getY(),
      z: player.getLocation().getZ(),
    },
    handled: false,
  });
}

/** Walks the in-flight attempt to its stand tile and clicks once adjacent. */
function continueDoorAttempt(core, player, state, world) {
  const attempt = state.doorAttempt;
  const objectLoc = attempt.object.getLocation();
  const loc = player.getLocation();
  const adjacent = Math.max(
    Math.abs(loc.getX() - objectLoc.getX()),
    Math.abs(loc.getY() - objectLoc.getY())
  ) <= 1;
  if (adjacent && isClosedDoor(attempt.object, player)) {
    clickDoor(player, state, world, attempt);
    return true;
  }
  if (!isClosedDoor(attempt.object, player)) {
    // Another bot opened it; the next dispatch can route through.
    state.doorAttempt = null;
    return true;
  }
  if (player.getMovementQueue?.()?.size?.() > 0) {
    return true;
  }
  attempt.routes += 1;
  const steps = core.PathFinder.calculateWalkRoute(player, attempt.stand.x, attempt.stand.y);
  if (!Number.isFinite(steps) || steps <= 0 || attempt.routes >= MAX_APPROACH_ROUTES) {
    state.doorAttempt = null;
  }
  return true;
}

/**
 * Movement hook. While an attempt is in flight it owns the walk and the click.
 * After a failed dispatch (`select`), picks a door that makes the target
 * reachable and starts an approach.
 * @returns {boolean} true when the brain should skip normal dispatch this tick.
 */
function maybeOpenDoor({ player, state, world, request, select = false }) {
  if (!player || !state || !request) {
    return false;
  }
  const core = world?.core;
  if (!core?.RegionManager || !core?.RsmodRouteFinding || !core?.PathFinder) {
    return false;
  }
  if (state.doorAttempt) {
    return continueDoorAttempt(core, player, state, world);
  }
  if (!select) {
    return false;
  }
  const nowMs = Date.now();
  if (nowMs < Number(state.nextDoorAttemptAt ?? 0)) {
    return false;
  }
  // The scan is expensive (two 51x51 tile sweeps, a route finder and a route per
  // candidate); pay it at most once per cooldown, found or not.
  state.nextDoorAttemptAt = nowMs + ATTEMPT_COOLDOWN_MS;
  const recent = state.recentDoorKeys ?? (state.recentDoorKeys = {});
  if (Object.keys(recent).length > MAX_TRACKED_DOORS) {
    for (const [key, until] of Object.entries(recent)) {
      if (Number(until) <= nowMs) {
        delete recent[key];
      }
    }
  }
  // The final destination can sit beyond the route finder's window; the current
  // segment is the yardstick for whether a door makes real progress. A segment at
  // (or on) the bot says nothing about progress - the dispatch failed before it
  // could leave its own tile (an exhausted plan, a pen the raw router cannot see
  // out of) - so the real destination is the yardstick instead, or the gate that
  // traps the bot is never tested.
  let targetX = Number.isFinite(request.lastSegmentX) ? request.lastSegmentX : request.x;
  let targetY = Number.isFinite(request.lastSegmentY) ? request.lastSegmentY : request.y;
  const botLoc = player.getLocation();
  if (
    Number.isFinite(targetX) && Number.isFinite(targetY) &&
    Math.max(Math.abs(botLoc.getX() - targetX), Math.abs(botLoc.getY() - targetY)) <= 1 &&
    Number.isFinite(request.x) && Number.isFinite(request.y)
  ) {
    targetX = request.x;
    targetY = request.y;
  }
  // On a planned long route, the route's next stop is the yardstick (a gate on the way to a
  // goal past the route finder's window, Taverley's on the road to Burthorpe, opens nothing
  // the goal itself could show); a door waypoint, the stop after it.
  const route = request.route;
  if (route?.waypoints?.length) {
    const next = route.waypoints[route.index] ?? null;
    const after = next?.door ? route.waypoints[route.index + 1] ?? next : next;
    if (after && Math.max(Math.abs(botLoc.getX() - after.x), Math.abs(botLoc.getY() - after.y)) > 1) {
      targetX = after.x;
      targetY = after.y;
    }
  }
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
    return false;
  }
  const candidates = findDoorCandidates(player, state, targetX, targetY, nowMs);
  if (!candidates.length) {
    return false;
  }
  const routeFinder = sharedRouteFinder(core);
  const picked = findUnblockingDoor(core, routeFinder, player, candidates, targetX, targetY);
  if (!picked) {
    return false;
  }
  state.doorAttempt = {
    object: picked.object,
    key: doorKey(picked.object),
    stand: picked.stand,
    routes: 0,
  };
  return continueDoorAttempt(core, player, state, world);
}

module.exports = {
  isClosedDoor,
  maybeOpenDoor,
  sharedRouteFinder,
  routeDistance,
};
