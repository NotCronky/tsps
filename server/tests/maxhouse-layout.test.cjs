// Run after `yarn build`: node --test tests/maxhouse-layout.test.cjs
const assert = require("node:assert/strict"), path = require("node:path");
const { before, after, test } = require("node:test");
const root = path.resolve(__dirname, "..");
require(root + "/dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require(root + "/dist/game/cache/CachePipeline");
const { PluginManager: PM } = require(root + "/dist/plugins/PluginManager");
const { Player } = require(root + "/dist/game/entity/impl/player/Player");
const { PlayerSession } = require(root + "/dist/net/PlayerSession");
let core, House, MaxHouse, Instance;
before(async () => {
  await CachePipeline.initialize(root);
  PM.loadFromDirectory(root + "/plugins");
  core = PM.getCoreApi();
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(3222, 3218);
  PM.emitServerStartup({});
  House = require(root + "/plugins/skills/construction/House.Construction");
  MaxHouse = require(root + "/plugins/skills/construction/MaxHouse.Construction");
  Instance = require(root + "/plugins/skills/construction/Instance.Construction");
});
after(() => PM.emitServerShutdown({}));

const rotated = (doors, rotation) => ((doors << rotation) | (doors >> (4 - rotation))) & 15;
const OFFSETS = [[0, 1], [1, 0], [0, -1], [-1, 0]];

test("::maxhouse builds the 4x4 one-floor max house, every room reachable from the exit portal", (t) => {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(1990); player.setUsername("maxhousetest"); player.setRegistered(true);
  player.setLocation(new core.Location(3222, 3218, 0)); player.needsPlacement = false;
  t.after(() => House.releaseHouse(player, true));
  MaxHouse.maxHouse({ player });

  const save = player.getAttribute("construction:house");
  const ground = save.rooms[1];
  const at = (x, y) => ground[x][y]?.roomKey ?? null;
  assert.deepEqual([4, 3, 2, 1].map((y) => [1, 2, 3, 4].map((x) => at(x, y))), [
    ["BEDROOM", "CHAPEL", "ACHIEVEMENT_GALLERY", "STUDY"],
    ["WORKSHOP", "SUPERIOR_GARDEN", "FORMAL_GARDEN", "PORTAL_NEXUS"],
    ["COSTUME_ROOM", "MENAGERIE_INDOORS", "SUPERIOR_GARDEN", "COMBAT_ROOM"],
    ["DINING_ROOM", "QUEST_HALL_UP", "BEDROOM", "GAMES_ROOM"],
  ]);
  assert.equal(ground.flat().filter(Boolean).length, 16, "a grass border all round, nothing else on the floor");
  assert.equal(save.rooms[0].flat().filter(Boolean).length + save.rooms[2].flat().filter(Boolean).length, 0, "no upstairs or dungeon");
  assert.equal(ground[2][3].furniture.TELEPORT_SPACE, "SPIRIT_TREE_AND_FAIRY_RING");
  assert.equal(ground[3][2].furniture.TELEPORT_SPACE, "OBELISK");
  assert.equal(ground[3][3].furniture.FORMAL_GARDEN_CENTERPIECE, "EXIT_PORTAL");
  assert.equal(ground[2][1].furniture.QUEST_HALL_STAIRS_UP, "HALL_OPULENT_RUG");
  assert.equal(ground[2][1].furniture.GUILD_TROPHY, "MOUNTED_MYTHICAL_CAPE");

  const doors = (room) => rotated(Instance.PlayerHouseInstance.prototype.templateDoorMask.call({ save }, room.roomKey), room.rotation);
  const seen = new Set(["3,3"]), stack = [[3, 3]];
  while (stack.length) {
    const [x, y] = stack.pop();
    OFFSETS.forEach(([dx, dy], edge) => {
      const next = ground[x + dx]?.[y + dy];
      if (!next || !(doors(ground[x][y]) & (1 << edge)) || !(doors(next) & (1 << ((edge + 2) & 3)))) return;
      if (!seen.has(`${x + dx},${y + dy}`)) { seen.add(`${x + dx},${y + dy}`); stack.push([x + dx, y + dy]); }
    });
  }
  assert.equal(seen.size, 16, "every room joins the formal garden through doorways");
  assert.equal(player.getPrivateArea(), House.houseFor(player), "the player is taken into the new house");
});
