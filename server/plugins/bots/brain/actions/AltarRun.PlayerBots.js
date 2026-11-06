"use strict";

const { playerState } = require("../ActionState.PlayerBots");
const { requestMovement } = require("../../behaviours/navigation/Navigation.PlayerBots");
const HouseHost = require("../../lib/HouseHost.PlayerBots");

/**
 * Trains Prayer at the house host's gilded altar, as players do at a house party:
 *   carrying bones: into the host's house at the Rimmington portal, bones on the altar (the
 *     offering loop offers them all, the burners the host keeps lit adding their bonus);
 *   out of bones: out through the portal, the noted bones on Phials, "Exchange all", and back in.
 * Everything goes through the plugins' own code: the house visit and exit (Construction), the
 * offering (Construction and BoneAltars), the exchange (NoteExchange, 5 coins a bone). Completes
 * when the noted bones are all offered; fails when there's no host, no coins, or Phials won't.
 *
 * JSON: { "type": "altarRun", "bone": itemId }
 */
const ALTARS = ["OAK_ALTAR", "TEAK_ALTAR", "CLOTH_ALTAR", "MAHOGANY_ALTAR", "LIMESTONE_ALTAR", "MARBLE_ALTAR", "GILDED_ALTAR"];
const CLICK_MS = 1800;
// Bones no fewer for this long while offering: offer again (a level-up, the loop stopped).
const OFFER_IDLE_MS = 6000;
const NEAR_TILES = 3;
const FAIL_AFTER = 6;
const PHIALS_FEE = 5;
// The exchange menu: 1, 5, all, X, Cancel.
const EXCHANGE_ALL = 3;

const chebyshev = (a, b) => Math.max(Math.abs(a.getX() - b.x), Math.abs(a.getY() - b.y));

function createAltarRunAction(spec, world) {
  const { core } = world;
  const bone = spec.bone;
  const note = core.ItemDefinition.forId(bone)?.getNoteId?.() ?? -1;
  const stateFor = (player) => playerState(action, player, () => ({ clickedAt: null, held: null, changedAt: 0, tries: 0 }));

  const furniture = (player) => {
    const request = { player, keys: ALTARS, objects: [] };
    world.emitCustomEvent?.("construction:furniture", request);
    return request.objects;
  };
  const slotOf = (player, id) => player.getInventory().getItems().findIndex((item) => item?.getId?.() === id);

  function offer(player, altar) {
    const at = altar.getLocation();
    player.getMovementQueue().walkToObject(altar, {
      execute: () => {
        const slot = slotOf(player, bone);
        if (slot < 0) return;
        world.emitItemOnObject?.({
          player, object: altar, objectId: altar.getId(), item: player.getInventory().getItems()[slot], itemId: bone,
          itemSlot: slot, interfaceType: 0, location: { x: at.getX(), y: at.getY(), z: at.getZ() }, handled: false,
        });
      },
    });
  }

  function walkTo(player, tile, nowMs) {
    requestMovement(player, tile.x, tile.y, { nowMs, z: tile.z, reason: "brain_altar_walk" });
  }

  function exchange(player, nowMs) {
    const phials = core.World.getNpcsNear(player.getLocation(), 16, null)
      .find((npc) => String(npc.getDefinition?.()?.getName?.() ?? "") === "Phials");
    if (!phials) {
      walkTo(player, HouseHost.PHIALS, nowMs);
      return;
    }
    // Phials' "Exchange all" menu from the last use: take it.
    if (player.getDialogueManager?.()) player.getDialogueManager().handleOption?.(EXCHANGE_ALL);
    const slot = slotOf(player, note);
    if (slot >= 0) core.UseItemPacketListener.itemOnNpc(player, core.Inventory.INTERFACE_ID, phials.getIndex(), note, slot);
  }

  const action = {
    id: "altarRun",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      const host = HouseHost.host();
      if (!host) return "failed";
      if (player.getMovementQueue().size() > 0) return "running";
      const held = player.getInventory().getAmount(bone);
      if (held !== bot.held) {
        bot.held = held;
        bot.changedAt = nowMs;
        bot.tries = 0;
      }
      if (bot.clickedAt !== null && nowMs - bot.clickedAt < CLICK_MS) return "running";
      const inside = player.getPrivateArea?.() != null;
      if (held > 0 && inside) {
        // Offering: the altar's loop takes them one by one.
        if (nowMs - bot.changedAt < OFFER_IDLE_MS && bot.clickedAt !== null) return "running";
        const altar = furniture(player)[0]?.object;
        if (!altar || ++bot.tries > FAIL_AFTER) return "failed";
        bot.clickedAt = nowMs;
        offer(player, altar);
        return "running";
      }
      if (inside) {
        bot.clickedAt = nowMs;
        world.emitCustomEvent?.("construction:leave-house", { player, handled: false });
        return "running";
      }
      if (held > 0) {
        if (chebyshev(player.getLocation(), HouseHost.PORTAL) > NEAR_TILES) {
          walkTo(player, HouseHost.PORTAL, nowMs);
          return "running";
        }
        if (++bot.tries > FAIL_AFTER) return "failed";
        bot.clickedAt = nowMs;
        world.emitCustomEvent?.("construction:visit-house", { player, owner: host.getUsername(), handled: false });
        return "running";
      }
      if (player.getInventory().getAmount(note) <= 0) return "success";
      if (player.getInventory().getAmount(core.ItemIdentifiers.COINS) < PHIALS_FEE) return "failed";
      if (++bot.tries > FAIL_AFTER * 2) return "failed";
      bot.clickedAt = nowMs;
      exchange(player, nowMs);
      return "running";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.clickedAt = null;
      bot.held = null;
      bot.tries = 0;
    },
    madeProgress(ctx) {
      return stateFor(ctx.player).tries <= 2;
    },
    describe(ctx) {
      return `gilded altar (${ctx.player.getPrivateArea?.() ? "offering" : "unnoting at Phials"})`;
    },
  };
  return action;
}

module.exports = { createAltarRunAction };
