"use strict";

/**
 * The quests a generated account can complete: every registered quest (QuestRuntime) with its
 * requirements and rewards from the cache quest table (dbtable 0). Quests that need a quest no one
 * has registered can't be done, and neither can quests with subquests (Recipe for Disaster): the
 * parent row's requirements say little about what the subquests need.
 */

const { QuestRuntime, questMetadata } = require("./Imports.SppBots");

let cached = null;

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

/** [[a, b], ...] from the cache's flattened [a, b, a, b] columns. */
function pairs(value) {
  const list = Array.isArray(value) ? value : [];
  const result = [];
  for (let index = 0; index + 1 < list.length; index += 2) result.push([list[index], list[index + 1]]);
  return result;
}

function buildQuestList(cache) {
  const registered = QuestRuntime.getRegisteredQuests();
  const rows = [];
  for (const quest of registered) {
    const row = questMetadata(quest, cache);
    if (row) rows.push({ quest, row });
  }
  const keyByRowId = new Map(rows.map(({ quest, row }) => [row.rowId, quest.key]));
  const list = [];
  for (const { quest, row } of rows) {
    if (first(row.type) !== 0 || first(row.has_subquests) === 1 || first(row.parent_quest) !== undefined) continue;
    const required = (row.requirement_quests ?? []).map((rowId) => keyByRowId.get(rowId) ?? null);
    if (required.includes(null)) continue;
    list.push({
      key: quest.key,
      name: quest.name,
      members: first(row.members) === 1,
      questPoints: first(row.questpoints) ?? quest.questPoints ?? 0,
      length: first(row.length) ?? 1,
      stats: pairs(row.requirement_stats),
      quests: required,
      qp: first(row.requirement_questpoints) ?? 0,
      combat: first(row.requirement_combat) ?? 0,
      xp: pairs(row.stat_xp_awarded),
    });
  }
  return list;
}

/** Built once, after the cache and every quest plugin have loaded. */
function questList(cache) {
  if (!cached) cached = buildQuestList(cache);
  return cached;
}

function registeredQuest(key) {
  return QuestRuntime.getRegisteredQuests().find((quest) => quest.key === key) ?? null;
}

module.exports = { questList, registeredQuest };
