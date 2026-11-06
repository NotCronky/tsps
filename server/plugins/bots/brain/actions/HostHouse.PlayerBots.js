"use strict";

const { playerState } = require("../ActionState.PlayerBots");
const { RIMMINGTON } = require("../../lib/HouseHost.PlayerBots");

/**
 * The house host's day: it keeps its max house open in Rimmington through the Construction
 * plugin's "construction:host-house" (::maxhouse's house the first time, its incense burners lit
 * for good), going back in whenever it finds itself outside. Never ends.
 *
 * JSON: { "type": "hostHouse", "location": 1 }
 */
const CHECK_MS = 3000;

function createHostHouseAction(spec, world) {
  const stateFor = (player) => playerState(action, player, () => ({ checkedAt: null }));
  const action = {
    id: "hostHouse",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      if (bot.checkedAt !== null && nowMs - bot.checkedAt < CHECK_MS) return "running";
      bot.checkedAt = nowMs;
      // Inside or not, asking again relights anything a rebuilt house lost.
      world.emitCustomEvent?.("construction:host-house", { player, location: spec.location ?? RIMMINGTON, handled: false });
      return "running";
    },
    stop(ctx) {
      stateFor(ctx.player).checkedAt = null;
    },
    madeProgress: () => true,
    describe: () => "hosting a house party",
  };
  return action;
}

module.exports = { createHostHouseAction };
