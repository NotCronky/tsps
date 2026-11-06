/**
 * Bow of Faerdhinen charges (https://oldschool.runescape.wiki/w/Bow_of_Faerdhinen).
 *
 * The bow fires its own crystal arrows and spends one charge per shot. Crystal shards add 100
 * charges each up to 20,000, waking an inactive bow; at zero it reverts to its inactive form.
 * Uncharge returns a shard per whole 100 charges left and leaves the bow inactive. The
 * coloured (c) bows never spend charges.
 *
 * A charged bow with no saved count (spawned, or from before charges were tracked) counts as
 * full.
 *
 * Corruption (Wiki, Bow of Faerdhinen (c)): at a Prifddinas singing bowl a bow and 2,000 crystal
 * shards, less one per 100 charges it holds, make the Bow of Faerdhinen (c): 82 Smithing and
 * Crafting (boostable), no experience, "With the help of the crystal bowl, you sing a dark song
 * which corrupts the crystals." It's offered in the bowl's menu (CrystalSinging).
 *
 * Recolouring (Wiki, Crystal of Hefin): a clan's crystal used on any colour of the corrupted bow
 * gives that clan's colour and is used up; the Crystal of Hefin brings back the original red.
 * The ids by clan are the ones CrystalBow's arrow table names (their colours match the clans').
 */
const MAX_CHARGES = 20000;
const SHARD_CHARGES = 100;
const CHARGES_META_KEY = "bow-of-faerdhinen";

let core = null;
let api = null;
let chargedId = -1;
let inactiveIds = new Set();
let bowIds = new Set();
// The corrupted bow's id by clan, and the clan by id.
let corruptedByClan = new Map();
let clanByCorrupted = new Map();

const CORRUPT_SHARDS = 2000;
const CORRUPT_LEVEL = 82;
const CORRUPT_MESSAGE = "With the help of the crystal bowl, you sing a dark song which corrupts the crystals.";
const CLANS = ["Hefin", "Ithell", "Iorwerth", "Trahaearn", "Cadarn", "Crwys", "Meilyr", "Amlodd"];

function charges(item) {
  const saved = Number(item?.getMetaValue?.(CHARGES_META_KEY)?.charges);
  if (Number.isFinite(saved)) {
    return Math.max(0, Math.min(MAX_CHARGES, Math.floor(saved)));
  }
  return item?.getId?.() === chargedId ? MAX_CHARGES : 0;
}

function refresh(player) {
  player.getInventory().refreshItems();
  player.getEquipment().refreshItems();
}

function plural(count, word) {
  return `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;
}

function wieldedBow(player) {
  const weapon = player.getEquipment().getItems()[core.Equipment.WEAPON_SLOT];
  return weapon && bowIds.has(weapon.getId()) ? weapon : null;
}

/** Spends `shots` charges; the bow turns inactive when the last one goes. */
function useCharges(player, bow, shots) {
  let left = charges(bow);
  for (let shot = 0; shot < shots && left > 0; shot++) {
    // Content may spare the charge (a league relic): the question every charged weapon asks.
    const consume = { player, itemId: bow.getId(), skip: false };
    api?.emitCustomEvent("combat:consume-charge", consume);
    if (!consume.skip) {
      left -= 1;
    }
  }
  if (left > 0) {
    bow.setMetaValue(CHARGES_META_KEY, { charges: left });
    return;
  }
  bow.setId(core.ItemIdentifiers.BOW_OF_FAERDHINEN_INACTIVE_);
  bow.setMetaValue(CHARGES_META_KEY, undefined);
  refresh(player);
  core.BonusManager?.update?.(player);
  player.getUpdateFlag?.()?.flag?.(core.Flag?.APPEARANCE);
  player.sendMessage("Your bow of Faerdhinen has run out of charges.");
}

/** The bow is its own ammunition: claim the shot so the bow itself is never dropped or broken. */
const ammoHandler = {
  checkAmmo() {
    return null;
  },
  decrementAmmo(player, _pos, amount) {
    const bow = wieldedBow(player);
    if (!bow) {
      return false;
    }
    if (bow.getId() === chargedId) {
      useCharges(player, bow, Math.max(1, Number(amount) || 1));
    }
    return true;
  },
};

function checkCharges({ player, item }) {
  player.sendMessage(`Your bow of Faerdhinen has ${plural(charges(item), "charge")} remaining.`);
}

function addShardCharges(event) {
  const { player } = event;
  const bow = [event.usedItem, event.usedWithItem].find((candidate) => {
    const id = candidate?.getId?.();
    return id === chargedId || inactiveIds.has(id);
  });
  const shard = [event.usedItem, event.usedWithItem].find((candidate) => candidate?.getId?.() === core.ItemIdentifiers.CRYSTAL_SHARD);
  if (!bow || !shard) {
    return;
  }
  event.handled = true;
  const left = charges(bow);
  if (left >= MAX_CHARGES) {
    player.sendMessage("Your bow of Faerdhinen cannot hold any more charges.");
    return;
  }
  const shardCount = player.getInventory().getAmount(core.ItemIdentifiers.CRYSTAL_SHARD);
  const shards = Math.min(shardCount, Math.ceil((MAX_CHARGES - left) / SHARD_CHARGES));
  if (shards <= 0) {
    return;
  }
  player.getInventory().deleteNumber(core.ItemIdentifiers.CRYSTAL_SHARD, shards);
  if (inactiveIds.has(bow.getId())) {
    bow.setId(chargedId);
  }
  const total = Math.min(MAX_CHARGES, left + shards * SHARD_CHARGES);
  bow.setMetaValue(CHARGES_META_KEY, { charges: total });
  refresh(player);
  player.sendMessage(`You add ${plural(shards, "crystal shard")} to the bow. It now has ${plural(total, "charge")}.`);
}

/** Uncharge: one shard back per whole 100 charges; the rest are lost and the bow goes inactive. */
function uncharge({ player, item }) {
  const left = charges(item);
  const shards = Math.floor(left / SHARD_CHARGES);
  const inventory = player.getInventory();
  if (shards > 0 && inventory.getAmount(core.ItemIdentifiers.CRYSTAL_SHARD) <= 0 && inventory.getFreeSlots() <= 0) {
    player.sendMessage("You need a free inventory space to uncharge the bow.");
    return;
  }
  item.setId(core.ItemIdentifiers.BOW_OF_FAERDHINEN_INACTIVE_);
  item.setMetaValue(CHARGES_META_KEY, undefined);
  if (shards > 0) {
    inventory.adds(core.ItemIdentifiers.CRYSTAL_SHARD, shards);
  }
  refresh(player);
  player.sendMessage(shards > 0
    ? `You uncharge the bow and recover ${plural(shards, "crystal shard")}.`
    : "You uncharge the bow.");
}

/** The bow to corrupt: the one carried with the most charges (the fewest shards to pay). */
function bowToCorrupt(player) {
  const items = player.getInventory().getItems?.() ?? [];
  let best = null;
  for (const item of items) {
    const id = item?.getId?.();
    if (id !== chargedId && !inactiveIds.has(id)) continue;
    if (!best || charges(item) > charges(best)) best = item;
  }
  return best;
}

/** The corruption as a crystal singing recipe, priced for the bow carried. */
function corruptionRecipe(player) {
  const bow = bowToCorrupt(player);
  if (!bow) return null;
  const I = core.ItemIdentifiers;
  const shards = Math.max(0, CORRUPT_SHARDS - Math.floor(charges(bow) / SHARD_CHARGES));
  return {
    productId: I.BOW_OF_FAERDHINEN_C_,
    level: CORRUPT_LEVEL,
    xp: 0,
    needs: shards > 0
      ? [{ itemId: bow.getId(), amount: 1 }, { itemId: I.CRYSTAL_SHARD, amount: shards }]
      : [{ itemId: bow.getId(), amount: 1 }],
    message: CORRUPT_MESSAGE,
    make(who) {
      const inventory = who.getInventory();
      const slot = inventory.getItems().indexOf(bow);
      if (slot < 0) return 0;
      if (shards > 0) inventory.deleteNumber(I.CRYSTAL_SHARD, shards);
      bow.setId(I.BOW_OF_FAERDHINEN_C_);
      bow.setMetaValue(CHARGES_META_KEY, undefined);
      return 1;
    },
  };
}

/** A clan's crystal on a corrupted bow: the clan's colour, the crystal used up. */
function recolour(event, clan) {
  const { player } = event;
  const bow = [event.usedItem, event.usedWithItem].find((candidate) => clanByCorrupted.has(candidate?.getId?.()));
  if (!bow) return;
  event.handled = true;
  if (clanByCorrupted.get(bow.getId()) === clan) {
    player.sendMessage(`Your bow of Faerdhinen is already in the colours of the ${clan} clan.`);
    return;
  }
  const crystalId = core.ItemIdentifiers[`CRYSTAL_OF_${clan.toUpperCase()}`];
  if (!player.getInventory().contains(crystalId)) return;
  player.getInventory().deleteNumber(crystalId, 1);
  bow.setId(corruptedByClan.get(clan));
  refresh(player);
  player.sendMessage(`You recolour your bow of Faerdhinen in the colours of the ${clan} clan.`);
}

/** The inactive bow has no stats; it must be charged before it can be wielded. */
function canEquip(event) {
  if (!inactiveIds.has(event?.item?.getId?.())) {
    return;
  }
  event.allow = false;
  event.player.sendMessage("Your bow of Faerdhinen is inactive. Add crystal shards to it before wielding it.");
}

function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  const I = core.ItemIdentifiers;
  const { BOW_OF_FAERDHINEN_IDS } = require("../../src/main/typescript/elvarg/game/content/combat/ranged/CrystalBow");
  chargedId = I.BOW_OF_FAERDHINEN;
  inactiveIds = new Set([I.BOW_OF_FAERDHINEN_INACTIVE_]);
  bowIds = new Set(BOW_OF_FAERDHINEN_IDS);
  // CrystalBow's arrow table: the original (Hefin's red), then Ithell to Amlodd two ids apart.
  const ids = [I.BOW_OF_FAERDHINEN_C_, I.BOW_OF_FAERDHINEN_C__4, I.BOW_OF_FAERDHINEN_C__6, I.BOW_OF_FAERDHINEN_C__8,
    I.BOW_OF_FAERDHINEN_C__10, I.BOW_OF_FAERDHINEN_C__12, I.BOW_OF_FAERDHINEN_C__14, I.BOW_OF_FAERDHINEN_C__16];
  corruptedByClan = new Map(CLANS.map((clan, index) => [clan, ids[index]]));
  clanByCorrupted = new Map(CLANS.map((clan, index) => [ids[index], clan]));
}

module.exports = {
  name: "BowOfFaerdhinen",
  members: true,
  attach,
  register(pluginApi) {
    attach(pluginApi);
    pluginApi.registerRangedAmmoHandler(ammoHandler);
    pluginApi.onCanEquip(canEquip);
    pluginApi.onItemAction("Bow of Faerdhinen", { Check: checkCharges, Uncharge: uncharge });
    pluginApi.onItemOnItem(addShardCharges, { noted: false });
    pluginApi.onCustomEvent("crystal-singing:recipes", ({ player, recipes }) => {
      const recipe = corruptionRecipe(player);
      if (recipe) recipes.push(recipe);
    });
    for (const clan of CLANS) {
      pluginApi.onItemOnItem(`Crystal of ${clan}`, "Bow of Faerdhinen (c)", (event) => recolour(event, clan), { noted: false });
    }
  },
  MAX_CHARGES,
  SHARD_CHARGES,
  _test: { charges, useCharges, ammoHandler, checkCharges, addShardCharges, uncharge, canEquip, corruptionRecipe, recolour, CLANS },
};
