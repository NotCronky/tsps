# TSPS bots (RuneLite plugins)

One jar, `tsps-bots.jar`, with three plugins (RuneLite gives each sideloaded jar its own class
loader, so plugins that share the fake mouse ship together):

- **TSPS Fake Mouse:** a mouse the bot plugins drive. While one holds it, the game ignores the
  real mouse (a first-in-line mouse listener swallows real events), a cursor shows where the bot's
  mouse is, and Escape gives control back. It glides on a slightly curved, eased path and clicks
  when it arrives. Points are scaled for stretched mode.
- **TSPS Farm Run** (below).
- **TSPS Agility:** runs agility courses; it holds the fake mouse while running and points it at
  each obstacle. Its source came from `~/tsps-agility-plugin`.

## TSPS Farm Run

A sideloaded RuneLite plugin for the TSPS server only: it refuses to act on any other server
(official worlds are 301 and up; TSPS's gateway serves world 1, listed as `tsps`).

- **Timers:** the side panel shows each patch's crop and when it's ready. A notification fires
  when the herbs are ready.
- **Runs:** **Start run**, or on its own at login when nothing is planted (setting). Start
  anywhere: with everything already in the inventory it goes straight to the patches; otherwise
  it reaches the Grand Exchange by Varrock teleport tablet or by casting Varrock Teleport. Each run
  keeps a Varrock teleport tablet in the inventory for the next one. It banks, buys what's missing on the
  GE (price +10% so offers fill in seconds), then for Falador, Catherby, Ardougne, Morytania and
  Hosidius: teleports (Explorer's ring / Ardougne cloak if you own one, else the teletab), walks
  to the patches, rakes, clears dead crops, harvests, composts, plants the highest-level herb,
  flower and allotment seeds your Farming level allows (composting with your filled bottomless
  compost bucket when it's in your bank or inventory, otherwise compost buckets), drops weeds and notes produce on the
  tool leprechaun. **Stop** ends it at any point.

It plays through the real interfaces, like a player: menu actions for objects, NPCs, items and
widgets, typing and clicking the GE search, and walking with the fake mouse: the client's "Walk
here" goes to the tile under the mouse, so it hovers the next waypoint, checks the client reports
that tile, then walks. Each run logs to `~/.rlcustom/tsps-farm-run.log`.

## Data

`src/main/resources/com/tsps/farmrun/farm-run-data.json` is generated from the server, never
edited: patch states and crops (the farming plugin), teleport landings, and walking waypoints
planned over the server's collision with the agent travel planner. Regenerate after the server
changes (build the server first):

```bash
node tools/runelite-bots/scripts/generate-data.cjs
```

## Build and install

```bash
cd tools/runelite-bots
./gradlew test installPlugin
```

`installPlugin` copies `tsps-bots.jar` to `~/.rlcustom/sideloaded-plugins`, where the
RSProx-launched RuneLite loads sideloaded plugins. Restart the client to load it.
