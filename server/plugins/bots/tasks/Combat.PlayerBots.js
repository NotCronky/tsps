"use strict";

const { no, ok, skillOf } = require("./Common.PlayerBots");

/**
 * Combat training: monsters that suit the character's combat level (combat_training in
 * data/definitions/bot-activities.json picks them), with the gear, food and runes it owns.
 * It trains the lowest of Attack, Strength and Defence, as a player balancing their stats would.
 */
function combatTasks(places) {
  return [{
    id: "combat",
    name: "Combat training",
    group: "Combat",
    skill: "combat",
    places: places.combat_training,
    minutes: [20, 40],
    check(player, { registry }) {
      if (!registry.byId.get("combat_training")) return no("combat training isn't available");
      if (player.getSkillManager().getCurrentLevel(skillOf("hitpoints")) < 10) {
        return no("too hurt to fight");
      }
      return ok();
    },
    build(player, { registry }) {
      return registry.byId.get("combat_training") ?? null;
    },
  }];
}

module.exports = { combatTasks };
