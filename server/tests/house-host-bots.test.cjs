// Run after `yarn build`: node --test tests/house-host-bots.test.cjs
//
// The bots' house party: the host's max house through the Construction plugin's bot events
// (opened to guests, burners lit for good), a guest's visit, offering at the gilded altar and
// leaving, and Phials' "Exchange all" the guests use to unnote their bones.
const assert = require("node:assert/strict");
const root = require("node:path").resolve(__dirname, "..");
const { before, after, test } = require("node:test");
require(root + "/dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require(root + "/dist/game/cache/CachePipeline");
const { PluginManager: PM } = require(root + "/dist/plugins/PluginManager");
const { Player } = require(root + "/dist/game/entity/impl/player/Player");
const { PlayerSession } = require(root + "/dist/net/PlayerSession");

let core, House, HouseHost;
before(async () => {
  await CachePipeline.initialize(root);
  PM.loadFromDirectory(root + "/plugins");
  core = PM.getCoreApi();
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(2954, 3224);
  PM.emitServerStartup({});
  House = require(root + "/plugins/skills/construction/House.Construction");
  HouseHost = require(root + "/plugins/bots/lib/HouseHost.PlayerBots");
});
after(() => PM.emitServerShutdown({}));

function player(t, name, x = 2954, y = 3222) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setUsername(name);
  p.setLocation(new core.Location(x, y, 0)); p.needsPlacement = false;
  // Into the world's player list (registered, with an index), so guests can find a host by name.
  assert.equal(core.World.getPlayers().add(p), true);
  t.after(() => { House.releaseHouse(p, true); core.World.getPlayers().removes(p); });
  return p;
}
const tick = (n) => { for (let i = 0; i < n; i++) core.TaskManager.process(); };
const furniture = (p, keys) => {
  const request = { player: p, keys, objects: [] };
  PM.emitCustomEvent("construction:furniture", request);
  return request.objects;
};

test("the host opens its max house in Rimmington with burners that never go out; a guest offers at the gilded altar", (t) => {
  const host = player(t, "househost");
  const request = { player: host, location: HouseHost.RIMMINGTON, handled: false };
  PM.emitCustomEvent("construction:host-house", request);
  assert.equal(request.handled, true);
  assert.equal(House.houseFor(host)?.owner, host, "the host is in its own house");
  assert.equal(House.houseStateFor(host).location, HouseHost.RIMMINGTON);
  const burners = furniture(host, ["MARBLE_BURNER", "MAHOGANY_BURNER", "INCENSE_BURNER"]);
  assert.equal(burners.length, 2, "the max house chapel's two burners");
  assert.ok(burners.every((entry) => entry.lit), "both lit");
  assert.ok([...House.houseFor(host).litBurners.values()].every((until) => until === Infinity), "for good");
  HouseHost.setHost(host);
  t.after(() => HouseHost.setHost(null));
  assert.equal(HouseHost.host(), host);

  const guest = player(t, "houseguest");
  const I = core.ItemIdentifiers;
  guest.getInventory().adds(I.BONES, 2);
  const visit = { player: guest, owner: host.getUsername(), handled: false };
  PM.emitCustomEvent("construction:visit-house", visit);
  assert.equal(visit.handled, true, "in through the portal");
  assert.equal(House.houseFor(guest), House.houseFor(host));
  const [altar] = furniture(guest, ["GILDED_ALTAR"]);
  assert.ok(altar, "the gilded altar");
  const before = guest.getSkillManager().getExperience(core.Skill.PRAYER);
  const at = altar.object.getLocation();
  guest.setLocation(new core.Location(at.getX(), at.getY() - 1, at.getZ()));
  PM.emitItemOnObject({
    player: guest, object: altar.object, objectId: altar.object.getId(), item: guest.getInventory().getItems()[0], itemId: I.BONES,
    itemSlot: 0, interfaceType: 0, location: { x: at.getX(), y: at.getY(), z: at.getZ() }, handled: false,
  });
  tick(20);
  assert.equal(guest.getInventory().getAmount(I.BONES), 0, "both offered");
  const gained = guest.getSkillManager().getExperience(core.Skill.PRAYER) - before;
  assert.ok(Math.abs(gained - 2 * 4.5 * 3.5) <= 1, `gilded altar and two burners: 350% (${gained})`);
  const leave = { player: guest, handled: false };
  PM.emitCustomEvent("construction:leave-house", leave);
  assert.equal(leave.handled, true);
  assert.equal(House.houseFor(guest), null, "out by the portal");
});

test("Phials' Exchange all option exchanges all the noted bones, as the guests pick it", (t) => {
  const guest = player(t, "phialsguest");
  const I = core.ItemIdentifiers;
  const note = core.ItemDefinition.forId(I.BONES).getNoteId();
  guest.getInventory().adds(note, 10);
  guest.getInventory().adds(I.COINS, 100);
  const phials = { getLocation: () => guest.getLocation(), getId: () => core.NpcIdentifiers.PHIALS };
  PM.emitItemOnNpc({ player: guest, target: phials, npcId: core.NpcIdentifiers.PHIALS, npcIndex: 0,
    item: guest.getInventory().getItems()[0], itemId: note, slot: 0, handled: false });
  guest.getDialogueManager().handleOption(3);
  assert.equal(guest.getInventory().getAmount(I.BONES), 10);
  assert.equal(guest.getInventory().getAmount(I.COINS), 50, "five coins a bone");
});
