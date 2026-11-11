"use strict";

/**
 * When bots play (docs/playerbots.md, Phase 1 step 4). Pure: the online target over the day and
 * each bot's favourite hour.
 */

// When people play: most in the evening, some in the afternoon, a few at night or in the morning.
const PLAY_HOURS = [[18, 23, 0.55], [12, 18, 0.25], [7, 12, 0.12], [0, 7, 0.08]];

/**
 * Bots online at `nowMs`: `online` at `peakHour`, down to `quietShare` of it twelve hours later
 * (a cosine over the day, server time), plus `extra` added by hand.
 */
function dailyTarget({ online, quietShare = 1, peakHour = 20 }, extra, nowMs) {
  const date = new Date(nowMs);
  const hour = date.getHours() + date.getMinutes() / 60;
  const share = quietShare + (1 - quietShare) * (1 + Math.cos((2 * Math.PI * (hour - peakHour)) / 24)) / 2;
  return Math.round(online * share) + extra;
}

/** A favourite hour to play, drawn from PLAY_HOURS. */
function favouriteHour(random = Math.random) {
  let roll = random();
  for (const [from, to, share] of PLAY_HOURS) {
    if ((roll -= share) <= 0) return from + Math.floor(random() * (to - from));
  }
  return 20;
}

/** How much more likely a bot is to log in now: 4 at its favourite hour, 1 from 4 hours away. */
function hourWeight(playHour, hour) {
  const apart = Math.min(Math.abs(hour - playHour), 24 - Math.abs(hour - playHour));
  return 1 + 3 * Math.max(0, 1 - apart / 4);
}

module.exports = { dailyTarget, favouriteHour, hourWeight, PLAY_HOURS };
