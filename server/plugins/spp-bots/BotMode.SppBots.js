"use strict";

/**
 * Bot mode (docs/playerbots.md): a real player hands their own character to the spp-bots brain for
 * a task they pick: a combat task (data/combat-tasks.json) or training a gathering skill. The
 * character then does what a bot does, with its own items: banking, travelling, fighting (eating,
 * prayers, potions, specials, style), looting. `::botmode` opens the menu (chatbox prompts, so it
 * works through the RuneLite gateway); `::botmode off` stops; so does logging out, the task ending,
 * or dying. Nothing is conjured: a task the character can't do (no set for the style) fails.
 *
 * The Gauntlets take a number of runs (`::botmode corrupted_gauntlet 10`, or the menu's prompt):
 * each run is a fresh task, killed or lost (a death in the Gauntlet is safe: the run's own items
 * go, nothing of the character's), till the count is done; any other failure stops it.
 */

const { createCombatTask, TASKS } = require("./CombatTask.SppBots");
const { createBrain } = require("./Brain.SppBots");
const { createTrainingActivity, COMBAT_SKILLS } = require("./Training.SppBots");
const { defend } = require("./Defence.SppBots");
const { HOUSE } = require("./Imports.SppBots");

// House Options' "no doors": a walk inside doesn't go through closed doors, so while bot mode
// has the character, its house is built without them; the player's own setting comes back after.
const NO_DOORS = 2;

const SKILLS = ["woodcutting", "mining", "fishing"];
// The chatbox menu shows 5 options at most: 4 choices and "More...".
const PAGE = 4;

const titleCase = (text) => text.replace(/(^|_)(\w)/g, (_, gap, letter) => (gap ? " " : "") + letter.toUpperCase());

function createBotMode(population) {
  const api = population.api;
  const active = new Map();
  const log = (event, data) => population.log(event, data);

  function choices() {
    return [
      ...COMBAT_SKILLS.map((skill) => ({ label: `Train ${titleCase(skill)}`, kind: "train", id: skill })),
      { label: "Fight: anything for my level", kind: "task", id: "auto" },
      { label: "Boss: The Gauntlet", kind: "gauntlet", id: "gauntlet" },
      { label: "Boss: The Corrupted Gauntlet", kind: "gauntlet", id: "corrupted_gauntlet" },
      ...Object.keys(TASKS).map((id) => ({ label: `Fight: ${titleCase(id)} (${TASKS[id].kills} kills)`, kind: "task", id })),
      ...SKILLS.map((skill) => ({ label: `Train ${titleCase(skill)}`, kind: "skill", id: skill })),
      { label: "Train skills (any)", kind: "skill", id: null },
    ];
  }

  /** The player's own door setting back (bot mode used "no doors"). */
  function restoreDoors(player, entry) {
    if (entry.doorMode === undefined) return;
    try {
      HOUSE.setDoorMode(player, entry.doorMode);
    } catch {
      // No house plugin or save: nothing was changed.
    }
    entry.doorMode = undefined;
  }

  function stop(player, why, { quiet = false } = {}) {
    const entry = active.get(player);
    if (!entry) return false;
    active.delete(player);
    restoreDoors(player, entry);
    entry.combatTask = null;
    entry.brain?.reset?.();
    player.getMovementQueue?.()?.reset?.();
    if (!quiet) player.sendMessage(`Bot mode off${why ? ` (${why})` : ""}.`);
    log("spp_bots_botmode", { name: player.getUsername(), on: false, why });
    return true;
  }

  function start(player, choice, { next = false } = {}) {
    // The next of a count of Gauntlet runs replaces the last one's entry without a word.
    stop(player, null, { quiet: next });
    if (!population.world) {
      player.sendMessage("Bot mode isn't ready yet; try again in a moment.");
      return;
    }
    const name = player.getUsername();
    const profile = { archetype: "main", only: choice.kind === "skill" ? choice.id : null };
    const entry = {
      player,
      bot: { name, profile },
      brain: createBrain(player, profile, { core: api.core, world: population.world, registry: population.registry, pacing: false }),
      choice,
    };
    if (choice.kind === "train") {
      const activity = createTrainingActivity({
        api, entry, skill: choice.id, log,
        onDone: (result, why) => {
          player.sendMessage(`Bot mode: training ${titleCase(choice.id)} ${result === "success" ? "done" : `stopped: ${why}`}.`);
          stop(player, result === "success" ? "training done" : "training stopped");
        },
      });
      entry.brain.replaceRoot(activity, Date.now());
      entry.brain.current = { id: `train ${choice.id}`, since: Date.now() };
    }
    if (choice.kind === "gauntlet") {
      const corrupted = choice.id === "corrupted_gauntlet";
      const name = `${corrupted ? "Corrupted " : ""}Gauntlet`;
      const runs = choice.runs ?? 1;
      const activity = require("./Gauntlet.SppBots").createGauntletTask({
        api, entry, log, corrupted,
        onDone: (result, state) => {
          // A run played out (killed, or lost in the maze or the arena) counts; on to the next
          // while any are left. Anything else (levels, the bank, the way there) stops it.
          const played = result === "success" || state.why === "died or left";
          const done = (choice.done ?? 0) + (played ? 1 : 0);
          const wins = (choice.wins ?? 0) + (result === "success" ? 1 : 0);
          if (played && done < runs) {
            player.sendMessage(`Bot mode: ${name} run ${done}/${runs} ${result === "success" ? "won" : "lost"} (${wins} kill${wins === 1 ? "" : "s"} so far).`);
            start(player, { ...choice, done, wins }, { next: true });
            return;
          }
          player.sendMessage(played
            ? `Bot mode: the ${name} done: ${wins} kill${wins === 1 ? "" : "s"} in ${done} run${done === 1 ? "" : "s"}.`
            : `Bot mode: the ${name} stopped: ${state.why} (${wins} kill${wins === 1 ? "" : "s"} in ${done} run${done === 1 ? "" : "s"}).`);
          stop(player, played ? "task done" : "task failed");
        },
      });
      entry.brain.replaceRoot(activity, Date.now());
      entry.brain.current = { id: `task ${choice.id}`, since: Date.now() };
    }
    if (choice.kind === "task") {
      let taskId = choice.id;
      if (taskId === "auto") {
        // A generated task for the character's level (TaskGen.SppBots.js) it has a set for.
        const picked = require("./TaskGen.SppBots").pickTask(api.core, player);
        if (!picked) {
          player.sendMessage("Bot mode: no task fits your character (a combat set it owns, its level).");
          return;
        }
        taskId = picked.id;
        player.sendMessage(`Bot mode: ${choice.kills > 0 ? choice.kills : picked.task.kills} ${picked.task.monster} at ${picked.task.area.x}, ${picked.task.area.y}.`);
      }
      // A number of kills chosen by the player (the menu's prompt or `::botmode <task> <n>`).
      const base = require("./TaskGen.SppBots").taskById(api.core, taskId);
      const task = base && choice.kills > 0 ? { ...base, kills: choice.kills } : base;
      if (task && choice.kills > 0) player.sendMessage(`Bot mode: ${choice.kills} kills.`);
      const activity = createCombatTask({
        api, entry, taskId, task, log,
        onDone: (result, state) => {
          player.sendMessage(`Bot mode: ${titleCase(taskId)} ${result === "success" ? "done" : `stopped: ${state.why}`} (${state.kills} kills).`);
          stop(player, result === "success" ? "task done" : "task failed");
        },
      });
      entry.brain.replaceRoot(activity, Date.now());
      entry.brain.current = { id: `task ${taskId}`, since: Date.now() };
    }
    try {
      const mode = HOUSE.doorMode(player);
      if (mode !== null && mode !== NO_DOORS) {
        entry.doorMode = mode;
        HOUSE.setDoorMode(player, NO_DOORS);
      }
    } catch {
      // No house: nothing to change.
    }
    active.set(player, entry);
    if (next) {
      log("spp_bots_botmode", { name, on: true, choice: choice.label, run: (choice.done ?? 0) + 1, of: choice.runs });
      return;
    }
    if (choice.kind === "gauntlet" && (choice.runs ?? 1) > 1) player.sendMessage(`Bot mode: ${choice.runs} runs.`);
    player.sendMessage(`Bot mode on: ${choice.kills > 0 ? choice.label.replace(/\(\d+ kills\)/, `(${choice.kills} kills)`) : choice.label}. Type ::botmode off to take over again.`);
    log("spp_bots_botmode", { name, on: true, choice: choice.label });
  }

  /**
   * How many kills, with the game's enter-amount prompt (a cache interface, so it works through
   * the gateway); nothing or 0 keeps the task's own number.
   */
  function askKills(player, choice) {
    player.setEnteredAmountAction?.({
      execute: (amount) => {
        const kills = Math.max(0, Math.min(10000, Math.floor(Number(amount) || 0)));
        start(player, { ...choice, kills });
      },
    });
    player.getPacketSender().sendEnterAmountPrompt("How many kills? (0 for the task's own)");
  }

  /** How many Gauntlet runs, with the same prompt; nothing or 0 is one. */
  function askRuns(player, choice) {
    player.setEnteredAmountAction?.({
      execute: (amount) => start(player, { ...choice, runs: Math.max(1, Math.min(1000, Math.floor(Number(amount) || 1))) }),
    });
    player.getPacketSender().sendEnterAmountPrompt("How many runs?");
  }

  /** The menu, a page at a time. */
  function menu(player, page = 0) {
    const all = choices();
    const shown = all.slice(page * PAGE, page * PAGE + PAGE);
    const options = [];
    for (const choice of shown) options.push(choice.label, () => (choice.kind === "task" ? askKills(player, choice) : choice.kind === "gauntlet" ? askRuns(player, choice) : start(player, choice)));
    if ((page + 1) * PAGE < all.length) options.push("More...", () => menu(player, page + 1));
    else if (active.has(player)) options.push("Turn bot mode off", () => stop(player, "turned off"));
    api.sendMultiChatboxPrompt(player, active.has(player) ? "Bot mode is on. Do something else?" : "Bot mode: what should your character do?", ...options);
  }

  /** `::botmode` (menu), `::botmode off`, `::botmode <task> [kills]`, `::botmode <gauntlet> [runs]`. */
  function command({ player, parts }) {
    const arg = String(parts[1] ?? "").toLowerCase();
    if (arg === "off") {
      if (!stop(player, "turned off")) player.sendMessage("Bot mode isn't on.");
      return true;
    }
    if (arg) {
      const choice = choices().find((entry) => entry.id === arg && entry.kind !== "skill") ?? choices().find((entry) => entry.id === arg);
      if (!choice) {
        player.sendMessage(`No such task. Tasks: ${Object.keys(TASKS).join(", ")}; or ${SKILLS.join(", ")}.`);
        return true;
      }
      const kills = Math.max(0, Math.min(10000, Math.floor(Number(parts[2]) || 0)));
      if (choice.kind === "gauntlet") start(player, { ...choice, runs: Math.max(1, Math.min(1000, kills || 1)) });
      else start(player, choice.kind === "task" ? { ...choice, kills } : choice);
      return true;
    }
    menu(player);
    return true;
  }

  /** Every tick, after the bots: each player in bot mode, a fight first, then the brain. */
  function tick() {
    const nowMs = Date.now();
    for (const [player, entry] of active) {
      if (!player.isRegistered?.()) {
        active.delete(player);
        continue;
      }
      try {
        if (entry.died && entry.choice?.kind === "gauntlet") {
          // A death in the Gauntlet is the run's (safe: back in the lobby): the task counts it.
          entry.died = false;
        } else if (entry.died && !player.isDyingReturn?.()) {
          // A death ends bot mode: the player decides what next.
          stop(player, "died");
          continue;
        }
        if (defend(api, entry, nowMs, log)) continue;
        entry.brain.tick(nowMs);
      } catch (error) {
        log("spp_bots_botmode_failed", { name: player.getUsername(), error: String(error?.stack ?? error) });
        stop(player, "error");
      }
    }
  }

  /** A death or logout (the plugin's hooks). */
  function onDeath(player) {
    const entry = active.get(player);
    if (entry) entry.died = true;
  }

  function onLogout(player) {
    if (active.has(player)) {
      const entry = active.get(player);
      entry.brain?.reset?.();
      restoreDoors(player, entry);
      active.delete(player);
    }
  }

  return { command, tick, onDeath, onLogout, active, choices };
}

module.exports = { createBotMode };
