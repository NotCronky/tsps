"use strict";

const { playerState } = require("../ActionState.PlayerBots");
const { approachObject, approachBlockedObject } = require("../../behaviours/navigation/Navigation.PlayerBots");
const { createObjectReachChecker } = require("../../behaviours/navigation/ObjectReach.PlayerBots");

// The essence pouches, as the Runecrafting plugin keeps them (Pouches.Runecrafting.js): their
// cache names (and decayed ones'), the level each needs, and their key in its saved state.
const POUCHES = [
  { key: "small", items: ["rcu_pouch_small"], level: 1 },
  { key: "medium", items: ["rcu_pouch_medium", "rcu_pouch_medium_degrade"], level: 25 },
  { key: "large", items: ["rcu_pouch_large", "rcu_pouch_large_degrade"], level: 50 },
  { key: "giant", items: ["rcu_pouch_giant", "rcu_pouch_giant_degrade"], level: 75 },
  { key: "colossal", items: ["rcu_pouch_colossal", "rcu_pouch_colossal_degrade"], level: 25 },
];
const POUCHES_ATTRIBUTE = "runecrafting:pouches";

/** [{ key, ids, level }] with the pouches' item ids from the cache. */
function pouchTypes(core) {
  return POUCHES.map((pouch) => ({
    ...pouch,
    ids: pouch.items.map((name) => core.CacheDefinitions?.getObjId?.(name)).filter((id) => Number.isInteger(id) && id >= 0),
  }));
}

/** The essence a pouch holds, from the plugin's saved state. */
function pouchHolds(player, key) {
  return Number(player.getAttribute(POUCHES_ATTRIBUTE)?.[key]?.amount ?? 0);
}

/** The carried pouches: [{ key, id, slot }]. */
function carriedPouches(player, core) {
  const items = player.getInventory().getItems();
  const found = [];
  for (const pouch of pouchTypes(core)) {
    const slot = items.findIndex((item) => pouch.ids.includes(item?.getId?.()));
    if (slot >= 0) found.push({ key: pouch.key, id: items[slot].getId(), slot });
  }
  return found;
}

/** An inventory item's named option (Fill, Empty), clicked as a player does. */
function clickItemOption(player, core, { id, slot }, option) {
  const options = core.CacheDefinitions?.getItem?.(id)?.inventoryActions ?? [];
  const clickType = options.indexOf(option) + 1;
  if (clickType <= 0) return false;
  core.ItemActionPacketListener.handleAction(player, core.Inventory.INTERFACE_ID, id, slot, clickType, option);
  return true;
}

/**
 * Fills its empty essence pouches from the essence it carries, one a tick (the plugin's Fill):
 * done when every carried pouch holds some, or the essence is gone.
 */
function createFillPouchesAction(spec, world) {
  const { core } = world;
  return {
    id: "fillPouches",
    update({ player }) {
      const essence = (spec.essence ?? []).some((id) => player.getInventory().getAmount(id) > 0);
      if (!essence) return "success";
      // Only empty ones: Fill on a full pouch empties it.
      const empty = carriedPouches(player, core).find((pouch) => pouchHolds(player, pouch.key) <= 0);
      if (!empty) return "success";
      const before = player.getInventory().getFreeSlots();
      clickItemOption(player, core, empty, "Fill");
      // Refused (its level, another essence in it): left as it is.
      return player.getInventory().getFreeSlots() > before ? "running" : "success";
    },
  };
}

/**
 * One Runecraft trip from the ruins, as a player makes it: in through the mysterious ruins (its
 * talisman used on them, or Enter with the tiara worn), Craft-rune at the altar (then each essence
 * pouch emptied and Craft-rune again), and out through the altar's portal. The Runecrafting plugin does the entering, the binding (its levels,
 * multiples and XP) and the portal. Succeeds once the essence is bound and it's back outside;
 * fails when the ruins, altar or portal can't be found or keep refusing.
 *
 * Spec: { ruins: [ids], altar: id, portal: id, talisman: id, tiara: id, essence: [ids] }
 */
const SEARCH_TILES = 40;
const DIRECT_ROUTE_TILES = 20;
const CLICK_MS = 3000;
const FAIL_AFTER = 6;

const chebyshev = (a, b) => Math.max(Math.abs(a.getX() - b.getX()), Math.abs(a.getY() - b.getY()));

function createCraftRunesAction(spec, world) {
  const { core } = world;
  const { ruins, altar, portal, talisman, tiara, essence } = spec;
  const canReach = createObjectReachChecker(core);
  const stateFor = (player) => playerState(action, player, () => ({ clickedAt: 0, tries: 0, step: null }));

  function nearest(player, ids) {
    const loc = player.getLocation();
    let best = null;
    let bestDistance = Infinity;
    for (const object of world.objectSearch?.findCandidatesByIds?.(player, ids, {
      regionRadius: 1, z: loc.getZ(), privateArea: player.getPrivateArea?.() ?? null,
    }) ?? []) {
      const at = object?.getLocation?.();
      if (!at || at.getZ() !== loc.getZ()) continue;
      const distance = chebyshev(at, loc);
      if (distance <= SEARCH_TILES && distance < bestDistance) {
        best = object;
        bestDistance = distance;
      }
    }
    return best;
  }

  const definitionOf = (player, object) => core.ObjectDefinition?.forPlayer?.(object.getId(), player) ?? object.getDefinition?.();
  const optionOf = (player, object, option) => (definitionOf(player, object)?.getActions?.() ?? []).indexOf(option) + 1;
  const slotOf = (player, id) => player.getInventory().getItems().findIndex((item) => item?.getId?.() === id);
  const location = (object) => ({ x: object.getLocation().getX(), y: object.getLocation().getY(), z: object.getLocation().getZ() });

  /** Its option clicked (or `item` used on it) once walked to, as a player's click does. */
  function interact(player, object, { option = null, item = null }) {
    const clickType = option ? optionOf(player, object, option) : 0;
    if (option && clickType <= 0) return false;
    player.getMovementQueue().walkToObject(object, {
      execute: () => {
        if (item !== null) {
          const slot = slotOf(player, item);
          if (slot < 0) return;
          world.emitItemOnObject?.({
            player, object, objectId: object.getId(), item: player.getInventory().getItems()[slot], itemId: item,
            itemSlot: slot, interfaceType: 0, location: location(object), handled: false,
          });
          return;
        }
        world.emitObjectInteraction?.({
          player, object, objectId: object.getId(), clickType, definition: definitionOf(player, object), location: location(object),
          sourceLocation: { x: player.getLocation().getX(), y: player.getLocation().getY(), z: player.getLocation().getZ() },
          handled: false,
        });
      },
    }, clickType);
    return true;
  }

  /** Walks to it first when it's far or walled off; true while that's under way. */
  function approach(player, object, nowMs) {
    if (chebyshev(object.getLocation(), player.getLocation()) > DIRECT_ROUTE_TILES) {
      approachObject(player, object, { nowMs, reason: "brain_runecraft_approach" });
      return true;
    }
    return approachBlockedObject(player, object, { nowMs, reason: "brain_runecraft_approach", canReach });
  }

  const action = {
    id: "craftRunes",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      if (player.getMovementQueue().size() > 0) return "running";
      if (nowMs - bot.clickedAt < CLICK_MS) return "running";
      const carrying = essence.some((id) => player.getInventory().getAmount(id) > 0);
      const altarHere = nearest(player, [altar]);
      // Bound: the pouches emptied for another load; then out through the portal; outside, done.
      const full = altarHere && !carrying ? carriedPouches(player, core).find((pouch) => pouchHolds(player, pouch.key) > 0) : null;
      if (full) {
        bot.clickedAt = nowMs - CLICK_MS + 600;
        clickItemOption(player, core, full, "Empty");
        return "running";
      }
      const step = !carrying ? (altarHere ? "portal" : "done") : altarHere ? "altar" : "ruins";
      if (step === "done") return "success";
      if (step !== bot.step) {
        bot.step = step;
        bot.tries = 0;
      }
      if (++bot.tries > FAIL_AFTER) return "failed";
      const target = step === "altar" ? altarHere : nearest(player, step === "portal" ? [portal] : ruins);
      if (!target) return "failed";
      if (approach(player, target, nowMs)) {
        bot.tries -= 1;
        return "running";
      }
      bot.clickedAt = nowMs;
      if (step === "altar") return interact(player, target, { option: "Craft-rune" }) ? "running" : "failed";
      if (step === "portal") return interact(player, target, { option: "Use" }) ? "running" : "failed";
      // The ruins: Enter with the tiara on, else its talisman used on them.
      const wearsTiara = player.getEquipment().getItems().some((item) => item?.getId?.() === tiara);
      if (wearsTiara && interact(player, target, { option: "Enter" })) return "running";
      if (slotOf(player, talisman) < 0) return "failed";
      interact(player, target, { item: talisman });
      return "running";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.clickedAt = 0;
      bot.tries = 0;
      bot.step = null;
    },
    madeProgress(ctx) {
      return stateFor(ctx.player).tries <= 2;
    },
    describe(ctx) {
      return `runecrafting (${stateFor(ctx.player).step ?? "starting"})`;
    },
  };
  return action;
}

module.exports = { createCraftRunesAction, createFillPouchesAction, pouchTypes, pouchHolds };
