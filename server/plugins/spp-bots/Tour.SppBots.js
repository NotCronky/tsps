"use strict";

/**
 * ::sppbots tour (docs/playerbots.md, "Travel everywhere"): sends online bots to random NPC spawns
 * the last reach run says are reachable and come back, then back to where they started, with
 * their own accounts (a bot without the quest for a shortcut walks around or has no route).
 * Every trip is written to data/saves/spp-bots/tour-report.json, with a summary of how many
 * arrived, which transports failed and how slow the planner was.
 */

const fs = require("fs");
const path = require("path");
const { createTravelActivity, bankStandTiles } = require("./Travel.SppBots");
const { lastReach, near, NPC_SPAWNS_FILE } = require("./Reach.SppBots");
const { SAVE_DIRECTORY, ensureSaveDirectory } = require("./Roster.SppBots");

const REPORT_FILE = path.join(SAVE_DIRECTORY, "tour-report.json");
/** A touring bot keeps playing at least this long, so a session's end doesn't cut a trip short. */
const SESSION_HOLD_MS = 90 * 60000;

const tileOf = (location) => ({ x: location.getX(), y: location.getY(), z: location.getZ() });

class Tour {
  constructor({ population, log }) {
    this.population = population;
    this.log = log;
    this.trips = []; // finished legs
    this.active = new Map(); // lower-case name -> { name, home, goal, npc, leg, startedAt }
    this.queued = []; // legs to start next tick: starting one from inside a brain update breaks its frames
    this.spawns = null;
    this.tell = () => {};
  }

  /** NPC spawns (or with `banks`, bank stands) the last reach run can get to and back from. */
  destinations(banks = false) {
    const reach = lastReach();
    if (!reach) return null;
    if (!this.spawns) this.spawns = JSON.parse(fs.readFileSync(NPC_SPAWNS_FILE, "utf8"));
    const places = banks
      ? bankStandTiles(this.population.api.core).map(({ x, y, z }) => ({ x, y, level: z, name: "bank" }))
      : this.spawns;
    return places.filter((spawn) => {
      const z = spawn.level ?? 0;
      return near(reach.forward, spawn.x, spawn.y, z) && near(reach.backward, spawn.x, spawn.y, z);
    });
  }

  /** Starts `count` more bots touring; false (with a message) when it can't. */
  start(count, tell, { banks = false } = {}) {
    this.tell = tell;
    const destinations = this.destinations(banks);
    if (!destinations) {
      tell("run ::sppbots reach first: tours go to spawns it found reachable.");
      return false;
    }
    const idle = [...this.population.online.values()]
      .filter((entry) => entry.brain && !this.active.has(entry.bot.name.toLowerCase()));
    const picked = idle.sort(() => Math.random() - 0.5).slice(0, count);
    for (const entry of picked) {
      const spawn = destinations[Math.floor(Math.random() * destinations.length)];
      const goal = { x: spawn.x, y: spawn.y, z: spawn.level ?? 0 };
      entry.sessionEndsAt = Math.max(entry.sessionEndsAt, Date.now() + SESSION_HOLD_MS);
      this.queued.push({ name: entry.bot.name, home: tileOf(entry.player.getLocation()), goal, npc: spawn.name, leg: "out" });
    }
    tell(`touring ${picked.length} bots (${destinations.length} reachable ${banks ? "bank stands" : "spawns"} to pick from).`);
    return true;
  }

  stop() {
    for (const trip of this.active.values()) this.population.online.get(trip.name.toLowerCase())?.brain?.reset?.();
    this.active.clear();
    this.queued = [];
    this.save();
  }

  tick() {
    const queued = this.queued;
    this.queued = [];
    for (const trip of queued) this.begin(trip);
  }

  begin(trip) {
    const entry = this.population.online.get(trip.name.toLowerCase());
    if (!entry?.brain) {
      this.finish({ ...trip, startedAt: Date.now() }, "logged out", null);
      return;
    }
    const target = trip.leg === "out" ? trip.goal : trip.home;
    const running = { ...trip, from: tileOf(entry.player.getLocation()), startedAt: Date.now() };
    this.active.set(trip.name.toLowerCase(), running);
    const activity = createTravelActivity({
      api: this.population.api,
      goal: target,
      log: this.log,
      onDone: (result, report) => this.finish(running, result, report),
    });
    entry.brain.replaceRoot(activity, Date.now());
    entry.trip = activity;
    entry.brain.current = { id: `tour ${trip.leg} to ${target.x},${target.y},${target.z}`, since: Date.now() };
  }

  finish(trip, result, report) {
    const key = trip.name.toLowerCase();
    if (this.active.get(key) === trip) this.active.delete(key);
    const entry = this.population.online.get(key);
    const outcome = result === "success" ? "arrived"
      : !entry ? "logged out"
        : report?.noRoute ? `no route (${report.noRoute})`
          : result;
    const at = entry ? tileOf(entry.player.getLocation()) : null;
    this.trips.push({
      name: trip.name, leg: trip.leg, npc: trip.npc, from: trip.from ?? null, to: trip.leg === "out" ? trip.goal : trip.home,
      at, outcome, seconds: Math.round((Date.now() - trip.startedAt) / 1000),
      replans: report?.replans ?? 0, failedTransports: report?.failed ?? [], slowestPlanMs: Math.round(report?.slowestPlanMs ?? 0),
      profile: entry ? { stage: entry.bot.profile.stage, archetype: entry.bot.profile.archetype } : null,
    });
    // Going home is a second leg, whether or not the bot got there.
    if (trip.leg === "out" && entry) this.queued.push({ ...trip, leg: "back" });
    this.save();
    if (this.active.size === 0 && this.queued.length === 0) this.tell(`tour done: ${this.summary().line}`);
  }

  summary() {
    const legs = { out: { arrived: 0, total: 0 }, back: { arrived: 0, total: 0 } };
    const outcomes = {};
    const failedTransports = {};
    let slowPlans = 0;
    let slowestPlanMs = 0;
    for (const trip of this.trips) {
      legs[trip.leg].total += 1;
      if (trip.outcome === "arrived") legs[trip.leg].arrived += 1;
      outcomes[trip.outcome] = (outcomes[trip.outcome] ?? 0) + 1;
      for (const key of trip.failedTransports) failedTransports[key] = (failedTransports[key] ?? 0) + 1;
      if (trip.slowestPlanMs > 50) slowPlans += 1;
      slowestPlanMs = Math.max(slowestPlanMs, trip.slowestPlanMs);
    }
    const line = `out ${legs.out.arrived}/${legs.out.total} arrived, back ${legs.back.arrived}/${legs.back.total}; `
      + `${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(", ")}; `
      + `${slowPlans} legs planned over 50 ms (slowest ${slowestPlanMs} ms).`;
    return { legs, outcomes, failedTransports, slowPlans, slowestPlanMs, line };
  }

  status() {
    return `tour: ${this.active.size} travelling, ${this.queued.length} queued; ${this.summary().line}`;
  }

  save() {
    ensureSaveDirectory();
    const { line, ...summary } = this.summary();
    const temp = `${REPORT_FILE}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ summary, active: [...this.active.values()], trips: this.trips }, null, 1));
    fs.renameSync(temp, REPORT_FILE);
  }
}

module.exports = { Tour, REPORT_FILE };
