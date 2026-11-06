"use strict";

const { createTravelToAction } = require("../brain/actions/TravelTo.PlayerBots");
const { level, no, ok } = require("./Common.PlayerBots");

/**
 * The Gauntlet, a boss task: the character travels to the Gauntlet Portal in Prifddinas (unless
 * it's there or in the lobby already) and plays runs through the Gauntlet plugin's own bot play
 * (which empties its pack and gear into the lobby's deposit box first: nothing goes in) ("gauntlet:play": prepare in the maze, make its gear at the singing bowl, fight
 * the Crystalline Hunllef with auto-prayer), taking its rewards from the chest between runs.
 *
 * Song of the Elves opens Prifddinas. The levels are what the Wiki suggests for a first kill:
 * ranged and magic for the bow and staff, defence and hitpoints to last, prayer for protection.
 */
const PORTAL = { x: 3227, y: 6114, z: 0 };
// The lobby under Prifddinas, and how near the portal counts as there.
const LOBBY = { minX: 3016, maxX: 3047, minY: 6112, maxY: 6143, z: 1 };
const NEAR_PORTAL = 12;

function there(player) {
  const at = player.getLocation();
  const inLobby = at.getZ() === LOBBY.z && at.getX() >= LOBBY.minX && at.getX() <= LOBBY.maxX && at.getY() >= LOBBY.minY && at.getY() <= LOBBY.maxY;
  const byPortal = at.getZ() === PORTAL.z && Math.max(Math.abs(at.getX() - PORTAL.x), Math.abs(at.getY() - PORTAL.y)) <= NEAR_PORTAL;
  return inLobby || byPortal;
}
// Agility 50: the crystal armour asks for it.
const LEVELS = { ranged: 70, magic: 70, defence: 70, hitpoints: 70, prayer: 43, agility: 50 };
// The Corrupted Gauntlet: harder hits (and a shorter prep), so higher levels; prayer for the
// offensive prayers (Eagle Eye, Mystic Might) that auto-prayer keeps up at the Hunllef.
const CORRUPTED_LEVELS = { ranged: 80, magic: 80, defence: 75, hitpoints: 80, prayer: 70, agility: 50 };
const QUEST = { key: "song_of_the_elves", name: "Song of the Elves" };

function questDone(world, player) {
  const request = { player, key: QUEST.key, complete: null, started: null };
  world?.emitCustomEvent?.("quest:is-complete", request);
  return request.complete === true;
}

/** Whether the character has completed a Gauntlet (the Corrupted one is open). */
function completedOne(world, player) {
  const request = { player, completed: false };
  world?.emitCustomEvent?.("gauntlet:completed", request);
  return request.completed === true;
}

/** Plays runs through the Gauntlet plugin until the task's time is up. */
function play(world, corrupted) {
  const controllers = new WeakMap();
  return {
    id: corrupted ? "corrupted_gauntlet" : "gauntlet",
    update({ player }) {
      let controller = controllers.get(player);
      if (!controller) {
        const request = { player, corrupted, controller: null };
        world.emitCustomEvent?.("gauntlet:play", request);
        if (!request.controller) return "failed";
        controller = request.controller;
        controllers.set(player, controller);
      }
      if (controller.tick()) return "running";
      controllers.delete(player);
      return "success";
    },
    stop({ player }) {
      controllers.get(player)?.stop?.();
      controllers.delete(player);
    },
    madeProgress: () => true,
    describe({ player }) {
      return controllers.get(player)?.describe?.() ?? (corrupted ? "the Corrupted Gauntlet" : "the Gauntlet");
    },
  };
}

/**
 * The Gauntlet task, or with `corrupted` the Corrupted Gauntlet's: the same play in its harder
 * mode, open once the character has completed a Gauntlet.
 */
function gauntletTask({ corrupted = false } = {}) {
  const levels = corrupted ? CORRUPTED_LEVELS : LEVELS;
  return {
    id: corrupted ? "corrupted_gauntlet" : "gauntlet",
    name: corrupted ? "Bosses: The Corrupted Gauntlet" : "Bosses: The Gauntlet",
    shortName: corrupted ? "The Corrupted Gauntlet" : "The Gauntlet",
    group: "Combat",
    subgroup: "Bosses",
    skill: "combat",
    level: corrupted ? 80 : 70,
    // Every run is its own instance: no crowd to speak of.
    crowd: Infinity,
    // It travels as part of the task, once its bank trip is done.
    places: [],
    minutes: [40, 80],
    // Mid-run it isn't swapped for another task: the maze has no way out but the run's end.
    busy(player, { world } = {}) {
      const request = { player, inRun: false };
      world?.emitCustomEvent?.("gauntlet:in-run", request);
      return request.inRun === true;
    },
    check(player, ctx = {}) {
      for (const [skill, needed] of Object.entries(levels)) {
        if (level(player, skill) < needed) return no(`needs ${needed} ${skill.charAt(0).toUpperCase()}${skill.slice(1)}`);
      }
      // A quest no plugin answers for counts as not done: Prifddinas stays shut.
      if (!questDone(ctx.world, player)) return no(`needs ${QUEST.name}`);
      if (corrupted && !completedOne(ctx.world, player)) return no("needs a Gauntlet completed");
      return ok();
    },
    build(player, { registry, world }) {
      const activity = registry.compile({ id: corrupted ? "task_corrupted_gauntlet" : "task_gauntlet", mode: "combat", capacity: 100000, repeat: false, actions: [] });
      if (!there(player)) activity.actions.push(createTravelToAction({ ...PORTAL, radius: 8 }, world));
      activity.actions.push(play(world, corrupted));
      return activity;
    },
  };
}

module.exports = { gauntletTask };
