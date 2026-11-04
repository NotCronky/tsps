"use strict";

const crypto = require("crypto");
const { attachBrain } = require("../brain/AttachBrain.PlayerBots");
const { chooseName } = require("../lib/Names.PlayerBots");
const { TaskAgent } = require("../agent/Agent.PlayerBots");
const { BotRoster } = require("./Roster.PlayerBots");
const { rollProfile, setUpNewAccount } = require("./Stages.PlayerBots");

/**
 * The bot population: accounts that play like people. Each is a normal saved account with a
 * realistic name, a stage it started at (early, mid or late game, Stages.PlayerBots.js) and a
 * profile (what it likes doing). It logs in and out on its own timers, so who is online changes
 * through the day, and while online a task agent (agent/Agent.PlayerBots.js) picks its work
 * from its levels, items and coins. World config "PlayerBots:population" turns it on.
 */
const CONFIG_KEY = "PlayerBots:population";
/** Marks a population bot while it's online (not saved): it plays by player rules, not a scripted bot's. */
const POPULATION_ATTRIBUTE = "player-bots:population";
const DEFAULTS = Object.freeze({
  enabled: false,
  // Accounts in all; about two thirds are online at once with the default timers.
  count: 110,
  sessionMinutes: [45, 150],
  breakMinutes: [20, 90],
});
const MINUTE_MS = 60000;
const SPAWN_GAP_MS = 1500;
const STARTUP_DELAY_MS = 5000;
const SPREAD_TILES = 6;
/** A bot in a fight keeps fighting: its task change or logout waits this long and tries again. */
const BUSY_RETRY_MS = 30000;
/** Ticks between looks at one bot; they are spread out over this many ticks. */
const CHECK_TICKS = 5;
const ONLINE_SHARE = 2 / 3;
const REPLY_DELAY_MS = [2000, 7000];
const REPLIES = [
  "hey", "sup", "busy with {task} atm", "just doing {task}", "lol", "not much, {task}",
  "hi", "brb", "{task} grind never ends", "yo",
];

function readConfig(raw) {
  const config = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  for (const key of ["sessionMinutes", "breakMinutes"]) {
    const [min, max] = Array.isArray(config[key]) ? config[key] : [];
    if (!(min > 0 && max >= min)) config[key] = DEFAULTS[key];
  }
  config.count = Math.max(0, Math.floor(Number(config.count) || 0));
  return config;
}

const rollBetween = ([min, max], random = Math.random) => min + random() * (max - min);
const inFight = (bot) => !!(bot.getCombat?.()?.getTarget?.() || bot.getCombat?.()?.getAttacker?.());

/** A password no one can log in with: bot accounts are never playable by people. */
function lockedPassword() {
  return `${crypto.randomBytes(16).toString("hex")}:${crypto.randomBytes(32).toString("hex")}`;
}

function registerPopulation({ api, botApi, runtime, registry, world, catalogue, resetMovementState }) {
  const config = readConfig(api.getPluginConfig(CONFIG_KEY));
  if (config.enabled !== true) return null;
  const core = api.core;
  const roster = new BotRoster();
  /** Online bots by lower-case name: { bot, profile, agent, logoutAt, retryAt }. */
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
      const name = chooseName(nameTaken);
      if (!name) break;
      roster.add({ name, ...rollProfile() });
    }
  }

  function startLocation(profile) {
    if (profile.location) return new core.Location(profile.location.x, profile.location.y, profile.location.z ?? 0);
    const towns = catalogue.hangAround.length ? catalogue.hangAround : [...catalogue.places.values()];
    const place = towns[Math.floor(Math.random() * towns.length)];
    const offset = () => Math.floor(Math.random() * (SPREAD_TILES * 2 + 1)) - SPREAD_TILES;
    return new core.Location(place.x + offset(), place.y + offset(), place.z ?? 0);
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
    bot.setAttribute(POPULATION_ATTRIBUTE, true);
    if (isNew) setUpNewAccount(bot, profile);
    const agent = new TaskAgent({ player: bot, catalogue, registry, world, profile: { style: profile.style, focus: profile.focus } });
    const first = agent.next(nowMs);
    const attached = attachBrain({
      runtime, registry, world, bot, resetMovementState,
      activity: first === "wait" ? registry.byId.get("roam") : first,
      home: bot.getLocation(),
      chooseNext: (time) => agent.next(time),
    });
    if (!attached) return false;
    online.set(key, { bot, profile, agent, retryAt: 0, logoutAt: nowMs + rollBetween(config.sessionMinutes) * MINUTE_MS });
    returnAt.delete(profile.name);
    return true;
  }

  function logOut(member) {
    member.bot.getForcedLogoutTimer?.().start?.(0);
    member.bot.requestLogout?.();
  }

  /** A new task when its time is up or it strayed into the Wilderness; logs out when its session ends. */
  function look(member, nowMs) {
    const { bot, agent } = member;
    if (nowMs >= member.logoutAt) {
      if (inFight(bot)) member.logoutAt = nowMs + BUSY_RETRY_MS;
      else logOut(member);
      return;
    }
    const strayed = core.Wilderness.isIn(bot);
    if (!strayed && !agent.due(nowMs)) return;
    if (nowMs < member.retryAt) return;
    if (inFight(bot)) {
      member.retryAt = nowMs + BUSY_RETRY_MS;
      return;
    }
    const brain = runtime.entriesByUsername.get(bot.getUsername())?.brain;
    const next = agent.next(nowMs);
    if (brain && next !== "wait") brain.replaceRoot(next, nowMs);
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

  function memberOf(player) {
    return online.get(String(player?.getUsername?.() ?? "").toLowerCase()) ?? null;
  }

  function onLogout({ player }) {
    const member = memberOf(player);
    if (!member) return;
    roster.setLocation(member.profile.name, player.getLocation());
    online.delete(member.profile.name.toLowerCase());
    returnAt.set(member.profile.name, Date.now() + rollBetween(config.breakMinutes) * MINUTE_MS);
  }

  /** A player messaging a bot gets a short reply, a few seconds later, as from someone busy. */
  function onPrivateMessage({ sender, recipient }) {
    const member = memberOf(recipient);
    if (!member || sender?.isPlayerBot?.() === true) return;
    const task = member.agent.current?.task.name.toLowerCase() ?? "stuff";
    const text = REPLIES[Math.floor(Math.random() * REPLIES.length)].replace("{task}", task);
    const timer = setTimeout(() => {
      if (member.bot.isRegistered?.() && sender.isRegistered?.()) {
        api.emitCustomEvent("friends:send-private-message", { sender: member.bot, recipient: sender, text });
      }
    }, rollBetween(REPLY_DELAY_MS));
    timer.unref?.();
  }

  /** "world:population": online bots count as players on the world list. */
  function countOnline(request) {
    request.count += online.size;
  }

  function onShutdown() {
    for (const member of online.values()) roster.setLocation(member.profile.name, member.bot.getLocation());
    roster.save(true);
  }

  function start() {
    fillRoster();
    const nowMs = Date.now();
    for (const profile of roster.bots) {
      const now = Math.random() < ONLINE_SHARE;
      returnAt.set(profile.name, now ? nowMs : nowMs + rollBetween(config.breakMinutes) * MINUTE_MS);
    }
    botApi.log("population_started", { roster: roster.bots.length });
  }

  /** ::bots [name] - who is online and what they're doing. */
  function listBots({ player, parts }) {
    const wanted = parts?.slice(1).join(" ").toLowerCase();
    player.sendMessage(`Bots: ${online.size} online of ${roster.bots.length}.`);
    const shown = [...online.values()]
      .filter(({ profile }) => !wanted || profile.name.toLowerCase().includes(wanted))
      .slice(0, wanted ? 10 : 15);
    for (const { profile, agent, bot } of shown) {
      player.sendMessage(`${profile.name} (${profile.stage}, ${profile.style}, total ${bot.getSkillManager().getTotalLevel?.() ?? "?"}): ${agent.describe()}`);
    }
  }

  class PopulationTick extends core.Task {
    constructor() {
      super(1, "player-bots-population", false);
    }

    execute() {
      const nowMs = Date.now();
      tick++;
      spawnDue(nowMs);
      let index = 0;
      for (const member of online.values()) {
        if ((index++ + tick) % CHECK_TICKS !== 0) continue;
        try {
          look(member, nowMs);
        } catch (error) {
          botApi.log("population_tick_failed", { bot: member.profile.name, error: String(error?.message ?? error) });
        }
      }
    }
  }

  api.onPlayerLogout(onLogout);
  api.onCustomEvent("world:population", countOnline);
  api.onCustomEvent("friends:private-message", onPrivateMessage);
  api.onServerShutdown(onShutdown);
  api.registerCommand("bots", listBots, core.PlayerRights.OWNER, "List the bot population and what they're doing: ::bots [name]");
  api.onServerStartup(() => {
    core.TaskManager.submit(new PopulationTick());
    setTimeout(start, STARTUP_DELAY_MS);
  });
  return { online, roster };
}

module.exports = { registerPopulation, readConfig, DEFAULTS, lockedPassword, POPULATION_ATTRIBUTE };
