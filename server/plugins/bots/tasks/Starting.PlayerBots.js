"use strict";

const { no, ok } = require("./Common.PlayerBots");

/**
 * Tutorial Island: a brand-new account has to leave it before anything else. For now the task
 * takes the Gielinor Guide's skip (the Tutorial Island plugin, through "tutorial:skip"), which
 * gives the starter kit and lands in Lumbridge; playing the island through comes later.
 */
function finishTutorial(world) {
  return {
    id: "finishTutorial",
    update({ player }) {
      const request = { player, skipped: false };
      world.emitCustomEvent?.("tutorial:skip", request);
      return request.skipped ? "success" : "failed";
    },
  };
}

/**
 * The skip opens the welcome and quest-complete boxes a tick or two later; the character closes
 * them, as a player does, so they don't hold up what it does next.
 */
function closeWelcome() {
  let ticks = 0;
  return {
    id: "closeWelcome",
    update({ player }) {
      if (++ticks < 3) return "running";
      ticks = 0;
      player.getPacketSender?.()?.sendInterfaceRemoval?.();
      return "success";
    },
    madeProgress: () => true,
  };
}

function startingTasks() {
  return [{
    id: "tutorial",
    name: "Tutorial Island",
    group: "Quests",
    skill: null,
    places: [],
    minutes: [1, 1],
    first: true,
    once: true,
    check(player, { world }) {
      const status = { player, active: false, canSkip: false };
      world?.emitCustomEvent?.("tutorial:status", status);
      if (!status.active) return no("already done");
      if (!status.canSkip) return no("this world doesn't allow skipping it yet");
      return ok();
    },
    build(player, { registry, world }) {
      const activity = registry.compile({ id: "task_tutorial", mode: "roaming", capacity: 100000, repeat: false, actions: [] });
      return { ...activity, actions: [finishTutorial(world), closeWelcome()] };
    },
  }];
}

module.exports = { startingTasks };
