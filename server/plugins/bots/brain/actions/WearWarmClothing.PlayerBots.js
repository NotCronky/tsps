"use strict";

const { createBankAction } = require("./Bank.PlayerBots");
const { playerState } = require("../ActionState.PlayerBots");

/**
 * Wears warm clothing for the Wintertodt, as a player gets ready: up to four pieces (what the
 * Wiki's warmth counts), one per equipment slot, from what it already wears, carries or has banked.
 * Which items are warm is the Wintertodt plugin's to say ("wintertodt:is-warm"). Banked pieces are
 * taken out in one bank visit, then put on through the normal equip code (wear requirements apply;
 * what they replace goes into the inventory). Nothing warm owned: it simply goes without.
 */
const MAX_WARM = 4;

function createWearWarmClothingAction(world) {
  const stateFor = (player) => playerState(action, player, () => ({ bankStep: null, fetched: false }));
  const { core } = world;

  const isWarm = (itemId) => {
    const request = { itemId, warm: false };
    world.emitCustomEvent?.("wintertodt:is-warm", request);
    return request.warm === true;
  };
  const slotOf = (itemId) => core.ItemDefinition.forId(itemId)?.getEquipmentType?.()?.getSlot?.() ?? -1;

  /** Warm pieces to put on: one per slot not already warm, up to MAX_WARM, carried before banked. */
  function wanted(player) {
    const worn = player.getEquipment().getItems();
    const warmSlots = new Set();
    worn.forEach((item, slot) => {
      if ((item?.getId?.() ?? -1) > 0 && isWarm(item.getId())) warmSlots.add(slot);
    });
    const picks = new Map();
    const consider = (item, banked) => {
      const id = item?.getId?.() ?? -1;
      if (id <= 0 || warmSlots.size + picks.size >= MAX_WARM) return;
      const slot = slotOf(id);
      if (slot < 0 || warmSlots.has(slot) || picks.has(slot) || !isWarm(id)) return;
      picks.set(slot, { id, banked });
    };
    for (const item of player.getInventory().getItems()) consider(item, false);
    for (let tab = 0; tab < 10; tab++) {
      for (const item of player.getBank?.(tab)?.getItems?.() ?? []) consider(item, true);
    }
    return [...picks.values()];
  }

  function wear(player, itemId) {
    const slot = player.getInventory().getItems().findIndex((item) => item?.getId?.() === itemId);
    if (slot >= 0) core.EquipPacketListener.equip(player, itemId, slot, core.Inventory.INTERFACE_ID);
  }

  const action = {
    id: "wearWarmClothing",
    update(ctx) {
      const { player } = ctx;
      const bot = stateFor(player);
      if (bot.bankStep) {
        const result = bot.bankStep.update(ctx);
        if (result !== "success" && result !== "failed") return "running";
        bot.bankStep.stop?.(ctx);
        bot.bankStep = null;
      }
      const picks = wanted(player);
      const banked = picks.filter((pick) => pick.banked);
      if (banked.length > 0 && !bot.fetched) {
        bot.fetched = true;
        bot.bankStep = createBankAction({ withdraw: banked.map((pick) => ({ item: pick.id, amount: 1 })) }, world);
        return "running";
      }
      for (const pick of picks) if (!pick.banked) wear(player, pick.id);
      bot.fetched = false;
      return "success";
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      bot.bankStep?.stop?.(ctx);
      bot.bankStep = null;
      bot.fetched = false;
    },
    madeProgress(ctx) {
      return stateFor(ctx.player).bankStep?.madeProgress?.(ctx) ?? true;
    },
  };
  return action;
}

module.exports = { createWearWarmClothingAction, MAX_WARM };
