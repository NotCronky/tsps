"use strict";

const { TOOLS, canGetTool, createEquipToolAction } = require("../brain/actions/EquipTool.PlayerBots");
const { createWearAction } = require("../brain/actions/Wear.PlayerBots");
const { createObtainAction } = require("../brain/actions/Obtain.PlayerBots");
const { createTravelToAction } = require("../brain/actions/TravelTo.PlayerBots");
const { createWearWarmClothingAction } = require("../brain/actions/WearWarmClothing.PlayerBots");
const Supplies = require("../lib/Supplies.PlayerBots");
const { canGet, itemId, level, no, ok } = require("./Common.PlayerBots");

/**
 * Wintertodt, a Firemaking task (50 Firemaking): the character gathers its kit (axe, tinderbox,
 * knife, hammer, a games necklace for the trip) from what it owns or can buy, wields its axe (if
 * its Attack allows) and wears the necklace, puts on up to four
 * pieces of warm clothing it owns (worn, carried or banked), travels to the camp,
 * and fights rounds with the Wintertodt plugin's own play ("wintertodt:play": chop, fletch, feed
 * and fix braziers, brew rejuvenation potions inside and drink them when cold). No food: the
 * potions are made in the prison. It ends when it can't keep warm or leaves the camp. It's a player like any
 * other there: real players' rounds count it, and it doesn't count towards the plugin's own crowd.
 */
const FIREMAKING_REQUIRED = 50;
const CAMP = { x: 1630, y: 3950, z: 0 };
// Near enough to the camp to walk (inside Kourend's north).
const NEAR_CAMP = { minX: 1550, maxX: 1750, minY: 3850, maxY: 4050 };
const GAMES_NECKLACES = [8, 7, 6, 5, 4, 3, 2, 1].map((charges) => itemId(`games_necklace_${charges}_`)).filter(Number.isInteger);

const nearCamp = (player) => {
  const at = player.getLocation();
  return at.getX() >= NEAR_CAMP.minX && at.getX() <= NEAR_CAMP.maxX && at.getY() >= NEAR_CAMP.minY && at.getY() <= NEAR_CAMP.maxY;
};

/** Plays rounds through the Wintertodt plugin until it's done (can't keep warm, or out of the camp). */
function play(world) {
  const controllers = new WeakMap();
  return {
    id: "wintertodt",
    update({ player }) {
      let controller = controllers.get(player);
      if (!controller) {
        const request = { player, controller: null };
        world.emitCustomEvent?.("wintertodt:play", request);
        if (!request.controller) return "failed";
        controller = request.controller;
        controllers.set(player, controller);
      }
      if (controller.tick()) return "running";
      controllers.delete(player);
      return "success";
    },
    stop({ player }) {
      controllers.get(player)?.stop?.();
      controllers.delete(player);
    },
    // Waiting between rounds, by its brazier, is part of the play.
    madeProgress: () => true,
  };
}

function wintertodtTask() {
  const kit = ["tinderbox", "knife", "hammer"].map(itemId);
  return {
    id: "wintertodt",
    name: "Firemaking: Wintertodt",
    shortName: "Wintertodt",
    group: "Processing",
    subgroup: "Firemaking",
    skill: "firemaking",
    level: FIREMAKING_REQUIRED,
    // It travels as part of the task, games necklace first.
    places: [],
    minutes: [30, 60],
    check(player) {
      if (level(player, "firemaking") < FIREMAKING_REQUIRED) return no(`needs ${FIREMAKING_REQUIRED} Firemaking`);
      if (!nearCamp(player) && !Supplies.bestOwned(player, GAMES_NECKLACES)) return no("needs a games necklace to get there");
      if (!canGetTool("axe", player)) return no("needs an axe or the coins for one");
      const missing = kit.find((id) => !canGet(player, id));
      if (missing !== undefined) return no("needs a tinderbox, knife and hammer, or the coins for them");
      return ok();
    },
    build(player, { registry, world }) {
      const necklace = nearCamp(player) ? null : Supplies.bestOwned(player, GAMES_NECKLACES)?.id ?? null;
      const items = kit.map((id) => ({ item: id, amount: 1 }));
      if (necklace !== null) items.push({ item: necklace, amount: 1 });
      const activity = registry.compile({ id: "task_wintertodt", mode: "firemaking", capacity: 100000, repeat: false, actions: [] });
      return {
        ...activity,
        actions: [
          createEquipToolAction({ tool: "axe" }, world),
          createObtainAction({ items }, world),
          // The axe wielded frees an inventory slot for roots; the necklace worn is the way home too.
          createWearAction({ items: (who) => [TOOLS.axe(who).find((id) => who.getInventory().getAmount(id) > 0), necklace] }, world),
          createWearWarmClothingAction(world),
          createTravelToAction({ ...CAMP, radius: 6 }, world),
          play(world),
        ],
      };
    },
  };
}

module.exports = { wintertodtTask, FIREMAKING_REQUIRED };
