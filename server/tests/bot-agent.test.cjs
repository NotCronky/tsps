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

test("the catalogue has gathering, processing, activity and combat tasks, each with real places", () => {
  assert.deepEqual([...new Set(catalogue.tasks.map((task) => task.group))], ["Quests", "Gathering", "Processing", "Activities", "Combat"]);
  assert.equal(new Set(catalogue.tasks.map((task) => task.id)).size, catalogue.tasks.length, "every task id is its own");
  for (const id of ["normal_trees", "magic_trees", "copper_tin_rocks", "runite_rocks", "fish_shrimps", "fish_sharks", "burn_logs",
    "cook_shrimp", "smelt_bronze_bar", "smith_bronze", "fletch_longbow_u", "herb_guamvial", "cut_sapphire", "bury_bones",
    "agility_draynor", "combat"]) {
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

test("processing tasks only open with materials banked, one task per log, fish and bar", () => {
  const ctx = { registry, world: {} };
  const player = realPlayer();
  assert.match(catalogue.get("burn_logs").check(player, ctx).reason, /logs/);
  assert.match(catalogue.get("smelt_bronze_bar").check(player, ctx).reason, /copper ore/);
  player.getBank(0).adds(core.ItemIdentifiers.LOGS, 50);
  player.getBank(0).adds(core.ItemIdentifiers.TINDERBOX, 1);
  assert.equal(catalogue.get("burn_logs").check(player, ctx).ok, true);
  assert.match(catalogue.get("burn_oak_logs").check(player, ctx).reason, /needs 15 Firemaking/);
  player.getBank(0).adds(core.ItemIdentifiers.COPPER_ORE, 20);
  player.getBank(0).adds(core.ItemIdentifiers.TIN_ORE, 20);
  assert.equal(catalogue.get("smelt_bronze_bar").check(player, ctx).ok, true);
  assert.equal(catalogue.get("smelt_bronze_bar").build(player, ctx).id, "task_smelt_bronze_bar");
  const firemaking = catalogue.tasks.filter((task) => task.subgroup === "Firemaking").map((task) => task.id);
  assert.deepEqual(firemaking.slice(0, 3), ["burn_logs", "burn_oak_logs", "burn_willow_logs"]);
  assert.ok(firemaking.includes("wintertodt"));
  assert.deepEqual(["cook_beef", "cook_rat_meat"].map((id) => catalogue.get(id).shortName), ["Beef", "Rat meat"], "cooking is named by the raw food");
});

test("every product is its own task: fletching, herblore, crafting and prayer, from the skills' own recipes", () => {
  const ctx = { registry, world: {} };
  const I = core.ItemIdentifiers;
  const player = realPlayer();
  const longbow = catalogue.get("fletch_longbow_u");
  assert.deepEqual([longbow.subgroup, longbow.family, longbow.level, longbow.shortName], ["Fletching", "Logs", 10, "Longbow (u)"]);
  assert.match(longbow.check(player, ctx).reason, /needs 10 Fletching/);
  player.getSkillManager().setMaxLevels(core.Skill.FLETCHING, 10, false).setCurrentLevel(core.Skill.FLETCHING, 10, false);
  assert.match(longbow.check(player, ctx).reason, /knife/, "no knife and no coins for one");
  player.getBank(0).adds(I.KNIFE, 1);
  assert.match(longbow.check(player, ctx).reason, /logs in the bank/);
  player.getBank(0).adds(I.LOGS, 100);
  assert.equal(longbow.check(player, ctx).ok, true);
  const activity = longbow.build(player, ctx);
  assert.deepEqual(activity.actions.map((action) => action.id), ["bank", "ensureItem", "bank", "make"]);
  for (const id of ["herb_guamvial", "herb_3dose1attack", "clean_guam_leaf", "cut_sapphire", "craft_leather_gloves", "blow_vial", "bury_big_bones", "smith_iron"]) {
    assert.ok(catalogue.get(id), id);
  }
  assert.equal(catalogue.get("herb_guamvial").family, "Unfinished potions");
  assert.equal(catalogue.get("herb_3dose1attack").shortName, "Attack potion(3)");
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
  assert.deepEqual(menu.options.filter((option) => typeof option === "string"),
    ["Let the brain choose", "Skills", "Combat", "Resume Woodcutting: Trees"]);
  menu.options[menu.options.indexOf("Skills") + 1]();
  const labels = () => prompts.at(-1).options.filter((option) => typeof option === "string");
  const pick = (label) => prompts.at(-1).options[prompts.at(-1).options.indexOf(label) + 1]();
  assert.deepEqual(labels(), ["Woodcutting", "Mining", "Fishing", "More...", "Back"], "the skills, three a page");
  pick("Mining");
  assert.deepEqual(labels(), ["Copper and tin (locked)", "Iron (locked)", "Silver (locked)", "More...", "Back"], "three a page, then More");
  pick("Back");
  pick("More...");
  pick("More...");
  assert.ok(labels().includes("Fletching"), labels().join());
  pick("Fletching");
  assert.ok(labels().includes("Logs") && labels().includes("Oak logs"), "a skill with families lists them first");
  pick("Logs");
  assert.ok(labels()[0].startsWith("Arrow shafts (logs)"), labels().join());
  BotMode.botModeCommand({ player, parts: ["botmode", "brain"] });
  assert.equal(BotMode.isActive(player), true, "the brain chooses");
  BotMode.loggedOut({ player });
  assert.equal(BotMode.isActive(player), false, "logging out ends it");
});

test("bot mode: a death its task lives through (a Gauntlet run) keeps it on; any other ends it", () => {
  BotMode.init({
    api: { sendMultiChatboxPrompt() {} },
    catalogue, registry, world: { core, log() {} }, behaviorMode: { ROAMING: "roaming" },
  });
  const player = realPlayer();
  player.sendMessage = () => {};
  player.getBank(0).adds(core.ItemIdentifiers.BRONZE_AXE, 1);
  const task = catalogue.get("normal_trees");
  const busy = task.busy;
  try {
    BotMode.botModeCommand({ player, parts: ["botmode", "normal_trees"] });
    BotMode.tickAll();
    assert.equal(BotMode.isActive(player), true);
    player.setHitpoints(0);
    task.busy = () => true;
    BotMode.tickAll();
    assert.equal(BotMode.isActive(player), true, "dead mid-run: the run's own death handling takes it");
    task.busy = () => false;
    BotMode.tickAll();
    assert.equal(BotMode.isActive(player), false, "an ordinary death ends bot mode");
  } finally {
    task.busy = busy;
    BotMode.loggedOut({ player });
  }
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
  assert.ok(catalogue.tasks.filter((entry) => entry.subgroup === "Firemaking").some((entry) => entry.id === "wintertodt"));
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

test("making: a knife used on logs through the Fletching plugin, the make menu answered with the task's product", () => {
  const { createMakeAction } = require("../plugins/bots/brain/actions/Make.PlayerBots");
  const I = core.ItemIdentifiers;
  const player = realPlayer();
  // The Fletching plugin's loop only runs for a player in the world.
  player.isRegistered = () => true;
  player.getSkillManager().setMaxLevels(core.Skill.FLETCHING, 10, false).setCurrentLevel(core.Skill.FLETCHING, 10, false);
  player.getInventory().adds(I.KNIFE, 1);
  player.getInventory().adds(I.LOGS, 3);
  const make = createMakeAction({ use: I.KNIFE, on: I.LOGS, output: I.LONGBOW_U_ }, { core });
  const ctx = { player, nowMs: 0 };
  assert.equal(make.update(ctx), "running");
  for (let tick = 0; tick < 20; tick++) core.TaskManager.process();
  assert.equal(player.getInventory().getAmount(I.LOGS), 0, "all three fletched");
  assert.equal(player.getInventory().getAmount(I.LONGBOW_U_), 3, "into the product picked, not the menu's first");
  assert.equal(make.update({ player, nowMs: 30000 }), "success", "nothing left to make");
});

test("clicking items: bones buried one after another through the Prayer plugin", () => {
  const { createClickItemAction } = require("../plugins/bots/brain/actions/ClickItem.PlayerBots");
  const I = core.ItemIdentifiers;
  const player = realPlayer();
  player.getInventory().adds(I.BONES, 1);
  const before = player.getSkillManager().getExperience(core.Skill.PRAYER);
  const bury = createClickItemAction({ items: [I.BONES] }, { core });
  assert.equal(bury.update({ player, nowMs: 0 }), "running");
  for (let tick = 0; tick < 5; tick++) core.TaskManager.process();
  assert.equal(player.getInventory().getAmount(I.BONES), 0);
  assert.ok(player.getSkillManager().getExperience(core.Skill.PRAYER) > before, "prayer XP from the plugin");
  assert.equal(bury.update({ player, nowMs: 5000 }), "success");
});

test("anvil smithing: the Smithing plugin's bot entry smiths the best product the level allows", () => {
  const Smithing = require("../plugins/skills/Smithing.plugin");
  const I = core.ItemIdentifiers;
  const player = realPlayer();
  const products = Smithing.anvilProducts(I.BRONZE_BAR);
  assert.ok(products.some((product) => product.itemId === I.BRONZE_DAGGER), "bronze products from the cache");
  player.getInventory().adds(I.HAMMER, 1);
  player.getInventory().adds(I.BRONZE_BAR, 2);
  assert.equal(Smithing.startBotSmithing(player, I.BRONZE_DAGGER, 28), true);
  assert.equal(Smithing.isSmithingActive(player), true, "the plugin's smithing session runs it");
  assert.equal(Smithing.startBotSmithing(player, I.RUNE_PLATEBODY, 28), false, "not at 1 Smithing, nor without the bars");
  const task = catalogue.get("smith_bronze");
  player.getBank(0).adds(I.BRONZE_BAR, 20);
  assert.equal(task.check(player, { registry, world: {} }).ok, true);
  assert.deepEqual(task.build(player, { registry, world: {} }).actions.map((action) => action.id), ["bank", "ensureItem", "bank", "smithAnvil"]);
});

test("agility: the Agility plugin names a lap's next obstacle and how it's clicked", () => {
  const player = realPlayer(3103, 3279);
  const request = { player, course: "draynor", restart: false, busy: false, next: null };
  PluginManager.emitCustomEvent("agility:course-next", request);
  assert.equal(request.next.index, 1, "no lap under way: the first obstacle");
  assert.ok(request.next.objectIds.includes(core.ObjectIds?.ROUGH_WALL ?? request.next.objectIds[0]));
  player.setAttribute("agility.progress", { course: "draynor", index: 2 });
  PluginManager.emitCustomEvent("agility:course-next", request);
  assert.equal(request.next.index, 3, "mid-lap: the one after the last");
  request.restart = true;
  PluginManager.emitCustomEvent("agility:course-next", request);
  assert.equal(request.next.index, 1, "after a fall: from the start");
  const rooftops = catalogue.tasks.filter((task) => task.subgroup === "Agility").map((task) => task.id);
  for (const key of ["draynor", "alkharid", "varrock", "canifis", "falador", "seers", "pollnivneach", "rellekka", "prifddinas", "ardougne"]) {
    assert.ok(rooftops.includes(`agility_${key}`), `${key} rooftop is a task`);
  }
  player.getSkillManager().setMaxLevels(core.Skill.AGILITY, 80, false).setCurrentLevel(core.Skill.AGILITY, 80, false);
  const questWorld = { emitCustomEvent: (name, payload) => PluginManager.emitCustomEvent(name, payload) };
  assert.match(catalogue.get("agility_canifis").check(player, { registry, world: questWorld }).reason, /Priest in Peril/);
  assert.match(catalogue.get("agility_prifddinas").check(player, { registry, world: questWorld }).reason, /Song of the Elves/);
  player.getSkillManager().setMaxLevels(core.Skill.AGILITY, 1, false).setCurrentLevel(core.Skill.AGILITY, 1, false);
  const course = catalogue.get("agility_draynor");
  assert.match(course.check(player, { registry, world: {} }).reason, /needs 10 Agility/);
  assert.deepEqual(course.build(player, { registry, world: {} }).actions.map((action) => action.id), ["runCourse"]);
});

test("agility: the Barbarian Outpost is a task, in by its pipe, each wall by its own tile", () => {
  const player = realPlayer(2552, 3561);
  const task = catalogue.get("agility_barbarian");
  assert.ok(task, "the Barbarian Outpost is a task");
  assert.match(task.check(player, { registry, world: {} }).reason, /needs 35 Agility/);
  player.getSkillManager().setMaxLevels(core.Skill.AGILITY, 35, false).setCurrentLevel(core.Skill.AGILITY, 35, false);
  assert.equal(task.check(player, { registry, world: {} }).ok, true);
  assert.deepEqual([task.places[0].x, task.places[0].y], [2552, 3561], "it starts north of the pipe");
  // The three walls share an id: the plugin says which one is next by its tile.
  const request = { player, course: "barbarian", restart: false, busy: false, next: null };
  player.setAttribute("agility.progress", { course: "barbarian", index: 5 });
  PluginManager.emitCustomEvent("agility:course-next", request);
  assert.equal(request.next.index, 6);
  assert.deepEqual(request.next.tiles, [[2539, 3553, 0]]);
  player.setAttribute("agility.progress", { course: "draynor", index: 1 });
  request.course = "draynor";
  PluginManager.emitCustomEvent("agility:course-next", request);
  assert.deepEqual(request.next.tiles, [], "a rooftop's obstacles: any of their ids");
});

test("agility: a lap picks up the marks of grace it comes by", () => {
  const { ItemOnGroundManager } = require("../dist/game/entity/impl/grounditem/ItemOnGroundManager");
  const { Item } = require("../dist/game/model/Item");
  const MARK = 11849;
  // On Draynor's first roof, a mark of its own on the tile it stands on.
  const player = realPlayer(3102, 3279);
  player.setLocation(new Location(3102, 3279, 3));
  World.getPlayers().add(player);
  try {
    player.getSkillManager().setMaxLevels(core.Skill.AGILITY, 20, false).setCurrentLevel(core.Skill.AGILITY, 20, false);
    ItemOnGroundManager.registerLocation(player, new Item(MARK, 1), player.getLocation().clone(), null, { goesGlobal: false, despawnDelay: 1000 });
    const { createRunCourseAction } = require("../plugins/bots/brain/actions/RunCourse.PlayerBots");
    const world = { core, emitCustomEvent: (name, payload) => PluginManager.emitCustomEvent(name, payload) };
    const lap = createRunCourseAction({ course: "draynor" }, world);
    assert.equal(lap.update({ player, nowMs: 100000 }), "running");
    assert.equal(player.getInventory().getAmount(MARK), 1, "picked up before the next obstacle");
  } finally {
    World.getPlayers().remove?.(player);
  }
});

test("runecraft: a task per walkable altar, with its talisman or tiara, essence and pouches from the bank", () => {
  const I = core.ItemIdentifiers;
  const ids = catalogue.tasks.filter((task) => task.subgroup === "Runecraft").map((task) => task.id);
  assert.deepEqual(ids, ["runecraft_air", "runecraft_mind", "runecraft_water", "runecraft_earth", "runecraft_fire", "runecraft_body"]);
  const player = realPlayer(2984, 3290);
  const task = catalogue.get("runecraft_fire");
  assert.match(task.check(player, { registry, world: {} }).reason, /needs 14 Runecraft/);
  player.getSkillManager().setMaxLevels(core.Skill.RUNECRAFTING, 55, false).setCurrentLevel(core.Skill.RUNECRAFTING, 55, false);
  assert.match(task.check(player, { registry, world: {} }).reason, /talisman or tiara/);
  player.getBank(0).adds(I.FIRE_TALISMAN, 1);
  assert.match(task.check(player, { registry, world: {} }).reason, /essence/);
  player.getBank(0).adds(I.RUNE_ESSENCE, 100);
  assert.equal(task.check(player, { registry, world: {} }).ok, true);
  // A pouch it owns comes along: filled, the inventory topped up after, then the trip.
  player.getBank(0).adds(I.SMALL_POUCH, 1);
  player.getBank(0).adds(I.GIANT_POUCH, 1);
  const world = { core, emitCustomEvent: (name, payload) => PluginManager.emitCustomEvent(name, payload) };
  const actions = task.build(player, { registry, world }).actions.map((action) => action.id);
  assert.deepEqual(actions, ["bank", "ensureItem", "ensureItem", "bank", "fillPouches", "bank", "wear", "travelTo", "craftRunes"],
    "the small pouch, not the giant (75 Runecraft)");
});

test("runecraft: the pouches fill from the essence carried, empty ones only", () => {
  const I = core.ItemIdentifiers;
  const { createFillPouchesAction } = require("../plugins/bots/brain/actions/CraftRunes.PlayerBots");
  const player = realPlayer();
  player.getSkillManager().setMaxLevels(core.Skill.RUNECRAFTING, 30, false).setCurrentLevel(core.Skill.RUNECRAFTING, 30, false);
  player.getInventory().add(new core.Item(I.SMALL_POUCH, 1));
  player.getInventory().add(new core.Item(I.MEDIUM_POUCH, 1));
  player.getInventory().add(new core.Item(I.RUNE_ESSENCE, 20));
  const fill = createFillPouchesAction({ essence: [I.RUNE_ESSENCE] }, { core });
  let result = "running";
  for (let i = 0; i < 5 && result === "running"; i++) result = fill.update({ player });
  assert.equal(result, "success");
  assert.equal(player.getInventory().getAmount(I.RUNE_ESSENCE), 11, "3 in the small pouch and 6 in the medium");
  // Full now: Fill would empty them, so it leaves them be.
  assert.equal(fill.update({ player }), "success");
  assert.equal(player.getInventory().getAmount(I.RUNE_ESSENCE), 11);
});

test("hunter: a bird snaring task per bird, at its spawns, with the snares its level allows", () => {
  const I = core.ItemIdentifiers;
  const ids = catalogue.tasks.filter((task) => task.subgroup === "Hunter").map((task) => task.id);
  assert.deepEqual(ids, ["hunt_crimson_swift", "hunt_golden_warbler", "hunt_copper_longtail", "hunt_cerulean_twitch", "hunt_tropical_wagtail"]);
  const player = realPlayer(2612, 3092);
  const task = catalogue.get("hunt_copper_longtail");
  assert.match(task.check(player, { registry, world: {} }).reason, /needs 9 Hunter/);
  player.getSkillManager().setMaxLevels(core.Skill.HUNTER, 45, false).setCurrentLevel(core.Skill.HUNTER, 45, false);
  player.getBank(0).adds(I.BIRD_SNARE, 5);
  assert.equal(task.check(player, { registry, world: {} }).ok, true);
  const world = { core, emitCustomEvent: (name, payload) => PluginManager.emitCustomEvent(name, payload) };
  const activity = task.build(player, { registry, world });
  assert.deepEqual(activity.actions.map((action) => action.id), ["ensureItem", "travelTo", "huntTraps"]);
});

test("slayer: a master's Assignment, then the task's monsters fought till it's done", () => {
  const task = catalogue.get("slayer");
  assert.ok(task, "Slayer is a task");
  const player = realPlayer(3093, 3262);
  player.getSkillManager().setMaxLevels(core.Skill.HITPOINTS, 30, false).setCurrentLevel(core.Skill.HITPOINTS, 30, false);
  assert.equal(task.check(player, { registry, world: {} }).ok, true);
  const world = { core, emitCustomEvent: (name, payload) => PluginManager.emitCustomEvent(name, payload) };
  const activity = task.build(player, { registry, world });
  assert.deepEqual(activity.actions.map((action) => action.id), ["slayerAssignment", "slayerKit", "trainCombat"]);
  // No task yet: nothing to fight.
  const { taskTargets } = require("../plugins/bots/tasks/Slayer.PlayerBots");
  assert.equal(taskTargets(player), null);
});

test("farming: a herb run round the walkable patches, while one of them is ready", () => {
  const I = core.ItemIdentifiers;
  const task = catalogue.get("farming_herbs");
  assert.ok(task, "the herb run is a task");
  const player = realPlayer(3013, 3355);
  assert.match(task.check(player, { registry, world: {} }).reason, /needs 9 Farming/);
  player.getSkillManager().setMaxLevels(core.Skill.FARMING, 40, false).setCurrentLevel(core.Skill.FARMING, 40, false);
  for (const tool of [I.RAKE, I.SEED_DIBBER, I.SPADE]) player.getBank(0).adds(tool, 1);
  assert.match(task.check(player, { registry, world: {} }).reason, /herb seeds/);
  player.getBank(0).adds(I.RANARR_SEED, 5);
  assert.equal(task.check(player, { registry, world: {} }).ok, true, "never planted: every patch is ready");
  const world = { core, emitCustomEvent: (name, payload) => PluginManager.emitCustomEvent(name, payload) };
  const actions = task.build(player, { registry, world }).actions.map((action) => action.id);
  assert.deepEqual(actions, ["bank", "ensureItem", "ensureItem", "ensureItem", "bank",
    "travelTo", "tendPatch", "travelTo", "tendPatch", "travelTo", "tendPatch", "bank"]);
  // All three growing: nothing to do till they've grown.
  const patches = {};
  for (const [id, x, y] of [[8150, 3058, 3311], [8151, 2813, 3463], [8152, 2670, 3374]]) {
    patches[`${id}:${x}:${y}:0`] = { crop: "RANARR", status: "growing", stage: 1, weeds: 0, nextAt: Date.now() + 3600000, plantedAt: Date.now() };
  }
  player.setAttribute("farming:state", { offset: 0, patches, tools: {}, autoWeed: false });
  assert.match(task.check(player, { registry, world: {} }).reason, /still growing/);
});

test("navigation: a walk into a dungeon goes by its trapdoor (opened first), and out by its ladder", () => {
  const { findStairs } = require("../plugins/bots/brain/Climbing.PlayerBots");
  // The map's collision and objects, as the server loads them.
  core.RegionManager.init?.();
  core.RegionManager.loadMapFiles(3097, 3468);
  core.RegionManager.loadMapFiles(3096, 9867);
  // Edgeville bank to Vannaka, in Edgeville Dungeon: the closed trapdoor south of the bank.
  const down = findStairs({ x: 3094, y: 3491, z: 0 }, { x: 3147, y: 9914, z: 0 }, -1, Date.now());
  assert.deepEqual([down?.getLocation().getX(), down?.getLocation().getY()], [3097, 3468]);
  // And back up from beside him to the bank.
  const up = findStairs({ x: 3147, y: 9914, z: 0 }, { x: 3094, y: 3491, z: 0 }, 1, Date.now());
  assert.ok(up, "a ladder up out of the dungeon");
  assert.ok(up.getLocation().getY() >= 6400, "found underground");
});

test("slayer: a task's kit from the Slayer data, protection worn and finishing items carried", () => {
  const I = core.ItemIdentifiers;
  const Kit = require("../plugins/bots/tasks/SlayerKit.PlayerBots");
  const task = (displayName, count = 20) => ({ task: { displayName }, count });
  const banshees = Kit.needs(task("Banshees"));
  assert.equal(banshees.length, 1);
  assert.equal(banshees[0].wear, true);
  assert.ok(banshees[0].ids.includes(I.EARMUFFS));
  assert.ok(Kit.needs(task("Aberrant Spectres"))[0].ids.includes(I.NOSE_PEG));
  assert.ok(Kit.needs(task("Basilisks"))[0].ids.includes(I.MIRROR_SHIELD));
  const lizards = Kit.needs(task("Lizards", 30));
  assert.deepEqual([lizards[0].ids, lizards[0].amount, lizards[0].wear], [[I.ICE_COOLER], 33, false], "an ice cooler a kill, and spares");
  assert.ok(Kit.needs(task("Gargoyles"))[0].ids.includes(I.ROCK_HAMMER));
  assert.deepEqual(Kit.needs(task("Cows")), [], "cows need nothing");
  // Bought when not owned: earmuffs are in the Slayer shops.
  assert.equal(Kit.missing(realPlayer(), task("Banshees")), null);
});

test("starting kit: the stage's quests its levels meet are complete, its teleports banked, once", () => {
  const I = core.ItemIdentifiers;
  const { applyStartingKit } = require("../plugins/bots/population/Stages.PlayerBots");
  const quests = new Map(require("../plugins/quests/QuestRuntime").getRegisteredQuests().map((quest) => [quest.key, quest]));
  const player = realPlayer();
  for (const skill of core.Skill.values()) player.getSkillManager().setMaxLevels(skill, 40, false).setCurrentLevel(skill, 40, false);
  assert.equal(applyStartingKit(player, { stage: "mid" }), true);
  for (const key of ["druidic_ritual", "priest_in_peril", "lost_city", "fremennik_trials", "nature_spirit", "animal_magnetism"]) {
    assert.equal(quests.get(key).isComplete(player), true, `${key} complete`);
  }
  assert.equal(quests.get("song_of_the_elves").isComplete(player), false, "a late quest isn't a mid account's");
  assert.equal(player.getBank(0).getAmount(I.VARROCK_TELEPORT), 15);
  assert.equal(player.getBank(0).getAmount(I.LAW_RUNE), 200);
  assert.equal(applyStartingKit(player, { stage: "mid" }), false, "given once");
  assert.equal(player.getBank(0).getAmount(I.VARROCK_TELEPORT), 15);
  // Levels short of a quest's: it isn't given (Lost City asks 31 Crafting, 36 Woodcutting).
  const low = realPlayer();
  applyStartingKit(low, { stage: "mid" });
  assert.equal(quests.get("lost_city").isComplete(low), false);
  assert.equal(quests.get("priest_in_peril").isComplete(low), true);
});

test("travel: fairy rings are teleports from the nearest ring it can walk to, with a fairy staff and Fairytale II's permission", () => {
  const I = core.ItemIdentifiers;
  const quests = new Map(require("../plugins/quests/QuestRuntime").getRegisteredQuests().map((quest) => [quest.key, quest]));
  const player = realPlayer(3092, 3245);
  const offer = (bank) => {
    const request = { player, options: [], bank, canWalkTo: (tile) => !(tile.getX() === 3082 && tile.getY() === 3206) };
    PluginManager.emitCustomEvent("teleport:options", request);
    return request.options.filter((option) => String(option.id).startsWith("fairy-ring:"));
  };
  player.getInventory().add(new core.Item(I.DRAMEN_STAFF, 1));
  assert.equal(offer().length, 0, "not before Fairytale II's permission");
  quests.get("fairytale_ii_cure_a_queen").setStage(player, 40);
  const rings = offer();
  const canifis = rings.find((option) => option.id === "fairy-ring:CKS");
  assert.ok(canifis && typeof canifis.use === "function", "Canifis' ring, usable");
  assert.notDeepEqual([canifis.via.getX(), canifis.via.getY()], [3082, 3206], "not the swamp island's ring: it can't walk there");
  // Banked staff only: the same, to withdraw first.
  player.getInventory().resetItems();
  const banked = offer([new core.Item(I.DRAMEN_STAFF, 1)]);
  assert.deepEqual(banked.find((option) => option.id === "fairy-ring:CKS").withdraw, [{ item: I.DRAMEN_STAFF, amount: 1 }]);
});

test("thieving: each pickpocket target is a task; hard hitters need food banked", () => {
  const I = core.ItemIdentifiers;
  const player = realPlayer();
  const ctx = { registry, world: {} };
  assert.equal(catalogue.get("pickpocket_man").check(player, ctx).ok, true);
  assert.deepEqual(catalogue.get("pickpocket_man").build(player, ctx).actions.map((action) => action.id), ["bank", "pickpocket"]);
  player.getSkillManager().setMaxLevels(core.Skill.THIEVING, 40, false).setCurrentLevel(core.Skill.THIEVING, 40, false);
  assert.match(catalogue.get("pickpocket_guard").check(player, ctx).reason, /food/);
  player.getBank(0).adds(I.TROUT, 20);
  assert.equal(catalogue.get("pickpocket_guard").check(player, ctx).ok, true);
  assert.deepEqual(catalogue.get("pickpocket_guard").build(player, ctx).actions.map((action) => action.id), ["bank", "bank", "pickpocket"]);
});

test("the gilded altar is a Prayer task per bone: open while the house host is hosting, bones and Phials' coins banked", () => {
  const HouseHost = require("../plugins/bots/lib/HouseHost.PlayerBots");
  const I = core.ItemIdentifiers;
  const ctx = { registry, world: { core, emitCustomEvent: () => {} } };
  const player = realPlayer();
  const task = catalogue.get("altar_big_bones");
  assert.deepEqual([task.subgroup, task.family], ["Prayer", "Gilded altar"]);
  assert.equal(catalogue.get("bury_big_bones").family, "Burying");
  assert.match(task.check(player, ctx).reason, /no house host/);
  const host = { isRegistered: () => true, getPrivateArea: () => ({}), getUsername: () => "Gilded Host" };
  HouseHost.setHost(host);
  try {
    assert.match(task.check(player, ctx).reason, /big bones in the bank/);
    player.getBank(0).adds(I.BIG_BONES, 100);
    assert.match(task.check(player, ctx).reason, /coins for Phials/);
    player.getBank(0).adds(I.COINS, 1000);
    assert.equal(task.check(player, ctx).ok, true);
    assert.deepEqual(task.build(player, ctx).actions.map((action) => action.id), ["bank", "bank", "travelTo", "altarRun"]);
  } finally {
    HouseHost.setHost(null);
  }
  assert.deepEqual(readConfig(undefined).host, { enabled: true, name: "Gilded Host" }, "the host is on by default");
  assert.equal(readConfig({ host: { name: "Altar Al" } }).host.name, "Altar Al");
});

test("the Gauntlet is a boss task: the levels for it and Song of the Elves; it travels there, then plays", () => {
  const task = catalogue.get("gauntlet");
  assert.deepEqual([task.group, task.subgroup], ["Combat", "Bosses"]);
  const player = realPlayer();
  const done = (complete) => ({ registry, world: { emitCustomEvent: (name, request) => { if (name === "quest:is-complete") request.complete = complete; } } });
  assert.match(task.check(player, done(true)).reason, /needs 70 Ranged/);
  for (const skill of ["RANGED", "MAGIC", "DEFENCE", "HITPOINTS", "PRAYER", "AGILITY"]) {
    player.getSkillManager().setMaxLevels(core.Skill[skill], 75, false).setCurrentLevel(core.Skill[skill], 75, false);
  }
  assert.match(task.check(player, done(false)).reason, /Song of the Elves/);
  assert.equal(task.check(player, done(true)).ok, true);
  assert.deepEqual(task.build(player, { registry, world: {} }).actions.map((action) => action.id), ["travelTo", "gauntlet"]);
  player.setLocation(new core.Location(3032, 6127, 1));
  assert.deepEqual(task.build(player, { registry, world: {} }).actions.map((action) => action.id), ["gauntlet"], "in the lobby: straight in");
});

test("crowding: a task with many characters on it comes up less, and a full one not at all", () => {
  const wc = { ...fakeTask("normal_trees", "Gathering", "woodcutting"), places: [{ id: "a" }] };
  const mining = { ...fakeTask("copper", "Gathering", "mining"), places: [{ id: "b" }] };
  const levelsEven = levels({ woodcutting: 20, mining: 20 });
  const score = (crowdOf) => Object.fromEntries(scoreTasks({ player: {}, ctx: {}, tasks: [wc, mining], levelOf: levelsEven, crowdOf })
    .map((entry) => [entry.task.id, entry]));
  const quiet = score(() => 0);
  const busy = score((task) => (task.id === "normal_trees" ? 10 : 0));
  assert.ok(busy.normal_trees.score < quiet.normal_trees.score / 2, "ten on it: well under half the weight");
  const full = score((task) => (task.id === "normal_trees" ? 25 : 0));
  assert.deepEqual([full.normal_trees.score, full.normal_trees.reason], [0, "too crowded"]);
});

test("crowding: the agent passes over a full place near it for a quieter one", () => {
  const Crowd = require("../plugins/bots/lib/Crowd.PlayerBots");
  const near = { id: "near_place", name: "Near", x: 3222, y: 3218, z: 0 };
  const far = { id: "far_place", name: "Far", x: 3300, y: 3300, z: 0 };
  const task = { ...fakeTask("normal_trees", "Gathering", "woodcutting"), places: [near, far] };
  const player = { getLocation: () => new Location(3222, 3218, 0), getSkillManager: () => ({ getMaxLevel: () => 1 }), isRegistered: () => true };
  const others = Array.from({ length: 15 }, () => ({ isRegistered: () => true }));
  try {
    const agent = new TaskAgent({ player, catalogue: { tasks: [task], get: () => task }, registry, world: {}, taskId: "normal_trees" });
    assert.deepEqual(agent.placeFor(task), { place: near, travel: false }, "an open place near it: stays");
    for (const other of others) Crowd.note(other, "anything", "near_place");
    assert.deepEqual(agent.placeFor(task), { place: far, travel: true }, "full: off to the other");
  } finally {
    for (const other of others) Crowd.forget(other);
  }
});
