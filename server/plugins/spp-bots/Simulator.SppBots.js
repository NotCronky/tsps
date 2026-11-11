"use strict";

/**
 * The account simulator (docs/playerbots.md, Phase 2): plays an account's history abstractly.
 * Starting from a fresh account it repeatedly picks what a player of this kind would do next
 * (train a skill, do a quest) and applies the method's rates instead of playing it tick by tick,
 * until the target play time is used up.
 *
 * Pure: no game state is touched. The same profile (seed included) always gives the same account.
 * Accounts.SppBots.js writes the result to a player through the game's own APIs.
 */

/** Cache stat ids, which are also the Skill enum's indices. Sailing (23) isn't simulated yet. */
const SKILLS = [
  "attack", "defence", "strength", "hitpoints", "ranged", "prayer", "magic", "cooking",
  "woodcutting", "fletching", "fishing", "firemaking", "crafting", "smithing", "mining",
  "herblore", "agility", "thieving", "slayer", "farming", "runecrafting", "hunter", "construction",
];
const SKILL_INDEX = new Map(SKILLS.map((name, index) => [name, index]));
const HITPOINTS = SKILL_INDEX.get("hitpoints");
const STARTING_HITPOINTS_XP = 1154; // level 10
const MAX_XP = 200_000_000;
const STEP_HOURS = 0.1;

const XP_FOR_LEVEL = (() => {
  const table = [0, 0];
  let points = 0;
  for (let level = 1; level < 99; level++) {
    points += Math.floor(level + 300 * Math.pow(2, level / 7));
    table.push(Math.floor(points / 4));
  }
  return table;
})();

function levelForXp(xp) {
  let level = 1;
  while (level < 99 && xp >= XP_FOR_LEVEL[level + 1]) level++;
  return level;
}

function xpForLevel(level) {
  return XP_FOR_LEVEL[Math.max(1, Math.min(99, level))];
}

/** The OSRS combat level formula. */
function combatLevel(levels) {
  const [attack, defence, strength, hitpoints, ranged, prayer, magic] = levels;
  const base = 0.25 * (defence + hitpoints + Math.floor(prayer / 2));
  const melee = 0.325 * (attack + strength);
  const range = 0.325 * Math.floor(ranged * 1.5);
  const mage = 0.325 * Math.floor(magic * 1.5);
  return Math.floor(base + Math.max(melee, range, mage));
}

/** mulberry32: small, fast and seedable. */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function between(random, [min, max]) {
  return min + random() * (max - min);
}

function pickWeighted(random, entries) {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0)) return null;
  let roll = random() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll < 0) return entry;
  }
  return entries[entries.length - 1];
}

/**
 * Rolls who an account is: stage, archetype, ironman, play time and efficiency. `overrides` pins
 * any of them (a command asking for an endgame bot). Every roll comes from the seed.
 */
function rollProfile(accounts, seed, overrides = {}) {
  const random = createRandom(seed);
  const stage = overrides.stage
    ?? pickWeighted(random, Object.entries(accounts.stages).map(([id, s]) => ({ id, weight: s.weight }))).id;
  const archetype = overrides.archetype
    ?? pickWeighted(random, Object.entries(accounts.archetypes).map(([id, a]) => ({ id, weight: a.weight }))).id;
  const ironman = overrides.ironman ?? random() < accounts.ironmanChance;
  const hours = overrides.hours ?? between(random, accounts.stages[stage].hours);
  const efficiency = between(random, accounts.efficiency);
  // Everyone has skills they like and skills they put off; these shape the account as much as its type.
  const shuffled = [...SKILLS].sort(() => random() - 0.5);
  const tastes = accounts.tastes ?? { favourites: 3, disliked: 3 };
  return {
    seed,
    stage,
    archetype,
    ironman,
    hours: Math.round(hours * 10) / 10,
    efficiency: Math.round(efficiency * 100) / 100,
    favourites: shuffled.slice(0, tastes.favourites),
    disliked: shuffled.slice(tastes.favourites, tastes.favourites + tastes.disliked),
  };
}

/**
 * Plays `profile` through. `quests` are the quests that can be completed, from the cache quest
 * table (Quests.SppBots.js): { key, members, questPoints, length, stats: [[skill, level]],
 * quests: [key], questPoints needed (qp), combat, xp: [[skill, xp]] }.
 */
function simulate({ profile, training, accounts, quests = [], members = true }) {
  const random = createRandom(profile.seed ^ 0x5bd1e995);
  const archetype = accounts.archetypes[profile.archetype];
  const xp = SKILLS.map((_, index) => (index === HITPOINTS ? STARTING_HITPOINTS_XP : 0));
  const done = [];
  const doneSet = new Set();
  let questPoints = 0;
  let gp = 0;
  let hours = 0;
  const gpFactor = profile.ironman ? accounts.ironmanGpFactor : 1;

  const capOf = (skill) => archetype.caps?.[SKILLS[skill]] ?? 99;
  const levelOf = (skill) => levelForXp(xp[skill]);
  const levels = () => xp.map(levelForXp);
  const methodsOf = (skill) =>
    (training.skills[SKILLS[skill]]?.methods ?? []).filter((method) => members || method.members !== true);
  const methodAt = (skill) => {
    const level = levelOf(skill);
    let best = null;
    for (const method of methodsOf(skill)) {
      if (method.level <= level) best = method;
    }
    return best;
  };

  /** Adds xp without passing the skill's cap (a pure's Defence stays 1) or 200m. */
  function gain(skill, amount) {
    const cap = capOf(skill);
    const limit = cap >= 99 ? MAX_XP : xpForLevel(cap + 1) - 1;
    xp[skill] = Math.min(limit, xp[skill] + amount);
  }

  function skillWeight(skill) {
    const name = SKILLS[skill];
    const level = levelOf(skill);
    if (level >= 99 || level >= capOf(skill) || !methodAt(skill)) return 0;
    const method = methodAt(skill);
    let weight = archetype.skillWeights?.[name] ?? archetype.otherSkillWeight ?? 1;
    if (profile.favourites?.includes(name)) weight *= accounts.tastes?.favouriteWeight ?? 3;
    if (profile.disliked?.includes(name)) weight *= accounts.tastes?.dislikedWeight ?? 0.3;
    // Players lean somewhat on the skills they're behind in, and away from ones that cost more than they have.
    const all = levels();
    const average = all.reduce((sum, value) => sum + value, 0) / all.length;
    weight *= (average + 10) / (level + 10);
    if (method.gp < 0 && gp < -method.gp) weight *= 0.1;
    return weight;
  }

  function train(skill, duration) {
    for (let spent = 0; spent < duration; spent += STEP_HOURS) {
      if (levelOf(skill) >= capOf(skill)) return spent;
      const method = methodAt(skill);
      if (!method) return spent;
      const step = Math.min(STEP_HOURS, duration - spent);
      const amount = method.xp * profile.efficiency * step;
      gain(skill, amount);
      for (const [other, share] of Object.entries(method.also ?? {})) {
        const index = SKILL_INDEX.get(other);
        if (index !== undefined && levelOf(index) < capOf(index)) gain(index, amount * share);
      }
      gp = Math.max(0, gp + method.gp * step * profile.efficiency * gpFactor);
    }
    return duration;
  }

  function questAllowed(quest) {
    if (doneSet.has(quest.key) || (!members && quest.members)) return false;
    if (questPoints < (quest.qp ?? 0)) return false;
    if ((quest.quests ?? []).some((key) => !doneSet.has(key))) return false;
    const current = levels();
    if ((quest.stats ?? []).some(([skill, level]) => (current[skill] ?? 1) < level)) return false;
    if (combatLevel(current) < (quest.combat ?? 0)) return false;
    // A quest whose reward xp would lift a capped skill (a pure's Defence) is one this player skips.
    return (quest.xp ?? []).every(([skill, amount]) => capOf(skill) >= 99 || levelForXp(xp[skill] + amount) <= capOf(skill));
  }

  function doQuest(quest) {
    hours += accounts.questHoursByLength[quest.length] ?? 1;
    for (const [skill, amount] of quest.xp ?? []) gain(skill, amount);
    questPoints += quest.questPoints ?? 0;
    done.push(quest.key);
    doneSet.add(quest.key);
  }

  while (hours < profile.hours) {
    const session = Math.min(between(random, accounts.sessionHours), profile.hours - hours);
    if (random() < archetype.questChance) {
      const open = quests.filter(questAllowed);
      const quest = pickWeighted(random, open.map((entry) => ({ entry, weight: 1 / (1 + entry.length) })))?.entry;
      if (quest) {
        doQuest(quest);
        continue;
      }
    }
    const skill = pickWeighted(random, SKILLS.map((_, index) => ({ index, weight: skillWeight(index) })))?.index;
    if (skill === undefined) break;
    hours += Math.max(STEP_HOURS, train(skill, session));
  }

  const finalLevels = levels();
  return {
    xp: xp.map(Math.floor),
    levels: finalLevels,
    combatLevel: combatLevel(finalLevels),
    totalLevel: finalLevels.reduce((sum, value) => sum + value, 0),
    quests: done,
    questPoints,
    gp: Math.floor(gp),
    hours: Math.round(hours * 10) / 10,
  };
}

module.exports = {
  SKILLS,
  SKILL_INDEX,
  levelForXp,
  xpForLevel,
  combatLevel,
  createRandom,
  rollProfile,
  simulate,
};
