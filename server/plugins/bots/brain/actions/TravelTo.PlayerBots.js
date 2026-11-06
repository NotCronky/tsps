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
 *   - the fairy ring network, with a fairy staff and Fairytale II started (FairyRings): from the
 *     ring nearest it, which it walks to first (an option's `via`, the walk counted in its cost);
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
// A walk to where a teleport is used from (a fairy ring) that takes longer than this: given up.
const VIA_WALK_MS = 120000;
// A teleport in the bank is worth a bank stop when it lands at least this much nearer.
const BANK_DETOUR_TILES = 40;

// A floor apart counts as this many tiles more (stairs), not as out of reach: upstairs in
// Lumbridge castle, a place 50 tiles off made every ground-floor teleport look nearer, and a bot
// on its way to the swamp went to the Mage Training Arena.
const FLOOR_TILES = 20;
const distance = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) + FLOOR_TILES * Math.abs((a.z ?? 0) - (b.z ?? 0));
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

// "here area>tile" -> whether a walk gets there (map data: the same for every bot there).
const walkable = new Map();
const MAX_WALKABLE = 4000;

/**
 * `canWalkTo(tile)` for "teleport:options": whether the character can walk from where it is to
 * stand by `tile` (a fairy ring on a swamp island can't be walked to). The route planner, exact.
 */
function walkCheck(player) {
  const { planRoute } = require("../../behaviours/navigation/LongRoutePlanner.PlayerBots");
  const { RegionManager } = require("../../../../src/main/typescript/elvarg/game/collision/RegionManager");
  const { isClosedDoor } = require("../DoorOpening.PlayerBots");
  const { MapObjects } = require("../../../../src/main/typescript/elvarg/game/entity/impl/object/MapObjects");
  const here = tileOf(player.getLocation());
  return (tile) => {
    const at = tileOf(tile);
    if (at.z !== here.z) return false;
    const key = `${here.x >> 3},${here.y >> 3},${here.z}>${at.x},${at.y}`;
    if (walkable.has(key)) return walkable.get(key);
    if (walkable.size > MAX_WALKABLE) walkable.clear();
    const isDoor = (x, y, z) => (MapObjects.mapObjects.get(MapObjects.getHash(x, y, z)) ?? [])
      .some((object) => object.getLocation().getX() === x && object.getLocation().getY() === y && isClosedDoor(object, null));
    const plan = planRoute({ from: here, to: { x: at.x, y: at.y }, exactOnly: true, goalReach: 1,
      getFlag: (x, y, z) => RegionManager.getClipping(x, y, z, null), isDoor });
    walkable.set(key, plan !== null);
    return plan !== null;
  };
}

/** Every teleport the character can use now (plugins answer "teleport:options"). */
function teleportOptions(player, world) {
  const request = { player, options: [], canWalkTo: walkCheck(player) };
  world.emitCustomEvent?.("teleport:options", request);
  return request.options.filter((option) => option?.to && typeof option.use === "function");
}

/** Teleports its bank would make possible: options with `withdraw`. */
function bankedTeleportOptions(player, world) {
  const request = { player, options: [], bank: bankItems(player), canWalkTo: walkCheck(player) };
  world.emitCustomEvent?.("teleport:options", request);
  return request.options.filter((option) => option?.to && Array.isArray(option.withdraw) && option.withdraw.length > 0);
}

/** How good an option is for reaching `place`: tiles left after it, plus its cost. */
const scoreOf = (option, place) => distance(option.to, place) + (option.cost ?? 0);

/** The Wilderness's main stretch (Ferox Enclave's included): nowhere to land on the way elsewhere. */
const inWilderness = (tile) => tile.x >= 2944 && tile.x <= 3392 && tile.y >= 3520 && tile.y <= 3968 && (tile.z ?? 0) === 0;

/**
 * The best option for getting to `place` from `here`, or null when none is worth it. One landing
 * in the Wilderness only for a place in it: a ring of dueling's Ferox Enclave isn't a way to
 * anywhere else, and a bot landing there was stranded.
 */
function bestTeleport(options, here, place, tried = new Set()) {
  const left = distance(here, place);
  const wild = inWilderness(place);
  return options
    .filter((option) => !tried.has(option.id) && (wild || !inWilderness(option.to)))
    .map((option) => ({ option, after: distance(option.to, place) }))
    .filter(({ after }) => after <= left - MIN_GAIN_TILES)
    .sort((a, b) => (a.after + (a.option.cost ?? 0)) - (b.after + (b.option.cost ?? 0)))[0]?.option ?? null;
}

function createTravelToAction(spec, world) {
  const place = { x: Number(spec.x), y: Number(spec.y), z: Number(spec.z ?? 0) };
  const walk = createWalkToAction({ ...place, radius: spec.radius ?? 4 });
  const stateFor = (player) => playerState(action, player, () => ({ tried: new Set(), waitUntil: 0, from: null, banked: false, bankStep: null, via: null }));

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
      // One used from somewhere it walks to first (a fairy ring): there, then used.
      if (option.via && distance(here, tileOf(option.via)) > 1) {
        const via = tileOf(option.via);
        bot.via = { option, since: nowMs, walk: createWalkToAction({ ...via, radius: 0 }) };
        return true;
      }
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
      if (bot.via) {
        const result = bot.via.walk.update(ctx);
        if (result === "success") {
          const { option } = bot.via;
          bot.via.walk.stop?.(ctx);
          bot.via = null;
          clearMovementRequest(player);
          if (option.use() === true) {
            bot.waitUntil = nowMs + (option.waitMs ?? 8000);
            bot.from = tileOf(player.getLocation());
          }
          return "running";
        }
        if (result === "failed" || nowMs - bot.via.since > VIA_WALK_MS) {
          bot.via.walk.stop?.(ctx);
          bot.via = null;
        } else {
          return "running";
        }
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
      bot.via?.walk?.stop?.(ctx);
      bot.via = null;
      walk.stop?.(ctx);
    },
    // Standing still through a cast is progress; so is walking.
    madeProgress(ctx) {
      const bot = stateFor(ctx.player);
      if (bot.waitUntil) return true;
      if (bot.via) return true;
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

module.exports = {
  inWilderness, createTravelToAction, teleportOptions, bankedTeleportOptions, bestTeleport };
