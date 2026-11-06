"use strict";

const ruinsData = require("../../skills/data/runecrafting-ruins.json");
const Supplies = require("../lib/Supplies.PlayerBots");
const { createTravelToAction } = require("../brain/actions/TravelTo.PlayerBots");
const { createCraftRunesAction, createFillPouchesAction, pouchTypes } = require("../brain/actions/CraftRunes.PlayerBots");
const { createWearAction } = require("../brain/actions/Wear.PlayerBots");
const { itemId, level, no, ok } = require("./Common.PlayerBots");

/**
 * Runecraft, a task per altar a character can walk to: essence and its talisman (or the tiara,
 * worn) out of the bank, to the mysterious ruins, in, the essence bound at the altar, out through
 * the portal, and back to the nearest bank for more. The Runecrafting plugin does all of it as for
 * a player (createCraftRunesAction). The essence is the character's own, banked: rune essence on
 * these altars, else pure. Its essence pouches (those its level opens) come along: filled at the
 * bank, the inventory topped up with essence after, and emptied at the altar for a second load. (Cosmic, law, nature, chaos and death need a quest, a boat or the
 * Wilderness to get to, so they aren't tasks yet.)
 */
const MINUTES = [20, 40];
const INVENTORY = 28;
const MIN_ESSENCE = 14;
const RUNE_ESSENCE = itemId("RUNE_ESSENCE");
const PURE_ESSENCE = itemId("PURE_ESSENCE");

// The Wiki's levels; the ruins (outside) and each altar's and portal's ids (the plugin's).
const ALTARS = [
  { rune: "Air", level: 1, ruins: [2983, 3288, 0], altar: "ALTAR_33", portal: "PORTAL_39" },
  { rune: "Mind", level: 2, ruins: [2980, 3511, 0], altar: "ALTAR_34", portal: "PORTAL_40" },
  { rune: "Water", level: 5, ruins: [3182, 3162, 0], altar: "ALTAR_35", portal: "PORTAL_41" },
  { rune: "Earth", level: 9, ruins: [3302, 3477, 0], altar: "ALTAR_36", portal: "PORTAL_42" },
  { rune: "Fire", level: 14, ruins: [3310, 3252, 0], altar: "ALTAR_37", portal: "PORTAL_43" },
  { rune: "Body", level: 20, ruins: [3050, 3442, 0], altar: "ALTAR_38", portal: "PORTAL_44" },
];

function runecraftTask(altar) {
  const data = ruinsData.find((entry) => entry.name === altar.rune);
  const { talismanId: talisman, tiaraId: tiara } = data;
  const essenceOf = (player) => [RUNE_ESSENCE, PURE_ESSENCE].find((id) => Supplies.bankedAmount(player, id) + Supplies.carriedAmount(player, id) > 0) ?? null;
  const keyOf = (player) => (Supplies.ownedAmount(player, tiara) > 0 ? tiara : Supplies.ownedAmount(player, talisman) > 0 ? talisman : null);
  const [x, y, z] = altar.ruins;
  return {
    id: `runecraft_${altar.rune.toLowerCase()}`,
    name: `Runecraft: ${altar.rune} runes`,
    shortName: `${altar.rune} runes`,
    group: "Processing",
    subgroup: "Runecraft",
    skill: "runecrafting",
    level: altar.level,
    crowd: 15,
    places: [{ id: `ruins_${altar.rune.toLowerCase()}`, name: `the ${altar.rune.toLowerCase()} altar's ruins`, x, y, z }],
    minutes: MINUTES,
    check(player) {
      if (level(player, "runecrafting") < altar.level) return no(`needs ${altar.level} Runecraft`);
      if (keyOf(player) === null) return no(`needs ${altar.rune.toLowerCase()} talisman or tiara`);
      const essence = essenceOf(player);
      const amount = essence === null ? 0 : Supplies.bankedAmount(player, essence) + Supplies.carriedAmount(player, essence);
      return amount >= MIN_ESSENCE ? ok() : no("needs rune or pure essence in the bank");
    },
    build(player, { registry, world }) {
      const key = keyOf(player);
      const essence = essenceOf(player);
      if (key === null || essence === null) return null;
      const { core } = world;
      // The ruins are a base loc whose variants (the tiara's) the cache lists.
      const base = data.ruinsId;
      const ruins = [base, ...(core.CacheDefinitions?.getObject?.(base)?.transforms ?? [])].filter((id) => Number.isInteger(id) && id >= 0);
      // The best of each pouch it owns and has the level for (a decayed one is still a pouch).
      const rc = level(player, "runecrafting");
      const pouches = pouchTypes(core).filter((pouch) => rc >= pouch.level)
        .map((pouch) => pouch.ids.find((id) => Supplies.ownedAmount(player, id) > 0)).filter(Number.isInteger);
      const load = { item: essence, amount: INVENTORY - (key === tiara ? 0 : 1) - pouches.length };
      const activity = registry.compile({
        id: `task_runecraft_${altar.rune.toLowerCase()}`, mode: "runecrafting", capacity: 100000, repeat: true, failureCooldownSeconds: 60,
        actions: [
          { type: "bank", until: { inventoryFull: false } },
          { type: "ensureItem", item: key },
          ...pouches.map((id) => ({ type: "ensureItem", item: id })),
          { type: "bank", withdraw: [load] },
        ],
      });
      if (pouches.length > 0) {
        // The pouches filled, then the inventory topped up again (the bank's withdraw takes it back to `load`).
        activity.actions.push(createFillPouchesAction({ essence: [RUNE_ESSENCE, PURE_ESSENCE] }, world));
        activity.actions.push(registry.compile({ id: "rc_top_up", mode: "runecrafting", capacity: 1, repeat: false, actions: [{ type: "bank", withdraw: [load], topUp: true }] }).actions[0]);
      }
      activity.actions.push(
        createWearAction({ items: () => (key === tiara ? [tiara] : []) }, world),
        createTravelToAction({ x, y, z, radius: 6 }, world),
        createCraftRunesAction({
          ruins, altar: core.ObjectIdentifiers[altar.altar], portal: core.ObjectIdentifiers[altar.portal],
          talisman, tiara, essence: [RUNE_ESSENCE, PURE_ESSENCE],
        }, world),
      );
      return activity;
    },
  };
}

function runecraftTasks() {
  return ALTARS.map(runecraftTask);
}

module.exports = { runecraftTasks };
