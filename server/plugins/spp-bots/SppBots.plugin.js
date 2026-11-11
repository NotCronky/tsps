"use strict";

/**
 * spp-bots: bots that live like players (docs/playerbots.md). Each has a saved account generated
 * by simulating what a player of its kind would have done (Accounts, Simulator, Gear), picks its
 * own activities (Brain, Activities) and logs in and out in sessions (Population).
 *
 * Settings: world.json/world.local.json pluginConfig "SppBots:population" (defaults below).
 * Upstream's PlayerBots is separate; turn it off with "plugins": { "PlayerBots": false }.
 */

const { SppBotRoster } = require("./Roster.SppBots");
const { Population, PROGRESS_EVENTS } = require("./Population.SppBots");
const { createCommands } = require("./Commands.SppBots");
const { createBotMode } = require("./BotMode.SppBots");
const { initPlayerBotStateCoreAccess } = require("./Imports.SppBots");
const { Scouting } = require("./Scout.SppBots");
const { Tour } = require("./Tour.SppBots");
const { tickPlanner } = require("./Travel.SppBots");

const CONFIG_KEY = "SppBots:population";
const DEFAULTS = Object.freeze({
  /** Bots online at the evening peak. 200 took ~40 ms of a 600 ms tick in testing (docs/playerbots.md, Measured). */
  online: 200,
  /** Share of `online` at the quietest hour (12 h from the peak); 1 keeps the count flat. */
  quietShare: 0.5,
  /** The busiest hour, server time. */
  peakHour: 20,
  /** Accounts in the roster; bots take turns being online. */
  rosterSize: 400,
  /** How long a bot plays before logging out, in minutes. */
  sessionMinutes: [30, 150],
  /** Most time all bots together may take of one game tick. */
  budgetMs: 20,
  /** A bot logs in at most every this many ticks. */
  loginEveryTicks: 2,
});
const VERBOSE = process.env.SPP_BOTS_LOG === "1";
const ALWAYS_LOGGED = new Set(["spp_bots_generated", "spp_bots_tick_failed", "spp_bots_quest_failed", "spp_bots_ironman_unavailable", "spp_bots_scout_failed", "spp_bots_scout_found", "spp_bots_slow_plan", "spp_bots_scout_lost", "spp_bots_transport_failed", "spp_bots_transport_missing", "spp_bots_no_route", "spp_bots_walk_stuck", "spp_bots_travel_fetch", "spp_bots_teleport", "spp_bots_travel_kit", "spp_bots_network", "spp_bots_bank_failed", "spp_bots_house", "spp_bots_house_failed", "spp_bots_teleport_refused", "spp_bots_bank_bad_stand", "spp_bots_site_trip", "spp_bots_attacked", "spp_bots_fled", "spp_bots_died", "spp_bots_rearmed", "spp_bots_session_end", "spp_bots_task", "spp_bots_botmode", "spp_bots_botmode_failed", "spp_bots_training", "spp_bots_host", "spp_bots_altar", "spp_bots_unlock", "spp_bots_gauntlet", "spp_bots_task_check", "spp_bots_dodge", "spp_bots_switch", "spp_bots_zulrah"]);

let population = null;
let scouting = null;
let tour = null;
let botMode = null;
let pluginApi = null;

function log(message, extra = {}) {
  if (!VERBOSE && !ALWAYS_LOGGED.has(message)) return;
  const line = `[spp-bots] ${message} ${JSON.stringify(extra)}`;
  if (message.endsWith("failed")) console.error(line);
  else console.info(line);
}

function readConfig(api) {
  const config = { ...DEFAULTS, ...(api.getPluginConfig(CONFIG_KEY, {}) ?? {}) };
  config.online = Math.max(0, Math.floor(Number(config.online) || 0));
  config.rosterSize = Math.max(config.online, Math.floor(Number(config.rosterSize) || 0));
  config.loginEveryTicks = Math.max(1, Math.floor(Number(config.loginEveryTicks) || 1));
  return config;
}

function createPopulation(api) {
  pluginApi = api;
  initPlayerBotStateCoreAccess(api);
  population = new Population({ api, roster: new SppBotRoster(), config: readConfig(api), log });
  scouting = new Scouting({ api, log });
  tour = new Tour({ population, log });
  return population;
}

function startup() {
  population.start();
  pluginApi.getTaskManager().submit(createTickTask(pluginApi));
}

function createTickTask(api) {
  return new (class extends api.core.Task {
    constructor() {
      super(1, "spp-bots", false);
    }

    execute() {
      population.tick();
      scouting.tick();
      tour.tick();
      tickPlanner(api.core);
      botMode?.tick();
    }
  })();
}

function shutdown() {
  population?.rememberLocations();
  population?.roster.save(true);
}

function logout({ player }) {
  population?.onLogout(player);
  botMode?.onLogout(player);
}

/** A bot died: once it's back up it puts its kept gear on again (Defence.SppBots.js). */
function death({ player }) {
  botMode?.onDeath(player);
  const entry = population?.online.get(String(player?.getUsername?.() ?? "").toLowerCase());
  if (entry) {
    entry.died = true;
    population.log("spp_bots_died", { name: entry.bot.name, at: { x: player.getLocation().getX(), y: player.getLocation().getY(), z: player.getLocation().getZ() } });
  }
}

function progress({ player }) {
  population?.noteProgress(player);
}

function listenForProgress(api) {
  for (const event of PROGRESS_EVENTS) api.onCustomEvent(event, progress);
}

module.exports = {
  name: "SppBots",
  register(api) {
    createPopulation(api);
    // Tiles about to be hit (ground-targeted projectiles), for dodging in fights.
    require("./Hazards.SppBots").attach(api.core);
    api.onServerStartup(startup);
    api.onServerShutdown(shutdown);
    api.onPlayerLogout(logout);
    api.onPlayerDeath(death);
    listenForProgress(api);
    botMode = createBotMode(population);
    population.botMode = botMode;
    // Prayer training finds the hosting bot through this (HousePrayer.SppBots.js).
    require("./HousePrayer.SppBots").setHostLookup(() => require("./HousePrayer.SppBots").onlineHost(population)?.bot.name ?? null);
    // Bot mode for real players: their own character does a task (docs/playerbots.md, Bot mode).
    api.registerCommand("botmode", (event) => botMode.command(event), api.core.PlayerRights.NONE, "Bot mode: your character does a task for you (::botmode, ::botmode off)");
    api.registerCommand("sppbots", createCommands(population, scouting, tour), api.core.PlayerRights.OWNER, "spp-bots: list, set online count, add a bot, go to one");
  },
};
