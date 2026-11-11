"use strict";

/**
 * Shortcuts for the route planner's heuristic (docs/playerbots.md, Travel): pure, no game imports.
 */

// A network hop is a shortcut for the heuristic only when it saves this much; at most this many.
const SHORTCUT_GAIN = 50;
const MAX_SHORTCUTS = 64;

/**
 * The network hops (spirit trees, fairy rings) that bring `goal` nearer, as the planner's
 * `shortcuts`: from each origin, the cheapest hop plus the distance from where it lands. Without
 * them a goal far off in map coordinates but one hop away (Prifddinas, y 6100, from its spirit
 * tree) looked thousands of tiles north, and the search ran to the cap ("too far" from Lumbridge).
 */
function networkShortcuts(hops, goal) {
  if (!goal || !hops?.size) return [];
  const surfaceY = (y) => (y >= 6400 ? y - 6400 : y);
  const distance = (x, y, tx, ty) => Math.min(Math.max(Math.abs(x - tx), Math.abs(y - ty)), Math.max(Math.abs(x - tx), Math.abs(surfaceY(y) - surfaceY(ty))));
  const shortcuts = [];
  for (const list of hops.values()) {
    if (!list.length) continue;
    const [x, y, z] = list[0].from;
    let cost = Infinity;
    for (const hop of list) cost = Math.min(cost, (hop.ticks ?? 1) + distance(hop.to[0], hop.to[1], goal.x, goal.y));
    if (cost + SHORTCUT_GAIN < distance(x, y, goal.x, goal.y)) shortcuts.push({ x, y, z, cost });
  }
  return shortcuts.sort((a, b) => a.cost - b.cost).slice(0, MAX_SHORTCUTS);
}

module.exports = { networkShortcuts, SHORTCUT_GAIN, MAX_SHORTCUTS };
