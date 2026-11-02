"use strict";

/**
 * Residents: bots with a life of their own and no language model. Each has a saved account, so
 * its levels and items last; a realistic name; a skill it cares about. It picks a goal (a kind of
 * work and a town, Goals.PlayerBots.js), walks there, works for a while and moves on, and logs in
 * and out on its own timers, so who is online changes through the day. World config
 * "PlayerBots:residents" turns them on. A resident that strays into the Wilderness goes back to town.
 */
const fs = require("fs");
const path = require("path");
const { attachBrain } = require("../brain/AttachBrain.PlayerBots");
const { applyLevels, applyOutfit, outfitTier } = require("../brain/SiteSpawner.PlayerBots");
const { createTravelActivity } = require("../ai/Activities.PlayerBots");
const { readAiBotConfig } = require("../ai/Config.PlayerBots");
const { chooseName } = require("../ai/Names.PlayerBots");
const { rollPersona } = require("../ai/Persona.PlayerBots");
const { buildCatalog, lockedPassword } = require("../ai/RegisterAiBots.PlayerBots");
const { AiBotRoster } = require("../ai/Roster.PlayerBots");
const { pickGoal, rollBetween, rollProfile, rollStart } = require("./Goals.PlayerBots");

const CONFIG_KEY = "PlayerBots:residents";
const DEFAULTS = Object.freeze({
  enabled: false,
  // Residents in all; about two thirds are online at once with the default timers.
  count: 110,
  sessionMinutes: [45, 150],
  breakMinutes: [20, 90],
  goalMinutes: [20, 45],
});
const ROSTER_FILE = path.join(process.cwd(), "data", "saves", "resident-bots.json");
const GOALS_FILE = path.join(__dirname, "..", "data", "resident-goals.json");
const PLACES_FILE = path.join(__dirname, "..", "data", "ai-places.json");
const ACTIVITIES_FILE = path.join(process.cwd(), "data", "definitions", "bot-activities.json");
const MINUTE_MS = 60000;
const SPAWN_GAP_MS = 1500;
const STARTUP_DELAY_MS = 5000;
const SPREAD_TILES = 6;
const NEAR_TILES = 8;
/** Give up on a walk after this long: the goal is rerolled from wherever the bot got to. */
const MAX_TRAVEL_MINUTES = 15;
/** A bot in a fight keeps fighting: its goal change or logout waits this long and tries again. */
const BUSY_RETRY_MS = 30000;
/** How many ticks between looks at one resident; they are spread out over this many ticks. */
const CHECK_TICKS = 5;

function readConfig(raw) {
  const config = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  for (const key of ["sessionMinutes", "breakMinutes", "goalMinutes"]) {
    const [min, max] = Array.isArray(config[key]) ? config[key] : [];
    if (!(min > 0 && max >= min)) config[key] = DEFAULTS[key];
  }
  config.count = Math.max(0, Math.floor(Number(config.count) || 0));
  return config;
}

const inFight = (bot) => !!(bot.getCombat?.()?.getTarget?.() || bot.getCombat?.()?.getAttacker?.());

function distance(location, place) {
  return Math.max(Math.abs(location.getX() - place.x), Math.abs(location.getY() - place.y));
}

function registerResidents({ api, botApi, runtime, registry, world, resetMovementState }) {
  const config = readConfig(api.getPluginConfig(CONFIG_KEY));
  if (config.enabled !== true) return null;
  const core = api.core;
  const goals = JSON.parse(fs.readFileSync(GOALS_FILE, "utf8"));
  const places = new Map(JSON.parse(fs.readFileSync(PLACES_FILE, "utf8")).places.map((place) => [place.id, place]));
  const tiers = JSON.parse(fs.readFileSync(ACTIVITIES_FILE, "utf8")).tiers ?? {};
  const catalog = buildCatalog(registry);
  const hangAround = registry.byId.get("roam") ?? null;
  const pacing = readAiBotConfig(undefined).pacing;
  const roster = new AiBotRoster(ROSTER_FILE);
  /** Online residents by lower-case name: { bot, profile, goal, lastMode, plan, changeAt, logoutAt, doing }. */
  const online = new Map();
  /** Profile name -> when it next logs in, for those offline. */
  const returnAt = new Map();
  let nextSpawnAt = 0;
  let tick = 0;

  function nameTaken(name) {
    return roster.has(name) || core.GameConstants.PLAYER_PERSISTENCE?.exists?.(name) === true || !!core.World.getPlayerByName(name);
  }

  function fillRoster() {
    while (roster.bots.length < config.count) {
      const name = chooseName("realistic", roster.bots.length, nameTaken);
      if (!name) break;
      roster.add({ name, persona: rollPersona(), ...rollProfile(goals) });
    }
  }

  function startLocation(profile) {
    if (profile.location) return new core.Location(profile.location.x, profile.location.y, profile.location.z ?? 0);
    const place = places.get(profile.home) ?? places.get("lumbridge");
    const offset = () => Math.floor(Math.random() * (SPREAD_TILES * 2 + 1)) - SPREAD_TILES;
    return new core.Location(place.x + offset(), place.y + offset(), place.z ?? 0);
  }

  /** First login only: levels and clothes for its tier. After that its save is what it earned. */
  function outfitNew(bot, profile) {
    const tier = tiers[profile.tier] ?? tiers.novices;
    if (!tier) return;
    const levels = { all: tier.skills, combat: tier.combat };
    applyLevels(bot, levels);
    applyOutfit(bot, outfitTier(levels));
  }

  function setHome(resident, place) {
    const state = runtime.entriesByUsername.get(resident.bot.getUsername())?.state;
    if (state) state.home = { x: place.x, y: place.y, z: place.z ?? 0 };
  }

  /** What this resident could work on right now. */
  function openEntries(bot) {
    return catalog.filter(({ id, activity }) => registry.hasRoom(id)
      && activity.requires.every((condition) => condition.check({ player: bot })));
  }

  function startGoal(resident, nowMs) {
    const { bot, profile } = resident;
    const brain = runtime.entriesByUsername.get(bot.getUsername())?.brain;
    const goal = pickGoal({ data: goals, focus: profile.focus, entries: openEntries(bot), hangAround, lastMode: resident.lastMode });
    const place = goal && places.get(goal.place);
    if (!brain || !place) {
      resident.changeAt = nowMs + BUSY_RETRY_MS;
      return;
    }
    resident.lastMode = goal.mode;
    brain.paused = false;
    if (distance(bot.getLocation(), place) <= NEAR_TILES) {
      setHome(resident, place);
      settle(resident, goal, nowMs);
      brain.replaceRoot(goal.activity, nowMs);
      return;
    }
    resident.plan = { goal, place };
    resident.changeAt = nowMs + MAX_TRAVEL_MINUTES * MINUTE_MS;
    resident.doing = `walking to ${place.name}`;
    brain.replaceRoot(createTravelActivity(place), nowMs);
  }

  function settle(resident, goal, nowMs) {
    resident.changeAt = nowMs + rollBetween(config.goalMinutes, Math.random) * MINUTE_MS;
    resident.doing = `${goal.mode.replace(/_/g, " ")} near ${places.get(goal.place)?.name ?? goal.place}`;
  }

  /** BotBrain.chooseNext: arrived, so start the planned work; otherwise look for a new goal. */
  function chooseNext(resident, nowMs) {
    const plan = resident.plan;
    if (plan) {
      resident.plan = null;
      setHome(resident, plan.place);
      settle(resident, plan.goal, nowMs);
      return plan.goal.activity;
    }
    resident.changeAt = 0;
    return "wait";
  }

  function logIn(profile, nowMs) {
    const key = profile.name.toLowerCase();
    if (online.has(key)) return true;
    if (core.World.getPlayerByName(profile.name)) return false;
    const isNew = core.GameConstants.PLAYER_PERSISTENCE?.exists?.(profile.name) !== true;
    const bot = runtime.spawnPvpBot(startLocation(profile), { username: profile.name, persistent: true, mode: "roaming" });
    if (!bot) return false;
    bot.setPasswordHashWithSalt(lockedPassword());
    bot.setRights(core.PlayerRights.NONE);
    bot.setAutoRetaliate(true);
    if (isNew) outfitNew(bot, profile);
    const resident = {
      bot, profile, plan: null, lastMode: null, changeAt: 0, doing: "logging in",
      logoutAt: nowMs + rollBetween(config.sessionMinutes, Math.random) * MINUTE_MS,
    };
    const attached = hangAround && attachBrain({
      runtime, registry, world, bot, activity: hangAround, home: bot.getLocation(), resetMovementState, pacing,
      chooseNext: (time) => chooseNext(resident, time),
    });
    if (!attached) return false;
    online.set(key, resident);
    returnAt.delete(profile.name);
    return true;
  }

  function logOut(resident) {
    resident.bot.getForcedLogoutTimer?.().start?.(0);
    resident.bot.requestLogout?.();
  }

  function look(resident, nowMs) {
    const { bot } = resident;
    if (core.Wilderness.isIn(bot)) {
      resident.plan = null;
      resident.lastMode = null;
      resident.changeAt = 0;
    }
    if (nowMs >= resident.logoutAt) {
      if (inFight(bot)) resident.logoutAt = nowMs + BUSY_RETRY_MS;
      else logOut(resident);
      return;
    }
    if (nowMs < resident.changeAt) return;
    if (inFight(bot)) resident.changeAt = nowMs + BUSY_RETRY_MS;
    else startGoal(resident, nowMs);
  }

  function spawnDue(nowMs) {
    if (nowMs < nextSpawnAt) return;
    for (const [name, at] of returnAt) {
      if (at > nowMs) continue;
      const profile = roster.get(name);
      if (profile && !logIn(profile, nowMs)) returnAt.set(name, nowMs + BUSY_RETRY_MS);
      nextSpawnAt = nowMs + SPAWN_GAP_MS;
      return;
    }
  }

  function onLogout({ player }) {
    const key = String(player?.getUsername?.() ?? "").toLowerCase();
    const resident = online.get(key);
    if (!resident) return;
    roster.setLocation(resident.profile.name, player.getLocation());
    online.delete(key);
    returnAt.set(resident.profile.name, Date.now() + rollBetween(config.breakMinutes, Math.random) * MINUTE_MS);
  }

  function onDeath({ player }) {
    const resident = online.get(String(player?.getUsername?.() ?? "").toLowerCase());
    if (!resident) return;
    resident.plan = null;
    resident.changeAt = 0;
  }

  function onShutdown() {
    for (const resident of online.values()) roster.setLocation(resident.profile.name, resident.bot.getLocation());
    roster.save(true);
  }

  function start() {
    fillRoster();
    const nowMs = Date.now();
    for (const profile of roster.bots) {
      const { online: isOnline, minutes } = rollStart(config);
      returnAt.set(profile.name, isOnline ? nowMs : nowMs + minutes * MINUTE_MS);
    }
    botApi.log("residents_started", { roster: roster.bots.length });
  }

  function listResidents({ player, parts }) {
    const wanted = parts?.slice(1).join(" ").toLowerCase();
    player.sendMessage(`Residents: ${online.size} online of ${roster.bots.length}.`);
    const shown = [...online.values()]
      .filter(({ profile }) => !wanted || profile.name.toLowerCase().includes(wanted))
      .slice(0, wanted ? 10 : 15);
    for (const { profile, doing, bot } of shown) {
      const skill = core.Skill[profile.focus.toUpperCase()];
      const level = skill ? `${bot.getSkillManager().getMaxLevel(skill)} ${profile.focus}` : `combat ${bot.getSkillManager().getCombatLevel()}`;
      player.sendMessage(`${profile.name} (${level}): ${doing}`);
    }
  }

  class ResidentTick extends core.Task {
    constructor() {
      super(1, "residents", false);
    }

    execute() {
      const nowMs = Date.now();
      tick++;
      spawnDue(nowMs);
      let index = 0;
      for (const resident of online.values()) {
        if ((index++ + tick) % CHECK_TICKS !== 0) continue;
        try {
          look(resident, nowMs);
        } catch (error) {
          botApi.log("resident_tick_failed", { bot: resident.profile.name, error: String(error?.message ?? error) });
        }
      }
    }
  }

  api.onPlayerLogout(onLogout);
  api.onPlayerDeath(onDeath);
  api.onServerShutdown(onShutdown);
  api.registerCommand("residents", listResidents, core.PlayerRights.OWNER, "List the resident bots and what they're doing: ::residents [name]");
  api.onServerStartup(() => {
    core.TaskManager.submit(new ResidentTick());
    setTimeout(start, STARTUP_DELAY_MS);
  });
  return { online, roster };
}

module.exports = { registerResidents, readConfig, DEFAULTS };
