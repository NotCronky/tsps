"use strict";

/**
 * Who is online and what they're doing each tick (docs/playerbots.md, Phase 3).
 *
 * - Logins: bots log in one at a time up to the target online count; a bot's first login
 *   generates its account (Accounts.SppBots.js).
 * - Sessions: each bot plays for a while, then logs out the way a player does (refused in combat)
 *   and another takes its place.
 * - Ticks: bots near a real player think every tick; others less often. All bots together get at
 *   most `budgetMs` of each tick; the rest wait for the next one, oldest first.
 */

const crypto = require("crypto");
const { createBotPlayer, resetMovementState, realisticName, PROGRESS_EVENTS, HOUSE, GRANT_UNLOCKS, UNLOCKS, isMembersWorld } = require("./Imports.SppBots");
const { newProfile, generateAccount, grantTravelKit, TRAVEL_KIT_VERSION } = require("./Accounts.SppBots");
// The first kit with combat sets (gear.json `kit` 4).
const COMBAT_KIT_FROM = 4;
const { createBrain, createBrainWorld, createRegistry } = require("./Brain.SppBots");
const { defend } = require("./Defence.SppBots");
const { dailyTarget, favouriteHour, hourWeight } = require("./Schedule.SppBots");
const { createHostActivity, RIMMINGTON } = require("./HousePrayer.SppBots");

/** Players log in and out at a bank or a town, not in the middle of nowhere. */
const LOGIN_SPOTS = Object.freeze([
  { name: "Lumbridge", x: 3222, y: 3218, z: 0 },
  { name: "Varrock west bank", x: 3185, y: 3436, z: 0 },
  { name: "Varrock east bank", x: 3253, y: 3420, z: 0 },
  { name: "Falador west bank", x: 2946, y: 3368, z: 0 },
  { name: "Draynor bank", x: 3093, y: 3243, z: 0 },
  { name: "Edgeville bank", x: 3094, y: 3491, z: 0 },
  { name: "Al Kharid bank", x: 3269, y: 3167, z: 0 },
]);
const NEAR_TILES = 32;
/** Construction a bot needs for a house of its own (a portal nexus). */
const HOUSE_LEVEL = 72;
// The prayer host's own house layout (HOUSE.hostHouse); a new version rebuilds it once.
const HOST_HOUSE_VERSION = 1;
// A members bot this strong has been offered as Zulrah's sacrifice (if Regicide lets it).
const ZULRAH_COMBAT = 85;
/** Instances (houses) are built from here east; nobody logs in there. */
const INSTANCE_SPACE_X = 6400;
const FAR_STRIDE = 4;
const LOGOUT_RETRY_MS = 30000;
// So far over the target (the budget was cut) that bots log out at once, not after banking.
const OVER_TARGET_NOW = 1.25;
// A session's end: this long at most to bank before logging out wherever the bot is.
const WIND_DOWN_MS = 5 * 60 * 1000;
/** About a minute of game ticks. */
const LOCATION_SAVE_TICKS = 100;

function totalXp(player) {
  return player.getSkillManager().getTotalExp();
}

function randomBetween([min, max]) {
  return min + Math.random() * (max - min);
}

// A player who ran out of energy turns run back on somewhere in this range (percent).
const RUN_AGAIN_AT = [25, 70];

/**
 * Run back on once there's energy again, as a player clicks the orb (RunAutoEnable does it for
 * players, on onPlayerProcess, which bots don't get). Each bot has its own threshold per rest.
 */
function resumeRunning(entry) {
  const player = entry.player;
  if (player.isRunningReturn?.() !== false) return;
  entry.runAgainAt ??= RUN_AGAIN_AT[0] + Math.random() * (RUN_AGAIN_AT[1] - RUN_AGAIN_AT[0]);
  if (player.getRunEnergy() < entry.runAgainAt) return;
  player.setRunning(true);
  entry.runAgainAt = null;
}

/** A password nobody can log in with: bot accounts are never played by people. */
function lockedPassword() {
  return `${crypto.randomBytes(16).toString("hex")}:${crypto.randomBytes(32).toString("hex")}`;
}

class Population {
  constructor({ api, roster, config, log }) {
    this.api = api;
    this.roster = roster;
    this.config = config;
    this.log = log;
    this.online = new Map(); // lower-case name -> entry
    this.world = null;
    this.registry = createRegistry();
    this.tickCount = 0;
    this.cursor = 0;
    this.lastTickMs = 0;
    this.extraLogins = 0;
  }

  /** Builds the brain world once the regions it indexes have loaded. */
  start() {
    this.world = createBrainWorld(this.api, this.log);
  }

  nameTaken(name) {
    const { GameConstants, World } = this.api.core;
    return this.roster.has(name) || GameConstants.PLAYER_PERSISTENCE?.exists?.(name) === true || !!World.getPlayerByName(name);
  }

  /** Adds a bot to the roster: a free name and a rolled profile. Its account is made at first login. */
  recruit(overrides = {}) {
    let name = null;
    for (let attempt = 0; attempt < 200 && !name; attempt++) {
      const candidate = realisticName();
      if (!this.nameTaken(candidate)) name = candidate;
    }
    if (!name) return null;
    const seed = crypto.randomBytes(4).readUInt32BE(0);
    return this.roster.add({ name, profile: newProfile(seed, overrides) });
  }

  /** The next roster bot that isn't online, filling the roster up to its size first. */
  /**
   * Bots online now: `online` at the evening peak, down to `quietShare` of it in the small hours
   * (a cosine over the day, server time), plus the ones added by hand.
   */
  target(nowMs) {
    return dailyTarget(this.config, this.extraLogins, nowMs);
  }

  /** Who logs in next: any offline bot, more often one whose favourite hour is near (`playHour`). */
  nextOffline(nowMs = Date.now()) {
    const offline = this.roster.bots.filter((bot) => !this.online.has(bot.name.toLowerCase()) && !this.api.core.World.getPlayerByName(bot.name));
    // A prayer host first: it's what guests travel to.
    const host = offline.find((bot) => bot.role === "prayerHost");
    if (host) return host;
    if (offline.length > 0) {
      const hour = new Date(nowMs).getHours();
      const weights = offline.map((bot) => {
        if (bot.playHour === undefined) bot.playHour = favouriteHour();
        return hourWeight(bot.playHour, hour);
      });
      let roll = Math.random() * weights.reduce((sum, weight) => sum + weight, 0);
      for (let index = 0; index < offline.length; index++) {
        roll -= weights[index];
        if (roll <= 0) return offline[index];
      }
      return offline[offline.length - 1];
    }
    if (this.roster.bots.length < this.config.rosterSize) return this.recruit();
    return null;
  }

  logIn(bot) {
    const { Location, PlayerRights } = this.api.core;
    // A spot in instance space (a house left by a crash) isn't somewhere to log in.
    const saved = bot.location && bot.location.x < INSTANCE_SPACE_X ? bot.location : null;
    const at = saved ?? LOGIN_SPOTS[Math.floor(Math.random() * LOGIN_SPOTS.length)];
    const player = createBotPlayer(bot.name, new Location(at.x, at.y, at.z ?? 0), {
      api: this.api,
      loadPersistence: true,
      saveRandomizedAppearance: true,
    });
    if (!player) return false;
    player.setPlayerBot(true);
    // Core's visible bot shortcuts (endless run energy, boosted hitpoints that never drop) don't
    // apply: docs/playerbots.md, Phase 1 step 2.
    player.setPlaysAsPlayer?.(true);
    player.setPasswordHashWithSalt(lockedPassword());
    player.setRights(PlayerRights.NONE);
    player.setAutoRetaliate(true);
    const nowMs = Date.now();
    this.online.set(bot.name.toLowerCase(), {
      bot,
      player,
      startXp: null,
      brain: null,
      lastThinkAt: 0,
      sessionEndsAt: nowMs + randomBetween(this.config.sessionMinutes) * 60000,
      logoutAt: 0,
    });
    this.log("spp_bots_login", { name: bot.name, at: at.name ?? `${at.x},${at.y}` });
    return true;
  }

  /** First tick a bot is in the world: its account (first login only), then its brain. */
  settle(entry) {
    const { player, bot } = entry;
    if (!bot.generated) {
      const summary = generateAccount(this.api, player, bot.profile, this.log);
      this.roster.update(bot.name, { generated: { ...summary, at: new Date().toISOString() } });
      this.api.core.GameConstants.PLAYER_PERSISTENCE?.save?.(player);
      this.log("spp_bots_generated", { name: bot.name, ...bot.profile, ...summary });
    }
    // Versions: true was the first kit. A new account gets the whole kit in generateAccount.
    let kitVersion = bot.travelKit === true ? 1 : Number(bot.travelKit ?? (bot.generated?.travelKit === true ? 1 : bot.generated?.travelKit) ?? 0) || 0;
    // Kits 4-6 (combat sets, supplies, specials) were granted without a save of the bot, so a
    // restart before it logged out lost them while the roster kept the version: once, again from
    // 3, without what the bot already owns.
    const regrant = !bot.kitSaved && kitVersion > COMBAT_KIT_FROM - 1;
    if (regrant) kitVersion = COMBAT_KIT_FROM - 1;
    if (kitVersion < TRAVEL_KIT_VERSION) {
      const kit = grantTravelKit(this.api, player, bot.profile, kitVersion, { skipOwned: regrant });
      // Saved now, not at logout: a restart must not lose what the roster says it has.
      this.api.core.GameConstants.PLAYER_PERSISTENCE?.save?.(player);
      this.roster.update(bot.name, { travelKit: TRAVEL_KIT_VERSION, kitSaved: true });
      if (kit.length) this.log("spp_bots_travel_kit", { name: bot.name, kit, regrant });
    } else if (!bot.kitSaved) {
      this.roster.update(bot.name, { kitSaved: true });
    }
    // Unlocks an account of this standing would have picked up on the way (Zulrah's boat for a
    // members fighter past Port Tyras): as the content's own dialogue leaves them.
    if (isMembersWorld() && player.getSkillManager().getCombatLevel() >= ZULRAH_COMBAT) {
      try {
        if (GRANT_UNLOCKS.zulrah(player)) {
          // Saved at once, as kits are: Rob Ok got it again after a restart.
          this.api.core.GameConstants.PLAYER_PERSISTENCE?.save?.(player);
          this.log("spp_bots_unlock", { name: bot.name, unlock: "zulrah" });
        }
        else if (!UNLOCKS.zulrah(player)) {
          const request = { player, key: "regicide", stage: 0 };
          this.api.emitCustomEvent?.("quest:get-stage", request);
          this.log("spp_bots_unlock", { name: bot.name, unlock: "zulrah", granted: false, regicideStage: request.stage });
        }
      } catch (error) {
        this.log("spp_bots_unlock", { name: bot.name, unlock: "zulrah", error: String(error?.message ?? error) });
      }
    }
    if (!bot.house && this.wantsHouse(player)) {
      // A house (Construction.MaxHouse's layout: a portal nexus, jewellery box, ...) for a bot
      // with the levels for a nexus. Building it puts the bot inside: it's put back where it was.
      const at = player.getLocation().clone();
      try {
        HOUSE.maxHouse(player);
        HOUSE.houseFor(player)?.exitHouse?.(player, at);
        if (player.getPrivateArea?.()) player.moveTo(at);
        this.api.core.GameConstants.PLAYER_PERSISTENCE?.save?.(player);
        this.roster.update(bot.name, { house: true });
        this.log("spp_bots_house", { name: bot.name });
      } catch (error) {
        this.log("spp_bots_house_failed", { name: bot.name, error: String(error?.message ?? error) });
        this.roster.update(bot.name, { house: "failed" });
      }
    }
    if (bot.house === true || this.wantsHouse(player)) HOUSE.openDoors(player);
    entry.brain = createBrain(player, bot.profile, { core: this.api.core, world: this.world, registry: this.registry });
    entry.startXp = totalXp(player);
    this.maybeHost(entry);
  }

  /**
   * The prayer host (docs/playerbots.md, Prayer hosts): `config.prayerHosts` bots with a max house
   * and Firemaking 30 host at Rimmington. The first such bot to log in while there are too few is
   * made one: its house moved to Rimmington, a tinderbox and marrentill in its bank (saved).
   */
  maybeHost(entry) {
    const { bot, player } = entry;
    const { Skill, ItemIds, GameConstants } = this.api.core;
    const hosts = this.roster.bots.filter((other) => other.role === "prayerHost").length;
    if (bot.role !== "prayerHost") {
      if (hosts >= (this.config.prayerHosts ?? 1) || bot.house !== true) return;
      if (player.getSkillManager().getMaxLevel(Skill.FIREMAKING) < 30) return;
      this.roster.update(bot.name, { role: "prayerHost" });
      this.log("spp_bots_host", { name: bot.name, step: "chosen" });
    }
    // A house of its own (the user: the max house is awful to walk for guests): the garden with
    // the exit portal, the chapel beside it (gilded altar, two marble burners), a nexus. Built
    // once (roster `hostHouse`); building it puts the bot inside, so it's put back first.
    if ((bot.hostHouse ?? 0) < HOST_HOUSE_VERSION) {
      const at = player.getLocation().clone();
      try {
        HOUSE.hostHouse(player);
        HOUSE.houseFor(player)?.exitHouse?.(player, at);
        if (player.getPrivateArea?.()) player.moveTo(at);
        this.roster.update(bot.name, { hostHouse: HOST_HOUSE_VERSION });
        this.log("spp_bots_host", { name: bot.name, step: "house built" });
      } catch (error) {
        this.log("spp_bots_host", { name: bot.name, step: "house", error: String(error?.message ?? error) });
      }
    }
    try {
      HOUSE.setLocation(player, RIMMINGTON.location);
      HOUSE.setDoorMode(player, 2);
    } catch (error) {
      this.log("spp_bots_host", { name: bot.name, step: "house", error: String(error?.message ?? error) });
    }
    const bank = player.getBank(0);
    const owns = (id) => [...Array(this.api.core.Bank.TOTAL_BANK_TABS).keys()].some((tab) => player.getBank(tab)?.getItems?.().some((item) => item?.getId?.() === id))
      || player.getInventory().contains(id);
    if (!owns(ItemIds.TINDERBOX)) bank.adds(ItemIds.TINDERBOX, 1);
    if (!owns(ItemIds.MARRENTILL)) bank.adds(ItemIds.MARRENTILL, 2000);
    GameConstants.PLAYER_PERSISTENCE?.save?.(player);
    entry.brain.replaceRoot(createHostActivity({ api: this.api, entry, log: this.log }), Date.now());
    entry.brain.current = { id: "prayer host", since: Date.now() };
  }

  /** A members bot with the Construction for a portal nexus (72) gets a house. */
  wantsHouse(player) {
    const { Skill } = this.api.core;
    return isMembersWorld() && player.getSkillManager().getMaxLevel(Skill.CONSTRUCTION) >= HOUSE_LEVEL;
  }

  /** Asks to log out as a player would: refused while fighting, so it's asked again later. */
  /** The session is over: to the nearest bank, everything in, then logout (WIND_DOWN_MS at most). */
  windDown(entry, nowMs) {
    const { createBankActivity } = require("./Travel.SppBots");
    entry.windDown = { until: nowMs + WIND_DOWN_MS, done: false };
    const activity = createBankActivity({
      api: this.api,
      log: this.log,
      onDone: (result) => {
        entry.windDown.done = true;
        this.log("spp_bots_session_end", { name: entry.bot.name, banked: result === "success" });
      },
    });
    entry.brain?.replaceRoot?.(activity, nowMs);
    if (entry.brain) entry.brain.current = { id: "ending session (bank)", since: nowMs };
  }

  /** Bots whose logout has been asked for and hasn't landed yet. */
  leaving() {
    let count = 0;
    for (const entry of this.online.values()) if (entry.loggingOut) count += 1;
    return count;
  }

  requestLogout(entry, nowMs) {
    entry.loggingOut = true;
    if (entry.logoutAt > nowMs) return;
    entry.logoutAt = nowMs + LOGOUT_RETRY_MS;
    entry.brain?.reset?.();
    resetMovementState(entry.player);
    this.api.core.World.queueLogoutRequest(entry.player);
  }

  onLogout(player) {
    const key = String(player?.getUsername?.() ?? "").toLowerCase();
    const entry = this.online.get(key);
    if (!entry) return;
    this.online.delete(key);
    entry.brain?.reset?.();
    const location = player.getLocation();
    if (!player.getPrivateArea?.()) this.roster.update(entry.bot.name, { location: { x: location.getX(), y: location.getY(), z: location.getZ() } });
    this.log("spp_bots_logout", { name: entry.bot.name });
  }

  /** Where every online bot stands, for a shutdown that doesn't log them out one by one. */
  rememberLocations() {
    for (const { bot, player } of this.online.values()) {
      if (player.getPrivateArea?.()) continue;
      const location = player.getLocation();
      bot.location = { x: location.getX(), y: location.getY(), z: location.getZ() };
    }
  }

  noteProgress(player) {
    this.online.get(String(player?.getUsername?.() ?? "").toLowerCase())?.brain?.noteProgress?.(Date.now());
  }

  /** Real players' positions, for deciding which bots someone can see. */
  watchers() {
    const spots = [];
    this.api.core.World.getPlayers().forEach((player) => {
      if (player && player.isPlayerBot?.() !== true) spots.push(player.getLocation());
    });
    return spots;
  }

  isWatched(player, spots) {
    const here = player.getLocation();
    return spots.some((spot) => spot.getZ() === here.getZ()
      && Math.abs(spot.getX() - here.getX()) <= NEAR_TILES && Math.abs(spot.getY() - here.getY()) <= NEAR_TILES);
  }

  tick() {
    if (!this.world) return;
    const started = performance.now();
    const nowMs = Date.now();
    this.tickCount += 1;

    // A restart or crash doesn't log bots out one by one: keep their positions fresh.
    if (this.tickCount % LOCATION_SAVE_TICKS === 0 && this.online.size > 0) {
      this.rememberLocations();
      this.roster.save();
    }

    const target = this.target(nowMs);
    if (this.online.size < target && this.tickCount % this.config.loginEveryTicks === 0) {
      const bot = this.nextOffline(nowMs);
      if (bot) this.logIn(bot);
    }
    // Over the target as the evening ends: one bot a tick ends its session (banks, then logs out).
    const windingDown = [...this.online.values()].filter((entry) => entry.windDown || entry.loggingOut).length;
    if (this.online.size - windingDown > target && this.tickCount % this.config.loginEveryTicks === 0) {
      const longest = [...this.online.values()].filter((entry) => entry.brain && !entry.windDown && !entry.loggingOut && entry.bot.role !== "prayerHost")
        .sort((a, b) => a.sessionEndsAt - b.sessionEndsAt)[0];
      if (longest) this.windDown(longest, nowMs);
    }

    const entries = [...this.online.values()];
    const spots = this.watchers();
    let ran = 0;
    // A first login generates an account (dozens of quests); one per tick keeps that from piling up.
    let settled = false;
    for (let index = 0; index < entries.length; index++) {
      if (performance.now() - started > this.config.budgetMs) break;
      const entry = entries[(this.cursor + index) % entries.length];
      const player = entry.player;
      if (!player.isRegistered?.()) continue;
      try {
        if (!entry.brain) {
          if (settled) continue;
          settled = true;
          const settleStarted = performance.now();
          this.settle(entry);
          this.log("spp_bots_settled", { name: entry.bot.name, ms: Math.round(performance.now() - settleStarted) });
          continue;
        }
        // Too many online (the budget): out now. A session that's over: bank first, as a player
        // ends a session, then log out there.
        // Bots already on their way out still count as online until their logout lands, so count
        // them off: otherwise one pass logs out every bot (it did: 195 to 26 for a target of 150).
        const staying = this.online.size - this.leaving();
        // (A logout the game refused, in combat, is asked again: requestLogout spaces the tries.)
        // A prayer host stays: guests come to its house (HousePrayer.SppBots.js).
        const isHost = entry.bot.role === "prayerHost";
        if (entry.loggingOut || (!isHost && staying > target * OVER_TARGET_NOW) || entry.windDown?.done || (entry.windDown && nowMs > entry.windDown.until)) {
          this.requestLogout(entry, nowMs);
          continue;
        }
        if (nowMs >= entry.sessionEndsAt && !entry.windDown && !isHost) this.windDown(entry, nowMs);
        // A fight comes first, every tick (eating can't wait for the bot's next think): the
        // activity waits while the bot fights back, eats or runs.
        if (defend(this.api, entry, nowMs, this.log)) continue;
        // A prayer host whose routine ended (or was replaced) gets it back, a minute later at most.
        if (entry.bot.role === "prayerHost" && entry.brain && entry.brain.current?.id !== "prayer host" && nowMs >= (entry.hostCheckAt ?? 0)) {
          entry.hostCheckAt = nowMs + 60000;
          entry.brain.replaceRoot(createHostActivity({ api: this.api, entry, log: this.log }), nowMs);
          entry.brain.current = { id: "prayer host", since: nowMs };
          this.log("spp_bots_host", { name: entry.bot.name, step: "routine restarted" });
        }
        const stride = this.isWatched(player, spots) ? 1 : FAR_STRIDE;
        if ((this.tickCount + index) % stride !== 0) continue;
        resumeRunning(entry);
        entry.brain.tick(nowMs);
        ran += 1;
      } catch (error) {
        this.log("spp_bots_tick_failed", { name: entry.bot.name, error: String(error?.stack ?? error) });
        entry.brain?.reset?.();
        entry.brain = null;
      }
    }
    this.cursor = entries.length ? (this.cursor + ran) % entries.length : 0;
    this.lastTickMs = performance.now() - started;
  }

  status() {
    return [...this.online.values()].map(({ bot, player, brain, sessionEndsAt, startXp }) => ({
      name: bot.name,
      stage: bot.profile.stage,
      archetype: bot.profile.archetype,
      ironman: bot.profile.ironman,
      combat: player.getSkillManager().getCombatLevel(),
      total: player.getSkillManager().getTotalLevel?.() ?? null,
      doing: brain?.current?.id ?? (brain ? "idle" : "logging in"),
      inventory: 28 - player.getInventory().getFreeSlots(),
      xpGained: startXp === null ? 0 : Math.round(totalXp(player) - startXp),
      minutesLeft: Math.max(0, Math.round((sessionEndsAt - Date.now()) / 60000)),
      at: `${player.getLocation().getX()},${player.getLocation().getY()},${player.getLocation().getZ()}`,
    }));
  }
}

module.exports = { Population, LOGIN_SPOTS, PROGRESS_EVENTS };
