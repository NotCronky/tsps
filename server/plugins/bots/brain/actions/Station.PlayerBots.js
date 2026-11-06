"use strict";

const { playerState } = require("../ActionState.PlayerBots");
const { resolveCatalogObjectIds } = require("../ObjectCatalog.PlayerBots");
const { approachObject, approachBlockedObject } = require("../../behaviours/navigation/Navigation.PlayerBots");
const { createObjectReachChecker } = require("../../behaviours/navigation/ObjectReach.PlayerBots");

/**
 * Works a crafting station as a player does, until `material` is used up: walks to the nearest of
 * `catalog` (a spinning wheel, potter's wheel, pottery oven, furnace), then either clicks its
 * `option` ("Spin", "Use", "Fire") or uses `use` on it (a gold bar on a furnace), and answers what
 * that opens: the make menu (`output`, "All"), or a plugin's bot entry (`event`, given `output`
 * as its itemId: "crafting:furnace-make" for the jewellery menu). The plugin does the making,
 * with its own checks, timing and XP.
 *
 * JSON: { "type": "station", "catalog": "spinning wheel", "option": "Spin", "material": id, "output": id }
 *       { "type": "station", "catalog": "furnace", "use": goldBar, "event": "crafting:furnace-make", "material": goldBar, "output": ring }
 */
// Far enough to find the station from the bank it was stocked at (Edgeville to Barbarian Village).
const SEARCH_TILES = 96;
const DIRECT_ROUTE_TILES = 20;
const MAKE_ALL = 28;
// Nothing used up this long after a click: click again; this many in a row: it can't here.
const IDLE_MS = 6000;
const FAILED_CLICKS = 3;

const chebyshev = (a, b) => Math.max(Math.abs(a.getX() - b.getX()), Math.abs(a.getY() - b.getY()));

function createStationAction(spec, world) {
  const { core } = world;
  const ids = resolveCatalogObjectIds({ catalog: spec.catalog });
  const { option = null, use = null, event = null, material, output } = spec;
  const stateFor = (player) => playerState(action, player, () => ({ clickedAt: 0, held: null, failures: 0 }));
  const canReach = createObjectReachChecker(core);

  function nearest(player) {
    const loc = player.getLocation();
    let best = null;
    let bestDistance = Infinity;
    for (const object of world.objectSearch?.findCandidatesByIds?.(player, ids, {
      regionRadius: 2, z: loc.getZ(), privateArea: player.getPrivateArea?.() ?? null,
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

  function answer(player) {
    if (event) {
      world.emitCustomEvent?.(event, { player, itemId: output, handled: false });
      return;
    }
    const menu = player.getCreationMenu?.();
    if (!menu) return;
    const items = menu.getItems?.() ?? [];
    player.getPacketSender().closeCreationMenu?.();
    // Not on offer (a quest it hasn't done): nothing made, and the clicks run out.
    if (items.includes(output)) menu.execute(output, MAKE_ALL);
  }

  function click(player, object) {
    const at = object.getLocation();
    const definition = core.ObjectDefinition?.forPlayer?.(object.getId(), player) ?? object.getDefinition?.();
    const clickType = option ? (definition?.getActions?.() ?? []).indexOf(option) + 1 : 0;
    player.getMovementQueue().walkToObject(object, {
      execute: () => {
        const location = { x: at.getX(), y: at.getY(), z: at.getZ() };
        if (use !== null) {
          const slot = player.getInventory().getItems().findIndex((item) => item?.getId?.() === use);
          if (slot < 0) return;
          world.emitItemOnObject?.({
            player, object, objectId: object.getId(), item: player.getInventory().getItems()[slot], itemId: use,
            itemSlot: slot, interfaceType: 0, location, handled: false,
          });
        } else {
          world.emitObjectInteraction?.({
            player, object, objectId: object.getId(), clickType, definition, location,
            sourceLocation: { x: player.getLocation().getX(), y: player.getLocation().getY(), z: player.getLocation().getZ() },
            handled: false,
          });
        }
        answer(player);
      },
    }, clickType);
  }

  const action = {
    id: "station",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      const held = player.getInventory().getAmount(material);
      if (held <= 0) return "success";
      if (bot.held !== null && held < bot.held) {
        bot.failures = 0;
        bot.clickedAt = nowMs;
      }
      bot.held = held;
      if (player.getMovementQueue().size() > 0) return "running";
      if (bot.clickedAt > 0 && nowMs - bot.clickedAt < IDLE_MS) return "running";
      const object = nearest(player);
      if (!object) return "failed";
      if (chebyshev(object.getLocation(), player.getLocation()) > DIRECT_ROUTE_TILES) {
        approachObject(player, object, { nowMs, reason: "brain_station_approach" });
        return "running";
      }
      // Behind a door (Falador farm's loom): the brain's walk opens it on the way.
      if (approachBlockedObject(player, object, { nowMs, reason: "brain_station_approach", canReach })) return "running";
      if (bot.clickedAt > 0 && ++bot.failures > FAILED_CLICKS) return "failed";
      bot.clickedAt = nowMs;
      click(player, object);
      return "running";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.clickedAt = 0;
      bot.held = null;
      bot.failures = 0;
    },
    madeProgress(ctx) {
      return stateFor(ctx.player).failures === 0;
    },
    describe() {
      return `making ${output} at a ${spec.catalog}`;
    },
  };
  return action;
}

module.exports = { createStationAction };
