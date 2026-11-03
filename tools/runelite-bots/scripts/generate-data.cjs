// Generates the plugin's game data from the server's own sources, so the plugin never drifts
// from what the server does:
//  - farm-run-data.json: patch states and growth timing (server/plugins/skills/data/farming-data.json),
//    crop levels (server/plugins/skills/farming/Data.Farming.js rows), teleport landings and the
//    walking waypoints from each landing to its patches, planned with the agent travel planner
//    (server/plugins/agent/mcp/TravelRoutes.AgentMcp.js) over the server's collision maps.
// Run from the repository root after the server is built: node tools/runelite-bots/scripts/generate-data.cjs
const fs = require("fs");
const path = require("path");
const server = path.resolve(__dirname, "../../../server");
const out = path.resolve(__dirname, "../src/main/resources/com/tsps/farmrun/farm-run-data.json");
process.chdir(server);
const d = (p) => require(path.join(server, "dist", p));
const quiet = () => { console.log = console.info = console.debug = console.warn = () => {}; };
const log = console.log.bind(console);

// Where each run step starts and ends. Landings are where a teleport puts you (standard teleports
// land within 2 tiles); targets are a walkable tile beside the patches.
const LOCATIONS = [
  { key: "falador", name: "Falador", target: [3056, 3309, 0], leprechaun: true,
    teleports: [{ kind: "item-op", items: ["Explorer's ring 2", "Explorer's ring 3", "Explorer's ring 4"], option: "Teleport", landing: [3052, 3291, 0] },
                { kind: "tablet", item: "Falador teleport", option: "Break", spell: "Falador teleport" }] },
  { key: "catherby", name: "Catherby", target: [2810, 3463, 0], leprechaun: true,
    teleports: [{ kind: "tablet", item: "Camelot teleport", option: "Break", spell: "Camelot teleport" }] },
  { key: "ardougne", name: "Ardougne", target: [2667, 3375, 0], leprechaun: true,
    teleports: [{ kind: "item-op", items: ["Ardougne cloak 2", "Ardougne cloak 3", "Ardougne cloak 4"], option: "Farm Teleport", landing: [2665, 3375, 0] },
                { kind: "tablet", item: "Ardougne teleport", option: "Break", spell: "Ardougne teleport" }] },
  { key: "morytania", name: "Morytania", target: [3602, 3527, 0], leprechaun: true,
    teleports: [{ kind: "tablet", item: "Fenkenstrain's castle teleport", option: "Break", spell: "Fenkenstrain's Castle Teleport" }] },
  { key: "hosidius", name: "Hosidius", target: [1736, 3552, 0], leprechaun: true,
    teleports: [{ kind: "tablet", item: "Hosidius teleport", option: "Break", landing: [1743, 3517, 0] }] },
];
const GRAND_EXCHANGE = { target: [3164, 3487, 0],
  teleports: [{ kind: "tablet", item: "Varrock teleport", option: "Break", spell: "Varrock teleport" }] };
// Supplies a run carries, by their in-game names.
const SUPPLIES = ["Coins", "Rake", "Seed dibber", "Spade", "Compost", "Supercompost", "Ultracompost", "Bucket", "Weeds", "Varrock teleport"];
const PATCH_TYPES = new Set(["HERB", "ALLOTMENT", "FLOWER"]);
const WAYPOINT_STEP = 9;

(async () => {
  quiet();
  require(path.join(server, "dist/Server")).Server.installProductionPathResolver();
  await d("game/cache/CachePipeline").CachePipeline.initialize(server);
  const { PluginManager } = d("plugins/PluginManager");
  PluginManager.loadFromDirectory(path.join(server, "plugins"));
  const core = PluginManager.getCoreApi();
  core.RegionManager.init();
  const { CacheDefinitions } = core;
  const { ItemDefinition } = d("game/definition/ItemDefinition");
  const { planTravel, BLOCKED } = require(path.join(server, "plugins/agent/mcp/TravelRoutes.AgentMcp"));
  const farming = JSON.parse(fs.readFileSync(path.join(server, "plugins/skills/data/farming-data.json"), "utf8"));

  const loaded = new Map();
  const getFlag = (x, y, z) => {
    const region = (x >> 6) * 256 + (y >> 6);
    if (!loaded.has(region)) {
      try { core.RegionManager.loadMapFiles(x, y, false); } catch {}
      loaded.set(region, core.RegionManager.getRegion(x, y) !== undefined);
    }
    return loaded.get(region) ? core.RegionManager.getClipping(x, y, z, null) : BLOCKED;
  };
  const spells = new Map([
    ...core.SpellTeleports.getTeleportDestinations(), ...core.LunarSpells.getTeleportDestinations(),
    ...core.ArceuusSpells.getTeleportDestinations(),
  ].map((spell) => [spell.name.toLowerCase(), spell.destination]));
  const Data = require(path.join(server, "plugins/skills/farming/Data.Farming.js"));
  Data.initializeFarmingData();
  const itemId = (name) => Data.itemId(name);
  const landingOf = (teleport) => {
    if (teleport.landing) return teleport.landing;
    const at = spells.get(teleport.spell.toLowerCase());
    if (!at) throw new Error(`unknown spell ${teleport.spell}`);
    return [at.getX(), at.getY(), at.getZ()];
  };
  const failures = [];
  const route = (label, from, to) => {
    const planned = planTravel({ from: { x: from[0], y: from[1], z: from[2] }, to: { x: to[0], y: to[1], z: to[2] }, getFlag, transportsAt: () => [] });
    if (!planned) { failures.push(label); return null; }
    const tiles = planned.steps.map((s) => [s.x, s.y, s.z]);
    const waypoints = tiles.filter((_, i) => i > 0 && (i % WAYPOINT_STEP === 0 || i === tiles.length - 1));
    return { from, steps: tiles.length - 1, waypoints };
  };
  const teleportsFor = (label, teleports, target) => teleports.map((t) => {
    const landing = landingOf(t);
    const base = { kind: t.kind, option: t.option, landing, route: route(`${label} via ${t.spell ?? t.items?.[0] ?? t.item}`, landing, target) };
    const items = (t.items ?? [t.item]).map(itemId);
    // The GE only trades tradeable items (the Hosidius tablet is a redirected house tab, untradeable).
    const buyable = items.every((id) => ItemDefinition.forId(id).isTradeable());
    return { ...base, items, buyable };
  });

  const locations = LOCATIONS.map((location) => {
    const [tx, ty] = location.target;
    const patches = farming.patches
      .filter((p) => PATCH_TYPES.has(p.type) && Math.abs(p.x - tx) < 12 && Math.abs(p.y - ty) < 12)
      .map((p) => ({ type: p.type, objectId: p.id, varbit: p.varbit, tile: [p.x, p.y, p.z] }));
    return { key: location.key, name: location.name, target: location.target, patches,
      teleports: teleportsFor(location.name, location.teleports, location.target) };
  });
  const grandExchange = { target: GRAND_EXCHANGE.target, teleports: teleportsFor("Grand Exchange", GRAND_EXCHANGE.teleports, GRAND_EXCHANGE.target) };

  // The crops a run plants, as the server's farming plugin defines them (Data.Farming.js).
  const crops = [...Data.CROPS.values()].filter((c) => PATCH_TYPES.has(c.type))
    .map((c) => ({ key: c.key, name: c.name, type: c.type, level: c.level, seedId: c.seed, seedCount: c.seedCount,
      produceId: c.produce, minutesPerStage: c.minutes, stages: c.stages }));
  // "Coins" also names an old unused item; the bank and GE use ItemIdentifiers.COINS.
  const supplies = Object.fromEntries(SUPPLIES.map((name) => [name, name === "Coins" ? core.ItemIdentifiers.COINS : itemId(name)]));
  // Both forms are named "Bottomless compost bucket"; the server turns the filled one (with
  // compost) into the empty one when its last charge is used (Services.Farming.js).
  supplies["Bottomless compost bucket (filled)"] = core.ItemIdentifiers.BOTTOMLESS_COMPOST_BUCKET_4;
  supplies["Bottomless compost bucket (empty)"] = core.ItemIdentifiers.BOTTOMLESS_COMPOST_BUCKET;
  const states = Object.fromEntries([...PATCH_TYPES].map((type) => [type, farming.states[type]]));
  const data = { source: "generated by tools/farm-run-plugin/scripts/generate-data.cjs from the server's data", grandExchange, locations, crops, supplies, states };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data, null, 1) + "\n");
  console.log = log;
  for (const l of [grandExchange, ...locations]) for (const t of l.teleports) log(`${l.name ?? "GE"} ${t.option} -> ${t.route ? t.route.steps + " steps, " + t.route.waypoints.length + " waypoints" : "NO ROUTE"}`);
  for (const l of locations) log(l.name, l.patches.map((p) => p.type).join(","));
  log("crops", crops.length, "failures", failures);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log = log; log(e); process.exit(1); });
