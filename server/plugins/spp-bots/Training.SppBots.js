"use strict";

/**
 * Skill training (docs/playerbots.md, Training): a bot trains a skill from where it is to a target
 * level by the methods in data/skill-training.json (from the OSRS Wiki's training guides), one
 * method per level band. Combat skills are combat tasks (CombatTask.SppBots.js) with a level goal
 * and the weapon style that trains the skill; the monster's area comes from the NPC spawns, not
 * from coordinates in the data.
 */

const path = require("path");

const TRAINING = require(path.join(__dirname, "data", "skill-training.json"));
// How often a bot takes the guide's first choice for its level rather than another.
const FIRST_CHOICE = 0.7;
const MAX_FAILURES = 3;

const lower = (value) => String(value ?? "").toLowerCase();

const { areasOf } = require("./TaskGen.SppBots");

/**
 * Where `player` should fight `method.monster`: the area nearest the method's `near` (the guide's
 * place), else nearest the bot; not in the Wilderness, nor where the last reach run didn't get.
 */
function areaFor(core, player, method) {
  const { lastReach, reached } = require("./Reach.SppBots");
  const reach = lastReach();
  const here = player.getLocation();
  const from = method.near ? { x: method.near[0], y: method.near[1] } : { x: here.getX(), y: here.getY() };
  let best = null;
  for (const area of areasOf(method.monster)) {
    if (area.x >= 6400) continue;
    if (core.Wilderness.levelAt(area.x, area.y) > 0) continue;
    if (reach && !reached(area.x, area.y, area.z)) continue;
    const distance = Math.max(Math.abs(area.x - from.x), Math.abs(area.y - from.y));
    // A handful of spawns isn't a training spot when a bigger one is near.
    const score = distance - Math.min(area.count, 20) * 4;
    if (!best || score < best.score) best = { area, score };
  }
  return best?.area ?? null;
}

function skillOf(name) {
  const skill = TRAINING.skills?.[lower(name)];
  if (!skill) return null;
  const methods = typeof skill.methods === "string" ? TRAINING[skill.methods] : skill.methods;
  return { ...skill, name: lower(name), methods: methods ?? [] };
}

function levelOf(core, player, skill) {
  const id = core.Skill?.[skill.toUpperCase()];
  return id === undefined ? 1 : player.getSkillManager().getMaxLevel(id);
}

/** The methods `player` can use for `skill` at its level now, guide order (and not `skip`ped). */
function methodsFor(core, player, skill, skip = new Set()) {
  const { owned } = require("./CombatTask.SppBots");
  const level = levelOf(core, player, skill.name);
  const have = owned(core, player);
  const members = require("./Imports.SppBots").isMembersWorld();
  return skill.methods.filter((method, index) => {
    if (skip.has(index) || level < method.from || level >= method.to) return false;
    if (method.members && !members) return false;
    return (method.items ?? []).every((key) => (have.get(core.ItemIds?.[key]) ?? 0) > 0);
  }).map((method) => ({ ...method, index: skill.methods.indexOf(method) }));
}

/**
 * Training as a one-off brain activity: one combat task per method, each to the method's top
 * level (or `target`), until `target` or nothing's left that the bot can do.
 */
function createTrainingActivity({ api, entry, skill: skillName, target = 99, log = () => {}, onDone = () => {} }) {
  const core = api.core;
  const { createCombatTask } = require("./CombatTask.SppBots");
  const skill = skillOf(skillName);
  const state = { current: null, failures: 0, skip: new Set(), methods: 0 };
  let finished = false;
  const finish = (result, why) => {
    if (finished) return;
    finished = true;
    log("spp_bots_training", { name: entry.bot.name, skill: skillName, result, why, level: skill ? levelOf(core, entry.player, skill.name) : null, methods: state.methods });
    onDone(result, why);
  };

  function next(player) {
    if (levelOf(core, player, skill.name) >= target) return finish("success", "level"), "success";
    // Prayer: a host's gilded altar first (the bot's bones, Phials, Rimmington), while there is one.
    if (skill.name === "prayer" && !state.altarDone) {
      const HousePrayer = require("./HousePrayer.SppBots");
      if (HousePrayer.hostName()) {
        state.altarDone = true;
        state.method = { monster: "host's altar", index: -1 };
        state.methods += 1;
        state.current = HousePrayer.createAltarActivity({ api, entry, host: HousePrayer.hostName, until: target, log });
        log("spp_bots_training", { name: entry.bot.name, skill: "prayer", step: "method", method: "host altar", host: HousePrayer.hostName(), level: levelOf(core, player, "prayer"), until: target });
        return "running";
      }
    }
    const options = methodsFor(core, player, skill, state.skip);
    if (options.length === 0) return finish("failed", "no method for this level"), "failed";
    const method = Math.random() < FIRST_CHOICE || options.length === 1 ? options[0] : options[1 + Math.floor(Math.random() * (options.length - 1))];
    const area = areaFor(core, player, method);
    if (!area) {
      state.skip.add(method.index);
      return "running";
    }
    const task = {
      monster: method.monster, area, style: skill.style, xpStyle: skill.xpStyle ?? null, bury: skill.bury === true,
      items: method.items, food: method.food ?? 8,
      until: { skill: skill.name, level: Math.min(target, method.to) },
    };
    state.method = method;
    state.methods += 1;
    state.current = createCombatTask({
      api, entry, taskId: `train:${skill.name}`, task, log,
      onDone: (result, taskState) => {
        state.lastResult = result;
        state.lastWhy = taskState.why;
      },
    });
    log("spp_bots_training", { name: entry.bot.name, skill: skill.name, step: "method", monster: method.monster, area, level: levelOf(core, player, skill.name), until: task.until.level });
    return "running";
  }

  const action = {
    id: "training",
    update(ctx) {
      if (!skill) return finish("failed", "unknown skill"), "failed";
      if (!state.current) return next(ctx.player);
      const result = state.current.actions[0].update(ctx);
      if (result === "running") return "running";
      state.current = null;
      if (result === "success") {
        state.failures = 0;
        return "running";
      }
      // That method didn't work out (no set for its style, out of food, no way there): another.
      // (The altar ending without bones isn't a failure of training: on to burying.)
      if (state.method?.index === -1) return "running";
      state.failures += 1;
      state.skip.add(state.method.index);
      if (state.failures >= MAX_FAILURES) return finish("failed", state.lastWhy ?? "failed"), "failed";
      return "running";
    },
    madeProgress: () => true,
    describe: () => ({ skill: skillName, target, method: state.method?.monster ?? null, task: state.current?.describe?.() ?? null, failures: state.failures }),
    stop(ctx) {
      state.current?.actions[0].stop(ctx);
      finish("failed", "stopped");
    },
  };
  return {
    id: `train:${skillName}`, skill: skillName, resolver: false, resolves: null, mode: "training", capacity: 1, repeat: false,
    ephemeral: false, manual: false, failureCooldownMs: 0, requires: [], setup: [], actions: [action],
    describe: () => action.describe(), produces: [], site: null,
  };
}

const COMBAT_SKILLS = Object.keys(TRAINING.skills ?? {});

module.exports = { createTrainingActivity, areasOf, areaFor, methodsFor, skillOf, COMBAT_SKILLS };
