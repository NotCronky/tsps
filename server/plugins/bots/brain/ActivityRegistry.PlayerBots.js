"use strict";

const fs = require("fs");
const path = require("path");
const { Skill } = require("../../../src/main/typescript/elvarg/game/model/Skill");
const { ItemIds } = require("../../../src/main/typescript/elvarg/util/IdEnums");
const { createInteractObjectAction } = require("./actions/InteractObject.PlayerBots");
const { createDropItemsAction } = require("./actions/DropItems.PlayerBots");
const { createChooseAction } = require("./actions/Choose.PlayerBots");
const { createSellItemsAction } = require("./actions/SellItems.PlayerBots");
const { createEquipToolAction } = require("./actions/EquipTool.PlayerBots");
const { createBankAction } = require("./actions/Bank.PlayerBots");
const { createBuyItemsAction } = require("./actions/BuyItems.PlayerBots");
const { createObtainAction } = require("./actions/Obtain.PlayerBots");
const { createOrElseAction } = require("./actions/OrElse.PlayerBots");
const { createWalkToAction } = require("./actions/WalkTo.PlayerBots");
const { createEnsureItemAction } = require("./actions/EnsureItem.PlayerBots");
const { createLightFireAction } = require("./actions/LightFire.PlayerBots");
const { createSmeltAction } = require("./actions/Smelt.PlayerBots");
const { createTrainCombatAction } = require("./actions/TrainCombat.PlayerBots");
const { createPvpCombatAction } = require("./actions/PvpCombat.PlayerBots");
const { createWanderAction } = require("./actions/Wander.PlayerBots");
const { createFollowOwnerAction } = require("./actions/FollowOwner.PlayerBots");
const { createFishAction } = require("./actions/Fish.PlayerBots");
const { createCookAction } = require("./actions/Cook.PlayerBots");

const DEFAULT_DEFINITIONS_PATH = path.join(
  process.cwd(),
  "data",
  "definitions",
  "bot-activities.json"
);


function applyFields(value, fields) {
  if (typeof value === "string") {
    if (value.startsWith("$") && Object.prototype.hasOwnProperty.call(fields, value.slice(1))) {
      return fields[value.slice(1)];
    }
    return value.replace(/\$([A-Za-z0-9_]+)/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(fields, key) ? String(fields[key]) : match
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => applyFields(entry, fields));
  }
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = applyFields(entry, fields);
    }
    return next;
  }
  return value;
}

function resolveItemId(name) {
  if (Number.isInteger(name)) {
    return name;
  }
  const key = String(name).trim().toUpperCase().replace(/[\s-]+/g, "_");
  return ItemIds[key] ?? null;
}

function resolveSkill(name) {
  const key = String(name).trim().toUpperCase().replace(/[\s-]+/g, "_");
  return Skill[key] ?? null;
}

function createCondition(spec) {
  if (spec.skill) {
    const skill = resolveSkill(spec.skill.id);
    const min = Number(spec.skill.min ?? 1);
    const max = Number(spec.skill.max ?? 99);
    return {
      id: `skill:${spec.skill.id}`,
      check(ctx) {
        const level = ctx.player?.getSkillManager?.().getCurrentLevel?.(skill) ?? 0;
        return level >= min && level <= max;
      },
    };
  }
  if (spec.hasItem) {
    const ids = (Array.isArray(spec.hasItem.id) ? spec.hasItem.id : [spec.hasItem.id])
      .map(resolveItemId)
      .filter((id) => Number.isInteger(id));
    const min = Number(spec.hasItem.min ?? 1);
    return {
      id: `item:${spec.hasItem.id}`,
      resolverKey: spec.resolver ?? `item:${spec.hasItem.id}`,
      check(ctx) {
        const inventory = ctx.player?.getInventory?.();
        if (!inventory) {
          return false;
        }
        return ids.some((id) => inventory.getAmount(id) >= min);
      },
    };
  }
  if (spec.inArea) {
    const area = spec.inArea;
    return {
      id: `area:${area.minX},${area.minY}`,
      resolverKey: spec.resolver ?? "area",
      check(ctx) {
        const loc = ctx.player?.getLocation?.();
        if (!loc) {
          return false;
        }
        return (
          loc.getX() >= area.minX &&
          loc.getX() <= area.maxX &&
          loc.getY() >= area.minY &&
          loc.getY() <= area.maxY &&
          loc.getZ() === (area.z ?? loc.getZ())
        );
      },
    };
  }
  throw new Error(`[bot activities] unknown condition ${JSON.stringify(spec)}`);
}

function createAction(spec, world) {
  if (spec.orElse) {
    const { orElse, ...primary } = spec;
    return createOrElseAction(createAction(primary, world), createAction(orElse, world));
  }
  if (spec.type === "interactObject") {
    return createInteractObjectAction(spec, world);
  }
  if (spec.type === "choose") {
    return createChooseAction(spec, (option) => createAction(option, world));
  }
  if (spec.type === "sellItems") {
    return createSellItemsAction(
      { ...spec, itemIds: (spec.itemIds ?? []).map(resolveItemId).filter((id) => Number.isInteger(id)) },
      world
    );
  }
  if (spec.type === "dropItems") {
    return createDropItemsAction({
      ...spec,
      itemIds: (spec.itemIds ?? []).map(resolveItemId).filter((id) => Number.isInteger(id)),
    });
  }
  if (spec.type === "equipTool") {
    return createEquipToolAction(spec, world);
  }
  if (spec.type === "obtain") {
    return createObtainAction({
      items: (spec.items ?? []).map((entry) => ({ item: resolveItemId(entry.item), amount: entry.amount })),
    }, world);
  }
  if (spec.type === "buyItems") {
    return createBuyItemsAction({ item: resolveItemId(spec.item), amount: spec.amount }, world);
  }
  if (spec.type === "bank") {
    return createBankAction(
      {
        ...spec,
        itemIds: (spec.itemIds ?? []).map(resolveItemId).filter((id) => Number.isInteger(id)),
        withdraw: (spec.withdraw ?? [])
          .map((entry) => ({
            item: resolveItemId(entry.item),
            amount: Math.max(1, Math.floor(Number(entry.amount ?? 1))),
          }))
          .filter((entry) => Number.isInteger(entry.item)),
      },
      world
    );
  }
  if (spec.type === "walkTo") {
    return createWalkToAction(spec);
  }
  if (spec.type === "ensureItem") {
    return createEnsureItemAction({
      ...spec,
      item: resolveItemId(spec.item),
    }, world);
  }
  if (spec.type === "lightFire") {
    return createLightFireAction(spec, world);
  }
  if (spec.type === "smelt") {
    return createSmeltAction(spec, world);
  }
  if (spec.type === "trainCombat") {
    return createTrainCombatAction(spec, world);
  }
  if (spec.type === "pvpCombat") {
    return createPvpCombatAction(spec, world?.pvpController ?? null);
  }
  if (spec.type === "wander") {
    return createWanderAction(spec, world);
  }
  if (spec.type === "followOwner") {
    return createFollowOwnerAction(spec, world);
  }
  if (spec.type === "fish") {
    return createFishAction({ ...spec, bait: spec.bait ? resolveItemId(spec.bait) : null }, world);
  }
  if (spec.type === "cook") {
    return createCookAction(spec, world);
  }
  throw new Error(`[bot activities] unknown action type '${spec.type}'`);
}

function compileActivity(definition, templates, world, options = {}) {
  const template = definition.template ? templates[definition.template] : null;
  if (definition.template && !template) {
    throw new Error(`[bot activities] unknown template '${definition.template}'`);
  }
  const merged = applyFields(
    template ? { ...template, ...definition } : definition,
    definition.fields ?? {}
  );
  return {
    id: merged.id,
    resolver: options.resolver === true,
    resolves: options.resolver === true ? merged.resolves ?? null : null,
    mode: merged.mode ?? null,
    capacity: Number.isFinite(merged.capacity) ? Math.max(1, Math.floor(merged.capacity)) : 1,
    repeat: merged.repeat === true,
    ephemeral: merged.ephemeral === true,
    manual: merged.manual === true,
    failureCooldownMs: Math.max(
      0,
      Math.floor(Number(merged.failureCooldownSeconds ?? 15)) * 1000
    ),
    requires: (merged.requires ?? []).map(createCondition),
    setup: (merged.setup ?? []).map(createCondition),
    actions: (merged.actions ?? []).map((action) => createAction(action, world)),
    produces: merged.produces ?? [],
    site: merged.site ?? null,
  };
}

/**
 * An action may name a gear table (`gearRef`) instead of carrying one inline; the tables
 * live in bot-combat-gear.json next to the activity definitions.
 */
function expandGearRefs(definition, gearTables) {
  if (!Array.isArray(definition?.actions)) {
    return definition;
  }
  const actions = definition.actions.map((action) => {
    const gearRef = action?.gearRef;
    if (!gearRef) {
      return action;
    }
    const gear = gearTables[gearRef];
    if (!gear) {
      throw new Error(`[bot activities] '${definition.id}' references unknown gear '${gearRef}'`);
    }
    const { gearRef: _ref, ...rest } = action;
    return { ...rest, ...gear };
  });
  return { ...definition, actions };
}

/**
 * Loads data-driven activities and their resolver links. Capacity slots
 * cap how many bots may run an activity at once; assignment happens only when a
 * brain goes idle, never per tick.
 */
function createBotActivityRegistry(options = {}) {
  const api = options.api ?? null;
  const world = options.world ?? {};
  const definitionsPath = options.definitionsPath ?? DEFAULT_DEFINITIONS_PATH;
  const raw = JSON.parse(fs.readFileSync(definitionsPath, "utf8"));
  if (!raw || typeof raw !== "object") {
    throw new Error("[bot activities] definitions must be an object");
  }
  const gearPath = options.combatGearPath ?? path.join(path.dirname(definitionsPath), "bot-combat-gear.json");
  const gearTables = JSON.parse(fs.readFileSync(gearPath, "utf8"));
  const templates = raw.templates ?? {};
  const activities = [];
  const resolvers = [];
  const byId = new Map();
  const fieldsById = new Map();
  for (const definition of raw.activities ?? []) {
    if (!definition?.id || byId.has(definition.id)) {
      throw new Error("[bot activities] activity ids must be unique");
    }
    // `fieldsFrom` copies another activity's fields first (a burn tier reuses its tree's
    // level and log), so only the differences stay in the file.
    let fields = definition.fields;
    if (definition.fieldsFrom) {
      const inherited = fieldsById.get(definition.fieldsFrom);
      if (!inherited) {
        throw new Error(
          `[bot activities] '${definition.id}' fieldsFrom unknown activity '${definition.fieldsFrom}'`
        );
      }
      fields = { ...inherited, ...(definition.fields ?? {}) };
    }
    fieldsById.set(definition.id, fields);
    const activity = compileActivity(expandGearRefs({ ...definition, fields }, gearTables), templates, world);
    activities.push(activity);
    byId.set(activity.id, activity);
  }
  for (const definition of raw.resolvers ?? []) {
    if (!definition?.id || byId.has(definition.id)) {
      throw new Error("[bot activities] resolver ids must be unique");
    }
    const resolver = compileActivity(definition, templates, world, { resolver: true });
    if (!resolver.resolves) {
      throw new Error(`[bot activities] resolver '${resolver.id}' needs a resolves key`);
    }
    resolvers.push(resolver);
    byId.set(resolver.id, resolver);
  }
  const slots = new Map();
  const lastActivityByPlayer = new WeakMap();
  const blockedUntilByPlayer = new WeakMap();

  function isBlocked(player, activityId, nowMs) {
    const until = blockedUntilByPlayer.get(player)?.get(activityId);
    return until !== undefined && until > nowMs;
  }

  function available(player, nowMs) {
    return activities.filter(
      (activity) =>
        activity.manual !== true &&
        (slots.get(activity.id) ?? 0) < activity.capacity &&
        !isBlocked(player, activity.id, nowMs) &&
        activity.requires.every((condition) => condition.check({ player }))
    );
  }

  return {
    activities,
    resolvers,
    byId,
    /** The Agility, Woodcutting, ... level an activity asks for (its `level` field). */
    levelOf(activityId) {
      return Number(fieldsById.get(activityId)?.level ?? 1);
    },
    /** An activity's data fields (its tool, log, bait ...). */
    fieldsOf(activityId) {
      return fieldsById.get(activityId) ?? {};
    },
    /** Builds an activity that isn't in the file (a task's own), from the same templates and actions. */
    compile(definition) {
      return compileActivity(expandGearRefs(definition, gearTables), templates, world);
    },
    hasRoom(activityId) {
      const activity = byId.get(activityId);
      return (
        !!activity && (slots.get(activity.id) ?? 0) < activity.capacity
      );
    },
    occupy(activity) {
      slots.set(activity.id, (slots.get(activity.id) ?? 0) + 1);
    },
    release(activity) {
      const next = Math.max(0, (slots.get(activity.id) ?? 0) - 1);
      slots.set(activity.id, next);
    },
    blockActivity(player, activityId, nowMs = Date.now(), durationMs = 15000) {
      let blocked = blockedUntilByPlayer.get(player);
      if (!blocked) {
        blocked = new Map();
        blockedUntilByPlayer.set(player, blocked);
      }
      blocked.set(activityId, nowMs + Math.max(0, durationMs));
    },
    /** `allowed` limits the pick to those ids; `avoid` excludes one (a rotation switch). */
    /** `weights` (id -> weight, default 1) biases a fresh pick, e.g. by a site's mode counts. */
    pickActivity(player, nowMs = Date.now(), { allowed = null, avoid = null, own = null, weights = null } = {}) {
      if (own) {
        // A bot going back to the activity it was given: only its failure cooldown
        // holds it back (capacity and `manual` are about handing out new activities).
        const activity = byId.get(own) ?? null;
        return activity && !isBlocked(player, own, nowMs) ? activity : null;
      }
      const previousId = lastActivityByPlayer.get(player);
      const candidates = available(player, nowMs).filter(
        (activity) => activity.id !== avoid && (!allowed || allowed.includes(activity.id))
      );
      const previous = candidates.find((activity) => activity.id === previousId);
      const weightOf = (activity) => Math.max(0, Number(weights?.[activity.id] ?? 1));
      let roll = Math.random() * candidates.reduce((sum, activity) => sum + weightOf(activity), 0);
      const picked = previous ?? candidates.find((activity) => (roll -= weightOf(activity)) < 0) ?? candidates[0] ?? null;
      if (picked) {
        lastActivityByPlayer.set(player, picked.id);
      }
      return picked;
    },
    resolversFor(condition) {
      const key = condition?.resolverKey;
      if (!key) {
        return [];
      }
      return resolvers.filter((resolver) => resolver.resolves === key);
    },
  };
}

module.exports = {
  createBotActivityRegistry,
};
