"use strict";

const { playerState } = require("../ActionState.PlayerBots");
const { requestMovement } = require("../../behaviours/navigation/Navigation.PlayerBots");
const { createTravelToAction } = require("./TravelTo.PlayerBots");

/**
 * A Slayer task from a master, as a player gets one: walks to the master and clicks Assignment
 * (the Slayer plugin's own handler gives the task, or refuses), reading through what the master
 * says: "Yes, please." to Turael's offer to swap a task another master gave, else on to the end.
 * Succeeds once `done(player)` (a task, or a different one); fails when the master can't be found
 * or keeps refusing.
 *
 * Spec: { master(player) -> { npcIds, x, y, z }, done(player) }
 */
const CLICK_MS = 2400;
const NEAR_TILES = 12;
const FAIL_AFTER = 4;

const chebyshev = (a, b) => Math.max(Math.abs(a.getX() - b.x), Math.abs(a.getY() - b.y));

function createSlayerAssignmentAction(spec, world) {
  const { core } = world;
  const { done } = spec;
  const ACCEPT = ["yes, please.", "yes please", "yes"];

  const pick = (labels) => ACCEPT.map((wanted) => labels.findIndex((label) => label.startsWith(wanted))).find((index) => index >= 0) ?? 0;

  /** One step of an open dialogue: the accepting option, else the next line. True while one's open. */
  function talk(player) {
    // A transcript's menu is a chatbox prompt (npc-dialogue's), answered as a click on it.
    const Prompt = core.MultiChatboxPrompt;
    const prompt = Prompt?.getPending?.(player);
    if (prompt) {
      const index = pick(prompt.options.map((option) => String(option ?? "").toLowerCase()));
      Prompt.handleInterfaceActionClick({ player, buttonId: Prompt.OPTIONS_WIDGET_ID, groupId: 219, slot: index + 1, action: index + 1 });
      return true;
    }
    const dialogue = player.getDialogueManager?.();
    if (!dialogue?.isActive?.()) return false;
    const current = dialogue.getCurrent();
    const options = current?.getOptions?.();
    if (Array.isArray(options)) {
      const labels = options.map((option) => String(option?.getText?.() ?? option?.text ?? option ?? "").toLowerCase());
      dialogue.handleOption(pick(labels) + 1);
    } else {
      dialogue.advance();
    }
    return true;
  }
  const stateFor = (player) => playerState(action, player, () => ({ clickedAt: 0, tries: 0 }));

  const action = {
    id: "slayerAssignment",
    update(ctx) {
      const { player, nowMs } = ctx;
      const bot = stateFor(player);
      if (done(player)) {
        player.getDialogueManager?.()?.reset?.();
        player.getPacketSender?.()?.sendInterfaceRemoval?.();
        return "success";
      }
      if (talk(player)) return "running";
      if (player.getMovementQueue().size() > 0 || nowMs - bot.clickedAt < CLICK_MS) return "running";
      const master = spec.master(player);
      const here = player.getLocation();
      if (here.getZ() !== master.z || chebyshev(here, master) > NEAR_TILES) {
        // To them as it travels anywhere: walking, or a teleport (a fairy ring to Canifis).
        const key = `${master.x},${master.y},${master.z}`;
        if (bot.travelKey !== key) {
          bot.travel = createTravelToAction({ x: master.x, y: master.y, z: master.z, radius: NEAR_TILES - 2 }, world);
          bot.travelKey = key;
        }
        const result = bot.travel.update(ctx);
        if (result === "failed") return "failed";
        return "running";
      }
      const npc = (core.World.getNpcsNear?.(here, NEAR_TILES + 4, player.getPrivateArea?.() ?? null) ?? [])
        .find((candidate) => master.npcIds.includes(candidate.getId()));
      bot.clickedAt = nowMs;
      // Not in sight yet (the area still loading), or Assignment keeps giving nothing: a few tries.
      if (++bot.tries > FAIL_AFTER) return "failed";
      if (!npc) return "running";
      // Right up to them by the brain's walk first: it opens doors (Turael's house in Burthorpe).
      const at = npc.getLocation();
      if (Math.max(Math.abs(at.getX() - here.getX()), Math.abs(at.getY() - here.getY())) > 1) {
        requestMovement(player, at.getX(), at.getY(), { nowMs, z: at.getZ(), reason: "brain_slayer_master", basicPather: true });
        bot.tries -= 1;
        return "running";
      }
      const definition = npc.getCurrentDefinition?.(player) ?? npc.getDefinition?.();
      // Assignment is the masters' third option.
      player.getMovementQueue().walkToEntity(npc, () => {
        const at = npc.getLocation();
        world.emitNpcInteraction?.({
          player, npc, npcId: npc.getId(), npcIndex: npc.getIndex(), clickType: 3, definition,
          location: { x: at.getX(), y: at.getY(), z: at.getZ() }, handled: false,
        });
      }, 1);
      return "running";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.clickedAt = 0;
      bot.tries = 0;
      bot.travel?.stop?.(ctx);
      bot.travel = null;
      bot.travelKey = null;
    },
    madeProgress() {
      return true;
    },
    describe() {
      return "getting a Slayer task";
    },
  };
  return action;
}

module.exports = { createSlayerAssignmentAction };
