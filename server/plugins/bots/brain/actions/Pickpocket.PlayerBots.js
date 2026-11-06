"use strict";

const { playerState } = require("../ActionState.PlayerBots");
const { requestMovement } = require("../../behaviours/navigation/Navigation.PlayerBots");

/**
 * Pickpockets the nearest of `npcs` (names) as a player does: "Pickpocket" through the normal
 * NPC option code, so the Thieving plugin rolls it, stuns, hits and pays out. Between attempts it
 * eats its own food when hurt (the food's own Eat option) and opens its coin pouches before they
 * fill up. Completes when the inventory is full (the activity banks and goes again); fails when
 * it's hurt with nothing left to eat, or nobody to pickpocket is about.
 *
 * JSON: { "type": "pickpocket", "npcs": ["Man", "Woman"], "food": [itemId, ...], "pouch": itemId }
 */
const SEARCH_TILES = 24;
const CLICK_MS = 1800;
const EAT_BELOW = 0.5;
const GIVE_UP_BELOW = 0.35;
// The Thieving plugin stops at 28 pouches; open them a little before.
const OPEN_POUCHES_AT = 24;
const NOBODY_MS = 30000;

function createPickpocketAction(spec, world) {
  const { core } = world;
  const names = new Set((spec.npcs ?? []).map((name) => String(name).toLowerCase()));
  const food = spec.food ?? [];
  const pouch = spec.pouch ?? null;
  const stateFor = (player) => playerState(action, player, () => ({ clickedAt: 0, nobodySince: 0 }));
  const chebyshev = (a, b) => Math.max(Math.abs(a.getX() - b.getX()), Math.abs(a.getY() - b.getY()));
  const definitionOf = (npc, player) => npc.getCurrentDefinition?.(player) ?? npc.getDefinition?.();
  const clickTypeOf = (npc, player) => (definitionOf(npc, player)?.getActions?.() ?? []).indexOf("Pickpocket") + 1;

  function click(player, itemId) {
    const slot = player.getInventory().getItems().findIndex((item) => item?.getId?.() === itemId);
    if (slot >= 0) core.ItemActionPacketListener.handleAction(player, core.Inventory.INTERFACE_ID, itemId, slot, 1);
    return slot >= 0;
  }

  function nearestTarget(player) {
    const loc = player.getLocation();
    let best = null;
    let bestDistance = Infinity;
    for (const npc of core.World.getNpcsNear(loc, SEARCH_TILES, player.getPrivateArea?.() ?? null)) {
      if (npc.isRegistered?.() === false || npc.getHitpoints?.() <= 0) continue;
      const name = String(definitionOf(npc, player)?.getName?.() ?? "").toLowerCase();
      if (!names.has(name) || clickTypeOf(npc, player) <= 0) continue;
      const at = npc.getLocation();
      if (at.getZ() !== loc.getZ()) continue;
      const distance = chebyshev(at, loc);
      if (distance < bestDistance) {
        best = npc;
        bestDistance = distance;
      }
    }
    return best;
  }

  const action = {
    id: "pickpocket",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      if (nowMs - bot.clickedAt < CLICK_MS) return "running";
      const skills = player.getSkillManager();
      const health = skills.getCurrentLevel(core.Skill.HITPOINTS) / Math.max(1, skills.getMaxLevel(core.Skill.HITPOINTS));
      if (health < EAT_BELOW) {
        const meal = food.find((id) => player.getInventory().getAmount(id) > 0);
        if (meal !== undefined) {
          bot.clickedAt = nowMs;
          click(player, meal);
          return "running";
        }
        if (health < GIVE_UP_BELOW) return "failed";
      }
      if (pouch !== null && player.getInventory().getAmount(pouch) >= OPEN_POUCHES_AT) {
        bot.clickedAt = nowMs;
        click(player, pouch);
        return "running";
      }
      if (player.getInventory().isFull()) return "success";
      if (player.getMovementQueue().size() > 0) return "running";
      const npc = nearestTarget(player);
      if (!npc) {
        bot.nobodySince ||= nowMs;
        return nowMs - bot.nobodySince >= NOBODY_MS ? "failed" : "running";
      }
      bot.nobodySince = 0;
      bot.clickedAt = nowMs;
      const clickType = clickTypeOf(npc, player);
      if (chebyshev(npc.getLocation(), player.getLocation()) > 12) {
        requestMovement(player, npc.getLocation().getX(), npc.getLocation().getY(), { nowMs, z: npc.getLocation().getZ(), reason: "brain_pickpocket_walk" });
        return "running";
      }
      player.getMovementQueue().walkToEntity(npc, () => {
        const at = npc.getLocation();
        world.emitNpcInteraction?.({
          player, npc, npcId: npc.getId(), npcIndex: npc.getIndex(), clickType,
          location: { x: at.getX(), y: at.getY(), z: at.getZ() }, handled: false,
        });
      }, 1);
      return "running";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.clickedAt = 0;
      bot.nobodySince = 0;
    },
    madeProgress(ctx) {
      return stateFor(ctx.player).nobodySince === 0;
    },
    describe() {
      return `pickpocket ${[...names].join("/")}`;
    },
  };
  return action;
}

module.exports = { createPickpocketAction };
