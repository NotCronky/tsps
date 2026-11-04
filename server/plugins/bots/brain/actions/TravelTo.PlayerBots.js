"use strict";

const { createWalkToAction } = require("./WalkTo.PlayerBots");
const { playerState } = require("../ActionState.PlayerBots");
const { clearMovementRequest } = require("../../behaviours/navigation/Navigation.PlayerBots");
const { createBankAction } = require("./Bank.PlayerBots");

/**
 * Gets a character to `place` the way a player would: a long way off, it teleports first, then
 * walks the rest. The teleports come from the plugins that own them, through "teleport:options"
 * ({ player, options }), each pushing what the character can use right now:
 *   - spellbook teleports it has the level, spellbook and carried runes for (SpellTeleports);
 *   - teleport tablets it carries (SpellTeleports);
 *   - charged jewellery it carries or wears: glory, games necklace, ring of dueling ... (Jewellery);
 *   - its spellbook's home teleport and the minigame teleports, off cooldown (HomeTeleports,
 *     MinigameTeleports).
 * An option is { id, name, to: { x, y, z }, waitMs, cost, use() -> started }. The one landing
 * nearest the place wins, with `cost` (in tiles) for what it uses up or how long it takes, as long
 * as it saves at least MIN_GAIN_TILES. Each is used through the plugin's own code, so runes,
 * charges, tablets, cooldowns and Wilderness limits are a player's. An option is tried once per
 * trip; one that doesn't land in time is dropped and the next best (or the walk) goes on.
 *
 * What's banked counts too: asked with `bank` (its banked items), the plugins also offer what the
 * bank makes possible - runes for a spell, a tablet, a piece of jewellery - with `withdraw` and no
 * `use`. When the best of those beats everything carried by BANK_DETOUR_TILES, the character stops
 * at a bank first (once a trip), takes it out, and then teleports with it like anything carried.
 */
const TELEPORT_TILES = 60;
const MIN_GAIN_TILES = 40;
// Moved this far in one go: it landed.
const LANDED_TILES = 20;
// A teleport in the bank is worth a bank stop when it lands at least this much nearer.
const BANK_DETOUR_TILES = 40;

const distance = (a, b) => (a.z ?? 0) !== (b.z ?? 0) ? Number.MAX_SAFE_INTEGER / 2 : Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const tileOf = (location) => ({ x: location.getX(), y: location.getY(), z: location.getZ() });

/** The character's banked items, every tab. */
function bankItems(player) {
  const items = [];
  for (let tab = 0; tab < 10; tab++) {
    for (const item of player.getBank?.(tab)?.getItems?.() ?? []) {
      if (item?.getId?.() > 0) items.push(item);
    }
  }
  return items;
}

/** Every teleport the character can use now (plugins answer "teleport:options"). */
function teleportOptions(player, world) {
  const request = { player, options: [] };
  world.emitCustomEvent?.("teleport:options", request);
  return request.options.filter((option) => option?.to && typeof option.use === "function");
}

/** Teleports its bank would make possible: options with `withdraw`. */
function bankedTeleportOptions(player, world) {
  const request = { player, options: [], bank: bankItems(player) };
  world.emitCustomEvent?.("teleport:options", request);
  return request.options.filter((option) => option?.to && Array.isArray(option.withdraw) && option.withdraw.length > 0);
}

/** How good an option is for reaching `place`: tiles left after it, plus its cost. */
const scoreOf = (option, place) => distance(option.to, place) + (option.cost ?? 0);

/** The best option for getting to `place` from `here`, or null when none is worth it. */
function bestTeleport(options, here, place, tried = new Set()) {
  const left = distance(here, place);
  return options
    .filter((option) => !tried.has(option.id))
    .map((option) => ({ option, after: distance(option.to, place) }))
    .filter(({ after }) => after <= left - MIN_GAIN_TILES)
    .sort((a, b) => (a.after + (a.option.cost ?? 0)) - (b.after + (b.option.cost ?? 0)))[0]?.option ?? null;
}

function createTravelToAction(spec, world) {
  const place = { x: Number(spec.x), y: Number(spec.y), z: Number(spec.z ?? 0) };
  const walk = createWalkToAction({ ...place, radius: spec.radius ?? 4 });
  const stateFor = (player) => playerState(action, player, () => ({ tried: new Set(), waitUntil: 0, from: null, banked: false, bankStep: null }));

  /** A bank stop for a banked teleport that beats everything carried; true when one is under way. */
  function fetchFromBank(player, bot, carriedBest) {
    if (bot.banked) return false;
    const here = tileOf(player.getLocation());
    const banked = bestTeleport(bankedTeleportOptions(player, world), here, place, bot.tried);
    if (!banked) return false;
    if (carriedBest && scoreOf(banked, place) + BANK_DETOUR_TILES > scoreOf(carriedBest, place)) return false;
    bot.banked = true;
    bot.bankStep = createBankAction({ withdraw: banked.withdraw }, world);
    return true;
  }

  /** Uses the best teleport for this trip; true when one is under way. */
  function teleport(player, bot, nowMs) {
    const here = tileOf(player.getLocation());
    const options = teleportOptions(player, world);
    if (fetchFromBank(player, bot, bestTeleport(options, here, place, bot.tried))) return true;
    for (let option = bestTeleport(options, here, place, bot.tried); option; option = bestTeleport(options, here, place, bot.tried)) {
      bot.tried.add(option.id);
      clearMovementRequest(player);
      player.getMovementQueue?.()?.reset?.();
      if (option.use() === true) {
        bot.waitUntil = nowMs + (option.waitMs ?? 8000);
        bot.from = here;
        return true;
      }
    }
    return false;
  }

  const action = {
    id: "travelTo",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      if (bot.bankStep) {
        const result = bot.bankStep.update(ctx);
        if (result !== "success" && result !== "failed") return "running";
        bot.bankStep.stop?.(ctx);
        bot.bankStep = null;
      }
      if (bot.waitUntil) {
        const landed = distance(tileOf(player.getLocation()), bot.from) >= LANDED_TILES;
        if (!landed && nowMs < bot.waitUntil) return "running";
        bot.waitUntil = 0;
      }
      if (distance(tileOf(player.getLocation()), place) > TELEPORT_TILES && teleport(player, bot, nowMs)) return "running";
      return walk.update(ctx);
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.tried.clear();
      bot.waitUntil = 0;
      bot.banked = false;
      bot.bankStep?.stop?.(ctx);
      bot.bankStep = null;
      walk.stop?.(ctx);
    },
    // Standing still through a cast is progress; so is walking.
    madeProgress(ctx) {
      const bot = stateFor(ctx.player);
      if (bot.waitUntil) return true;
      if (bot.bankStep) return bot.bankStep.madeProgress?.(ctx) ?? true;
      const position = tileOf(ctx.player.getLocation());
      const key = `${position.x},${position.y},${position.z}`;
      const moved = bot.position !== undefined && bot.position !== key;
      bot.position = key;
      return moved;
    },
  };
  return action;
}

module.exports = { createTravelToAction, teleportOptions, bankedTeleportOptions, bestTeleport };
