"use strict";

/**
 * Who is doing what, where: every character a task agent runs (population bots and players in
 * bot mode) is noted with its task and the place it went for it. The brain spreads tasks out with
 * it, and the agent picks a quieter place, so hundreds of bots don't all end up on the same trees.
 *
 * Entries go when the character is replaced (a new task), forgotten (logout, bot mode off), or
 * no longer in the world.
 */
const entries = new Map();

/** `player` is now on `taskId` at `placeId` (null when the task has no place). */
function note(player, taskId, placeId = null) {
  if (!player) return;
  entries.set(player, { taskId, placeId });
}

function forget(player) {
  entries.delete(player);
}

function live() {
  for (const player of entries.keys()) {
    if (player.isRegistered?.() === false) entries.delete(player);
  }
  return entries;
}

/** Characters on a task (anywhere), not counting `self`. */
function onTask(taskId, self = null) {
  let count = 0;
  for (const [player, entry] of live()) if (player !== self && entry.taskId === taskId) count++;
  return count;
}

/** Every task's characters (a Map of task id to count), not counting `self`: one pass, for a decision. */
function taskCounts(self = null) {
  const counts = new Map();
  for (const [player, entry] of live()) {
    if (player !== self && entry.taskId) counts.set(entry.taskId, (counts.get(entry.taskId) ?? 0) + 1);
  }
  return counts;
}

/** Characters at a place (on any task), not counting `self`. */
function atPlace(placeId, self = null) {
  if (!placeId) return 0;
  let count = 0;
  for (const [player, entry] of live()) if (player !== self && entry.placeId === placeId) count++;
  return count;
}

/** Characters near a tile (within `tiles`), not counting `self`: who is actually standing about. */
function near(location, tiles, self = null) {
  let count = 0;
  for (const player of live().keys()) {
    if (player === self) continue;
    const at = player.getLocation?.();
    if (!at || at.getZ() !== location.z) continue;
    if (Math.max(Math.abs(at.getX() - location.x), Math.abs(at.getY() - location.y)) <= tiles) count++;
  }
  return count;
}

/** What a character is noted as doing: { taskId, placeId }, or null. */
function of(player) {
  return entries.get(player) ?? null;
}

module.exports = { note, forget, of, onTask, taskCounts, atPlace, near, size: () => live().size };
