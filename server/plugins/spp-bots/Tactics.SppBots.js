"use strict";

/**
 * How a bot fights a monster (docs/playerbots.md, Combat): the attack style that does the most
 * damage to it, and special attacks, with a switch to a special weapon and back. Every change is
 * what a player's click does: a combat tab style button (WeaponInterfaceManager.changeCombatStyle),
 * the special bar (CombatSpecial.activate), Wield on an inventory item.
 */

const INVENTORY_INTERFACE = 3214;
const path = require("path");
const MONSTERS = require(path.join(__dirname, "data", "monsters.json")).rules;
// An NPC's overhead icon: the style it's protected from.
const PROTECTS = { 0: "melee", 1: "ranged", 2: "magic" };
const STYLE_OF_TYPE = ["melee", "ranged", "magic"];
// The fewest milliseconds between two style switches (a switch takes a tick or two to land).
const SWITCH_GAP_MS = 1800;
// A special is worth it against a monster with at least this many hitpoints left.
const SPEC_MIN_HITPOINTS = 15;
// Gives up on a switch that doesn't take (a full inventory, a level it lacks) after this long.
const SWITCH_MS = 6000;
// A special armed this long with the energy untouched isn't going to go.
const SPEC_STUCK_MS = 10000;

const lower = (value) => String(value ?? "").toLowerCase();

/** OSRS hit chance: attack roll against defence roll. */
function hitChance(attackRoll, defenceRoll) {
  return attackRoll > defenceRoll
    ? 1 - (defenceRoll + 2) / (2 * (attackRoll + 1))
    : attackRoll / (2 * (defenceRoll + 1));
}

/**
 * Expected damage per hit of a melee style against a monster. `levels` { attack, strength } (the
 * bot's current), `bonuses` { attack: [stab, slash, crush, ...], strength }, `style` { type: 0-2,
 * kind: "ACCURATE" | "AGGRESSIVE" | "DEFENSIVE" | "CONTROLLED" }, `npc` { defence, bonuses: [stab,
 * slash, crush, magic, ranged] }. Prayers and set effects aside (they scale every style alike).
 */
function meleeDamage(levels, bonuses, style, npc) {
  const attackStyle = style.kind === "ACCURATE" ? 3 : style.kind === "CONTROLLED" ? 1 : 0;
  const strengthStyle = style.kind === "AGGRESSIVE" ? 3 : style.kind === "CONTROLLED" ? 1 : 0;
  const attackRoll = (levels.attack + attackStyle + 8) * ((bonuses.attack[style.type] ?? 0) + 64);
  const defenceRoll = (npc.defence + 9) * ((npc.bonuses[style.type] ?? 0) + 64);
  const maxHit = Math.floor(0.5 + ((levels.strength + strengthStyle + 8) * ((bonuses.strength ?? 0) + 64)) / 640);
  return hitChance(attackRoll, defenceRoll) * (maxHit / 2);
}

/** The monster's defence, as meleeDamage wants it. */
function npcDefence(npc) {
  const stats = npc.getCurrentDefinition?.()?.getStats?.() ?? [];
  const bonuses = [0, 1, 2, 3, 4].map((index) => Number(npc.getDefenceBonus?.(index) ?? stats[10 + index] ?? 0) || 0);
  return { defence: Number(stats[2] ?? 1) || 1, bonuses };
}

function fightTypesOf(player) {
  return Object.values(player.getWeapon?.()?.getFightType?.() ?? {}).filter((type) => type && typeof type.getChildId === "function");
}

/**
 * The weapon's style that does the most damage to `npc`: melee by meleeDamage, ranged rapid (the
 * aggressive slot; it attacks a tick faster). Null while autocasting (the spell decides).
 */
// The weapon styles (FightStyle kinds) that give XP in a skill a training task asks for.
const XP_KINDS = {
  attack: ["ACCURATE"], strength: ["AGGRESSIVE"], defence: ["DEFENSIVE"], shared: ["CONTROLLED"],
  ranged: ["ACCURATE", "AGGRESSIVE"], // accurate and rapid; longrange shares with Defence
};

/**
 * `xpStyle`: a training task's skill (attack, strength, defence, shared, ranged); only the
 * weapon's styles that train it count, the most damaging of those. Without one, the most damaging.
 */
function bestFightType(core, player, npc, xpStyle = null) {
  if (player.getCombat?.().getAutocastSpell?.()) return null;
  const types = fightTypesOf(player);
  if (types.length === 0) return null;
  const style = (type) => String(type.getStyle?.()?.constructor?.name ?? type.getStyle?.()?.name ?? type.getStyle?.() ?? "");
  const kindOf = (type) => {
    const fightStyle = type.getStyle?.();
    for (const kind of ["ACCURATE", "AGGRESSIVE", "DEFENSIVE", "CONTROLLED"]) if (fightStyle === core.FightStyle?.[kind]) return kind;
    return style(type).toUpperCase();
  };
  const ranged = types.every((type) => type.getBonusType?.() === 4);
  if (ranged) {
    // Rapid trains Ranged fastest; longrange (DEFENSIVE) when training Defence with a bow.
    const wanted = xpStyle === "defence" ? "DEFENSIVE" : "AGGRESSIVE";
    return types.find((type) => kindOf(type) === wanted) ?? types.find((type) => kindOf(type) === "AGGRESSIVE") ?? null;
  }
  const kinds = xpStyle ? XP_KINDS[xpStyle] ?? null : null;
  const skills = player.getSkillManager();
  const levels = { attack: skills.getCurrentLevel(core.Skill.ATTACK), strength: skills.getCurrentLevel(core.Skill.STRENGTH) };
  const manager = player.getBonusManager();
  const bonuses = { attack: manager.getAttackBonus(), strength: manager.getOtherBonus()[0] ?? 0 };
  const defence = npcDefence(npc);
  let best = null;
  for (const type of types) {
    const attackType = type.getBonusType?.();
    if (!(attackType >= 0 && attackType <= 2)) continue;
    if (kinds && !kinds.includes(kindOf(type))) continue;
    const damage = meleeDamage(levels, bonuses, { type: attackType, kind: kindOf(type) }, defence);
    if (!best || damage > best.damage) best = { type, damage };
  }
  return best?.type ?? null;
}

/** Sets the best style if it isn't the current one, as the combat tab's button. */
function chooseStyle(core, player, npc, xpStyle = null) {
  const best = bestFightType(core, player, npc, xpStyle) ?? (xpStyle ? bestFightType(core, player, npc) : null);
  if (!best || player.getFightType?.() === best) return false;
  return core.WeaponInterfaceManager.changeCombatStyle(player, best.getChildId());
}

/** The special of an item (CombatSpecial), or null. */
function specialOf(core, itemId) {
  return itemId > 0 ? core.CombatSpecial.getForWeaponId(itemId) ?? null : null;
}

function wornId(core, player, slot) {
  return player.getEquipment().getItems()[core.Equipment[slot]]?.getId?.() ?? -1;
}

/** Wield (or Wear) an inventory item by id; false if it isn't there. */
function wield(core, player, itemId) {
  const items = player.getInventory().getItems();
  const slot = items.findIndex((item) => item?.getId?.() === itemId);
  if (slot < 0) return false;
  const actions = (core.CacheDefinitions.getItem(itemId)?.inventoryActions ?? []).map(lower);
  if (!actions.some((action) => action === "wield" || action === "wear")) return false;
  // Wield/Wear is its own packet (EquipPacketListener), not an item action.
  core.EquipPacketListener.equip(player, itemId, slot, INVENTORY_INTERFACE);
  return true;
}

/**
 * Attack `npc` again after a wield (which resets the attack, as for a player who then clicks the
 * monster again): the attack option's own call.
 */
function reattack(player, npc) {
  if (!npc || !(npc.getHitpoints?.() > 0)) return;
  const combat = player.getCombat();
  if (combat.getTarget?.() === npc) return;
  combat.attack(npc);
}

/** A special weapon in the inventory the bot has the energy for, as { itemId, special }, or null. */
function specInPack(core, player) {
  const energy = player.getSpecialPercentage();
  for (const item of player.getInventory().getItems()) {
    const special = specialOf(core, item?.getId?.() ?? -1);
    if (special && energy >= core.CombatSpecial.energyCost(player, special)) return { itemId: item.getId(), special };
  }
  return null;
}

/**
 * One tick of specials in a fight against `npc`. `fight.spec` keeps a switch in progress:
 * { phase: "armed" | "back", main, shield, since }. Returns what it did, or null.
 */
function specialTick(core, player, fight, npc, nowMs) {
  const state = fight.spec;
  const energy = player.getSpecialPercentage();
  const weaponId = wornId(core, player, "WEAPON_SLOT");
  const worth = (npc?.getHitpoints?.() ?? 0) >= SPEC_MIN_HITPOINTS;

  if (state?.phase === "armed") {
    const special = specialOf(core, weaponId);
    if (weaponId !== state.weapon) {
      // The wield hasn't landed yet (or didn't): give it a moment.
      if (nowMs - state.since < SWITCH_MS) return null;
      fight.spec = { ...state, phase: "back", since: nowMs };
      return null;
    }
    // A special that never goes (energy untouched SPEC_STUCK_MS after arming: no ammo, no
    // reach): back to the main weapon rather than stand there re-arming it every tick.
    if (energy >= (state.energy ?? 0) && nowMs - state.since > SPEC_STUCK_MS) {
      fight.spec = { ...state, phase: "back", since: nowMs };
      return null;
    }
    if (special && worth && energy >= core.CombatSpecial.energyCost(player, special)) {
      if (!player.isSpecialActivated()) core.CombatSpecial.activate(player);
      reattack(player, npc);
      return "special";
    }
    if (player.isSpecialActivated()) return null; // the last one is still to land
    fight.spec = { ...state, phase: "back", since: nowMs };
  }
  if (fight.spec?.phase === "back") {
    // Back to the main weapon (and the shield a two-handed special took off).
    const { main, shield } = fight.spec;
    if (weaponId !== main) wield(core, player, main);
    if (shield > 0 && wornId(core, player, "SHIELD_SLOT") !== shield) wield(core, player, shield);
    const done = wornId(core, player, "WEAPON_SLOT") === main && (shield <= 0 || wornId(core, player, "SHIELD_SLOT") === shield);
    if (done || nowMs - fight.spec.since > SWITCH_MS) fight.spec = null;
    // Back on the main weapon, the fight goes on (a wield resets the attack, as for a player).
    if (done) reattack(player, npc);
    return "switch back";
  }
  if (!worth || player.getCombat?.().getAutocastSpell?.()) return null;
  // A special weapon brought in the pack is what the bot came to use: switch, special, back.
  const spec = specInPack(core, player);
  if (spec) {
    fight.spec = { phase: "armed", weapon: spec.itemId, main: weaponId, shield: wornId(core, player, "SHIELD_SLOT"), since: nowMs, energy };
    wield(core, player, spec.itemId);
    wieldAmmo(core, player, spec.itemId);
    return "switch";
  }
  // Otherwise the weapon worn, if it has a special.
  const own = specialOf(core, weaponId);
  if (own && energy >= core.CombatSpecial.energyCost(player, own)) {
    if (!player.isSpecialActivated()) core.CombatSpecial.activate(player);
    return "special";
  }
  return null;
}

/** The style the bot fights with now: "melee", "ranged" or "magic". */
function currentStyle(core, player) {
  if (player.getCombat?.().getAutocastSpell?.()) return "magic";
  try {
    return STYLE_OF_TYPE[Number(core.CombatFactory.getMethod(player)?.type?.())] ?? "melee";
  } catch {
    return "melee";
  }
}

function ruleFor(npc) {
  const name = lower(npc?.getCurrentDefinition?.()?.getName?.());
  return MONSTERS.find((rule) => rule.names.some((entry) => lower(entry) === name)) ?? null;
}

/** A rough damage score of a style against a monster's defence: its level over the defence bonus. */
function styleScore(core, player, style, npc) {
  const { bonuses } = npcDefence(npc);
  const skills = player.getSkillManager();
  const level = style === "melee"
    ? Math.max(skills.getCurrentLevel(core.Skill.ATTACK), skills.getCurrentLevel(core.Skill.STRENGTH))
    : skills.getCurrentLevel(style === "magic" ? core.Skill.MAGIC : core.Skill.RANGED);
  const against = style === "melee" ? Math.min(bonuses[0], bonuses[1], bonuses[2]) : style === "magic" ? bonuses[3] : bonuses[4];
  return level * (64 / Math.max(16, against + 64));
}

/** Wear a carried set: its weapon and ammo from the pack, its spell for autocast. */
const nameOf = (core, id) => String(core.ItemDefinition?.forId?.(id)?.getName?.() ?? core.CacheDefinitions?.getItem?.(id)?.name ?? "");

/** Whether a weapon fires ammo from the ammo slot (a bow or crossbow; not the crystal ones). */
const firesAmmo = (core, weaponId) => /bow/i.test(nameOf(core, weaponId)) && !/crystal|bowfa|craw|venator|webweaver/i.test(nameOf(core, weaponId));

/**
 * Its ammo on for a weapon that fires it: `preferred` if carried, else any arrows or bolts in the
 * pack. Without: "You don't have any ammunition to fire." (sppdev's bow switch, and the magic
 * shortbow taken out for its special, both left the arrows in the pack).
 */
function wieldAmmo(core, player, weaponId, preferred = null) {
  if (!preferred && !firesAmmo(core, weaponId)) return false;
  const worn = player.getEquipment().getItems()[core.Equipment.AMMUNITION_SLOT];
  if (worn?.getAmount?.() > 0 && (!preferred || worn.getId() === preferred)) return false;
  const id = preferred && player.getInventory().contains(preferred) ? preferred
    : player.getInventory().getItems().find((item) => item?.getId?.() > 0 && /arrow|bolt/i.test(nameOf(core, item.getId())))?.getId?.();
  return id ? wield(core, player, id) : false;
}

// Slots a style's armour is picked for (armourFor), and how a piece scores by its bonuses (the
// cache's: 0-2 stab/slash/crush, 3 magic, 4 ranged attack; 10 strength, 11 ranged strength, 12
// magic damage): its attack bonus, damage counted heavier (tsps's Zulrah bot's gearSet).
const ARMOUR_SLOTS = ["HEAD_SLOT", "CAPE_SLOT", "AMULET_SLOT", "BODY_SLOT", "LEG_SLOT", "HANDS_SLOT", "FEET_SLOT", "RING_SLOT", "SHIELD_SLOT"];
function pieceScore(core, id, style) {
  const bonuses = core.ItemDefinition?.forId?.(id)?.getBonuses?.() ?? [];
  const at = (index) => Number(bonuses[index]) || 0;
  if (style === "magic") return at(3) + 3 * at(12);
  if (style === "ranged") return at(4) + 2 * at(11);
  return Math.max(at(0), at(1), at(2)) + at(10);
}

/**
 * A style's best armour of what the bot carries and wears, by slot: { HEAD_SLOT: id, ... }, only
 * pieces that help the style (a positive score) and that it can wear (levels). Void counts as a set
 * (its stats are the set effect, not the pieces'): with a top, robe and gloves the style's own helm.
 * `twoHanded`: no shield. Without it a style switch changed only the weapon (sppdev at Zulrah:
 * Bandos on through every magic and ranged phase).
 */
function armourFor(core, player, style, twoHanded = false) {
  const E = core.Equipment;
  const ids = [...player.getInventory().getItems(), ...player.getEquipment().getItems()].map((item) => item?.getId?.()).filter((id) => id > 0);
  const skills = core.Skill?.values?.() ?? [];
  const wearable = (id) => (core.ItemDefinition?.forId?.(id)?.getRequirements?.() ?? [])
    .every((level, skill) => !level || !skills[skill] || player.getSkillManager().getMaxLevel(skills[skill]) >= level);
  const slotOf = (id) => core.ItemDefinition?.forId?.(id)?.getEquipmentType?.()?.getSlot?.() ?? -1;
  const best = {};
  for (const name of ARMOUR_SLOTS) {
    if (name === "SHIELD_SLOT" && twoHanded) continue;
    let pick = null;
    for (const id of ids) {
      if (slotOf(id) !== E[name] || !wearable(id)) continue;
      const value = pieceScore(core, id, style);
      if (value > 0 && (!pick || value > pick.value)) pick = { id, value };
    }
    if (pick) best[name] = pick.id;
  }
  const named = (pattern) => ids.find((id) => pattern.test(nameOf(core, id)));
  // The cache's names: "Void knight top" and "Elite void top" (not "Elite void knight top": the
  // elite set went unseen and the ranger helm, no bonuses of its own, never went on), and "(or)".
  const top = named(/^(void knight|elite void) top( \(or\))?$/i);
  const robe = named(/^(void knight|elite void) robe( \(or\))?$/i);
  const gloves = named(/^void knight gloves( \(or\))?$/i);
  const kind = { magic: "mage", ranged: "ranger" }[style] ?? "melee";
  const helm = named(new RegExp(`^void ${kind} helm( \\(or\\))?$`, "i"));
  if (top && robe && gloves && helm) Object.assign(best, { HEAD_SLOT: helm, BODY_SLOT: top, LEG_SLOT: robe, HANDS_SLOT: gloves });
  return best;
}

function wearSet(core, player, set) {
  wield(core, player, set.worn.WEAPON_SLOT);
  // A one-handed weapon's shield back on (a blowpipe switch took the defender off).
  if (set.worn.SHIELD_SLOT) wield(core, player, set.worn.SHIELD_SLOT);
  // The rest of the set: its armour, the pieces carried (worn ones stay).
  for (const [slot, id] of Object.entries(set.worn)) {
    if (slot === "WEAPON_SLOT" || slot === "SHIELD_SLOT" || !(id > 0)) continue;
    if (player.getEquipment().getItems()[core.Equipment[slot]]?.getId?.() !== id) wield(core, player, id);
  }
  wieldAmmo(core, player, set.worn.WEAPON_SLOT, set.ammo?.id ?? null);
  if (set.spell) {
    const spell = core.CombatSpells?.[set.spell.toUpperCase().replace(/ /g, "_")];
    if (spell) core.Autocasting.setAutocast(player, spell);
  } else if (player.getCombat?.().getAutocastSpell?.()) {
    core.Autocasting.setAutocast(player, null);
  }
}

/**
 * Mid-fight style switches. `sets` the task's sets by style ({ melee: set, ranged: set, ... }, the
 * main one and those carried for switching). Switches away from a style the monster prays against
 * (its overhead icon), and for a monster whose rule is "form" re-picks the best style when it
 * changes form. Returns the style switched to, or null.
 */
function switchTick(core, player, fight, npc, sets, nowMs) {
  if (!npc || !sets || fight.spec) return null;
  const styles = Object.keys(sets);
  if (styles.length < 2) return null;
  if (fight.switchedAt !== undefined && nowMs - fight.switchedAt < SWITCH_GAP_MS) return null;
  const rule = ruleFor(npc);
  const current = currentStyle(core, player);
  const prayedAgainst = PROTECTS[headIcon(core, npc)] ?? null;
  const order = [...(rule?.prefer ?? []), ...styles].filter((style, index, all) => styles.includes(style) && all.indexOf(style) === index);
  let wanted = null;
  if (prayedAgainst === current) {
    wanted = order.filter((style) => style !== current).sort((a, b) => styleScore(core, player, b, npc) - styleScore(core, player, a, npc))[0] ?? null;
  } else if (rule?.switch === "form" && fight.formId !== npc.getId?.()) {
    fight.formId = npc.getId?.();
    const best = order.filter((style) => style !== prayedAgainst)
      .sort((a, b) => styleScore(core, player, b, npc) - styleScore(core, player, a, npc))[0];
    if (best && best !== current) wanted = best;
  }
  if (!wanted || !sets[wanted]) return null;
  wearSet(core, player, sets[wanted]);
  fight.switchedAt = nowMs;
  fight.switchLog?.({
    to: wanted, prayed: prayedAgainst, weapon: player.getEquipment().getItems()[core.Equipment.WEAPON_SLOT]?.getId?.() ?? null,
    ammo: player.getEquipment().getItems()[core.Equipment.AMMUNITION_SLOT]?.getId?.() ?? null,
  });
  fight.styled = false; // the attack style is chosen again for the new weapon
  reattack(player, npc);
  return wanted;
}

/**
 * The overhead icon a client draws over the NPC: the one set on it, else its (transformed) cache
 * definition's. Demonic gorillas pray by being another id whose definition carries the icon, and
 * have none set, so bots kept hitting a gorilla praying melee with a whip (380 hp untouched).
 */
function headIcon(core, npc) {
  const set = npc.getHeadIcon?.();
  if (Number.isInteger(set) && set >= 0) return set;
  try {
    const type = core.CacheDefinitions?.getNpc?.(npc.getId());
    const index = type?.headIconSpriteIndices?.[0];
    if (Number.isInteger(index) && index >= 0) return index;
    return Number.isInteger(type?.headIconPrayer) && type.headIconPrayer >= 0 ? type.headIconPrayer : -1;
  } catch {
    return -1;
  }
}

/** Whether data/monsters.json says this monster prays against the style that hurts it. */
function praysAgainst(name) {
  const key = lower(name);
  return MONSTERS.some((rule) => rule.switch === "protection" && rule.names.some((entry) => lower(entry) === key));
}

module.exports = { reattack, headIcon, praysAgainst, meleeDamage, hitChance, bestFightType, chooseStyle, specialTick, switchTick, currentStyle, wearSet, armourFor, pieceScore, npcDefence };
