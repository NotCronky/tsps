"use strict";

/**
 * What a character does next. Every task it can do right now (its levels, items and coins
 * allow it: task.check) gets a score, and one is drawn at random by score:
 *   - its profile: a skiller avoids fighting, a fighter prefers it, a focus skill comes up more;
 *   - its levels: skills behind the rest are pulled up, as players even their stats out;
 *   - variety: what it just did comes up less, so it moves between tasks;
 *   - processing what it has banked is worth a little more (it gathered for it);
 *   - a skill with several tiers open (iron, coal and mithril) shares one skill's weight between
 *     them, the best ones likelier, so a skill with many tiers doesn't crowd out the rest.
 * Pure functions, so tests can fix `random`.
 */
const FOCUS_WEIGHT = 3;
const STYLE_WEIGHTS = {
  balanced: { Gathering: 1, Processing: 1, Combat: 1 },
  skiller: { Gathering: 1.2, Processing: 1.2, Combat: 0.25 },
  fighter: { Gathering: 0.6, Processing: 0.6, Combat: 3 },
};
const PROCESSING_BONUS = 1.4;
const RECENT_WEIGHTS = [0.15, 0.5];
const LEVEL_SPREAD = 25;
const COMBAT_SKILLS = ["attack", "strength", "defence"];
// A skill's tiers share its weight, each tier up twice as likely as the one below.
const TIER_STEP = 2;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** The level that stands for a task: its skill's, or the mean melee level for combat. */
function taskLevel(task, levelOf) {
  if (task.skill === "combat") return COMBAT_SKILLS.reduce((sum, skill) => sum + levelOf(skill), 0) / COMBAT_SKILLS.length;
  return levelOf(task.skill);
}

/**
 * Scores for the tasks open to the character: [{ task, score, reason }] for all of them, with
 * score 0 and the reason for those it can't do. `recent` lists task ids, latest first.
 */
function scoreTasks({ player, tasks, ctx, profile = {}, recent = [], levelOf }) {
  const open = [];
  const scored = tasks.map((task) => {
    const check = task.check(player, ctx);
    if (!check.ok) return { task, score: 0, reason: check.reason };
    open.push(task);
    return { task, score: 1, reason: null };
  });
  // Each skill counts once, however many of its tiers are open.
  const bySkill = new Map(open.map((task) => [task.skill ?? task.id, task]));
  const levels = [...bySkill.values()].map((task) => taskLevel(task, levelOf));
  const mean = levels.length ? levels.reduce((sum, value) => sum + value, 0) / levels.length : 1;
  const style = STYLE_WEIGHTS[profile.style] ?? STYLE_WEIGHTS.balanced;
  for (const entry of scored) {
    if (entry.score === 0) continue;
    const { task } = entry;
    let score = style[task.group] ?? 1;
    if (profile.focus && (profile.focus === task.skill || profile.focus === task.id)) score *= FOCUS_WEIGHT;
    score *= clamp(1 + (mean - taskLevel(task, levelOf)) / LEVEL_SPREAD, 0.4, 2.5);
    if (task.group === "Processing") score *= PROCESSING_BONUS;
    const index = recent.indexOf(task.id);
    if (index >= 0 && index < RECENT_WEIGHTS.length) score *= RECENT_WEIGHTS[index];
    entry.score = score;
  }
  shareTiers(scored);
  return scored;
}

/** Open tasks of one skill split their skill's weight: by level, each tier twice the last. */
function shareTiers(scored) {
  const bySkill = new Map();
  for (const entry of scored) {
    if (entry.score <= 0 || !Number.isFinite(entry.task.level)) continue;
    if (!bySkill.has(entry.task.skill)) bySkill.set(entry.task.skill, []);
    bySkill.get(entry.task.skill).push(entry);
  }
  for (const entries of bySkill.values()) {
    entries.sort((a, b) => a.task.level - b.task.level);
    const weights = entries.map((_, index) => TIER_STEP ** index);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    entries.forEach((entry, index) => { entry.score *= weights[index] / total; });
  }
}

/**
 * Draws a task by score; null when there is nothing the character can do. A task marked `first`
 * that is open (Tutorial Island) comes before anything else.
 */
function chooseTask(options, random = Math.random) {
  const scored = scoreTasks(options).filter((entry) => entry.score > 0);
  const first = scored.find((entry) => entry.task.first === true);
  if (first) return first.task;
  const total = scored.reduce((sum, entry) => sum + entry.score, 0);
  if (total <= 0) return null;
  let roll = random() * total;
  for (const entry of scored) {
    roll -= entry.score;
    if (roll < 0) return entry.task;
  }
  return scored.at(-1).task;
}

module.exports = { STYLE_WEIGHTS, chooseTask, scoreTasks, taskLevel };
