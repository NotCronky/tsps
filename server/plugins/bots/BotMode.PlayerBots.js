"use strict";

const { BotBrain } = require("./brain/Brain.PlayerBots");
const { createInitialState, resetMovementState } = require("./behaviours/state/State.PlayerBots");
const { TaskAgent } = require("./agent/Agent.PlayerBots");

/**
 * Bot mode: a player's own character plays itself, through the same task agent and executor
 * as the bots, while they watch. `::botmode` opens a picker (let the brain choose, or a task
 * from a group); `::botmode <task>` starts one; `::botmode off` stops. Any click of the
 * player's own in the world takes back control at once ("player:world-input"), and logging
 * out ends it. The character stays an ordinary player throughout: it isn't flagged as a bot.
 */
const LAST_TASK_ATTRIBUTE = "bot-mode:last-task";
const BRAIN_CHOICE = "brain";

let pluginApi = null;
let catalogue = null;
let registry = null;
let world = null;
let behaviorMode = null;
/** Player -> { agent, brain }. */
const sessions = new Map();

function init(options) {
  ({ api: pluginApi, catalogue, registry, world, behaviorMode } = options);
}

function isActive(player) {
  return sessions.has(player);
}

function stop(player, message) {
  const session = sessions.get(player);
  if (!session) return false;
  sessions.delete(player);
  session.brain.reset();
  resetMovementState(player);
  player.getMovementQueue?.()?.reset?.();
  if (message) player.sendMessage(message);
  return true;
}

/** Starts bot mode on `taskId` (a catalogue id), or with the brain choosing when it is BRAIN_CHOICE. */
function start(player, taskId) {
  stop(player);
  const task = taskId === BRAIN_CHOICE ? null : catalogue.get(taskId);
  if (taskId !== BRAIN_CHOICE) {
    if (!task) {
      player.sendMessage(`There's no task called '${taskId}'. Type ::botmode to pick one.`);
      return false;
    }
    const check = task.check(player, { registry, world });
    if (!check.ok) {
      player.sendMessage(`You can't do ${task.name} yet: ${check.reason}.`);
      return false;
    }
  }
  const location = player.getLocation();
  const state = createInitialState({ x: location.getX(), y: location.getY(), z: location.getZ() }, behaviorMode);
  const agent = new TaskAgent({
    player,
    catalogue,
    registry,
    world,
    taskId: task ? task.id : null,
    onStuck: (reason) => stop(player, `<col=ff0000>Bot mode stopped:</col> ${reason}.`),
  });
  const brain = new BotBrain({ player, state, registry, world, chooseNext: (nowMs) => agent.next(nowMs) });
  sessions.set(player, { agent, brain });
  player.setAttribute(LAST_TASK_ATTRIBUTE, task ? task.id : BRAIN_CHOICE);
  player.sendMessage(task
    ? `<col=00aa00>Bot mode on:</col> ${task.name}. Click anywhere to take back control, or type ::botmode off.`
    : "<col=00aa00>Bot mode on:</col> the brain picks what to train. Click anywhere to take back control, or type ::botmode off.");
  return true;
}

/** Menus hold five options: a page shows up to three entries, then "More" and "Back". */
const PAGE = 3;

/** One page of `entries` ([label, onPick]), with paging and a way back. */
function pagedMenu(player, title, entries, back, page = 0) {
  const fits = entries.length <= PAGE + 1;
  const shown = fits ? entries : entries.slice(page * PAGE, page * PAGE + PAGE);
  const options = shown.flat();
  if (!fits) {
    const more = (page + 1) * PAGE < entries.length;
    options.push(more ? "More..." : "Start of the list", () => pagedMenu(player, title, entries, back, more ? page + 1 : 0));
  }
  options.push("Back", back);
  pluginApi.sendMultiChatboxPrompt(player, title, ...options);
}

/** A task as a menu entry: locked ones say why when picked. */
function taskEntry(player, task, label = task.name) {
  const check = task.check(player, { registry, world });
  return [check.ok ? label : `${label} (locked)`, () => {
    if (!check.ok) player.sendMessage(`${task.name} is locked: ${check.reason}.`);
    else start(player, task.id);
  }];
}

/** A group's tasks; a group of skills with tiers (Gathering) lists the skills first. */
function groupMenu(player, group) {
  const tasks = catalogue.tasks.filter((task) => task.group === group);
  const subgroups = [...new Set(tasks.map((task) => task.subgroup).filter(Boolean))];
  const back = () => openPicker(player);
  if (subgroups.length === 0) {
    pagedMenu(player, `Bot mode: ${group}`, tasks.map((task) => taskEntry(player, task)), back);
    return;
  }
  pagedMenu(player, `Bot mode: ${group}`, subgroups.map((subgroup) => [subgroup, () => {
    const tiers = tasks.filter((task) => task.subgroup === subgroup);
    pagedMenu(player, `Bot mode: ${subgroup}`, tiers.map((task) => taskEntry(player, task, task.shortName ?? task.name)),
      () => groupMenu(player, group));
  }]), back);
}

function openPicker(player) {
  const last = player.getAttribute(LAST_TASK_ATTRIBUTE);
  const lastTask = last && last !== BRAIN_CHOICE ? catalogue.get(last) : null;
  // Quests only show while one is open (Tutorial Island), so the picker stays within five options.
  const shown = catalogue.groups.filter((group) => group !== "Quests"
    || catalogue.tasks.some((task) => task.group === group && task.check(player, { registry, world }).ok));
  const options = [
    "Let the brain choose", () => start(player, BRAIN_CHOICE),
    ...shown.flatMap((group) => [group, () => groupMenu(player, group)]),
  ];
  if (lastTask) options.push(`Resume ${lastTask.name}`, () => start(player, lastTask.id));
  pluginApi.sendMultiChatboxPrompt(player, "What should your character do?", ...options.slice(0, 10));
}

/** ::botmode [off | status | <task>] */
function botModeCommand({ player, parts }) {
  const arg = (parts?.slice(1).join(" ") ?? "").trim().toLowerCase();
  if (arg === "off" || arg === "stop") {
    if (!stop(player, "Bot mode off.")) player.sendMessage("Bot mode isn't on.");
    return true;
  }
  if (arg === "status") {
    const session = sessions.get(player);
    player.sendMessage(session ? `Bot mode: ${session.agent.describe()}.` : "Bot mode is off.");
    return true;
  }
  if (arg === "list") {
    for (const task of catalogue.tasks) {
      const check = task.check(player, { registry, world });
      player.sendMessage(`${task.id}: ${task.name}${check.ok ? "" : ` (locked: ${check.reason})`}`);
    }
    return true;
  }
  if (arg === "brain" || arg === "auto") start(player, BRAIN_CHOICE);
  else if (arg) start(player, arg);
  else openPicker(player);
  return true;
}

/** The player clicked in the world themselves: their character is theirs again. */
function tookOver({ player }) {
  if (isActive(player)) stop(player, "Bot mode off: you took over.");
}

function loggedOut({ player }) {
  stop(player);
}

/** One tick for every character in bot mode: its executor acts, and a finished task makes way. */
function tickAll(nowMs = Date.now()) {
  for (const [player, session] of sessions) {
    if (player.isRegistered?.() === false || player.getHitpoints?.() <= 0) {
      stop(player);
      continue;
    }
    try {
      if (session.agent.due(nowMs) && !player.getCombat?.()?.getTarget?.()) {
        const next = session.agent.next(nowMs);
        if (next !== "wait") session.brain.replaceRoot(next, nowMs);
      }
      session.brain.tick(nowMs);
    } catch (error) {
      world.log?.("bot_mode_tick_failed", { player: player.getUsername?.(), error: String(error?.message ?? error) });
      stop(player, "<col=ff0000>Bot mode stopped:</col> something went wrong.");
    }
  }
}

module.exports = {
  LAST_TASK_ATTRIBUTE,
  BRAIN_CHOICE,
  init,
  isActive,
  start,
  stop,
  botModeCommand,
  tookOver,
  loggedOut,
  tickAll,
  sessions,
};
