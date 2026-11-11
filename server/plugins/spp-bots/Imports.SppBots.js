"use strict";

/**
 * Everything spp-bots takes from other plugins' internals, in one place: an upstream rename
 * breaks this file and nothing else (docs/playerbots.md, "Where the code lives").
 *
 * From upstream's bots (plugins/bots/) we reuse the player factory, the frame-stack brain, its
 * walking/banking/gathering actions and the object index. We never use their activity registry,
 * equipTool, ensureItem or trainCombat: those conjure tools, food and gear, and spp-bots only use
 * what the account owns.
 */

const { createBotPlayer } = require("../bots/behaviours/spawn/PlayerFactory.PlayerBots");
const { BotBrain } = require("../bots/brain/Brain.PlayerBots");
const { createInitialState, initPlayerBotStateCoreAccess, resetMovementState } = require("../bots/behaviours/state/State.PlayerBots");
const { createTraversalAssist } = require("../bots/lib/TraversalAssist.PlayerBots");
const { listCatalogObjectIds, resolveCatalogObjectIds } = require("../bots/brain/ObjectCatalog.PlayerBots");
const { BANK_BOOTH_IDS } = require("../bots/lib/BankBooths.PlayerBots");
const { PROGRESS_EVENTS } = require("../bots/brain/BrainEvents.PlayerBots");
const { createInteractObjectAction } = require("../bots/brain/actions/InteractObject.PlayerBots");
const { createBankAction } = require("../bots/brain/actions/Bank.PlayerBots");
const { createDropItemsAction } = require("../bots/brain/actions/DropItems.PlayerBots");
const { createFishAction } = require("../bots/brain/actions/Fish.PlayerBots");
const { createWanderAction } = require("../bots/brain/actions/Wander.PlayerBots");
const { realisticName } = require("../bots/ai/Names.PlayerBots");

const { planTravel, createTravelSearch, toLegs, indexTransports, unmetRequirements, BLOCKED } = require("../agent/mcp/TravelRoutes.AgentMcp");

const { JEWELLERY } = require("../items/Teleports.Jewellery");
const TELEPORT_TABLETS = require("../combat/data/teleport-tablets.json");
const MINIGAME_TELEPORTS = require("../interface/data/minigame-teleports.json").minigames;
const { dateMinutes } = require("../combat/HomeTeleportSequence");
const SPIRIT_TREES = require("../world/data/spirit-trees.json").trees;
// The player-owned house (Teleports/Travel.SppBots.js): entering, its nexus and jewellery box.
// Required on first use: Construction's modules read its core at load, which only exists once the
// Construction plugin has registered (requiring them earlier broke both plugins).
const construction = (name) => require(`../skills/construction/${name}.Construction`);
const JEWELLERY_BOX = require("../skills/construction/data/jewellery-box.json");

const QuestRuntime = require("../quests/QuestRuntime");
const { questMetadata } = require("../quests/QuestList.QuestRuntime");

const Woodcutting = require("../skills/Woodcutting.plugin");
const Mining = require("../skills/Mining.plugin");
const Fishing = require("../skills/Fishing.plugin");
const Cooking = require("../skills/Cooking.plugin");
const Firemaking = require("../skills/Firemaking.plugin");
const Smithing = require("../skills/Smithing.plugin");

const { ItemIds } = require("../../src/main/typescript/elvarg/util/IdEnums");
const WorldDefinition = require("../../src/main/typescript/elvarg/game/definition/WorldDefinition");

/** A skilling plugin is mid-action for this player (the brain waits rather than clicking again). */
function isSkilling(player) {
  return (
    Fishing.isFishingActive?.(player) === true ||
    Cooking.isCookingActive?.(player) === true ||
    Woodcutting.isWoodcuttingActive?.(player) === true ||
    Mining.isMiningActive?.(player) === true ||
    Firemaking.isFiremakingActive?.(player) === true ||
    Smithing.isSmeltingActive?.(player) === true
  );
}

module.exports = {
  createBotPlayer,
  BotBrain,
  createInitialState,
  initPlayerBotStateCoreAccess,
  resetMovementState,
  createTraversalAssist,
  listCatalogObjectIds,
  resolveCatalogObjectIds,
  BANK_BOOTH_IDS,
  PROGRESS_EVENTS,
  createInteractObjectAction,
  createBankAction,
  createDropItemsAction,
  createFishAction,
  createWanderAction,
  realisticName,
  QuestRuntime,
  questMetadata,
  Woodcutting,
  Mining,
  ItemIds,
  isMembersWorld: () => WorldDefinition.isMembersWorld(),
  isSkilling,
  // The travel planner and its transport table (agent travel_to), shared rather than copied.
  planTravel,
  createTravelSearch,
  toLegs,
  indexTransports,
  unmetRequirements,
  BLOCKED,
  // Teleports bots use (Teleports.SppBots.js): the jewellery table, tablet and scroll names, the
  // minigame list, and the minigame teleport's cooldown clock and attribute.
  JEWELLERY,
  TELEPORT_TABLETS,
  MINIGAME_TELEPORTS,
  dateMinutes,
  SPIRIT_TREES,
  /**
   * Unlocks boss tasks need (CombatTask's `requires.unlocks`): whether the player has it, and
   * `grant` for a simulated account whose history includes it (Population, at login).
   */
  UNLOCKS: {
    // Zulrah's boat: the High Priestess has accepted them as the sacrifice (Access stage 3).
    zulrah: (player) => require("../bosses/zulrah/Access.Zulrah").stageOf(player) >= 3,
  },
  GRANT_UNLOCKS: {
    // As the High Priestess's dialogue leaves it; only with Regicide as far as Port Tyras.
    zulrah: (player) => {
      const Access = require("../bosses/zulrah/Access.Zulrah");
      if (Access.stageOf(player) >= 3 || !Access.reachedPortTyras(player)) return false;
      player.setAttribute(Access.ACCESS_ATTRIBUTE, Access.STAGE.SACRIFICED);
      return true;
    },
  },
  /**
   * The Gauntlet (Gauntlet.SppBots.js): what a player there sees and uses outside a run (the lobby,
   * Bryn, the reward chest), and whether one is under way. The run itself is GauntletPlay's.
   */
  GAUNTLET: {
    BRYN: 9020,
    run: (player) => require("../minigames/gauntlet/RunState.Gauntlet").runInside(player),
    inLobby: (player) => {
      const { LOBBY_ZONE } = require("../minigames/gauntlet/Shared.Gauntlet");
      const at = player.getLocation();
      return at.getX() >= LOBBY_ZONE.minX && at.getX() <= LOBBY_ZONE.maxX && at.getY() >= LOBBY_ZONE.minY && at.getY() <= LOBBY_ZONE.maxY && LOBBY_ZONE.levels.includes(at.getZ());
    },
    spokenToBryn: (player) => player.getAttribute(require("../minigames/gauntlet/Lobby.Gauntlet").ATTR_SPOKEN_TO_BRYN) === true,
    rewardWaiting: (player) => Boolean(player.getAttribute(require("../minigames/gauntlet/Rewards.Gauntlet").ATTR_REWARD)),
    emptyHanded: (player) => require("../minigames/gauntlet/Shared.Gauntlet").isEmptyHanded(player),
    /** Whether a Gauntlet has been completed (the entrance offers Enter-corrupted). */
    completed: (player) => require("../minigames/gauntlet/RunState.Gauntlet").hasCompleted(player),
  },
  HOUSE: {
    houseFor: (player) => construction("House").houseFor(player),
    houseState: (player) => construction("House").houseStateFor(player),
    maxHouse: (player) => construction("MaxHouse").maxHouse({ player }),
    /** The prayer host's house: the garden (its exit portal), the chapel beside it, a portal nexus. */
    hostHouse: (player) => construction("MaxHouse").maxHouse({ player, rooms: { ground: ["CHAPEL", "PORTAL_NEXUS"], basement: [] } }),
    /**
     * House Options' "Doors: open", as many players set it. Rooms are joined by doors, closed
     * by default, and a walk doesn't go through a closed door: a bot at the entrance couldn't
     * reach its nexus. (0 closed, 1 open, 2 none; read when the house is built.)
     */
    /** Moves the house (as an estate agent does) to a house-locations.json id; Rimmington is 1. */
    setLocation: (player, id) => {
      const saved = construction("House").houseStateFor(player);
      if (saved) saved.location = id;
    },
    /** House Options' door setting (0 closed, 1 open, 2 no doors), or null without a house save. */
    doorMode: (player) => construction("House").houseStateFor(player)?.doorMode ?? null,
    /** Sets it (read when the house is next built: entering it builds it). */
    setDoorMode: (player, mode) => {
      const saved = construction("House").houseStateFor(player);
      if (saved) saved.doorMode = mode;
    },
    openDoors: (player) => {
      const saved = construction("House").houseStateFor(player);
      if (saved && (saved.doorMode ?? 0) === 0) saved.doorMode = 1;
    },
    /** Out of the house to its portal outside, as its exit portal does. */
    leave: (player) => {
      const house = construction("House").houseFor(player);
      if (house) house.exitHouse(player, construction("Estate").houseExit(construction("House").houseStateFor(player)));
    },
    nexusSlots: (player) => player.getAttribute(construction("Nexus").STATE_ATTRIBUTE)?.slots ?? [],
    nexusDestinations: () => construction("Nexus").destinations(),
    get nexusMenu() { return construction("Ids").iface("telenexus_teleport"); },
    nexusRows: 13,
    get jewelleryBoxMenu() { return construction("Ids").iface("poh_jewellery_box"); },
    jewelleryBoxes: JEWELLERY_BOX.boxes,
  },
  MINIGAME_TELEPORT: { lastMinuteAttribute: "minigame-teleport:last-minute", cooldownMinutes: 20, groupingInterface: 76, groupingTeleportChild: 32, groupingActivityEnum: 848 },
  TRANSPORTS_FILE: require("path").join(__dirname, "..", "agent", "data", "transports.json"),
  // The server's own object teleports (World's LocTeleports): ladders, holes, openings it moves a
  // player through with no other handler.
  LOC_TELEPORTS_FILE: require("path").join(__dirname, "..", "world", "data", "loc-teleports.json"),
};
