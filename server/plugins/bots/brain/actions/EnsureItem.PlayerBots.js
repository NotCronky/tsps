"use strict";

const { createObtainAction } = require("./Obtain.PlayerBots");

/**
 * Has `amount` of an item in the inventory (a tinderbox, bait, a fishing net): carried, taken
 * out of the bank, or bought with the character's coins (Obtain.PlayerBots.js). Never conjured.
 */
function createEnsureItemAction(spec, world) {
  const obtain = createObtainAction({ items: [{ item: spec.item, amount: spec.amount ?? 1 }] }, world);
  return { ...obtain, id: "ensureItem" };
}

module.exports = {
  createEnsureItemAction,
};
