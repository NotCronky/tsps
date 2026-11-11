"use strict";

/**
 * Live activities (data/activities.json), compiled for one bot at a time: "fetch my rune axe from
 * the bank, chop willows until full, bank the logs". Gathering, walking and banking are upstream's
 * brain actions; the tool and bait always come out of the bot's own bank, never from thin air
 * (upstream's equipTool, ensureItem and the fish action's bait top-up conjure them).
 */

const path = require("path");
const {
  ItemIds,
  createInteractObjectAction,
  createFishAction,
  createDropItemsAction,
  isMembersWorld,
  resolveCatalogObjectIds,
} = require("./Imports.SppBots");
const { canHave } = require("./Gear.SppBots");

const { activities: DEFINITIONS } = require(path.join(__dirname, "data", "activities.json"));
const gear = require(path.join(__dirname, "data", "gear.json"));

const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
/** Fewer free slots than this and the bot banks everything before it starts. */
const ROOM_NEEDED = 5;
const STALL_SECONDS = 120;
const BAIT_WITHDRAW = 1000;
// Beyond this (upstream's live range for objects), the bot makes a trip to the spot first.
const FAR_SITE_TILES = 64;
// A spot the bot couldn't get to is left alone this long.
const SITE_SKIP_MS = 30 * 60 * 1000;
// A spot with this many players in its 8x8 chunk is taken: the trip looks for the next one.
const CROWDED_PLAYERS = 3;
// Chunks other bots' site trips are heading for: "x,y,z" -> [until, ...], counted as crowd.
const CLAIM_MS = 10 * 60 * 1000;
const claims = new Map();
function claimed(chunk, nowMs) {
  const list = (claims.get(chunk) ?? []).filter((until) => until > nowMs);
  if (list.length) claims.set(chunk, list);
  else claims.delete(chunk);
  return list.length;
}

function id(key) {
  const value = ItemIds[key];
  if (!Number.isInteger(value)) throw new Error(`[spp-bots] unknown item ${key} in data/activities.json`);
  return value;
}

/** Every item the bot has anywhere: inventory, worn and banked, as id -> amount. */
function holdings(player) {
  const owned = new Map();
  const count = (item) => {
    if (!item || item.getId() < 0 || item.getAmount() <= 0) return;
    owned.set(item.getId(), (owned.get(item.getId()) ?? 0) + item.getAmount());
  };
  player.getInventory().getItems().forEach(count);
  player.getEquipment().getItems().forEach(count);
  for (const bank of player.getBanks?.() ?? []) bank?.getItems?.().forEach(count);
  return owned;
}

/** The skill levels by name gear.json's requirements read. */
function levelsOf(player, Skill, SKILLS) {
  const skills = player.getSkillManager();
  return SKILLS.map((name) => skills.getMaxLevel(Skill[name.toUpperCase()]));
}

/**
 * The best tool of `kind` the bot owns and may use: gear.json's tools list is best first, and its
 * level requirements are the same ones the skill plugins enforce.
 */
function ownedTool(kind, owned, account) {
  for (const entry of gear.tools[kind] ?? []) {
    if (owned.has(id(entry.item)) && canHave({ ...entry, iron: undefined, quest: undefined }, account)) return id(entry.item);
  }
  return null;
}

/** Which activities this bot can start now: its level, the world, and the tool it owns. */
function available(player, core, SKILLS) {
  const owned = holdings(player);
  const levels = levelsOf(player, core.Skill, SKILLS);
  const account = { levels, members: isMembersWorld(), combatLevel: 3, questNames: new Set() };
  const result = [];
  for (const [activityId, definition] of Object.entries(DEFINITIONS)) {
    const level = player.getSkillManager().getMaxLevel(core.Skill[definition.skill.toUpperCase()]);
    if (level < definition.level) continue;
    let tool = null;
    if (definition.tool) {
      tool = ownedTool(definition.tool, owned, account);
    } else if (definition.fishingTool) {
      tool = owned.has(id(definition.fishingTool)) ? id(definition.fishingTool) : null;
    }
    if (tool === null) continue;
    if (definition.bait && !owned.has(id(definition.bait))) continue;
    result.push({ id: activityId, definition, tool, level });
  }
  return result;
}

/**
 * Banks everything first when the inventory is nearly full (loot, quest rewards, a last trip's
 * leftovers), as a player does before starting something new. Otherwise it's done at once.
 */
function createMakeRoomAction(world) {
  const depositAll = bankVisit(world, { depositAll: true });
  return {
    id: "makeRoom",
    update(ctx) {
      if (ctx.player.getInventory().getFreeSlots() >= ROOM_NEEDED) return "success";
      return depositAll.update(ctx);
    },
    madeProgress: () => true,
    stop(ctx) {
      depositAll.stop?.(ctx);
    },
  };
}

/**
 * A visit to the nearest bank of any kind (Travel.SppBots.js). Required here, not at the top:
 * Travel requires this file.
 */
function bankVisit(world, spec) {
  const { createBankVisit } = require("./Travel.SppBots");
  return createBankVisit({ api: world.api, log: world.log, ...spec });
}

const tileKey = (x, y, z) => z * 268435456 + x * 16384 + y;
const siteSets = new Map();

/** Every indexed tile of these objects (spp-bots' own object index), as tile keys; cached. */
function siteTiles(objectIds) {
  const cacheKey = [...objectIds].sort((a, b) => a - b).join(",");
  if (siteSets.has(cacheKey)) return siteSets.get(cacheKey);
  const tiles = new Set();
  try {
    const { SAVE_DIRECTORY } = require("./Roster.SppBots");
    const index = JSON.parse(require("fs").readFileSync(path.join(SAVE_DIRECTORY, "object-index.json"), "utf8"));
    const wanted = new Set(objectIds.map(String));
    for (const [region, byId] of Object.entries(index.r ?? {})) {
      const baseX = (Number(region) >> 8) << 6;
      const baseY = (Number(region) & 0xff) << 6;
      for (const [id, entries] of Object.entries(byId)) {
        if (!wanted.has(id)) continue;
        for (const [lx, ly, z] of entries) tiles.add(tileKey(baseX + lx, baseY + ly, z));
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("[spp-bots] site index", error);
  }
  siteSets.set(cacheKey, tiles);
  return tiles;
}

/**
 * To the activity's spot (an indexed object: a willow, a rock) when none is in live range: one
 * trip to the nearest the bot can get to (teleports, boats, a fare from the bank), found by the
 * search itself, so an island's bots don't head for the nearest tree across the sea. Near
 * enough, it's done at once and the gathering action picks the object.
 */
function createGoToSiteAction(world, objectIds) {
  const { createTravelAction } = require("./Travel.SppBots");
  const trips = new WeakMap();
  const skips = new WeakMap();
  return {
    id: "goToSite",
    update(ctx) {
      const player = ctx.player;
      let trip = trips.get(player);
      if (!trip) {
        if (player.getPrivateArea?.()) return "success";
        const at = player.getLocation();
        // Spots are on the ground: from a bank upstairs (Lumbridge castle) search floor 0.
        const ground = at.getZ() === 0 ? player : { getLocation: () => new world.core.Location(at.getX(), at.getY(), 0), getPrivateArea: () => null };
        const near = world.objectSearch?.findNearestIndexedLocation?.(ground, objectIds, { regionRadius: 1 });
        if (near && at.getZ() === 0 && Math.max(Math.abs(near.x - at.getX()), Math.abs(near.y - at.getY())) <= FAR_SITE_TILES) return "success";
        const tiles = siteTiles(objectIds);
        if (!tiles.size) return "success";
        const nowMs = Date.now();
        const skipped = skips.get(player) ?? new Map();
        skips.set(player, skipped);
        // Not into the Wilderness for an ordinary tree or rock (a bot already there may stay).
        const inWilderness = world.core.Wilderness.levelAt(at.getX(), at.getY()) > 0;
        const besideSpot = (x, y, z) => {
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              if ((dx || dy) && tiles.has(tileKey(x + dx, y + dy, z))) return true;
            }
          }
          return false;
        };
        // Players by chunk, once for the trip: bots that land together spread out, as players do.
        const crowd = new Map();
        world.core.World.getPlayers().forEach((other) => {
          if (!other || other === player) return;
          const l = other.getLocation();
          const chunk = `${l.getX() >> 3},${l.getY() >> 3},${l.getZ()}`;
          crowd.set(chunk, (crowd.get(chunk) ?? 0) + 1);
        });
        const isGoal = (x, y, z) => besideSpot(x, y, z)
          && (crowd.get(`${x >> 3},${y >> 3},${z}`) ?? 0) + claimed(`${x >> 3},${y >> 3},${z}`, nowMs) < CROWDED_PLAYERS
          && (skipped.get(`${x >> 3},${y >> 3},${z}`) ?? 0) <= nowMs
          && (inWilderness || !(world.core.Wilderness.levelAt(x, y) > 0));
        trip = { action: createTravelAction({ api: world.api, isGoal, log: world.log }), from: { x: at.getX(), y: at.getY(), z: at.getZ() } };
        trips.set(player, trip);
      }
      const result = trip.action.update(ctx);
      if (!trip.claimed) {
        // Once planned, the spot is spoken for: the next bot's search counts it as crowd.
        const to = trip.action.destination?.(player);
        if (to) {
          trip.claimed = `${to.x >> 3},${to.y >> 3},${to.z}`;
          claims.set(trip.claimed, [...(claims.get(trip.claimed) ?? []), Date.now() + CLAIM_MS]);
        }
      }
      if (result === "running") return "running";
      trip.action.stop(ctx);
      trips.delete(player);
      const here = player.getLocation();
      world.log?.("spp_bots_site_trip", { name: player.getUsername(), result, from: trip.from, at: { x: here.getX(), y: here.getY(), z: here.getZ() } });
      // A spot it got to but couldn't use is left alone a while (by 8x8 chunk).
      if (result === "failed") skips.get(player)?.set(`${here.getX() >> 3},${here.getY() >> 3},${here.getZ()}`, Date.now() + SITE_SKIP_MS);
      return result;
    },
    madeProgress: (ctx) => trips.get(ctx.player)?.action.madeProgress(ctx) ?? true,
    stop(ctx) {
      trips.get(ctx.player)?.action.stop(ctx);
      trips.delete(ctx.player);
    },
  };
}

/** Fetches the tool (and bait) unless the bot has some on it already, as upstream's withdraw did. */
function createWithdrawAction(world, withdraw) {
  const visit = bankVisit(world, { withdraw });
  const has = (player, item) => player.getInventory().getAmount(item) > 0
    || player.getEquipment().getItems().some((worn) => worn && worn.getId() === item);
  return {
    id: "withdrawTools",
    update(ctx) {
      if (withdraw.every(({ item }) => has(ctx.player, item))) return "success";
      return visit.update(ctx);
    },
    madeProgress: () => true,
    stop(ctx) {
      visit.stop?.(ctx);
    },
  };
}

/**
 * One bot's run of an activity, in the shape upstream's BotBrain runs (an id, a mode, conditions
 * and a repeating list of actions). `dropper`: the bot power-trains, dropping what it gathers.
 */
function compile(choice, world, { dropper = false } = {}) {
  const { definition } = choice;
  const products = definition.products.map(id);
  const withdraw = [{ item: choice.tool, amount: 1 }];
  if (definition.bait) withdraw.push({ item: id(definition.bait), amount: BAIT_WITHDRAW });
  const gather = definition.spot
    ? createFishAction({ tool: definition.spot, bait: null, until: { inventoryFull: true } }, world)
    : createInteractObjectAction({
      catalog: definition.catalog,
      tier: definition.tier,
      option: definition.option,
      until: { inventoryFull: true },
      stallSeconds: STALL_SECONDS,
    }, world);
  const empty = dropper
    ? createDropItemsAction({ itemIds: products })
    : bankVisit(world, { depositIds: products });
  return {
    id: choice.id,
    skill: definition.skill,
    resolver: false,
    resolves: null,
    mode: definition.skill,
    capacity: 1,
    repeat: true,
    ephemeral: false,
    manual: false,
    failureCooldownMs: FAILURE_COOLDOWN_MS,
    requires: [],
    setup: [],
    actions: [
      createMakeRoomAction(world),
      createWithdrawAction(world, withdraw),
      ...(definition.spot ? [] : [createGoToSiteAction(world, resolveCatalogObjectIds({ catalog: definition.catalog, tier: definition.tier }))]),
      gather,
      empty,
    ],
    produces: products,
    site: null,
  };
}

module.exports = { available, compile, holdings, DEFINITIONS };
