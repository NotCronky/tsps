"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * What a character owns and where it can buy the rest: bots progress like players, so a tool,
 * bait or food comes from their own inventory, equipment or bank, or is bought with their own
 * coins at a shop that stocks it. Nothing is ever conjured.
 */
const COINS = 995;
const SHOPS_FILE = path.join(process.cwd(), "data", "definitions", "shops.json");
let shopsBySellingItem = null;

function bankModule() {
  return require("../../../src/main/typescript/elvarg/game/model/container/impl/Bank");
}

/** How many of `itemId` the character has banked, over every tab. */
function bankedAmount(player, itemId) {
  const { Bank } = bankModule();
  let total = 0;
  for (let tab = 0; tab < Bank.TOTAL_BANK_TABS - 1; tab++) {
    const bank = player.getBank?.(tab);
    if (!bank) continue;
    for (const item of bank.getItems?.() ?? []) {
      if (item?.getId?.() === itemId) total += item.getAmount();
    }
  }
  return total;
}

function equippedAmount(player, itemId) {
  let total = 0;
  for (const item of player.getEquipment?.()?.getItems?.() ?? []) {
    if (item?.getId?.() === itemId) total += item.getAmount();
  }
  return total;
}

/** Carried: in the inventory or worn. */
function carriedAmount(player, itemId) {
  return (player.getInventory?.()?.getAmount?.(itemId) ?? 0) + equippedAmount(player, itemId);
}

function ownedAmount(player, itemId) {
  return carriedAmount(player, itemId) + bankedAmount(player, itemId);
}

/** The first of `ids` (best first) the character owns: { id, carried }; null when none. */
function bestOwned(player, ids) {
  for (const id of ids) {
    if (carriedAmount(player, id) > 0) return { id, carried: true };
    if (bankedAmount(player, id) > 0) return { id, carried: false };
  }
  return null;
}

/** Coin-priced shops by the items they stock: item id -> [{ shopId, npcIds }]. */
function shopsSelling(itemId, file = SHOPS_FILE) {
  if (!shopsBySellingItem) {
    shopsBySellingItem = new Map();
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const shop of Array.isArray(raw) ? raw : raw.shops ?? []) {
      if ((shop.currency ?? "COINS") !== "COINS") continue;
      const npcIds = (shop.npcInteractions ?? []).flatMap((link) => link.npcIds ?? []);
      if (npcIds.length === 0) continue;
      for (const stock of shop.originalStock ?? []) {
        if (!(stock.amount > 0)) continue;
        if (!shopsBySellingItem.has(stock.id)) shopsBySellingItem.set(stock.id, []);
        shopsBySellingItem.get(stock.id).push({ shopId: shop.id, npcIds });
      }
    }
  }
  return shopsBySellingItem.get(itemId) ?? [];
}

function canBuy(itemId) {
  return shopsSelling(itemId).length > 0;
}

/** A shop price estimate (the item's value), for deciding how many coins to take out. */
function priceEstimate(itemId) {
  const { ItemDefinition } = require("../../../src/main/typescript/elvarg/game/definition/ItemDefinition");
  const value = Number(ItemDefinition.forId(itemId)?.getValue?.() ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function coins(player) {
  return ownedAmount(player, COINS);
}

module.exports = {
  COINS,
  bankedAmount,
  bestOwned,
  canBuy,
  carriedAmount,
  coins,
  ownedAmount,
  priceEstimate,
  shopsSelling,
};
