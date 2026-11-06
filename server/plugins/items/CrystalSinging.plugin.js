"use strict";

/**
 * Crystal singing at the Prifddinas singing bowls (https://oldschool.runescape.wiki/w/Crystal_singing).
 *
 * Sing-crystal offers every recipe the player has the materials for, in one menu: the crystal
 * armour (its plugin's recipes), the crystal bow, halberd and shield from a crystal weapon seed,
 * the Bow of Faerdhinen and Blade of Saeldor from an enhanced crystal weapon seed, and the
 * enhanced crystal key. Using a seed on the bowl offers that seed's recipes only. Materials,
 * levels (Smithing and Crafting, boostable) and XP (in both) are the Wiki's; the Bow of
 * Faerdhinen starts with 10,000 charges (Wiki).
 *
 * The menu title, the refusals, the animation and sound 8 are the captured singing bowl's (see
 * CrystalKey.KeyChests). Song of the Elves is needed, as for the armour. Other bowls (the
 * Gauntlet's, the Eyes and Path of Glouphrie's) fall through to their own plugins.
 *
 * The Bow of Faerdhinen (c) is BowOfFaerdhinen's recipe. Not here yet (Wiki recipes): crystal
 * tools, the eternal teleport crystal, the celestial signet and the Blade of Saeldor (c).
 */
const MENU_TITLE = "How many would you like to make?";
const NO_MATERIALS = "You do not have all of the required materials and requirements to make anything.";
const LEVEL_TOO_LOW = "You need to be at least level {level} Crafting and Smithing to create anything through crystal singing.";
const SONG_LOCKED = "You need to complete Song of the Elves to sing crystal.";
const SONG_OF_THE_ELVES = "song_of_the_elves";
const SING_SOUND = 8;
const BOWFA_START_CHARGES = 10000;

let api = null;
let core = null;
let bowlIds = new Set();

/** [product, seed, shards, level, xp, extra] for the weapons sung here. */
function weaponRecipes() {
  const I = core.ItemIdentifiers;
  const recipe = (productId, seedId, shards, level, xp, extra = {}) => ({
    productId, level, xp, needs: [{ itemId: seedId, amount: 1 }, { itemId: I.CRYSTAL_SHARD, amount: shards }], ...extra,
  });
  return [
    recipe(I.CRYSTAL_BOW, I.CRYSTAL_WEAPON_SEED, 40, 78, 2000),
    recipe(I.CRYSTAL_HALBERD, I.CRYSTAL_WEAPON_SEED, 40, 78, 2000),
    recipe(I.CRYSTAL_SHIELD, I.CRYSTAL_WEAPON_SEED, 40, 78, 2000),
    recipe(I.BOW_OF_FAERDHINEN, I.ENHANCED_CRYSTAL_WEAPON_SEED, 100, 82, 5000, {
      meta: ["bow-of-faerdhinen", { charges: BOWFA_START_CHARGES }],
    }),
    recipe(I.BLADE_OF_SAELDOR, I.ENHANCED_CRYSTAL_WEAPON_SEED, 100, 82, 5000),
  ];
}

/**
 * Every recipe: these weapons, plus what other plugins add through
 * "crystal-singing:recipes" { player, recipes } (crystal armour, the enhanced key). A recipe is
 * { productId, level, xp, needs: [{ itemId, amount }], meta?: [key, value] }, and optionally
 * `make(player, amount)` (returns how many it made) to take and give the items itself, and
 * `message` to send once it's sung.
 */
function recipes(player) {
  const request = { player, recipes: [] };
  api.emitCustomEvent("crystal-singing:recipes", request);
  return [...request.recipes, ...weaponRecipes()];
}

function affordable(player, recipe) {
  const inventory = player.getInventory();
  return Math.min(...recipe.needs.map(({ itemId, amount }) => Math.floor(inventory.getAmount(itemId) / amount)));
}

function meetsLevels(player, recipe) {
  const skills = player.getSkillManager();
  return [core.Skill.SMITHING, core.Skill.CRAFTING].every((skill) => skills.getCurrentLevel(skill) >= recipe.level);
}

function songComplete(player) {
  const request = { player, key: SONG_OF_THE_ELVES, complete: false };
  api.emitCustomEvent("quest:is-complete", request);
  return request.complete === true;
}

function statement(player, text) {
  const { DialogueChainBuilder, StatementDialogue, EndDialogue } = core;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new StatementDialogue(0, text), new EndDialogue(1)));
}

/** Opens the menu of what the player can sing (only `seedId`'s recipes when a seed was used). */
function open(player, seedId = null) {
  if (!songComplete(player)) return statement(player, SONG_LOCKED);
  const options = recipes(player)
    .filter((recipe) => seedId === null || recipe.needs.some((need) => need.itemId === seedId))
    .filter((recipe) => affordable(player, recipe) > 0);
  if (options.length === 0) return statement(player, NO_MATERIALS);
  const able = options.filter((recipe) => meetsLevels(player, recipe));
  if (able.length === 0) {
    const lowest = Math.min(...options.map((recipe) => recipe.level));
    return statement(player, LEVEL_TOO_LOW.replace("{level}", lowest));
  }
  player.getPacketSender().sendCreationMenu(new core.CreationMenu(MENU_TITLE, able.map((recipe) => recipe.productId), {
    execute: (productId, amount) => {
      const recipe = able.find((candidate) => candidate.productId === productId);
      if (recipe) sing(player, recipe, amount);
    },
  }));
}

/** Sings `amount` (as many as the materials allow) at once, as the bowl does. */
function sing(player, recipe, amount) {
  const made = Math.min(Math.max(1, Math.floor(Number(amount) || 1)), affordable(player, recipe));
  if (made <= 0 || !meetsLevels(player, recipe)) return 0;
  const inventory = player.getInventory();
  if (recipe.make) {
    if (!(recipe.make(player, made) > 0)) return 0;
  } else {
    for (const { itemId, amount: need } of recipe.needs) inventory.deleteNumber(itemId, need * made);
    for (let index = 0; index < made; index++) {
      const item = new core.Item(recipe.productId, 1);
      if (recipe.meta) item.setMetaValue(recipe.meta[0], { ...recipe.meta[1] });
      inventory.add(item, false);
    }
  }
  inventory.refreshItems();
  const sequence = core.CacheDefinitions?.getSeqId?.("prif_crystal_singing");
  if (sequence != null) player.performAnimation(new core.Animation(sequence));
  player.getPacketSender().sendSound(SING_SOUND, 1, 0);
  const skills = player.getSkillManager();
  if (recipe.xp > 0) {
    skills.addExperiences(core.Skill.SMITHING, recipe.xp * made);
    skills.addExperiences(core.Skill.CRAFTING, recipe.xp * made);
  }
  if (recipe.message) player.sendMessage(recipe.message);
  return made;
}

function singCrystal({ player, objectId }) {
  if (!bowlIds.has(objectId)) return false;
  open(player);
  return true;
}

/** A seed (or a bow to corrupt) used on the bowl: that item's recipes only. */
function useSeedOnBowl(event) {
  const { player, objectId } = event;
  if (objectId != null && !bowlIds.has(objectId)) return false;
  open(player, event.itemId ?? event.item?.getId?.());
  return true;
}

module.exports = {
  name: "CrystalSinging",
  members: true,
  register(pluginApi) {
    api = pluginApi;
    core = pluginApi.core;
    bowlIds = new Set([core.CacheDefinitions.getLocId("prif_singing_bowl")].filter((id) => id != null && id >= 0));
    api.onObjectInteraction("Singing bowl", { "Sing-crystal": singCrystal });
    for (const seed of ["Crystal weapon seed", "Enhanced crystal weapon seed", "Bow of Faerdhinen", "Bow of Faerdhinen (inactive)"]) {
      api.onItemOnObject(seed, "Singing bowl", useSeedOnBowl, { noted: false });
    }
  },
  _test: { open, sing, recipes, weaponRecipes, singCrystal, useSeedOnBowl, BOWFA_START_CHARGES },
};
