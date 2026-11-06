"use strict";

const fletching = require("../../skills/data/fletching.json");
const herblore = require("../../skills/data/herblore.json");
const crafting = require("../../skills/data/crafting.json");
const bones = require("../../skills/data/bones.json");
const { makingTask, slug, resolve, nameOf } = require("./Making.PlayerBots");
const { createTravelToAction } = require("../brain/actions/TravelTo.PlayerBots");
const HouseHost = require("../lib/HouseHost.PlayerBots");
const Supplies = require("../lib/Supplies.PlayerBots");
const { no, ok } = require("./Common.PlayerBots");

/**
 * The skills that turn one thing into another at a bank, every product its own task, from the
 * skill plugins' own recipe data (plugins/skills/data): Fletching (each log's shafts, bows and
 * shields, stringing each bow, each crossbow's stock on its limbs, arrows, darts and bolts by metal,
 * gem-tipped bolts), Herblore
 * (cleaning each herb, each unfinished and finished potion), Crafting (each gem, each leather and
 * dragonhide piece, glassblowing, battlestaves, stringing amulets) and Prayer (burying each bone).
 * `family` sorts a skill's tasks in the bot mode picker.
 */

/** "OAK_LONGBOW_U_" -> "Oak longbow (u)". */
function pretty(key) {
  const text = String(key).toLowerCase().replace(/_u_$/, " (u)").replace(/_/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const FLETCHING_FAMILIES = {
  crossbows: "Crossbows",
  stringing: "Stringing bows",
  arrows: "Arrows",
  darts: "Darts",
  bolts: "Bolts",
  tipped: "Gem-tipped bolts",
};
const material = (name) => (name === "@feathers" ? "FEATHER" : name);

function fletchingTasks(places) {
  const tools = fletching.tools ?? {};
  const tasks = [];
  for (const recipe of fletching.recipes) {
    if (recipe.quest) continue;
    const group = fletching.groups[recipe.group] ?? {};
    const materials = recipe.materials.map(([name, amount]) => [material(name), amount]);
    if (recipe.group === "logs" || recipe.group === "shields") {
      // The knife on one kind of log: a family per log.
      if (materials.length !== 1) continue;
      const log = materials[0][0];
      const shafts = recipe.output === "ARROW_SHAFT";
      tasks.push(makingTask({
        id: `fletch_${slug(recipe.output)}${shafts ? `_${slug(log)}` : ""}`,
        subgroup: "Fletching",
        family: pretty(log),
        skill: "fletching",
        level: recipe.level,
        tool: tools[group.tool] ?? tools.knife,
        materials,
        output: recipe.output,
        shortName: shafts ? `Arrow shafts (${pretty(log).toLowerCase()})` : undefined,
        places,
      }));
    } else if (FLETCHING_FAMILIES[recipe.group]) {
      if (materials.length !== 2) continue;
      tasks.push(makingTask({
        id: `fletch_${slug(recipe.output)}`,
        subgroup: "Fletching",
        family: FLETCHING_FAMILIES[recipe.group],
        skill: "fletching",
        level: recipe.level,
        // A crossbow's stock goes on its limbs with a hammer held.
        tool: group.held ? group.held.flatMap((name) => tools[name] ?? []) : null,
        held: Boolean(group.held),
        materials,
        output: recipe.output,
        places,
      }));
    }
  }
  return tasks;
}

function herbloreTasks(places) {
  const tasks = herblore.herbs.map((herb) => makingTask({
    id: `clean_${slug(herb.clean)}`,
    kind: "click",
    subgroup: "Herblore",
    family: "Cleaning herbs",
    skill: "herblore",
    level: herb.level,
    tool: null,
    materials: [[herb.grimy, 1]],
    output: herb.clean,
    places,
  }));
  for (const recipe of herblore.recipes) {
    const { product, ingredients } = recipe;
    if (recipe.quest || ingredients.length !== 2 || ingredients.some(([, amount]) => amount !== 1)) continue;
    // One task per potion: the three-dose mix (the others are doses topped up).
    if (/^[124]dose/.test(product)) continue;
    const unfinished = /vial$/.test(product) || /^unfinished/.test(product);
    tasks.push(makingTask({
      id: `herb_${slug(product)}`,
      subgroup: "Herblore",
      family: unfinished ? "Unfinished potions" : "Potions",
      skill: "herblore",
      level: recipe.level,
      tool: null,
      materials: ingredients,
      output: product,
      places,
    }));
  }
  return tasks;
}

function craftingTasks(places) {
  const tasks = [];
  for (const gem of crafting.gems.recipes) {
    tasks.push(makingTask({
      id: `cut_${slug(gem.cut)}`, subgroup: "Crafting", family: "Gem cutting", skill: "crafting", level: gem.level,
      tool: ["CHISEL", "JEWELLERS_CHISEL"], materials: [[gem.uncut, 1]], output: gem.cut, places,
    }));
  }
  for (const [leather, items] of Object.entries(crafting.leather)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      tasks.push(makingTask({
        id: `craft_${slug(item.item)}`, subgroup: "Crafting", family: pretty(leather), skill: "crafting", level: item.level,
        tool: ["NEEDLE"], materials: [[leather, item.leather ?? 1], ["THREAD", 1]], output: item.item, places,
      }));
    }
  }
  for (const item of crafting.glassblowing.recipes) {
    tasks.push(makingTask({
      id: `blow_${slug(item.item)}`, subgroup: "Crafting", family: "Glassblowing", skill: "crafting", level: item.level,
      tool: ["GLASSBLOWING_PIPE"], materials: [["MOLTEN_GLASS", 1]], output: item.item, places,
    }));
  }
  for (const staff of crafting.battlestaves.recipes) {
    tasks.push(makingTask({
      id: `craft_${slug(staff.item)}`, subgroup: "Crafting", family: "Battlestaves", skill: "crafting", level: staff.level,
      tool: null, materials: [[staff.orb, 1], ["BATTLESTAFF", 1]], output: staff.item, places,
    }));
  }
  return tasks;
}

// Bones a player buries for Prayer: not the minigame, quest and ground-only ones.
const NOT_BURIED = /^(mm_|tbwt_|zogre_|dorgesh_|alan_|bones_burnt|.*monkey)/;

function prayerTasks(places) {
  const buried = bones.bones.filter((bone) => !bone.groundOnly && !NOT_BURIED.test(bone.obj));
  return [...buried.map((bone) => makingTask({
      id: `bury_${slug(bone.obj)}`,
      kind: "click",
      subgroup: "Prayer",
      family: "Burying",
      skill: "prayer",
      level: bone.level ?? 1,
      tool: null,
      materials: [[bone.obj, 1]],
      places,
    })), ...buried.map(altarTask)];
}

// A trip's bones at the altar: what an inventory holds, ten times over, unnoted at Phials.
const ALTAR_TRIP = 260;
const ALTAR_MIN = 27;
const PHIALS_FEE = 5;

/** Bones at the house host's gilded altar: a task per bone, open while the host is hosting. */
function altarTask(bone) {
  const id = resolve(bone.obj);
  return {
    id: `altar_${slug(bone.obj)}`,
    get name() { return `Prayer: ${this.shortName} at the gilded altar`; },
    get shortName() { return Number.isInteger(id) ? nameOf(id) : pretty(bone.obj); },
    group: "Processing",
    subgroup: "Prayer",
    family: "Gilded altar",
    skill: "prayer",
    // A house party: plenty at the altar at once.
    crowd: 20,
    // A little above burying the same bones, so the altar comes up more once it's open.
    level: (bone.level ?? 1) + 1,
    // It travels as part of the task, after the bank.
    places: [],
    minutes: [20, 45],
    check(player) {
      if (!Number.isInteger(id)) return no("isn't in this game");
      if (!HouseHost.host()) return no("no house host is online");
      const banked = Supplies.bankedAmount(player, id);
      if (banked < ALTAR_MIN) return no(`needs ${nameOf(id).toLowerCase()} in the bank`);
      if (Supplies.coins(player) < Math.min(banked, ALTAR_TRIP) * PHIALS_FEE) return no("needs coins for Phials");
      return ok();
    },
    build(player, { registry, world }) {
      const amount = Math.min(Supplies.bankedAmount(player, id), ALTAR_TRIP);
      const activity = registry.compile({
        id: `task_altar_${slug(bone.obj)}`, mode: "prayer", capacity: 100000, repeat: false,
        actions: [
          { type: "bank", until: { inventoryFull: false } },
          { type: "bank", withdraw: [{ item: id, amount, noted: true }, { item: Supplies.COINS, amount: amount * PHIALS_FEE }] },
          { type: "altarRun", bone: id },
        ],
      });
      // To Rimmington between the bank and the altar, by teleport where it has one.
      activity.actions.splice(2, 0, createTravelToAction({ ...HouseHost.PORTAL, radius: 6 }, world));
      return activity;
    },
  };
}

function artisanTasks(places) {
  const bank = places.banking ?? [];
  const tasks = [...fletchingTasks(bank), ...herbloreTasks(bank), ...craftingTasks(bank), ...prayerTasks(bank)];
  // Two recipes for one product (anti-venom+ from either antidote): the first is the task.
  const seen = new Set();
  return tasks.filter((task) => !seen.has(task.id) && seen.add(task.id));
}

module.exports = { artisanTasks, pretty };
