"use strict";

const { createTravelToAction } = require("../brain/actions/TravelTo.PlayerBots");
const { chooseTask } = require("./Brain.PlayerBots");
const { level } = require("../tasks/Common.PlayerBots");

/**
 * Drives any character - a bot, or a player in bot mode - through tasks. It feeds the executor
 * (brain/Brain.PlayerBots.js, which runs one action a tick) through its `chooseNext` hook: when
 * the executor is idle it asks the agent, and the agent answers with the next task's activity.
 *
 * A task is either the player's pick (bot mode) or the brain's (agent/Brain.PlayerBots.js).
 * A character far from every place the task is done travels to one first (teleporting when it
 * can, brain/actions/TravelTo.PlayerBots.js). A task marked `once` (Tutorial Island) hands a
 * picked bot mode over to the brain when it's done. A brain-chosen task runs
 * for its `minutes`, then `due()` says it's time for another. A task that ends again within a
 * minute of starting (no tool, out of supplies) rests for a while; a picked one that keeps doing
 * that is reported through `onStuck` instead.
 */
const MINUTE_MS = 60000;
const NEAR_TILES = 50;
const QUICK_FAIL_MS = MINUTE_MS;
const REST_MS = 5 * MINUTE_MS;
const STUCK_FAILS = 3;
const RECENT = 3;
// A character with nothing it can do wanders where it is, and asks again this often.
const IDLE_RETRY_MS = 30000;

function travelActivity(place, world) {
  return {
    id: "travel",
    resolver: false,
    resolves: null,
    mode: "roaming",
    capacity: 100000,
    repeat: false,
    ephemeral: false,
    manual: true,
    failureCooldownMs: 0,
    requires: [],
    setup: [],
    actions: [createTravelToAction({ x: place.x, y: place.y, z: place.z ?? 0, radius: 4 }, world)],
    produces: [],
    site: null,
  };
}

const distance = (location, place) => Math.max(Math.abs(location.getX() - place.x), Math.abs(location.getY() - place.y));

class TaskAgent {
  constructor({ player, catalogue, registry, world, profile = {}, taskId = null, random = Math.random, onStuck = null }) {
    this.player = player;
    this.catalogue = catalogue;
    this.ctx = { registry, world };
    this.profile = profile;
    this.taskId = taskId;
    this.random = random;
    this.onStuck = onStuck;
    this.current = null;
    this.pending = null;
    this.recent = [];
    this.restingUntil = new Map();
    this.quickFails = 0;
    this.idleUntil = 0;
  }

  /** What the character is doing, for ::botmode and ::bots. */
  describe() {
    if (this.pending) return `travelling to ${this.pending.place.name} for ${this.pending.task.name}`;
    return this.current ? this.current.task.name : "looking for something to do";
  }

  /** Brain-chosen tasks run their time; a picked one runs until the player stops it. */
  due(nowMs) {
    return this.taskId === null && this.current !== null && this.pending === null && nowMs >= this.current.endsAt;
  }

  /** The executor's chooseNext: the next activity, or "wait" to stay idle and ask again. */
  next(nowMs = Date.now()) {
    if (this.pending) {
      const { task } = this.pending;
      this.pending = null;
      return this.start(task, nowMs);
    }
    this.noteEnded(nowMs);
    if (nowMs < this.idleUntil) return "wait";
    const task = this.pick(nowMs);
    if (!task) {
      this.idleUntil = nowMs + IDLE_RETRY_MS;
      return this.ctx.registry.byId.get("roam") ?? "wait";
    }
    const place = this.placeFor(task);
    if (place) {
      this.pending = { task, place };
      return travelActivity(place, this.ctx.world);
    }
    return this.start(task, nowMs);
  }

  pick(nowMs) {
    if (this.taskId !== null) {
      const task = this.catalogue.get(this.taskId);
      const check = task ? task.check(this.player, this.ctx) : { ok: false, reason: "no such task" };
      if (!check.ok) {
        this.stuck(check.reason);
        return null;
      }
      return task;
    }
    const tasks = this.catalogue.tasks.filter((task) => (this.restingUntil.get(task.id) ?? 0) <= nowMs);
    return chooseTask({
      player: this.player,
      tasks,
      ctx: this.ctx,
      profile: this.profile,
      recent: this.recent,
      levelOf: (skill) => level(this.player, skill),
    }, this.random);
  }

  /** Nearest of the task's places, when the character isn't already near one. */
  placeFor(task) {
    const here = this.player.getLocation();
    const places = task.places ?? [];
    if (places.length === 0 || places.some((place) => distance(here, place) <= NEAR_TILES)) return null;
    return places.reduce((best, place) => (distance(here, place) < distance(here, best) ? place : best));
  }

  start(task, nowMs) {
    const activity = task.build(this.player, this.ctx);
    if (!activity) {
      this.rest(task, nowMs);
      return "wait";
    }
    const [min, max] = task.minutes ?? [20, 40];
    this.current = { task, startedAt: nowMs, endsAt: nowMs + (min + this.random() * (max - min)) * MINUTE_MS };
    this.recent = [task.id, ...this.recent.filter((id) => id !== task.id)].slice(0, RECENT);
    return activity;
  }

  /** The executor asked again, so the current task ended: one that ended at once rests. */
  noteEnded(nowMs) {
    const ended = this.current;
    this.current = null;
    if (!ended) return;
    // A one-off (Tutorial Island) that's done: a bot mode picked for it carries on with the brain.
    if (ended.task.once && this.taskId === ended.task.id && !ended.task.check(this.player, this.ctx).ok) {
      this.taskId = null;
      return;
    }
    if (nowMs - ended.startedAt >= QUICK_FAIL_MS) {
      this.quickFails = 0;
      return;
    }
    this.rest(ended.task, nowMs);
    if (this.taskId !== null && ++this.quickFails >= STUCK_FAILS) {
      this.stuck(`couldn't keep going with ${ended.task.name}`);
    }
  }

  rest(task, nowMs) {
    this.restingUntil.set(task.id, nowMs + REST_MS);
  }

  stuck(reason) {
    this.quickFails = 0;
    this.onStuck?.(reason);
  }
}

module.exports = { TaskAgent, travelActivity, NEAR_TILES };
