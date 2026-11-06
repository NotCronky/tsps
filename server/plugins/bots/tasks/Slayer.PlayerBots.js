"use strict";

const fs = require("fs");
const path = require("path");
const { no, ok, skillOf } = require("./Common.PlayerBots");
const { createSlayerAssignmentAction } = require("../brain/actions/SlayerAssignment.PlayerBots");
const Kit = require("./SlayerKit.PlayerBots");

/**
 * Slayer, as players train it: a task from a master (Assignment, through the Slayer plugin), then
 * its monsters fought with combat training's gear, food and styles (trainCombat, kept to the NPCs
 * the task counts) till it's done, then back to the master for the next. The master is the best
 * one its combat level opens that it can walk to: Nieve at 85 combat, Vannaka (Edgeville
 * Dungeon) at 40, Mazchna (Canifis, with Priest in Peril) at 20, else Turael or Spria,
 * whichever is nearer. A task whose monsters it can't find or reach ends the trip.
 */
const MINUTES = [30, 60];
// A task none of whose monsters it could reach (behind a quest, a boat or a ladder): left for
// this long, the brain's other tasks in its place. (A player would skip it; a bot has no points.)
const OUT_OF_REACH_MS = 30 * 60 * 1000;
const outOfReach = new WeakMap();
const ACTIVITIES_FILE = path.join(__dirname, "..", "..", "..", "data", "definitions", "bot-activities.json");

// The masters' spawns (data/definitions/npc-spawns.json) and the combat they need (slayer-masters.json).
const MASTERS = [
  { name: "Nieve", npcIds: [1455], x: 2465, y: 3490, z: 0, combat: 85 },
  // In Edgeville Dungeon, down the trapdoor.
  { name: "Vannaka", npcIds: [403], x: 3147, y: 9914, z: 0, combat: 40 },
  // In Canifis, past the Salve: Priest in Peril.
  { name: "Mazchna", npcIds: [13652], x: 3511, y: 3509, z: 0, combat: 20, quest: "priest_in_peril" },
  { name: "Turael", npcIds: [13651], x: 2931, y: 3536, z: 0, combat: 0 },
  { name: "Spria", npcIds: [10440], x: 3091, y: 3266, z: 0, combat: 0 },
];

const TURAEL_ID = 1;
const TURAEL = MASTERS.find((master) => master.name === "Turael");

/** Whether it found the task's monsters out of reach lately. */
function stuckOn(player, task) {
  const stuck = outOfReach.get(player);
  return Boolean(stuck) && stuck.key === `${task.taskId}` && stuck.until > Date.now();
}

const slayer = () => ({
  Tasks: require("../../skills/slayer/Tasks.Slayer"),
  Data: require("../../skills/slayer/Data.Slayer"),
});

/** The current task's monsters, for trainCombat's `targets`: null with no task (or a boss task). */
function taskTargets(player) {
  const { Tasks, Data } = slayer();
  const task = Tasks.current(player);
  if (!task || task.taskId === Data.BOSS_TASK_ID) return null;
  return {
    key: `${task.taskId}`,
    counts: (definition) => Boolean(definition) && Data.npcCountsFor(task.taskId, definition.getId?.(), definition.getName?.()),
  };
}

function masterFor(player) {
  const combat = player.getSkillManager().getCombatLevel?.() ?? 3;
  const quests = new Map((require("../../quests/QuestRuntime").getRegisteredQuests?.() ?? []).map((quest) => [quest.key, quest]));
  const { canReachSpot } = require("../behaviours/navigation/LongRoutes.PlayerBots");
  // One it can walk to, or that a teleport it has (or has banked) lands near: Canifis, past the
  // Salve, by its fairy ring.
  const request = { player, options: [], bank: Array.from({ length: 10 }, (_, tab) => player.getBank?.(tab)?.getItems?.() ?? []).flat().filter((item) => item?.getId?.() > 0) };
  require("../../../src/main/typescript/elvarg/plugins/PluginManager").PluginManager.emitCustomEvent("teleport:options", request);
  const landsNear = (master) => request.options.some((option) => option?.to && (option.to.z ?? option.to.getZ?.() ?? 0) === master.z
    && Math.max(Math.abs((option.to.x ?? option.to.getX()) - master.x), Math.abs((option.to.y ?? option.to.getY()) - master.y)) <= 80);
  const reachable = (master) => canReachSpot(player, master) !== false || landsNear(master);
  const open = MASTERS.filter((master) => combat >= master.combat && (!master.quest || quests.get(master.quest)?.isComplete?.(player) === true)
    && (master.combat === 0 || reachable(master)));
  const best = Math.max(...open.map((master) => master.combat));
  const at = player.getLocation();
  return open.filter((master) => master.combat === best)
    .sort((a, b) => Math.max(Math.abs(a.x - at.getX()), Math.abs(a.y - at.getY())) - Math.max(Math.abs(b.x - at.getX()), Math.abs(b.y - at.getY())))[0];
}

let trainingSpec = null;
/** combat_training's own trainCombat step (bot-activities.json): its stages, gear and food. */
function combatTraining() {
  if (trainingSpec) return trainingSpec;
  const raw = JSON.parse(fs.readFileSync(ACTIVITIES_FILE, "utf8"));
  const list = Array.isArray(raw.activities) ? raw.activities : Object.values(raw.activities ?? {});
  trainingSpec = list.find((activity) => activity.id === "combat_training")?.actions?.find((action) => action.type === "trainCombat") ?? null;
  return trainingSpec;
}

function slayerTask() {
  return {
    id: "slayer",
    name: "Slayer: tasks from a master",
    shortName: "Slayer tasks",
    group: "Combat",
    subgroup: "Slayer",
    skill: "slayer",
    places: [],
    minutes: MINUTES,
    check(player) {
      if (!combatTraining()) return no("combat training isn't available");
      if (player.getSkillManager().getCurrentLevel(skillOf("hitpoints")) < 10) return no("too hurt to fight");
      const task = require("../../skills/slayer/Tasks.Slayer").current(player);
      // Out of reach: Turael swaps another master's task for one of his; his own it must leave.
      if (task && stuckOn(player, task) && task.masterId === TURAEL_ID) {
        return no(`its Slayer task (${task.task?.displayName ?? "monsters"}) is out of its reach`);
      }
      return ok();
    },
    build(player, { registry, world }) {
      const training = combatTraining();
      if (!training) return null;
      const Tasks = require("../../skills/slayer/Tasks.Slayer");
      // Stuck on another master's task it can't reach: Turael, to swap it.
      const swapping = (who) => {
        const current = Tasks.current(who);
        return Boolean(current) && stuckOn(who, current) && current.masterId !== TURAEL_ID;
      };
      const activity = registry.compile({
        id: "task_slayer", mode: "combat_training", capacity: 100000, repeat: true, failureCooldownSeconds: 60,
        actions: [{
          ...training, durationSeconds: { min: 3600, max: 3600 }, targets: taskTargets,
          // The task's protection stays on whatever armour it would otherwise wear.
          keepWorn: (who) => Kit.needs(Tasks.current(who)).filter((need) => need.wear).flatMap((need) => need.ids),
        }],
      });
      // A task it isn't stuck on, and it's on to the fight.
      const done = (who) => taskTargets(who) !== null && !swapping(who);
      activity.actions.unshift(createSlayerAssignmentAction({ master: (who) => (swapping(who) ? TURAEL : masterFor(who)), done }, world));
      // Its kit before the fight: the protection worn, the finishing item carried. One it can't
      // get is like monsters out of reach: Turael swaps another master's task.
      const kit = Kit.createSlayerKitAction({ task: (who) => Tasks.current(who) }, world);
      const kitUpdate = kit.update.bind(kit);
      kit.update = (ctx) => {
        const result = kitUpdate(ctx);
        const targets = taskTargets(ctx.player);
        if (result === "failed" && targets) {
          outOfReach.set(ctx.player, { key: targets.key, until: Date.now() + OUT_OF_REACH_MS });
          if (swapping(ctx.player)) return "success";
        }
        return result;
      };
      activity.actions.splice(1, 0, kit);
      // The fight failing before a single kill: its monsters are out of reach; noted for check().
      const fight = activity.actions[2];
      const update = fight.update.bind(fight);
      fight.update = (ctx) => {
        const targets = taskTargets(ctx.player);
        const before = require("../../skills/slayer/Tasks.Slayer").current(ctx.player)?.count ?? 0;
        // One waiting at 0 hitpoints for its finishing item gets it.
        Kit.finishTarget(ctx.player, world.core);
        // A swap on the way: the kit's turn first, then the fight.
        if (swapping(ctx.player)) return "success";
        const result = update(ctx);
        const after = require("../../skills/slayer/Tasks.Slayer").current(ctx.player)?.count ?? 0;
        if (after < before) outOfReach.delete(ctx.player);
        if (result === "failed" && targets) {
          outOfReach.set(ctx.player, { key: targets.key, until: Date.now() + OUT_OF_REACH_MS });
          // Another master's: round again, to Turael for a swap; his own: the trip ends.
          if (swapping(ctx.player)) return "success";
        }
        return result;
      };
      return activity;
    },
  };
}

module.exports = { slayerTask, taskTargets };
