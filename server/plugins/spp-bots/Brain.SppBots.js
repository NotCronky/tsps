"use strict";

const path = require("path");

/**
 * A bot's brain (docs/playerbots.md, Phase 4): upstream's BotBrain runs the activity; this picks
 * the activity. The pick follows who the bot is (its archetype's and its own favourite skills),
 * leans towards skills it's behind in, and usually goes to the best spot its levels allow.
 */

const {
  BotBrain,
  createInitialState,
  createTraversalAssist,
  listCatalogObjectIds,
  isSkilling,
} = require("./Imports.SppBots");
const { ensureSaveDirectory } = require("./Roster.SppBots");
const { available, compile } = require("./Activities.SppBots");
const { SKILLS } = require("./Simulator.SppBots");
const { accounts } = require("./Accounts.SppBots");

const BEHAVIOR_MODE = Object.freeze({ ROAMING: "roaming" });
/** Players mostly use the best spot they can, but not always (willows are popular for a reason). */
const BEST_TIER_CHANCE = 0.75;
/** Power-training: drop instead of banking. */
const DROPPER_CHANCE = 0.25;
/** A bot that found nothing to do looks again after this long. */
const IDLE_RETRY_MS = 30000;

/**
 * Pauses so a bot doesn't act every tick, as a player doesn't click every tick (ms ranges).
 * The same shape as AI bots' pacing (docs/ai-bots.md).
 */
const PACING = Object.freeze({
  actionPauseMs: [600, 2400],
  activityPauseMs: [2000, 8000],
  walkPauseChance: 0.3,
  walkPauseMs: [600, 2400],
  dropsPerTick: [1, 2],
});

/** What upstream's brain actions expect of the world they run in (as PluginBoot builds it). */
function createBrainWorld(api, log) {
  // Our own copy of the object index: rebuilding upstream's plugins/bots/data/object-index.json
  // would change a tracked upstream file.
  const cachePath = path.join(ensureSaveDirectory(), "object-index.json");
  const traversalAssist = createTraversalAssist(api, { objectIds: [], cachePath });
  // Every kind of bank (Banks.SppBots.js): booths, and chests the index then finds too.
  traversalAssist.trackObjectIds([...listCatalogObjectIds(), ...require("./Banks.SppBots").bankObjectIds(api.core)]);
  traversalAssist.initializePersistentIndex();
  traversalAssist.schedulePersistentIndexInitialization(0);
  const faceTarget = (event) => {
    const target = event?.object?.getLocation?.() ?? event?.npc?.getLocation?.();
    if (!target) return;
    if (typeof event.player?.forcePositionToFace === "function") event.player.forcePositionToFace(target);
    else event.player?.setPositionToFace?.(target);
  };
  const World = api.getWorld();
  return {
    core: api.core,
    refreshEquipment: (player) => api.getBonusManager().update(player),
    objectSearch: traversalAssist,
    regionManager: api.getRegionManager(),
    areaManager: api.getAreaManager(),
    getPlayerByName: (name) => World.getPlayerByName(name),
    ditch: {},
    emitObjectInteraction: (event) => {
      faceTarget(event);
      return api.emitObjectInteraction(event);
    },
    emitNpcInteraction: (event) => {
      faceTarget(event);
      return api.emitNpcInteraction(event);
    },
    emitItemOnObject: (event) => {
      faceTarget(event);
      return api.emitItemOnObject(event);
    },
    isBusy: isSkilling,
    log,
    // For spp-bots' own actions (bank visits travel with the plugin's api).
    api,
  };
}

/**
 * What BotBrain asks of a registry. spp-bots pick their own activities (chooseNext), so this only
 * remembers failures: an activity that failed is left alone for its cooldown.
 */
function createRegistry() {
  const blocked = new WeakMap();
  return {
    occupy() {},
    release() {},
    resolversFor: () => [],
    pickActivity: () => null,
    blockActivity(player, activityId, nowMs = Date.now(), durationMs = 15000) {
      let map = blocked.get(player);
      if (!map) blocked.set(player, (map = new Map()));
      map.set(activityId, nowMs + durationMs);
    },
    isBlocked(player, activityId, nowMs) {
      return (blocked.get(player)?.get(activityId) ?? 0) > nowMs;
    },
  };
}

function pickWeighted(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0)) return null;
  let roll = Math.random() * total;
  for (const entry of entries) {
    if ((roll -= entry.weight) < 0) return entry;
  }
  return entries[entries.length - 1];
}

/** The next activity for `player`, whose roster entry is `profile`; null when it can do nothing. */
function chooseActivity(player, profile, { core, world, registry, nowMs }) {
  // `profile.only`: one skill (a player in bot mode who asked for it).
  const choices = available(player, core, SKILLS).filter((choice) => !registry.isBlocked(player, choice.id, nowMs)
    && (!profile.only || choice.definition.skill === profile.only));
  if (choices.length === 0) return null;
  const archetype = accounts.archetypes[profile.archetype] ?? {};
  const bySkill = new Map();
  for (const choice of choices) {
    const list = bySkill.get(choice.definition.skill) ?? [];
    list.push(choice);
    bySkill.set(choice.definition.skill, list);
  }
  const skillEntries = [...bySkill.entries()].map(([skill, list]) => {
    let weight = archetype.skillWeights?.[skill] ?? archetype.otherSkillWeight ?? 1;
    if (profile.favourites?.includes(skill)) weight *= accounts.tastes.favouriteWeight;
    if (profile.disliked?.includes(skill)) weight *= accounts.tastes.dislikedWeight;
    const level = player.getSkillManager().getMaxLevel(core.Skill[skill.toUpperCase()]);
    weight *= 50 / (level + 10);
    return { skill, list, weight };
  });
  const picked = pickWeighted(skillEntries);
  if (!picked) return null;
  const tiers = [...picked.list].sort((a, b) => b.level - a.level);
  const choice = Math.random() < BEST_TIER_CHANCE || tiers.length === 1
    ? tiers[0]
    : tiers[1 + Math.floor(Math.random() * (tiers.length - 1))];
  return compile(choice, world, { dropper: Math.random() < DROPPER_CHANCE });
}

/** A brain for one bot, starting with nothing: its first chooseNext picks what it does. */
function createBrain(player, profile, services) {
  const location = player.getLocation();
  const state = createInitialState({ x: location.getX(), y: location.getY(), z: location.getZ() }, BEHAVIOR_MODE);
  const brain = new BotBrain({
    player,
    state,
    registry: services.registry,
    world: services.world,
    activity: null,
    // A real player in bot mode acts every tick (the user's call): no pauses between actions.
    pacing: services.pacing === false ? null : PACING,
    chooseNext: (nowMs) => {
      // The brain asks every tick while idle; a bot with nothing to do looks again a while later.
      if (nowMs < (brain.nextPickAt ?? 0)) return "wait";
      const activity = chooseActivity(player, profile, { ...services, nowMs });
      brain.current = activity ? { id: activity.id, since: nowMs } : null;
      if (!activity) brain.nextPickAt = nowMs + IDLE_RETRY_MS;
      return activity ?? "wait";
    },
    nowMs: Date.now(),
  });
  brain.current = null;
  return brain;
}

module.exports = { createBrainWorld, createRegistry, createBrain, chooseActivity, PACING };
