/**
 * ::quest - an admin command to look at or set a player's quest progress, for testing
 * quest-gated content without playing the quest.
 *
 *   ::quest <name>             show the quest's stage
 *   ::quest <name> complete    complete it as the quest itself does (rewards, points, scroll)
 *   ::quest <name> reset       back to not started
 *   ::quest <name> <stage>     set the stage
 *
 * <name> is a quest's name or key, any case; part of a name works when only one quest matches
 * ("grand tree"). Quest points follow a quest set below or above its completion stage.
 *
 *   ::completeallquests        complete every quest, keeping no experience or items
 *
 * It runs each quest's own completion, because onReward also sets what a quest unlocks (a
 * spellbook, a patch, a varbit the cache reads) alongside what it hands out. Experience is refused
 * for the length of the run and the player's items are put back afterwards.
 */
const QuestRuntime = require("./QuestRuntime");
const { PlayerRights } = require("../../src/main/typescript/elvarg/game/model/rights/PlayerRights");

const USAGE = "Usage: ::quest <name> [complete|reset|<stage>]";
const COMPLETE_ALL_OPTIONS = Object.freeze({ experience: false, scroll: false, announce: false });
/** Players ::completeallquests is working through: experience is refused until it ends. */
const completingAll = new WeakSet();

function normalise(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** The one quest a name means: an exact name or key first, then a unique partial match. */
function findQuests(text) {
  const wanted = normalise(text);
  const quests = QuestRuntime.getRegisteredQuests();
  const exact = quests.filter((quest) => normalise(quest.name) === wanted || normalise(quest.key) === wanted ||
    normalise(quest.name).replace(/^the /, "") === wanted);
  return exact.length > 0 ? exact : quests.filter((quest) => normalise(quest.name).includes(wanted));
}

function addQuestPoints(player, delta) {
  const points = Math.max(0, (Number(player.getAttribute(QuestRuntime.QUEST_POINTS_ATTRIBUTE)) || 0) + delta);
  player.setAttribute(QuestRuntime.QUEST_POINTS_ATTRIBUTE, points);
  player.getPacketSender().sendConfig(QuestRuntime.QUEST_POINTS_VARP, points);
}

/** Sets a stage directly, keeping the quest points in step when it crosses completion. */
function setStage(player, quest, stage) {
  const wasComplete = quest.isComplete(player);
  quest.setStage(player, stage);
  const isComplete = quest.isComplete(player);
  if (wasComplete !== isComplete) addQuestPoints(player, (isComplete ? 1 : -1) * (quest.questPoints || 0));
}

function describe(player, quest) {
  const state = quest.isComplete(player) ? "complete" : quest.isStarted(player) ? "started" : "not started";
  return `${quest.name}: stage ${quest.getStage(player)} (${state}; completes at ${quest.completionValue ?? 2}).`;
}

function questCommand({ player, parts }) {
  const args = parts.slice(1);
  const last = String(args.at(-1) ?? "").toLowerCase();
  const action = last === "complete" || last === "reset" || /^\d+$/.test(last) ? last : null;
  const name = (action ? args.slice(0, -1) : args).join(" ");
  if (!name) {
    player.sendMessage(USAGE);
    return true;
  }
  const matches = findQuests(name);
  if (matches.length !== 1) {
    player.sendMessage(matches.length === 0
      ? `No quest matches "${name}".`
      : `"${name}" matches ${matches.length} quests: ${matches.slice(0, 5).map((quest) => quest.name).join(", ")}${matches.length > 5 ? ", ..." : ""}.`);
    return true;
  }
  const [quest] = matches;
  if (action === "complete") {
    if (!quest.complete(player)) player.sendMessage(`${quest.name} is already complete.`);
  } else if (action === "reset") {
    setStage(player, quest, 0);
  } else if (action !== null) {
    setStage(player, quest, Number(action));
  }
  player.sendMessage(describe(player, quest));
  return true;
}

function refuseExperience(event) {
  if (completingAll.has(event.player)) event.allow = false;
}

/** Sets every container a reward can reach back to what it held, and redraws the two on screen. */
function restoreItems(player, saved) {
  for (const [container, items] of saved) container.setItems(items);
  player.getInventory().refreshItems();
  player.getEquipment().refreshItems();
}

/** One quest's own completion; a reward that throws is reported, not left to stop the rest. */
function completeWithoutRewards(player, quest) {
  try {
    return quest.complete(player, COMPLETE_ALL_OPTIONS) ? "completed" : "skipped";
  } catch (error) {
    console.warn(`[quests] ::completeallquests: ${quest.name} failed`, error);
    return "failed";
  }
}

function completeAllQuests({ player }) {
  const quests = QuestRuntime.getRegisteredQuests();
  const inventory = player.getInventory();
  const containers = [inventory, player.getEquipment(), ...player.getBanks().filter(Boolean)];
  const saved = containers.map((container) => [container, container.getCopiedItems()]);
  const results = { completed: 0, skipped: 0, failed: [] };
  completingAll.add(player);
  try {
    // Emptied between quests, so a reward never finds it full and falls to the ground.
    inventory.resetItems();
    for (const quest of quests) {
      const result = completeWithoutRewards(player, quest);
      if (result === "failed") results.failed.push(quest.name);
      else results[result]++;
      inventory.resetItems();
    }
  } finally {
    completingAll.delete(player);
    restoreItems(player, saved);
  }
  player.getPacketSender().sendInterfaceRemoval();
  player.sendMessage(`Completed ${results.completed} quests without rewards (${results.skipped} were already complete).`);
  if (results.failed.length > 0) {
    player.sendMessage(`${results.failed.length} failed: ${results.failed.slice(0, 5).join(", ")}${results.failed.length > 5 ? ", ..." : ""}.`);
  }
  return true;
}

module.exports = {
  name: "QuestCommand",
  register(api) {
    api.registerCommand("quest", questCommand, PlayerRights.ADMINISTRATOR, "Show or set a quest's progress: ::quest <name> [complete|reset|<stage>]");
    api.registerCommand("completeallquests", completeAllQuests, PlayerRights.OWNER, "Complete every quest, keeping no experience or items");
    api.onCanGainExperience(refuseExperience);
  },
  _test: { questCommand, findQuests, completeAllQuests, refuseExperience },
};
