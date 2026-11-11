"use strict";

/**
 * ::sppbots (owner): see who's online and what they're doing, change how many are online, or log
 * in a bot of a given kind next to you.
 *
 *   ::sppbots                         who's online
 *   ::sppbots online <n>              keep n bots online
 *   ::sppbots add [stage] [archetype] [iron]   a new bot, logged in where you stand
 *   ::sppbots goto <name>             go to a bot
 *   ::sppbots reach                   where can bots get to (and back) from where you stand
 *   ::sppbots probe <x> <y> [z]       one tile in the last reach
 *   ::sppbots scout start [n] | status | stop   find missing ways in and out with n scouts
 *   ::sppbots travel <name> <x> <y> [z]          send a bot somewhere (it plans with its own account)
 *   ::sppbots train <name> <skill> [level]       a bot trains a skill (data/skill-training.json)
 *   ::sppbots task <name> <task|auto>            a combat task (data/combat-tasks.json, or generated) for one bot
 *   ::sppbots tasks [check | for <name> | <monster>]   generated tasks: count, the checker's report, what a bot can do
 *   ::sppbots planner                             the route planner's queue (every search in the log)
 *   ::sppbots trip <name>                        where that bot's trip is (planning, which leg, the bank)
 *   ::sppbots tour [n] [banks] | status | stop   send n bots to random reachable NPCs (or banks) and back
 */

const { runReach, probe } = require("./Reach.SppBots");
const { createTravelActivity, plannerStatus, plannerLoad } = require("./Travel.SppBots");

const STAGES = ["new", "early", "mid", "late", "endgame"];
const ARCHETYPES = ["main", "pure", "skiller"];

function createCommands(population, scouting, tour) {
  function list(player) {
    const rows = population.status();
    player.sendMessage(`spp-bots: ${rows.length} online (target ${population.target(Date.now())} now, ${population.config.online} at the peak), roster ${population.roster.bots.length}, last tick ${population.lastTickMs.toFixed(1)} ms.`);
    for (const row of rows.slice(0, 30)) {
      player.sendMessage(`${row.name}: ${row.stage} ${row.archetype}${row.ironman ? " iron" : ""}, cb ${row.combat}, total ${row.total}, ${row.doing} (inv ${row.inventory}/28, +${row.xpGained} xp), ${row.minutesLeft}m left @ ${row.at}`);
    }
  }

  function setOnline(player, value) {
    const count = Math.max(0, Math.floor(Number(value)));
    if (!Number.isFinite(count)) {
      player.sendMessage("Use ::sppbots online <number>.");
      return;
    }
    population.config.online = count;
    population.config.rosterSize = Math.max(population.config.rosterSize, count);
    population.extraLogins = 0;
    player.sendMessage(`spp-bots: keeping ${count} online.`);
  }

  function add(player, args) {
    const overrides = {};
    for (const arg of args) {
      if (STAGES.includes(arg)) overrides.stage = arg;
      else if (ARCHETYPES.includes(arg)) overrides.archetype = arg;
      else if (arg === "iron" || arg === "ironman") overrides.ironman = true;
      else if (arg === "main-acc" || arg === "normal") overrides.ironman = false;
    }
    const bot = population.recruit(overrides);
    if (!bot) {
      player.sendMessage("spp-bots: no free name.");
      return;
    }
    const here = player.getLocation();
    bot.location = { x: here.getX(), y: here.getY(), z: here.getZ() };
    population.extraLogins += 1;
    if (!population.logIn(bot)) {
      population.extraLogins -= 1;
      player.sendMessage(`spp-bots: ${bot.name} couldn't log in.`);
      return;
    }
    const { stage, archetype, ironman, hours } = bot.profile;
    player.sendMessage(`spp-bots: ${bot.name} (${stage} ${archetype}${ironman ? " ironman" : ""}, ${hours} h played) is logging in here.`);
  }

  function goTo(player, name) {
    const entry = population.online.get(String(name ?? "").toLowerCase());
    if (!entry) {
      player.sendMessage(`spp-bots: ${name} isn't online.`);
      return;
    }
    player.moveTo(entry.player.getLocation().clone());
  }

  let reach = null;
  function startReach(player) {
    if (reach) {
      player.sendMessage(`spp-bots: reach is running (${reach.progress()}).`);
      return;
    }
    const here = player.getLocation();
    const start = { x: here.getX(), y: here.getY(), z: here.getZ() };
    player.sendMessage(`spp-bots: flooding the world from ${start.x},${start.y},${start.z}; this takes a while.`);
    reach = runReach(population.api.core, start, (report, file) => {
      reach = null;
      player.sendMessage(`spp-bots: reach done in ${Math.round(report.ms / 1000)} s: ${report.tiles.forward} tiles reachable, ${report.tiles.backward} can get back.`);
      player.sendMessage(`Transports: ${report.transports.cut} of ${report.transports.total} unreachable, ${report.transports.oneWay} one-way. NPCs: ${report.npcs.cut} of ${report.npcs.total} unreachable, ${report.npcs.oneWay} one-way.`);
      player.sendMessage(`Report: ${file}`);
    }, (error) => {
      reach = null;
      player.sendMessage(`spp-bots: reach failed: ${error?.message ?? error}`);
      console.error("[spp-bots] reach failed", error);
    });
  }

  function scout(player, args) {
    const [action = "status", count] = args;
    const name = player.getUsername();
    // Rounds take a while: tell whoever started it, if they're still online, and the server log.
    const tell = (message) => {
      console.info(`[spp-bots] scout: ${message}`);
      population.api.core.World.getPlayerByName(name)?.sendMessage?.(`spp-bots scout: ${message}`);
    };
    if (action === "start") {
      if (!scouting.start(Number(count) || 6, tell)) player.sendMessage(`spp-bots: ${scouting.status()}`);
    } else if (action === "stop") {
      scouting.stop();
      player.sendMessage("spp-bots: scouting stopped; findings saved.");
    } else {
      player.sendMessage(`spp-bots: ${scouting.status()}`);
    }
  }

  /** `task <name...> <task>`: a combat task (data/combat-tasks.json or generated) for one bot; `auto` picks one. */
  function combatTask(player, words) {
    const { createCombatTask, TASKS } = require("./CombatTask.SppBots");
    const TaskGen = require("./TaskGen.SppBots");
    // `task:style` runs it with that style (melee, ranged or magic) instead of the task's own.
    let [taskId, styleOverride] = String(words.pop() ?? "").split(":");
    const name = words.join(" ");
    if (!taskId || (taskId !== "auto" && taskId !== "gauntlet" && taskId !== "corrupted_gauntlet" && !TaskGen.taskById(population.api.core, taskId))) {
      player.sendMessage(`Use ::sppbots task <name> <task|auto>; tasks: ${Object.keys(TASKS).join(", ")}, or a generated one (::sppbots tasks <monster>).`);
      return;
    }
    const entry = population.online.get(name.toLowerCase());
    if (!entry?.brain) {
      player.sendMessage(`spp-bots: ${name} isn't online (or is still logging in).`);
      return;
    }
    if (taskId === "gauntlet" || taskId === "corrupted_gauntlet") {
      const { createGauntletTask } = require("./Gauntlet.SppBots");
      const asker = player.getUsername();
      const corrupted = taskId === "corrupted_gauntlet";
      const activity = createGauntletTask({
        api: population.api, entry, log: population.log, corrupted,
        onDone: (result, state) => population.api.core.World.getPlayerByName(asker)?.sendMessage?.(`spp-bots: ${entry.bot.name} ${taskId}: ${result} (${state.why}).`),
      });
      entry.brain.replaceRoot(activity, Date.now());
      entry.trip = activity;
      entry.brain.current = { id: `task ${taskId}`, since: Date.now() };
      return player.sendMessage(`spp-bots: ${entry.bot.name} is off to the ${corrupted ? "Corrupted " : ""}Gauntlet.`);
    }
    if (taskId === "auto") {
      const picked = TaskGen.pickTask(population.api.core, entry.player);
      if (!picked) return player.sendMessage(`spp-bots: no task fits ${entry.bot.name} (combat ${entry.player.getSkillManager().getCombatLevel()}).`);
      taskId = picked.id;
    }
    const asker = player.getUsername();
    const base = TaskGen.taskById(population.api.core, taskId);
    const task = styleOverride ? { ...base, style: styleOverride } : base;
    const activity = createCombatTask({
      api: population.api, entry, taskId, task, log: population.log,
      onDone: (result, state) => population.api.core.World.getPlayerByName(asker)?.sendMessage?.(`spp-bots: ${entry.bot.name} ${taskId}: ${result} (${state.kills} kills, ${state.restocks} restocks).`),
    });
    entry.brain.replaceRoot(activity, Date.now());
    entry.trip = activity;
    entry.brain.current = { id: `task ${taskId}`, since: Date.now() };
    player.sendMessage(`spp-bots: ${entry.bot.name} is on task ${taskId}.`);
  }

  /**
   * `tasks`: how many tasks there are; `tasks check`: the checker over every task (the report in
   * data/saves/spp-bots/task-report.json, the worst in chat); `tasks for <name>`: what that bot can
   * do and why not; `tasks <monster>`: the generated tasks for a monster.
   */
  function tasks(player, words) {
    const TaskGen = require("./TaskGen.SppBots");
    const core = population.api.core;
    const all = TaskGen.allTasks(core);
    const sub = String(words[0] ?? "").toLowerCase();
    if (sub === "check") {
      const report = TaskGen.checkAll(core, { reach: require("./Reach.SppBots") });
      const reachIn = Boolean(require("./Reach.SppBots").lastReach());
      try {
        const fs = require("fs");
        const path = require("path");
        const file = path.join(process.cwd(), "data", "saves", "spp-bots", "task-report.json");
        fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), reach: reachIn, ...report }, null, 2));
      } catch (error) {
        console.error("[spp-bots] task report", error);
      }
      player.sendMessage(`spp-bots: ${report.tasks} tasks, ${Object.keys(report.byTask).length} with problems (${report.errors} errors, ${report.warnings} warnings)${reachIn ? "" : "; no reach run, so reach wasn't checked"}. Report in task-report.json.`);
      for (const [id, problems] of Object.entries(report.byTask).filter(([, p]) => p.some((x) => x.level === "error")).slice(0, 8)) {
        player.sendMessage(`${id}: ${problems.map((p) => p.what).join("; ")}`);
      }
      population.log("spp_bots_task_check", { tasks: report.tasks, problems: Object.keys(report.byTask).length, errors: report.errors, warnings: report.warnings, reach: reachIn });
      return;
    }
    if (sub === "for") {
      const entry = population.online.get(words.slice(1).join(" ").toLowerCase());
      const target = entry?.player ?? (words.length === 1 ? player : null);
      if (!target) return player.sendMessage(`spp-bots: ${words.slice(1).join(" ")} isn't online.`);
      const have = require("./CombatTask.SppBots").owned(core, target);
      const why = new Map();
      const ok = [];
      for (const [id, task] of Object.entries(all)) {
        const result = TaskGen.canDo(core, target, task, { have, reach: true, api: population.api });
        if (result.ok) ok.push(id);
        else {
          const key = result.why.replace(/\d+/g, "N");
          why.set(key, (why.get(key) ?? 0) + 1);
        }
      }
      player.sendMessage(`spp-bots: ${target.getUsername()} (combat ${target.getSkillManager().getCombatLevel()}) can do ${ok.length} of ${Object.keys(all).length} tasks: ${ok.slice(0, 12).join(", ")}${ok.length > 12 ? ", ..." : ""}`);
      player.sendMessage(`Not: ${[...why].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w} ${n}`).join(", ")}`);
      const picked = TaskGen.pickTask(core, target);
      player.sendMessage(`It would pick: ${picked ? picked.id : "nothing"}.`);
      return;
    }
    if (sub) {
      const key = words.join(" ").toLowerCase().replace(/[^a-z0-9]/g, "");
      const found = Object.entries(all).filter(([, t]) => t.monster.toLowerCase().replace(/[^a-z0-9]/g, "") === key);
      player.sendMessage(`spp-bots: ${found.length} tasks for ${words.join(" ")}.`);
      for (const [id, t] of found.slice(0, 12)) player.sendMessage(`${id}: lvl ${t.level ?? "?"}, cb ${(t.combat ?? []).join("-")}, ${t.count ?? "?"} spawns, r ${t.area.radius}, ${t.kills} kills, ${t.food} food${t.members ? ", members" : ""}${t.slayer > 1 ? `, slayer ${t.slayer}` : ""}`);
      return;
    }
    const generated = Object.values(all).filter((t) => t.generated).length;
    player.sendMessage(`spp-bots: ${Object.keys(all).length} combat tasks (${generated} generated from the spawns). ::sppbots tasks check | for <name> | <monster>.`);
  }

  /** `train <name...> <skill> [level]`: a bot trains a skill by data/skill-training.json. */
  function train(player, words) {
    const { createTrainingActivity, COMBAT_SKILLS } = require("./Training.SppBots");
    const target = /^\d+$/.test(words[words.length - 1] ?? "") ? Number(words.pop()) : 99;
    const skill = String(words.pop() ?? "").toLowerCase();
    if (!COMBAT_SKILLS.includes(skill)) {
      player.sendMessage(`Use ::sppbots train <name> <skill> [level]; skills: ${COMBAT_SKILLS.join(", ")}.`);
      return;
    }
    const entry = population.online.get(words.join(" ").toLowerCase());
    if (!entry?.brain) return player.sendMessage(`spp-bots: ${words.join(" ")} isn't online.`);
    const asker = player.getUsername();
    const activity = createTrainingActivity({
      api: population.api, entry, skill, target, log: population.log,
      onDone: (result, why) => population.api.core.World.getPlayerByName(asker)?.sendMessage?.(`spp-bots: ${entry.bot.name} ${skill}: ${result} (${why}).`),
    });
    entry.brain.replaceRoot(activity, Date.now());
    entry.trip = activity;
    entry.brain.current = { id: `train ${skill} to ${target}`, since: Date.now() };
    player.sendMessage(`spp-bots: ${entry.bot.name} is training ${skill} to ${target}.`);
  }

  /** `set <name...> <style>`: the set that bot would take for a style (what it owns, worn or banked). */
  function showSet(player, words) {
    const { setFor } = require("./CombatTask.SppBots");
    const style = words.pop();
    const entry = population.online.get(words.join(" ").toLowerCase());
    if (!entry) return player.sendMessage("spp-bots: not online.");
    const set = setFor(population.api.core, entry.player, style);
    const line = JSON.stringify(set);
    console.info(`[spp-bots] set ${entry.bot.name} ${style}: ${line}`);
    player.sendMessage(`spp-bots: ${entry.bot.name} ${style}: ${line ?? "none"}`);
  }

  /** `landings`: transports whose landing tile is blocked (the planner doesn't walk on from those). */
  function landings(player) {
    const { createMap } = require("./Travel.SppBots");
    const { transportIndex } = require("./Transports.SppBots");
    const { BLOCKED } = require("./Imports.SppBots");
    const map = createMap(population.api.core);
    let total = 0;
    const blocked = [];
    for (const transports of transportIndex().values()) {
      for (const transport of transports) {
        total += 1;
        const [x, y, z] = transport.to;
        if (map.getFlag(x, y, z) & BLOCKED) blocked.push(`${transport.menu}@${x},${y},${z}`);
      }
    }
    console.info(`[spp-bots] landings blocked ${blocked.length} of ${total}: ${JSON.stringify(blocked.slice(0, 60))}`);
    player.sendMessage(`spp-bots: ${blocked.length} of ${total} transports land on a blocked tile (examples in the log).`);
  }

  /** `planner`: what the shared route planner is working on (summary in chat, every search in the log). */
  function plannerView(player) {
    const rows = plannerStatus();
    const plain = rows.filter((row) => row.plain).length;
    const big = rows.filter((row) => row.expansions >= 60000).length;
    const oldest = rows.reduce((max, row) => Math.max(max, row.ageS), 0);
    const load = plannerLoad();
    player.sendMessage(`spp-bots: planner ${rows.length} searches (${plain} bank walks, ${big} over 60k), oldest ${oldest} s; budget ${load.budgetMs} ms, used ${load.msPerTick} ms a tick over ${load.ticks} ticks.`);
    console.info(`[spp-bots] planner ${JSON.stringify(rows)}`);
  }

  /** `trip <name...>`: the state of the bot's last trip (from travel or a tour), in chat and the log. */
  function trip(player, name) {
    // A bot, or a player in bot mode.
    const entry = population.online.get(name.toLowerCase())
      ?? [...(population.botMode?.active?.values?.() ?? [])].find((e) => e.bot.name.toLowerCase() === name.toLowerCase());
    if (!entry) return player.sendMessage(`spp-bots: ${name} isn't online.`);
    const brain = entry.brain;
    const frames = (brain?.frames ?? []).map((frame) => ({ activity: frame.behaviour?.id ?? null, state: frame.state, failReason: frame.failReason ?? null, action: frame.action?.()?.id ?? null, detail: frame.action?.()?.describe?.() ?? null }));
    const restMs = Math.max(0, Math.round((brain?.restUntil ?? 0) - Date.now()));
    const fight = entry.fight ? { wants: entry.fight.wants, spec: entry.fight.spec?.phase ?? null, specialEnergy: entry.player.getSpecialPercentage?.(), style: entry.player.getFightType?.()?.getChildId?.(), prayers: (entry.player.getPrayerActive?.() ?? []).map((on, id) => (on ? id : -1)).filter((id) => id >= 0), hitpoints: entry.player.getHitpoints?.(), npc: entry.fight.npc?.getCurrentDefinition?.()?.getName?.() ?? null } : null;
    const line = JSON.stringify({ trip: entry.trip ? entry.trip.describe(entry.player) : null, frames, restMs, paused: Boolean(brain?.paused), lastError: brain?.lastError ?? null, fight });
    console.info(`[spp-bots] trip ${entry.bot.name}: ${line}`);
    player.sendMessage(`spp-bots: ${entry.bot.name} (${entry.brain?.current?.id ?? "idle"}): ${line}`);
  }

  /** `travel <name...> <x> <y> [z]`: the name may have spaces, the coordinates are the last numbers. */
  function travel(player, words) {
    const numbers = [];
    while (words.length && /^-?\d+$/.test(words[words.length - 1]) && numbers.length < 3) numbers.unshift(Number(words.pop()));
    if (numbers.length < 2 || !words.length) {
      player.sendMessage("Use ::sppbots travel <name> <x> <y> [z].");
      return;
    }
    const [x, y, z = 0] = numbers;
    const name = words.join(" ");
    const entry = population.online.get(name.toLowerCase());
    if (!entry?.brain) {
      player.sendMessage(`spp-bots: ${name} isn't online (or is still logging in).`);
      return;
    }
    const asker = player.getUsername();
    const startedAt = Date.now();
    const activity = createTravelActivity({
      api: population.api,
      goal: { x, y, z },
      log: population.log,
      onDone: (result, report) => {
        const at = entry.player.getLocation();
        const line = `${entry.bot.name} ${result === "success" ? "arrived" : "gave up"} at ${at.getX()},${at.getY()},${at.getZ()} after ${Math.round((Date.now() - startedAt) / 1000)} s (${report?.noRoute ? `no route: ${report.noRoute}` : `${report?.replans ?? 0} plans`}${report?.failed?.length ? `, failed: ${report.failed.join("; ")}` : ""}).`;
        console.info(`[spp-bots] travel: ${line}`);
        population.api.core.World.getPlayerByName(asker)?.sendMessage?.(`spp-bots: ${line}`);
      },
    });
    entry.brain.replaceRoot(activity, Date.now());
    entry.trip = activity;
    entry.brain.current = { id: `travel to ${x},${y},${z}`, since: Date.now() };
    player.sendMessage(`spp-bots: ${entry.bot.name} is on the way to ${x},${y},${z}.`);
  }

  function touring(player, args) {
    const [action = "status", count] = args;
    const name = player.getUsername();
    const tell = (message) => {
      console.info(`[spp-bots] ${message}`);
      population.api.core.World.getPlayerByName(name)?.sendMessage?.(`spp-bots ${message}`);
    };
    if (action === "stop") {
      tour.stop();
      player.sendMessage(`spp-bots: tour stopped. ${tour.status()}`);
    } else if (action === "status") {
      player.sendMessage(`spp-bots: ${tour.status()}`);
    } else {
      tour.start(Number(action) || Number(count) || 10, tell, { banks: args.includes("banks") });
    }
  }

  return function sppbots({ player, parts }) {
    const [, sub, ...args] = parts.map((part) => String(part).toLowerCase());
    if (!sub) list(player);
    else if (sub === "online") setOnline(player, args[0]);
    else if (sub === "add") add(player, args);
    else if (sub === "goto") goTo(player, parts.slice(2).join(" "));
    else if (sub === "reach") startReach(player);
    else if (sub === "scout") scout(player, args);
    else if (sub === "travel") travel(player, parts.slice(2).map(String));
    else if (sub === "planner") plannerView(player);
    else if (sub === "landings") landings(player);
    else if (sub === "tasks") tasks(player, parts.slice(2).map(String));
    else if (sub === "task") combatTask(player, parts.slice(2).map(String));
    else if (sub === "set") showSet(player, parts.slice(2).map(String));
    else if (sub === "train") train(player, parts.slice(2).map(String));
    else if (sub === "trip") trip(player, parts.slice(2).join(" "));
    else if (sub === "tour") touring(player, args);
    else if (sub === "probe") {
      const [x, y, z = 0] = args.map(Number);
      const result = probe(x, y, z);
      player.sendMessage(result ? `probe ${x},${y},${z}: ${JSON.stringify(result)}` : "spp-bots: run ::sppbots reach first.");
    }
    else player.sendMessage("Use ::sppbots, online <n>, add [stage] [archetype] [iron], goto <name>, travel <name> <x> <y> [z], trip <name>, tour [n], reach, probe, scout.");
    return true;
  };
}

module.exports = { createCommands };
