"use strict";

/**
 * What a resident does next, with no model involved: a kind of work weighted to the skill it
 * cares about, the best activity its levels allow for that work, and a town from
 * data/resident-goals.json. Everything here is pure, so `random` can be fixed in tests.
 */
const HANG_AROUND = "hang_around";

function pick(list, random) {
  return list[Math.floor(random() * list.length)];
}

function pickWeighted(weights, random) {
  const entries = Object.entries(weights).filter(([, weight]) => weight > 0);
  let roll = random() * entries.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [key, weight] of entries) {
    roll -= weight;
    if (roll < 0) return key;
  }
  return entries.at(-1)?.[0] ?? null;
}

function rollBetween([min, max], random) {
  return min + random() * (max - min);
}

/** A new resident: the skill it cares about, how experienced it is, and the town it starts in. */
function rollProfile(data, random = Math.random) {
  const focus = pick(data.focuses, random);
  return { focus, tier: pickWeighted(data.tierWeights, random), home: pick(data.places[focus], random) };
}

/** The highest-level activity of each kind of work among `entries` ({ id, level, activity }). */
function bestByMode(entries) {
  const best = new Map();
  for (const entry of entries) {
    const mode = entry.activity.mode;
    if (!best.has(mode) || entry.level > best.get(mode).level) best.set(mode, entry);
  }
  return best;
}

/**
 * The next goal: { mode, activity, place }, or null when nothing is open. `entries` are the
 * activities this resident can do right now; the kind of work it just did is avoided so it
 * moves on, unless there is nothing else.
 */
function pickGoal({ data, focus, entries, hangAround, lastMode, random = Math.random }) {
  const best = bestByMode(entries);
  const weights = {};
  for (const mode of best.keys()) {
    if (data.places[mode]) weights[mode] = mode === focus ? data.focusWeight : data.otherWeight;
  }
  if (hangAround) weights[HANG_AROUND] = data.hangAroundWeight;
  const others = Object.fromEntries(Object.entries(weights).filter(([mode]) => mode !== lastMode));
  const mode = pickWeighted(Object.keys(others).length > 0 ? others : weights, random);
  if (!mode) return null;
  return {
    mode,
    activity: mode === HANG_AROUND ? hangAround : best.get(mode).activity,
    place: pick(data.places[mode], random),
  };
}

/** A fresh timer at startup: whether a resident starts online, and when that next changes. */
function rollStart(config, random = Math.random) {
  const online = rollBetween(config.sessionMinutes, random);
  const away = rollBetween(config.breakMinutes, random);
  const isOnline = random() < online / (online + away);
  return { online: isOnline, minutes: (isOnline ? online : away) * random() };
}

module.exports = { HANG_AROUND, bestByMode, pickGoal, pickWeighted, rollBetween, rollProfile, rollStart };
