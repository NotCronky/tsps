"use strict";

const { playerState } = require("../ActionState.PlayerBots");
const { approachObject, queueRouteAndFlagAppearance } = require("../../behaviours/navigation/Navigation.PlayerBots");
const { RsmodRouteFinding } = require("../../../../src/main/typescript/elvarg/game/model/movement/path/RsmodRouteFinding");

const routeFinder = new RsmodRouteFinding();
const { ItemOnGroundManager } = require("../../../../src/main/typescript/elvarg/game/entity/impl/grounditem/ItemOnGroundManager");
const { ItemIds } = require("../../../../src/main/typescript/elvarg/util/IdEnums");

// Marks this far off or nearer are walked to.
const MARK_TILES = 20;

/** Whether a walk from where the player stands reaches the tile. */
function walkReaches(player, [x, y, z]) {
  const loc = player.getLocation();
  if (loc.getZ() !== z) return false;
  if (loc.getX() === x && loc.getY() === y) return true;
  const route = routeFinder.findRoute({
    level: z, srcX: loc.getX(), srcY: loc.getY(), srcSize: 1, destX: x, destY: y, destWidth: 1, destLength: 1,
    locAngle: 0, locShape: -1, moveNear: false, blockAccessFlags: 0, maxWaypoints: 25, privateArea: null,
  });
  return route.success === true && route.alternative !== true;
}

/**
 * Runs laps of an agility course as a player does: clicks the lap's next obstacle, waits while
 * it's crossed, and goes on to the next. The Agility plugin says which obstacle is next and how
 * it's clicked ("agility:course-next"), and plays it with its own rolls, failures, XP and lap
 * bonus; walkToObject walks the obstacle's own route. A fall (the next obstacle nowhere near)
 * starts the lap again from the first. Runs until the task's time is up; fails when the course
 * can't be found or obstacles keep refusing (a level, a quest).
 *
 * A course behind an entrance (the Barbarian Outpost's pipe) gives `entry`: the object, a tile
 * either side of it (`outside`, `inside`). Where no walk reaches the inside, it goes to the
 * outside and clicks the entrance (the Agility plugin's own shortcut) before the first obstacle.
 *
 * A lap that leaves a platform by a ladder that isn't one of its obstacles (the Barbarian
 * Outpost's, after the ledge) gives `down`: the ladder, and the obstacle it's taken before.
 *
 * Its marks of grace are picked up as it goes: a mark of its own on the floor that a walk from
 * where it stands reaches (on the roof it's on) is picked up before the next obstacle.
 *
 * JSON: { "type": "runCourse", "course": "draynor",
 *         "entry"?: { "object": id, "outside": [x, y, z], "inside": [x, y, z] },
 *         "down"?: { "objects": [id, ...], "before": index } }
 */
const SEARCH_TILES = 40;
const DIRECT_ROUTE_TILES = 20;
const CLICK_MS = 2400;
// Clicks on one obstacle that start nothing: try the lap from the start, then give up.
const RESTART_AFTER = 4;
const FAIL_AFTER = 10;
// Ticks in a row the first obstacle can be out of sight before the course counts as lost (the
// object search can miss it a tick, and a restart asked for on a roof is taken back).
const LOST_AFTER = 10;

const chebyshev = (a, b) => Math.max(Math.abs(a.getX() - b.getX()), Math.abs(a.getY() - b.getY()));

function createRunCourseAction(spec, world) {
  const { course, entry = null, down = null } = spec;
  const outside = (player) => entry !== null && !walkReaches(player, entry.inside);
  const stateFor = (player) => playerState(action, player, () => ({ restart: false, clickedAt: 0, clicks: 0, index: null, xp: null, markAt: 0, markTries: 0, lost: 0 }));

  function nearest(player, ids, tiles = []) {
    const loc = player.getLocation();
    let best = null;
    let bestDistance = Infinity;
    for (const object of world.objectSearch?.findCandidatesByIds?.(player, ids, {
      regionRadius: 1, z: loc.getZ(), privateArea: player.getPrivateArea?.() ?? null,
    }) ?? []) {
      const at = object?.getLocation?.();
      if (!at || at.getZ() !== loc.getZ()) continue;
      // One of several obstacles sharing an id (the Barbarian Outpost's walls): only its own.
      if (tiles.length && !tiles.some(([x, y, z]) => at.getX() === x && at.getY() === y && at.getZ() === z)) continue;
      const distance = chebyshev(at, loc);
      if (distance <= SEARCH_TILES && distance < bestDistance) {
        best = object;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** A mark it can pick up: its tile walked to, or (a tile walls off, as a spawn on Seers' first roof is) one beside it. */
  function pickable(player, at) {
    const [x, y, z] = [at.getX(), at.getY(), at.getZ()];
    return [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => walkReaches(player, [x + dx, y + dy, z]));
  }

  /** Walks to its nearest reachable mark of grace and picks it up; false when there's none. */
  function pickUpMark(player, bot, nowMs) {
    const loc = player.getLocation();
    const marks = ItemOnGroundManager.ownedBy(player.getUsername())
      .filter((item) => item.getItem().getId() === ItemIds.MARK_OF_GRACE && item.getPrivateArea() === (player.getPrivateArea?.() ?? null))
      .map((item) => ({ item, at: item.getPosition() }))
      .filter(({ at }) => at.getZ() === loc.getZ() && chebyshev(at, loc) <= MARK_TILES && pickable(player, at))
      .sort((a, b) => chebyshev(a.at, loc) - chebyshev(b.at, loc));
    const mark = marks[0];
    if (!mark) return false;
    if (nowMs - bot.markAt < CLICK_MS) return true;
    bot.markAt = nowMs;
    if (++bot.markTries > FAIL_AFTER) return false;
    if (mark.at.getX() === loc.getX() && mark.at.getY() === loc.getY()) ItemOnGroundManager.pickup(player, mark.item);
    else player.getMovementQueue().walkToGroundItem(mark.at, () => ItemOnGroundManager.pickup(player, mark.item));
    return true;
  }

  const action = {
    id: "runCourse",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      const request = { player, course, restart: bot.restart, busy: false, next: null };
      world.emitCustomEvent?.("agility:course-next", request);
      const { next } = request;
      if (!next) return "failed";
      if (request.busy || player.getForceMovement?.() != null || player.getMovementQueue?.()?.size?.() > 0) return "running";
      // A new obstacle, or XP since the last click: the lap is going on.
      const xp = player.getSkillManager().getExperience(world.core.Skill.AGILITY);
      if (next.index !== bot.index || (bot.xp !== null && xp > bot.xp)) {
        bot.index = next.index;
        bot.clicks = 0;
        bot.markTries = 0;
      }
      bot.xp = xp;
      if (pickUpMark(player, bot, nowMs)) return "running";
      const entering = next.index === 1 && outside(player);
      if (entering && !walkReaches(player, entry.outside)) {
        const [x, y, z] = entry.outside;
        // The brain's own walk: its traversal opens the doors and gates on the way.
        queueRouteAndFlagAppearance(player, x, y, { nowMs, z, reason: "brain_agility_entry", basicPather: true });
        return "running";
      }
      const climbing = down !== null && next.index === down.before && player.getLocation().getZ() > 0;
      const object = nearest(player, entering ? [entry.object] : climbing ? down.objects : next.objectIds, entering || climbing ? [] : next.tiles ?? []);
      if (!object) {
        if (next.index === 1) {
          // Up on the course, the lap isn't over: carry on with it rather than start again.
          if (bot.restart && player.getLocation().getZ() > 0) bot.restart = false;
          return ++bot.lost > LOST_AFTER ? "failed" : "running";
        }
        // Fallen off, or the lap was left: start again from the first obstacle.
        bot.restart = true;
        return "running";
      }
      bot.restart = false;
      bot.lost = 0;
      if (chebyshev(object.getLocation(), player.getLocation()) > DIRECT_ROUTE_TILES) {
        approachObject(player, object, { nowMs, reason: "brain_agility_approach" });
        return "running";
      }
      if (nowMs - bot.clickedAt < CLICK_MS) return "running";
      bot.clicks += 1;
      if (bot.clicks > FAIL_AFTER) return "failed";
      if (bot.clicks > RESTART_AFTER && next.index !== 1) bot.restart = true;
      bot.clickedAt = nowMs;
      const clickType = entering || climbing ? 1 : next.clickType(object);
      const at = object.getLocation();
      player.getMovementQueue().walkToObject(object, {
        execute: () => {
          world.emitObjectInteraction?.({
            player, object, objectId: object.getId(), clickType,
            location: { x: at.getX(), y: at.getY(), z: at.getZ() },
            sourceLocation: { x: player.getLocation().getX(), y: player.getLocation().getY(), z: player.getLocation().getZ() },
            handled: false,
          });
        },
      }, clickType);
      return "running";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.restart = false;
      bot.clicks = 0;
      bot.index = null;
      bot.xp = null;
    },
    madeProgress(ctx) {
      return stateFor(ctx.player).clicks <= RESTART_AFTER;
    },
    describe(ctx) {
      return `agility lap (${course}, obstacle ${stateFor(ctx.player).index ?? "?"})`;
    },
  };
  return action;
}

module.exports = { createRunCourseAction };
module.exports.walkReaches = walkReaches;
