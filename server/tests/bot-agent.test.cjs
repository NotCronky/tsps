// Run after `yarn build`: node --test tests/bot-agent.test.cjs
//
// The rebuilt player bots: the brain that picks a task from levels and profile, the task agent
// that walks to a task's place and rests tasks that fail, the tasks' requirements, new accounts'
// stages, owned-or-bought supplies, the population count, and bot mode on a player's own character.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { Location } = require("../dist/game/model/Location");
const { World } = require("../dist/game/World");

const { chooseTask, scoreTasks } = require("../plugins/bots/agent/Brain.PlayerBots");
const { TaskAgent } = require("../plugins/bots/agent/Agent.PlayerBots");
const { createCatalogue } = require("../plugins/bots/tasks/Catalogue.PlayerBots");
const { rollProfile, setUpNewAccount } = require("../plugins/bots/population/Stages.PlayerBots");
const { readConfig } = require("../plugins/bots/population/Population.PlayerBots");
const Supplies = require("../plugins/bots/lib/Supplies.PlayerBots");
const { createObtainAction } = require("../plugins/bots/brain/actions/Obtain.PlayerBots");
const BotMode = require("../plugins/bots/BotMode.PlayerBots");

let core;
let registry;
let catalogue;
let next = 4100;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PluginManager.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PluginManager.getCoreApi();
  // Required after the plugins load: earlier, the skill plugins it pulls in keep the process alive.
  const { createBotActivityRegistry } = require("../plugins/bots/brain/ActivityRegistry.PlayerBots");
  registry = createBotActivityRegistry({ world: { core } });
  catalogue = createCatalogue(registry);
});

function realPlayer(x = 3222, y = 3218) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(next++);
  player.setUsername(`agent${player.getIndex()}`);
  player.setLocation(new Location(x, y, 0));
  return player;
}

/** A task stand-in for the brain: open or not, in a group, for a skill. */
function fakeTask(id, group, skill, open = true) {
  return { id, name: id, group, skill, places: [], minutes: [1, 1], check: () => (open ? { ok: true } : { ok: false, reason: "locked" }), build: () => ({ id }) };
}

const levels = (map) => (skill) => map[skill] ?? 1;

test("the brain only scores tasks the character can do, and says why the others are locked", () => {
  const tasks = [fakeTask("woodcutting", "Gathering", "woodcutting"), fakeTask("mining", "Gathering", "mining", false)];
  const scored = scoreTasks({ player: {}, tasks, ctx: {}, levelOf: levels({}) });
  assert.ok(scored[0].score > 0);
  assert.deepEqual([scored[1].score, scored[1].reason], [0, "locked"]);
  assert.equal(chooseTask({ player: {}, tasks: [tasks[1]], ctx: {}, levelOf: levels({}) }), null, "nothing open: no task");
});

test("the brain pulls lagging skills up, follows the focus and profile, and avoids repeats", () => {
  const wc = fakeTask("woodcutting", "Gathering", "woodcutting");
  const mining = fakeTask("mining", "Gathering", "mining");
  const combat = fakeTask("combat", "Combat", "combat");
  const score = (options) => Object.fromEntries(scoreTasks({ player: {}, ctx: {}, tasks: [wc, mining, combat], ...options })
    .map((entry) => [entry.task.id, entry.score]));
  const behind = score({ levelOf: levels({ woodcutting: 10, mining: 60, attack: 60, strength: 60, defence: 60 }) });
  assert.ok(behind.woodcutting > behind.mining, "the lagging skill comes up more");
  const even = levels({ woodcutting: 40, mining: 40, attack: 40, strength: 40, defence: 40 });
  assert.ok(score({ levelOf: even, profile: { focus: "mining" } }).mining > score({ levelOf: even }).mining, "focus");
  assert.ok(score({ levelOf: even, profile: { style: "skiller" } }).combat < score({ levelOf: even }).combat, "a skiller avoids fighting");
  assert.ok(score({ levelOf: even, profile: { style: "fighter" } }).combat > score({ levelOf: even }).combat, "a fighter prefers it");
  assert.ok(score({ levelOf: even, recent: ["mining"] }).mining < score({ levelOf: even }).mining, "what it just did comes up less");
  assert.equal(chooseTask({ player: {}, ctx: {}, tasks: [wc, mining], levelOf: even }, () => 0).id, "woodcutting", "drawn by score");
});

test("the agent travels to a far task's place first, then starts it, and asks again when its time is up", () => {
  const place = { id: "town", name: "Town", x: 3000, y: 3000, z: 0 };
  const task = { ...fakeTask("woodcutting", "Gathering", "woodcutting"), places: [place], minutes: [10, 10] };
  const player = { getLocation: () => new Location(3222, 3218, 0), getSkillManager: () => ({ getMaxLevel: () => 1 }) };
  const agent = new TaskAgent({ player, catalogue: { tasks: [task], get: () => task }, registry, world: {}, random: () => 0 });
  const travel = agent.next(0);
  assert.equal(travel.id, "travel", "far from every place: walk there first");
  assert.match(agent.describe(), /travelling to Town for woodcutting/);
  assert.deepEqual(agent.next(1000), { id: "woodcutting" }, "arrived: the task's activity");
  assert.equal(agent.due(1000 + 9 * 60000), false);
  assert.equal(agent.due(1000 + 10 * 60000), true, "its minutes are up");
});

test("a task that ends at once rests; a picked one that keeps failing is reported as stuck", () => {
  const task = fakeTask("mining", "Gathering", "mining");
  const other = fakeTask("woodcutting", "Gathering", "woodcutting");
  const player = { getLocation: () => new Location(3222, 3218, 0), getSkillManager: () => ({ getMaxLevel: () => 1 }) };
  const ids = [];
  const agent = new TaskAgent({ player, catalogue: { tasks: [task, other], get: () => null }, registry, world: {}, random: () => 0, profile: {} });
  ids.push(agent.next(0).id);
  ids.push(agent.next(1000).id);
  ids.push(agent.next(2000).id);
  assert.equal(ids[0], "mining");
  assert.equal(ids[1], "woodcutting", "mining ended within a minute: it rests");
  const reasons = [];
  const picked = new TaskAgent({ player, catalogue: { tasks: [task], get: () => task }, registry, world: {}, taskId: "mining", onStuck: (reason) => reasons.push(reason) });
  for (let at = 0; at <= 4000; at += 1000) picked.next(at);
  assert.equal(reasons.length, 1, "three quick failures in a row: stuck");
  assert.match(reasons[0], /couldn't keep going with mining/);
});

test("the catalogue has gathering, processing and combat tasks, each with real places", () => {
  assert.deepEqual([...new Set(catalogue.tasks.map((task) => task.group))], ["Quests", "Gathering", "Processing", "Combat"]);
  for (const id of ["normal_trees", "magic_trees", "copper_tin_rocks", "runite_rocks", "fish_shrimps", "fish_sharks", "firemaking", "cooking", "smelting", "combat"]) {
    const task = catalogue.get(id);
    assert.ok(task, id);
    assert.ok(task.places.length > 0 && task.places.every((place) => Number.isInteger(place.x)), `${id} has places`);
  }
});

test("every ore, tree and fishing method is its own task, with its own level and tool", () => {
  const ctx = { registry, world: {} };
  const player = realPlayer();
  const mining = catalogue.tasks.filter((task) => task.subgroup === "Mining").map((task) => [task.id, task.level]);
  assert.deepEqual(mining, [["copper_tin_rocks", 1], ["iron_rocks", 15], ["silver_rocks", 20], ["coal_rocks", 30],
    ["gold_rocks", 40], ["mithril_rocks", 55], ["adamantite_rocks", 70], ["runite_rocks", 85]]);
  assert.equal(catalogue.get("iron_rocks").name, "Mining: Iron");
  assert.match(catalogue.get("normal_trees").check(player, ctx).reason, /needs an axe/, "no axe, no coins: locked");
  player.getBank(0).adds(core.ItemIdentifiers.BRONZE_AXE, 1);
  assert.equal(catalogue.get("normal_trees").check(player, ctx).ok, true, "an axe in the bank will do");
  assert.equal(catalogue.get("normal_trees").build(player, ctx).id, "normal_trees");
  assert.match(catalogue.get("yew_trees").check(player, ctx).reason, /needs 60 Woodcutting/);
  player.getSkillManager().setMaxLevels(core.Skill.WOODCUTTING, 60, false).setCurrentLevel(core.Skill.WOODCUTTING, 60, false);
  assert.equal(catalogue.get("yew_trees").check(player, ctx).ok, true);
  assert.deepEqual(catalogue.get("runite_rocks").places.map((place) => place.id), ["falador"], "runite miners go where runite is");
  assert.match(catalogue.get("fish_lobsters").check(player, ctx).reason, /needs 40 Fishing/);
  const fishing = catalogue.tasks.filter((task) => task.subgroup === "Fishing").map((task) => task.shortName);
  assert.deepEqual(fishing, ["Shrimps and anchovies", "Sardines and herring", "Mackerel, cod and bass", "Trout and salmon",
    "Pike", "Tuna and swordfish", "Lobsters", "Sharks"], "one task per main fish");
});

test("a skill's open tiers share its weight, the higher likelier, so it doesn't crowd out other skills", () => {
  const tier = (id, level) => ({ ...fakeTask(id, "Gathering", "mining"), level });
  const wc = { ...fakeTask("normal_trees", "Gathering", "woodcutting"), level: 1 };
  const scored = Object.fromEntries(scoreTasks({ player: {}, ctx: {}, tasks: [tier("copper", 1), tier("iron", 15), tier("coal", 30), wc], levelOf: () => 40 })
    .map((entry) => [entry.task.id, entry.score]));
  assert.ok(scored.coal > scored.iron && scored.iron > scored.copper, "best tiers likelier");
  assert.ok(Math.abs(scored.copper + scored.iron + scored.coal - scored.normal_trees) < 1e-9, "mining's tiers add up to one skill's weight");
});

test("processing tasks only open with materials banked", () => {
  const ctx = { registry, world: {} };
  const player = realPlayer();
  assert.match(catalogue.get("firemaking").check(player, ctx).reason, /logs/);
  assert.match(catalogue.get("smelting").check(player, ctx).reason, /ores/);
  player.getBank(0).adds(core.ItemIdentifiers.LOGS, 50);
  player.getBank(0).adds(core.ItemIdentifiers.TINDERBOX, 1);
  assert.equal(catalogue.get("firemaking").check(player, ctx).ok, true);
  player.getBank(0).adds(core.ItemIdentifiers.COPPER_ORE, 20);
  player.getBank(0).adds(core.ItemIdentifiers.TIN_ORE, 20);
  assert.equal(catalogue.get("smelting").check(player, ctx).ok, true);
  assert.equal(catalogue.get("smelting").build(player, ctx).id, "task_smelting");
});

test("supplies: owned counts what's carried and banked; shops are found by what they stock", () => {
  const player = realPlayer();
  player.getInventory().adds(core.ItemIdentifiers.TINDERBOX, 1);
  player.getBank(0).adds(core.ItemIdentifiers.BRONZE_AXE, 1);
  assert.equal(Supplies.carriedAmount(player, core.ItemIdentifiers.TINDERBOX), 1);
  assert.equal(Supplies.bankedAmount(player, core.ItemIdentifiers.BRONZE_AXE), 1);
  assert.deepEqual(Supplies.bestOwned(player, [core.ItemIdentifiers.RUNE_AXE, core.ItemIdentifiers.BRONZE_AXE]),
    { id: core.ItemIdentifiers.BRONZE_AXE, carried: false });
  assert.ok(Supplies.canBuy(core.ItemIdentifiers.BRONZE_AXE), "a shop sells bronze axes");
});

test("obtaining an item uses what's carried, and fails rather than conjure what isn't owned or affordable", () => {
  const player = realPlayer();
  const obtain = createObtainAction({ items: [{ item: core.ItemIdentifiers.TINDERBOX, amount: 1 }] }, { core, log() {} });
  player.getInventory().adds(core.ItemIdentifiers.TINDERBOX, 1);
  assert.equal(obtain.update({ player, nowMs: 0 }), "success");
  const broke = realPlayer();
  assert.equal(obtain.update({ player: broke, nowMs: 0 }), "failed", "not owned, no coins: nothing conjured");
  assert.equal(broke.getInventory().getAmount(core.ItemIdentifiers.TINDERBOX), 0);
});

test("a new account is set up for its stage: levels in the band, gear it can wear, tools and coins banked", () => {
  const data = require("../plugins/bots/data/stages.json");
  for (const stage of ["early", "mid", "late"]) {
    const player = realPlayer();
    setUpNewAccount(player, { stage, style: "balanced", focus: "mining" }, () => 0.5, data);
    const band = data.stages[stage];
    const woodcutting = player.getSkillManager().getMaxLevel(core.Skill.WOODCUTTING);
    assert.ok(woodcutting >= band.skills[0] && woodcutting <= band.skills[1], `${stage} woodcutting ${woodcutting}`);
    const combat = player.getSkillManager().getCombatLevel();
    assert.ok(combat >= band.combat[0] && combat <= band.combat[1], `${stage} combat ${combat}`);
    assert.ok(Supplies.bankedAmount(player, core.ItemIdentifiers.COINS) >= band.coins[0], "coins banked");
    assert.ok(Supplies.bankedAmount(player, core.ItemIdentifiers.TINDERBOX) === 1, "a tinderbox");
    assert.ok((player.getEquipment().getItems()[core.Equipment.WEAPON_SLOT]?.getId() ?? -1) > 0, "a weapon worn");
  }
  const profile = rollProfile(data, () => 0);
  assert.deepEqual(profile, { stage: "early", style: "balanced", focus: "woodcutting" });
});

test("population config defaults to off, 110 accounts", () => {
  assert.deepEqual([readConfig(undefined).enabled, readConfig(undefined).count], [false, 110]);
  assert.equal(readConfig({ enabled: true, count: 20 }).count, 20);
});

test("the world's population counts players plugins report (online bots) on top of connected ones", () => {
  const base = World.getPopulation();
  const api = PluginManager.createApi("PopulationTest");
  api.onCustomEvent("world:population", (request) => { request.count += 7; });
  assert.equal(World.getPopulation(), base + 7);
});

test("bot mode: a picked task starts, a click of the player's own stops it, and locked tasks say why", () => {
  const prompts = [];
  BotMode.init({
    api: { sendMultiChatboxPrompt: (player, title, ...options) => prompts.push({ title, options }) },
    catalogue, registry, world: { core, log() {} }, behaviorMode: { ROAMING: "roaming" },
  });
  const player = realPlayer();
  const messages = [];
  player.sendMessage = (text) => messages.push(text);
  BotMode.botModeCommand({ player, parts: ["botmode", "normal_trees"] });
  assert.equal(BotMode.isActive(player), false, "no axe: woodcutting doesn't start");
  assert.match(messages.at(-1), /can't do Woodcutting: Trees yet: needs an axe/);
  player.getBank(0).adds(core.ItemIdentifiers.BRONZE_AXE, 1);
  BotMode.botModeCommand({ player, parts: ["botmode", "normal_trees"] });
  assert.equal(BotMode.isActive(player), true);
  assert.equal(player.getAttribute(BotMode.LAST_TASK_ATTRIBUTE), "normal_trees", "remembered for ::botmode resume");
  BotMode.tookOver({ player });
  assert.equal(BotMode.isActive(player), false, "the player's own click takes over");
  assert.match(messages.at(-1), /you took over/);
  BotMode.botModeCommand({ player, parts: ["botmode"] });
  const menu = prompts.at(-1);
  assert.equal(menu.options[0], "Let the brain choose");
  assert.ok(menu.options.includes("Gathering") && menu.options.includes("Resume Woodcutting: Trees"));
  menu.options[menu.options.indexOf("Gathering") + 1]();
  assert.deepEqual(prompts.at(-1).options.filter((option) => typeof option === "string"), ["Woodcutting", "Mining", "Fishing", "Back"]);
  prompts.at(-1).options[prompts.at(-1).options.indexOf("Mining") + 1]();
  const tiers = prompts.at(-1).options.filter((option) => typeof option === "string");
  assert.deepEqual(tiers, ["Copper and tin (locked)", "Iron (locked)", "Silver (locked)", "More...", "Back"], "three a page, then More");
  BotMode.botModeCommand({ player, parts: ["botmode", "brain"] });
  assert.equal(BotMode.isActive(player), true, "the brain chooses");
  BotMode.loggedOut({ player });
  assert.equal(BotMode.isActive(player), false, "logging out ends it");
});

test("Tutorial Island comes before anything else on a new account, skipping through the tutorial plugin", () => {
  const task = catalogue.get("tutorial");
  const skipped = [];
  const world = (active, canSkip = true) => ({
    emitCustomEvent: (name, request) => {
      if (name === "tutorial:status") Object.assign(request, { active, canSkip });
      if (name === "tutorial:skip") { skipped.push(request.player); request.skipped = true; }
    },
  });
  const player = realPlayer(3094, 3104);
  assert.equal(task.check(player, { registry, world: world(false) }).reason, "already done");
  assert.match(task.check(player, { registry, world: world(true, false) }).reason, /doesn't allow skipping/);
  assert.equal(task.check(player, { registry, world: world(true) }).ok, true);
  const chosen = chooseTask({ player, tasks: catalogue.tasks, ctx: { registry, world: world(true) }, levelOf: () => 1 }, () => 0.99);
  assert.equal(chosen.id, "tutorial", "first, whatever the dice say");
  const activity = task.build(player, { registry, world: world(true) });
  assert.equal(activity.actions[0].update({ player }), "success");
  assert.deepEqual(skipped, [player]);
});

test("travel teleports with whatever the character can use: spells, tablets, jewellery, home and minigame teleports", () => {
  const { teleportOptions, bestTeleport, createTravelToAction } = require("../plugins/bots/brain/actions/TravelTo.PlayerBots");
  const world = { emitCustomEvent: (name, payload) => PluginManager.emitCustomEvent(name, payload) };
  const I = core.ItemIdentifiers;
  const falador = { x: 2964, y: 3378, z: 0 };
  const varrock = { x: 3213, y: 3424, z: 0 };
  const wintertodt = { x: 1630, y: 3960, z: 0 };
  const player = realPlayer(falador.x, falador.y);
  const kinds = () => new Set(teleportOptions(player, world).map((option) => option.kind));
  assert.deepEqual([...kinds()].sort(), ["home", "minigame"], "a new character: only the free ones");
  assert.equal(bestTeleport(teleportOptions(player, world), falador, varrock).kind, "minigame", "free: the minigame teleport that lands nearest");
  player.getSkillManager().setMaxLevels(core.Skill.MAGIC, 40, false).setCurrentLevel(core.Skill.MAGIC, 40, false);
  for (const [rune, amount] of [[I.LAW_RUNE, 5], [I.AIR_RUNE, 20], [I.FIRE_RUNE, 5], [I.WATER_RUNE, 5], [I.EARTH_RUNE, 5]]) player.getInventory().adds(rune, amount);
  assert.equal(bestTeleport(teleportOptions(player, world), falador, varrock).id, "spell:varrock teleport");
  const broke = realPlayer(falador.x, falador.y);
  broke.getInventory().adds(I.VARROCK_TELEPORT, 1);
  assert.equal(bestTeleport(teleportOptions(broke, world), falador, varrock).id, "tablet:varrock teleport", "a tablet it carries");
  broke.getInventory().adds(I.GAMES_NECKLACE_8_, 1);
  assert.equal(bestTeleport(teleportOptions(broke, world), falador, wintertodt).id, "jewellery:games:Wintertodt Camp");
  const used = [];
  const fake = { emitCustomEvent: (name, request) => request.options.push(
    { id: "a", to: varrock, cost: 0, use: () => { used.push("a"); return false; } },
    { id: "b", to: { x: 3200, y: 3400, z: 0 }, cost: 0, use: () => { used.push("b"); return true; } }) };
  const ctx = { player, nowMs: 0, frame: { lastProgressAt: 0 } };
  assert.equal(createTravelToAction(varrock, fake).update(ctx), "running");
  assert.deepEqual(used, ["a", "b"], "one that doesn't start: the next best");
});

test("Wintertodt is a Firemaking task: 50 Firemaking, a way there, its kit; it plays through the Wintertodt plugin", () => {
  const world = { emitCustomEvent: (name, payload) => PluginManager.emitCustomEvent(name, payload) };
  const I = core.ItemIdentifiers;
  const task = catalogue.get("wintertodt");
  assert.deepEqual([task.group, task.subgroup], ["Processing", "Firemaking"]);
  assert.deepEqual(catalogue.tasks.filter((entry) => entry.subgroup === "Firemaking").map((entry) => entry.id), ["firemaking", "wintertodt"]);
  const player = realPlayer();
  const ctx = { registry, world };
  assert.match(task.check(player, ctx).reason, /needs 50 Firemaking/);
  player.getSkillManager().setMaxLevels(core.Skill.FIREMAKING, 60, false).setCurrentLevel(core.Skill.FIREMAKING, 60, false);
  assert.match(task.check(player, ctx).reason, /games necklace/, "from the mainland it needs the necklace");
  player.getBank(0).adds(I.GAMES_NECKLACE_8_, 1);
  assert.match(task.check(player, ctx).reason, /axe/);
  player.getBank(0).adds(I.RUNE_AXE, 1);
  player.getBank(0).adds(I.COINS, 1000);
  assert.equal(task.check(player, ctx).ok, true, "kit and cakes it can buy");
  const activity = task.build(player, ctx);
  assert.deepEqual(activity.actions.map((action) => action.id), ["equipTool", "obtain", "wear", "wearWarmClothing", "travelTo", "wintertodt"]);
  const request = { player, controller: null };
  PluginManager.emitCustomEvent("wintertodt:play", request);
  assert.equal(typeof request.controller?.tick, "function", "the Wintertodt plugin plays it");
  assert.equal(request.controller.tick(), false, "not at the camp: nothing to play");
});

test("a teleport in the bank is fetched first when it beats everything carried", () => {
  const { bankedTeleportOptions, createTravelToAction } = require("../plugins/bots/brain/actions/TravelTo.PlayerBots");
  const world = { core, log() {}, emitCustomEvent: (name, payload) => PluginManager.emitCustomEvent(name, payload) };
  const I = core.ItemIdentifiers;
  const varrock = { x: 3213, y: 3424, z: 0 };
  const player = realPlayer(2964, 3378);
  player.getSkillManager().setMaxLevels(core.Skill.MAGIC, 40, false).setCurrentLevel(core.Skill.MAGIC, 40, false);
  player.getInventory().adds(I.AIR_RUNE, 3);
  for (const [item, amount] of [[I.LAW_RUNE, 50], [I.FIRE_RUNE, 50], [I.GAMES_NECKLACE_8_, 1], [I.CAMELOT_TELEPORT, 3]]) player.getBank(0).adds(item, amount);
  const banked = new Map(bankedTeleportOptions(player, world).map((option) => [option.id, option.withdraw]));
  assert.deepEqual(banked.get("spell:varrock teleport"), [{ item: I.LAW_RUNE, amount: 1 }, { item: I.FIRE_RUNE, amount: 1 }],
    "only the runes it's missing: the airs are carried");
  assert.deepEqual(banked.get("tablet:camelot teleport"), [{ item: I.CAMELOT_TELEPORT, amount: 1 }]);
  assert.deepEqual(banked.get("jewellery:games:Wintertodt Camp"), [{ item: I.GAMES_NECKLACE_8_, amount: 1 }]);
  const travel = createTravelToAction(varrock, world);
  const ctx = { player, nowMs: 0, frame: { lastProgressAt: 0 } };
  assert.equal(travel.update(ctx), "running");
  assert.equal(travel.describe?.(ctx) ?? "bank", "bank");
  assert.ok(player.getInventory().getAmount(I.LAW_RUNE) === 0, "it heads to a bank for the runes, not straight off");
});

test("warm clothing for the Wintertodt: up to four pieces, one per slot, from the bank and the inventory", () => {
  const { createWearWarmClothingAction } = require("../plugins/bots/brain/actions/WearWarmClothing.PlayerBots");
  const world = { core, log() {}, emitCustomEvent: (name, payload) => PluginManager.emitCustomEvent(name, payload) };
  const I = core.ItemIdentifiers;
  const warm = (id) => { const request = { itemId: id, warm: false }; PluginManager.emitCustomEvent("wintertodt:is-warm", request); return request.warm; };
  assert.equal(warm(I.SANTA_HAT), true, "the Wintertodt plugin says what's warm");
  assert.equal(warm(I.RUNE_AXE), false);
  const player = realPlayer();
  player.getInventory().adds(I.SANTA_HAT, 1);
  const action = createWearWarmClothingAction(world);
  const ctx = { player, nowMs: 0, frame: { lastProgressAt: 0 } };
  assert.equal(action.update(ctx), "success", "nothing banked: puts on what it carries");
  assert.equal(player.getEquipment().getItems()[core.Equipment.HEAD_SLOT]?.getId(), I.SANTA_HAT);
  player.getBank(0).adds(I.CLUE_HUNTER_GLOVES, 1);
  assert.equal(action.update(ctx), "running", "a warm piece in the bank: off to get it");
});
