/**
 * Dissecting sacred eels (https://oldschool.runescape.wiki/w/Sacred_eel): a knife on an eel takes
 * Zulrah's scales out of it at 72 Cooking, and it never fails. The scales rise with the boosted
 * Cooking level: 3-5 to start, one more each way every 8 levels, up to 7-9 from 104. Each eel gives
 * 100 XP and 3 for each scale (109-127), and players keep running while it goes on (update of 23
 * July 2020). The Wiki gives neither the pace nor the animation, so those two are this server's
 * own until a capture says otherwise.
 */
const Common = require("./Common.Cooking");

const LEVEL = 72;
const BAND_LEVELS = 8;
const MAX_BANDS = 4;
const MINIMUM_SCALES = 3;
const SCALE_SPREAD = 2;
const BASE_XP = 100;
const XP_PER_SCALE = 3;
const TICKS_PER_EEL = 3;
const ANIMATION = "human_cutting_knife";
const KNIFE_NAME = "Knife";

/** The fewest and most scales an eel gives at this Cooking level. */
function scaleRange(level) {
  const bands = Math.min(MAX_BANDS, Math.floor((level - LEVEL) / BAND_LEVELS));
  const minimum = MINIMUM_SCALES + Math.max(0, bands);
  return { minimum, maximum: minimum + SCALE_SPREAD };
}

function rollScales(level, random = Math.random) {
  const { minimum, maximum } = scaleRange(level);
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

/** One eel: it goes, the scales come. False when none is left. */
function dissectOne(player) {
  const { ItemIdentifiers, Skill } = Common.core;
  const inventory = player.getInventory();
  if (inventory.getAmount(ItemIdentifiers.SACRED_EEL) <= 0) return false;
  const scales = rollScales(Common.level(player));
  const xp = BASE_XP + scales * XP_PER_SCALE;
  inventory.deleteNumber(ItemIdentifiers.SACRED_EEL, 1);
  inventory.adds(ItemIdentifiers.ZULRAHS_SCALES, scales);
  Common.addXp(player, xp);
  Common.api.emitCustomEvent("skills:produced", {
    player, skill: Skill.COOKING, itemId: ItemIdentifiers.ZULRAHS_SCALES, amount: scales, xp,
  });
  return true;
}

function animate(player) {
  player.performAnimation(new Common.core.Animation(Common.gameval("seq", ANIMATION)));
}

/** Its own task key, not the player's index: walking cancels those, and it doesn't stop this. */
function taskKey(player) {
  return `sacred-eels:${player.getIndex()}`;
}

/** Works through every eel carried, one action cycle at a time. */
function dissectAll(player) {
  const { TaskManager } = Common.core;
  TaskManager.cancelTasks(player.getIndex());
  TaskManager.cancelTasks(taskKey(player));
  animate(player);
  let wait = TICKS_PER_EEL;
  Common.run(player, () => {
    if (--wait > 0) return true;
    const actions = Common.actionsPerCycle(player, "make");
    for (let done = 0; done < actions; done++) {
      if (!dissectOne(player)) return false;
    }
    if (player.getInventory().getAmount(Common.core.ItemIdentifiers.SACRED_EEL) <= 0) return false;
    animate(player);
    wait = TICKS_PER_EEL;
    return true;
  }, taskKey(player));
}

/** By name: the cache has more than one Knife, and any of them will do. */
function isKnife(itemId) {
  return Common.core.ItemDefinition.forId(itemId).getName() === KNIFE_NAME;
}

function useItemOnItem(event) {
  const { player, usedItemId, usedWithItemId } = event;
  const { SACRED_EEL } = Common.core.ItemIdentifiers;
  const toolId = usedItemId === SACRED_EEL ? usedWithItemId : usedWithItemId === SACRED_EEL ? usedItemId : null;
  if (toolId === null || !isKnife(toolId)) return;
  event.handled = true;
  if (Common.level(player) < LEVEL) {
    Common.mesbox(player, `You need a Cooking level of ${LEVEL} to dissect a sacred eel.`);
    return;
  }
  dissectAll(player);
}

module.exports = Object.assign(function attachEels(api) {
  api.onItemOnItem(useItemOnItem, { noted: false });
}, { scaleRange, rollScales, dissectOne });
