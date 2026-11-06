# Player bots

Bots that play like people: saved accounts that log in and out, train what their levels allow,
and earn everything they own. The same brain can play any player's own character in bot mode.

Code: `server/plugins/bots/`. Tests: `server/tests/bot-agent.test.cjs`, `bot-brain.test.cjs`.

## How a character decides what to do

- **Tasks** (`tasks/`) are what a character can be doing, each with its own level, tool and
  places; every material and product is its own task, so a skill has as many tasks as it has
  things to train on (542 in all; each one is listed under Tasks by skill, below):
  - **Gathering:** each tier (Woodcutting: trees ... magic; Mining: copper and tin ... runite;
    Fishing by main fish: shrimps ... sharks), from `server/data/definitions/bot-activities.json`,
    so a tier added there is a task; its places go in `data/task-places.json` under its activity id.
  - **Processing** (what's banked): Firemaking per log and Wintertodt, Cooking per raw food,
    Smithing (smelting per bar, anvil smithing per metal, making the best item the level allows),
    and from the skill plugins' own recipe data (`plugins/skills/data/`): Fletching (each log's
    shafts, bows, stocks and shields, each crossbow's stock on its limbs with a hammer held,
    stringing each bow and crossbow, arrows, darts, bolts, gem-tipped bolts),
    Herblore (cleaning each herb, each unfinished and finished potion), Crafting (each gem, each
    leather and dragonhide piece, glassblowing, battlestaves; at a station, each gold and silver
    jewellery piece at a furnace, each spun product at a wheel, each woven one at Falador farm's
    loom, and pottery shaped at a potter's wheel then fired) and Prayer (burying each bone). A recipe added to that data is a task.
    Magic: Low and High Level Alchemy (on the most valuable spare products it has banked),
    Superheat Item per bar, and Enchanting per piece of jewellery (the enchanting plugin's own
    table, `magic:enchant-recipes`), with its own runes, banked or bought.
    Runecraft: a task per altar it can walk to (air, mind, water, earth, fire, body): its banked
    essence (rune, else pure) and talisman (or tiara, worn) out of the bank, its essence pouches
    (those its level opens) filled there and the inventory topped up, then the ruins, the altar
    (each pouch emptied for a second Craft-rune), out through the portal and back to the bank
    for the next load, all through the Runecrafting plugin.
  - **Activities:** Agility (the Gnome Stronghold, the Barbarian Outpost and every rooftop,
    Draynor to Ardougne; Canifis needs Priest in Peril and Prifddinas Song of the Elves) and Thieving (each pickpocket
    target, and each stall: Varrock's tea stall and Ardougne market's baker's, silk, fur, silver,
    spice and gem stalls), and Hunter: bird snaring, a task per bird (crimson swifts, golden
    warblers, copper longtails, cerulean twitches, tropical wagtails) at its busiest spawns (from
    `npc-spawns.json`), with the snares its level lets it lay, owned or bought; it lays them on
    free tiles, checks catches, dismantles failed traps, picks up fallen ones, keeps the feathers
    and drops the bones and meat. Farming: a herb run round the patches it can walk to
    (Falador, Catherby, Ardougne), with its rake, seed dibber and spade (owned or bought) and the
    best herb seeds it has banked: each patch picked when grown, cleared when dead, raked and
    planted. It's on offer only while a patch is ready, so it comes back once the herbs have
    grown (in a test, three patches planted, then 100 minutes later picked, 11 ranarr banked, and
    replanted).
  - **Combat:** training, Slayer, and the bosses (the Gauntlet and the Corrupted Gauntlet, below).
    Slayer: a task from the best master its combat opens that it can walk to (Nieve at 85,
    Vannaka in Edgeville Dungeon at 40, Mazchna in Canifis at 20 with Priest in Peril, else Turael
    or Spria, whichever is nearer; reached as it travels anywhere, a fairy ring to Canifis
    included), through the master's own Assignment
    option; the task's monsters fought with combat training's gear and food (only the NPCs the
    task counts, wherever they are: over ground or down a dungeon); back for the next when it's
    done. Before each fight its kit, from the Slayer plugin's data: the protection the monsters
    call for worn (earmuffs, a nose peg, a facemask, a mirror shield, a spiny helmet; combat
    training's own gear doesn't replace it), and the finishing item carried (a rock hammer, a bag
    of salt or ice cooler a kill, a fungicide spray), used on a monster waiting at 0 hitpoints;
    owned, else bought at a Slayer master's shop. A task none of whose monsters it can get to
    (behind a quest, a key, a boat), or whose kit it can't get, it takes to Turael, who swaps
    another master's task for one of his, as players do (his offer's "Yes, please.", a chatbox
    prompt it answers as a click); one of his own it leaves for half an hour, with that reason.
    In a test, a Vannaka task of shades became Turael's zombies. In test runs it did
    birds, spiders and bears for Spria, and 65 hobgoblins for Vannaka; how many of a master's
    tasks it can reach from the master: Spria 15 of 25, Vannaka 14 of 46, Nieve 10 of 46.

  Each says what it needs (`check`: levels, a tool owned or affordable, materials in the bank) and
  builds the activity that does it from the actions in `brain/actions/` (`build`).
- **The brain** (`agent/Brain.PlayerBots.js`) scores every task the character can do right now
  and draws one by score:
  - its profile: a skiller avoids fighting, a fighter prefers it, a focus skill comes up three times
    as often;
  - its levels: skills behind the rest come up more, as players even their stats out;
  - variety: what it just did comes up less;
  - a skill's open tiers share that skill's weight, each tier up twice as likely as the one below,
    so a miner mostly mines the best ore it can without Mining crowding out other skills;
  - processing what it banked is worth a little more.
- **The agent** (`agent/Agent.PlayerBots.js`) runs the chosen task:
  - it takes the character to the nearest of the task's places first (`data/task-places.json`).
    More than 60 tiles away, it teleports when that gets it at least 40 tiles nearer, then walks
    the rest (`brain/actions/TravelTo.PlayerBots.js`). The teleports come from the plugins that own
    them, through `teleport:options` ({ player, options }): spellbook teleports it has the
    spellbook, level and carried runes for (standard, Ancient, Lunar, Arceuus), teleport tablets
    and charged jewellery it carries or wears, its home teleport, the minigame teleports off
    cooldown, and the fairy rings (FairyRings: with a dramen or lunar staff, wielded on the way,
    and Fairytale II's permission): every ring's destination from the nearest ring it can walk to
    (one on a swamp island it can't), which it walks to first (an option's `via`, the walk counted
    in its cost), then Configure, the code and Confirm through the plugin's own dials. In a test,
    Draynor to the Canifis rooftop by the Lumbridge Swamp ring took 242 ticks. The one landing nearest wins, with a small cost for what it uses up. Each is used
    through its plugin's own code, so runes, charges, tablets, XP, cooldowns and Wilderness limits apply.
    Banked teleports count too: when one in the bank (runes for a spell, a tablet, jewellery) lands at
    least 40 tiles nearer than anything carried, it stops at a bank for it first, once a trip;
  - it runs the task for 15-45 minutes, then asks the brain again;
  - a task that ends within a minute (no tool it can get, out of materials) rests for 5 minutes.
- **The executor** (`brain/Brain.PlayerBots.js`) carries out the activity one action a tick:
  walking, doors, stairs, shortcuts, banking, gathering. The skill actions go through the
  plugins' own code, as a player's clicks do:
  - `make`: one item used on another, and the product picked in the make menu (Fletching,
    Herblore, Crafting);
  - `clickItem`: an item's own option (burying bones, cleaning herbs);
  - `station`: a crafting station worked till the material's gone - its option clicked or an item
    used on it, and the make menu (or a plugin's bot entry: `crafting:furnace-make` for jewellery)
    answered;
  - `castOnItem`: a spell on inventory items (alchemy through the core, superheat and enchanting
    through their plugins' spell-on-item hooks);
  - `craftRunes`: into the ruins (talisman on them, or Enter in the tiara), Craft-rune, the
    pouches emptied and Craft-rune again, out by the portal; `fillPouches`: Fill on each empty
    pouch (Fill on a full one would empty it);
  - `tendPatch`: one farming patch through the Farming plugin's options (it shows the patch as
    that one first: the herb patches share a varbit), waiting out each rake or pick (`isWorking`);
  - `huntTraps`: traps laid near where it started, checked, reset and picked up;
    `slayerAssignment`: a master's Assignment; `trainCombat` with `targets`: a set of NPCs (a
    Slayer task's) in place of a level band;
  - `smithAnvil`: bars at an anvil, through the Smithing plugin's bot entry (`startBotSmithing`);
  - `runCourse`: the lap's next obstacle, from the Agility plugin (`agility:course-next`, which
    names an obstacle's tile when several share an id, as the Barbarian Outpost's walls do); in
    through a course's entrance first when it's behind one (the Barbarian Outpost's pipe), down a
    ladder that isn't an obstacle (off its ledge), and every mark of grace of its own that it can
    walk to (or beside) picked up on the way. In test laps it picked up every mark that spawned;
  - `pickpocket`: the Thieving plugin's Pickpocket option; it eats its own food when hurt and
    opens its coin pouches.

## Tasks by skill

Every task a character can be given (542 in all), by skill, with the level each needs.
Listed from the task catalogue (`tasks/Catalogue.PlayerBots.js`); a recipe or tier added to a skill's
data becomes a task, and shows up here when the list is made again.

### Woodcutting (6)

Each tier at its trees, the logs banked, burnt or dropped.

- Trees 1, Oak trees 15, Willow trees 30, Maple trees 45, Yew trees 60, Magic trees 75

### Mining (8)

Each ore at its rocks.

- Copper and tin 1, Iron 15, Silver 20, Coal 30, Gold 40, Mithril 55, Adamantite 70, Runite 85

### Fishing (8)

By main catch, with the net, rod, harpoon or pot its level allows.

- Shrimps and anchovies 1, Sardines and herring 5, Mackerel, cod and bass 16, Trout and salmon 20, Pike 25, Tuna and swordfish 35, Lobsters 40, Sharks 76

### Firemaking (10)

Each log at a bank, and Wintertodt (its kit, the camp, rounds through the Wintertodt plugin).

- Logs 1, Oak logs 15, Willow logs 30, Teak logs 35, Maple logs 45, Mahogany logs 50, Yew logs 60, Magic logs 75, Redwood logs 90, Wintertodt 50

### Cooking (43)

Each raw food from the bank, on a range.

- Beef 1, Rat meat 1, Chicken 1, Rabbit 1, Shrimps 1, Anchovies 1, Sardine 1, Ugthanki meat 1, Herring 5, Guppy 7, Mackerel 10, T-bone steak 13, Trout 15, Cod 18, Pike 20, Cavefish 20, Red crab meat 21, Salmon 25, Tuna 30, Chompy 30, Tetra 33, Cave eel 38, Lobster 40, Bass 43, Swordfish 45, Catfish 46, Blue crab meat 48, Lava eel 53, Swordtip squid 56, Monkfish 62, Giant krill 69, Jumbo squid 71, Haddock 73, Rainbow crab meat 77, Yellowfin 79, Shark 80, Sea turtle 82, Halibut 83, Anglerfish 84, Bluefin 87, Dark crab 90, Manta ray 91, Marlin 91

### Smithing (16)

Bars at a furnace; at Varrock's anvil, the best item the level allows of each metal.

- **Smelting:** Bronze bars 1, Iron bars 15, Silver bars 20, Lead bars 25, Steel bars 30, Gold bars 40, Mithril bars 50, Adamantite bars 70, Cupronickel bars 74, Runite bars 85
- **Anvil:** Bronze items 1, Iron items 15, Steel items 30, Mithril items 50, Adamant items 70, Rune items 85

### Fletching (115)

From the Fletching plugin's recipes, at a bank.

- **Logs:** Arrow shafts (logs) 1, Javelin shaft 3, Shortbow (u) 5, Longbow (u) 10, Wooden stock 9
- **Oak logs:** Arrow shafts (oak logs) 15, Oak shortbow (u) 20, Oak longbow (u) 25, Oak stock 24, Oak shield 27
- **Willow logs:** Arrow shafts (willow logs) 30, Willow shortbow (u) 35, Willow longbow (u) 40, Willow stock 39, Willow shield 42
- **Teak logs:** Teak stock 46
- **Maple logs:** Arrow shafts (maple logs) 45, Maple shortbow (u) 50, Maple longbow (u) 55, Maple stock 54, Maple shield 57
- **Mahogany logs:** Mahogany stock 61
- **Yew logs:** Arrow shafts (yew logs) 60, Yew shortbow (u) 65, Yew longbow (u) 70, Yew stock 69, Yew shield 72
- **Magic logs:** Arrow shafts (magic logs) 75, Magic shortbow (u) 80, Magic longbow (u) 85, Magic stock 78, Magic shield 87
- **Redwood logs:** Arrow shafts (redwood logs) 90, Redwood shield 92, Redwood hiking staff 90
- **Celastrus bark:** Battlestaff 40
- **Ent branch:** Atlatl dart shaft 74
- **Stringing bows:** Shortbow 5, Longbow 10, Oak shortbow 20, Oak longbow 25, Willow shortbow 35, Willow longbow 40, Maple shortbow 50, Maple longbow 55, Yew shortbow 65, Yew longbow 70, Magic shortbow 80, Magic longbow 85, Bronze crossbow 9, Blurite crossbow 24, Iron crossbow 39, Steel crossbow 46, Mithril crossbow 54, Adamant crossbow 61, Rune crossbow 69, Dragon crossbow 78
- **Crossbows:** Bronze crossbow (u) 9, Blurite crossbow (u) 24, Iron crossbow (u) 39, Steel crossbow (u) 46, Mithril crossbow (u) 54, Adamant crossbow (u) 61, Runite crossbow (u) 69, Dragon crossbow (u) 78
- **Arrows:** Headless arrow 1, Bronze arrow 1, Iron arrow 15, Steel arrow 30, Mithril arrow 45, Broad arrows 52, Adamant arrow 60, Rune arrow 75, Amethyst arrow 82, Dragon arrow 90
- **Darts:** Bronze dart 10, Iron dart 22, Steel dart 37, Mithril dart 52, Adamant dart 67, Rune dart 81, Amethyst dart 90, Dragon dart 95
- **Bolts:** Bronze bolts 9, Blurite bolts 24, Iron bolts 39, Silver bolts 43, Steel bolts 46, Mithril bolts 54, Broad bolts 55, Adamant bolts 61, Runite bolts 69, Dragon bolts 84
- **Gem-tipped bolts:** Opal bolts 11, Jade bolts 26, Pearl bolts 41, Topaz bolts 48, Barbed bolts 51, Sapphire bolts 56, Emerald bolts 58, Ruby bolts 63, Diamond bolts 65, Dragonstone bolts 71, Onyx bolts 73, Amethyst broad bolts 76, Opal dragon bolts 84, Jade dragon bolts 84, Pearl dragon bolts 84, Topaz dragon bolts 84, Sapphire dragon bolts 84, Emerald dragon bolts 84, Ruby dragon bolts 84, Diamond dragon bolts 84, Dragonstone dragon bolts 84, Onyx dragon bolts 84

### Herblore (80)

From the Herblore plugin's recipes, at a bank (Druidic Ritual comes with the starting kit).

- **Cleaning herbs:** Guam leaf 3, Marrentill 5, Tarromin 11, Harralander 20, Ranarr weed 25, Toadflax 30, Irit leaf 40, Avantoe 48, Kwuarm 54, Huasca 58, Snapdragon 59, Cadantine 65, Lantadyme 67, Dwarf weed 70, Torstol 75
- **Potions:** Attack potion(3) 3, Antipoison(3) 5, Strength potion(3) 12, Restore potion(3) 22, Compost potion(3) 22, Energy potion(3) 26, Defence potion(3) 30, Agility potion(3) 34, Combat potion(3) 36, Prayer potion(3) 38, Super attack(3) 45, Superantipoison(3) 48, Fishing potion(3) 50, Super energy(3) 52, Hunter potion(3) 53, Goading potion(3) 54, Super strength(3) 55, Haemostatic dressing (3) 56, Haemostatic poultice 56, Prayer regeneration potion(3) 58, Weapon poison 60, Super fishing potion(3) 62, Super restore(3) 63, Super defence(3) 66, Super hunter potion(3) 67, Antidote+(4) 68, Antifire potion(3) 69, Ranging potion(3) 72, Weapon poison(+) 73, Magic potion(3) 76, Zamorak brew(3) 78, Antidote++(4) 79, Bastion potion(3) 80, Battlemage potion(3) 80, Saradomin brew(3) 81, Surge potion(3) 81, Weapon poison(++) 82, Ancient brew(3) 85, Menaphite remedy(3) 88, Armadyl brew(3) 89, Anti-venom+(4) 94, Extended anti-venom+(1) 94
- **Unfinished potions:** Guam potion (unf) 3, Marrentill potion (unf) 5, Tarromin potion (unf) 12, Harralander potion (unf) 22, Ranarr potion (unf) 30, Toadflax potion (unf) 34, Irit potion (unf) 45, Avantoe potion (unf) 50, Kwuarm potion (unf) 55, Elkhorn potion (unf) 56, Huasca potion (unf) 58, Pillar potion (unf) 62, Snapdragon potion (unf) 63, Cadantine potion (unf) 66, Antidote+ (unf) 68, Lantadyme potion (unf) 69, Dwarf weed potion (unf) 72, Weapon poison+ (unf) 73, Torstol potion (unf) 78, Antidote++ (unf) 79, Cadantine blood potion (unf) 80, Weapon poison++ (unf) 82, Umbral potion (unf) 89

### Crafting (127)

From the Crafting plugin's data: at a bank, a furnace, the Barbarian Village wheels and oven, or Falador farm's loom.

- **Gem cutting:** Opal 1, Jade 13, Red topaz 16, Sapphire 20, Emerald 27, Ruby 34, Diamond 43, Dragonstone 55, Onyx 67, Zenyte 89
- **Leather:** Leather gloves 1, Leather boots 7, Leather cowl 9, Leather vambraces 11, Leather body 14, Leather chaps 18, Coif 38
- **Hard leather:** Hardleather body 28
- **Green dragon leather:** Green d'hide body 63, Green d'hide vambraces 57, Green d'hide chaps 60
- **Blue dragon leather:** Blue d'hide body 71, Blue d'hide vambraces 66, Blue d'hide chaps 68
- **Red dragon leather:** Red d'hide body 77, Red d'hide vambraces 73, Red d'hide chaps 75
- **Black dragon leather:** Black d'hide body 84, Black d'hide vambraces 79, Black d'hide chaps 82
- **Snakeskin:** Snakeskin boots 45, Snakeskin vambraces 47, Snakeskin bandana 48, Snakeskin chaps 51, Snakeskin body 53
- **Xerician fabric:** Xerician hat 14, Xerician robe 17, Xerician top 22
- **Hueycoatl hide:** Hueycoatl hide vambraces 76, Hueycoatl hide coif 76, Hueycoatl hide chaps 77, Hueycoatl hide body 78
- **Glassblowing:** Beer glass 1, Empty candle lantern 4, Empty oil lamp 12, Vial 33, Empty fishbowl 42, Unpowered orb 46, Lantern lens 49, Empty light orb 87
- **Battlestaves:** Water battlestaff 54, Earth battlestaff 58, Fire battlestaff 62, Air battlestaff 66
- **Gold jewellery:** Gold ring 5, Sapphire ring 20, Emerald ring 27, Ruby ring 34, Diamond ring 43, Dragonstone ring 55, Onyx ring 67, Zenyte ring 89, Gold necklace 6, Sapphire necklace 22, Emerald necklace 29, Ruby necklace 40, Diamond necklace 56, Dragon necklace 72, Onyx necklace 82, Zenyte necklace 92, Gold amulet (u) 8, Sapphire amulet (u) 24, Emerald amulet (u) 31, Ruby amulet (u) 50, Diamond amulet (u) 70, Dragonstone amulet (u) 80, Onyx amulet (u) 90, Zenyte amulet (u) 98, Gold bracelet 2 7, Sapphire bracelet 2 23, Emerald bracelet 30, Ruby bracelet 42, Diamond bracelet 58, Dragonstone bracelet 74, Onyx bracelet 84, Zenyte bracelet 2 95
- **Silver:** Opal ring 1, Jade ring 13, Topaz ring 16, Opal necklace 16, Jade necklace 25, Topaz necklace 32, Opal amulet (u) 27, Jade amulet (u) 34, Topaz amulet (u) 45, Opal bracelet 22, Jade bracelet 29, Topaz bracelet 38, Unstrung symbol 16, Unstrung emblem 17, Silver sickle 18, Conductor 20, Silver bolts unf 21, Tiara 23, Silvthrill rod 2 25, Demonic sigil 30
- **Spinning:** Ball of wool 1, Linen yarn 12, Bow string 10, Crossbow string 10, Magic string 19, Rope 30, Hemp yarn 39, Cotton yarn 73
- **Weaving:** Strip of cloth 10, Bolt of linen 12, Empty sack 21, Drift net 26, Basket 36, Bolt of canvas 39, Bolt of cotton 73
- **Pottery:** Pot 1, Pie dish 7, Bowl 8, Empty plant pot 19, Empty cup 3, Pot lid 25

### Prayer (32)

Each bone buried, or offered at the house host's gilded altar while the host is hosting (no level needed, but superior dragon bones' 70).

- **Burying:** Bones, Wolf bones, Bat bones, Big bones, Wyrmling bones, Babydragon bones, Wyrm bones, Strykewyrm bones, Dragon bones, Wyvern bones, Drake bones, Lava dragon bones, Frost dragon bones, Hydra bones, Dagannoth bones, Superior dragon bones 70
- **Gilded altar:** Bones, Wolf bones, Bat bones, Big bones, Wyrmling bones, Babydragon bones, Wyrm bones, Strykewyrm bones, Dragon bones, Wyvern bones, Drake bones, Lava dragon bones, Frost dragon bones, Hydra bones, Dagannoth bones, Superior dragon bones 70

### Runecraft (6)

An altar it can walk to, with its essence, talisman or tiara, and pouches.

- Air runes 1, Mind runes 2, Water runes 5, Earth runes 9, Fire runes 14, Body runes 20

### Magic (51)

With its own runes: alchemy on its spare products, Superheat Item per bar (Smithing's levels apply), each jewellery enchantment.

- **Alchemy:** Low Level Alchemy 21, High Level Alchemy 55
- **Superheat:** Superheat iron bars 43, Superheat silver bars 43, Superheat lead bars 43, Superheat steel bars 43, Superheat gold bars 43, Superheat mithril bars 43, Superheat adamantite bars 43, Superheat cupronickel bars 43, Superheat runite bars 43
- **Enchanting:** Sapphire amulet into amulet of magic 7, Opal amulet into amulet of bounty 7, Sapphire ring into ring of recoil 7, Sapphire necklace into games necklace(8) 7, Sapphire bracelet into bracelet of clay 7, Opal ring into ring of pursuit 7, Opal necklace into dodgy necklace 7, Opal bracelet into expeditious bracelet 7, Emerald amulet into amulet of defence 27, Jade amulet into amulet of chemistry 27, Jade bracelet into flamtaer bracelet 27, Emerald ring into ring of dueling(8) 27, Emerald necklace into binding necklace 27, Emerald bracelet into castle wars bracelet(3) 27, Jade ring into ring of returning(5) 27, Jade necklace into necklace of passage(5) 27, Ruby amulet into amulet of strength 49, Ruby necklace into digsite pendant (5) 49, Topaz amulet into burning amulet(5) 49, Ruby ring into ring of forging 49, Ruby bracelet into inoculation bracelet 49, Topaz ring into efaritay's aid 49, Topaz necklace into necklace of faith 49, Topaz bracelet into bracelet of slaughter 49, Diamond amulet into amulet of power 57, Diamond ring into ring of life 57, Diamond necklace into phoenix necklace 57, Diamond bracelet into abyssal bracelet(5) 57, Dragonstone amulet into amulet of glory 68, Dragonstone ring into ring of wealth 68, Dragon necklace into skills necklace 68, Dragonstone bracelet into combat bracelet 68, Onyx amulet into amulet of fury 87, Onyx ring into ring of stone 87, Onyx necklace into berserker necklace 87, Onyx bracelet into regen bracelet 87, Zenyte amulet into amulet of torture 93, Zenyte ring into ring of suffering 93, Zenyte necklace into necklace of anguish 93, Zenyte bracelet into tormented bracelet 93

### Agility (12)

Every course, marks of grace picked up; Canifis needs Priest in Peril (fairy ring CKS gets it there), Prifddinas Song of the Elves.

- Gnome Stronghold 1, Draynor Village Rooftop 10, Al Kharid Rooftop 20, Varrock Rooftop 30, Barbarian Outpost 35, Canifis Rooftop 40, Falador Rooftop 50, Seers' Village Rooftop 60, Pollnivneach Rooftop 70, Rellekka Rooftop 80, Prifddinas Agility Course 75, Ardougne Rooftop 90

### Thieving (17)

Each pickpocket target where it spawns (food along for hard hitters), each stall.

- **Pickpocketing:** Men and women 1, Farmers 10, Warriors 25, Rogues 32, Master farmers 38, Guards 40, Wealthy citizens 50, Knights of Ardougne 55, Paladins 70, Heroes 80
- **Stalls:** Tea stall 5, Baker's stall 5, Silk stall 20, Fur stall 35, Silver stall 50, Spice stall 65, Gem stall 75

### Hunter (5)

Bird snaring at each bird's busiest spawns, with the snares its level lets it lay.

- **Bird snaring:** Crimson swifts 1, Golden warblers 5, Copper longtails 9, Cerulean twitches 11, Tropical wagtails 19

### Farming (1)

Falador, Catherby and Ardougne's herb patches, on offer while one of them is ready.

- Herb run 9

### Slayer (1)

A task from Nieve (85 combat), Vannaka (40), Mazchna (20, Priest in Peril) or Turael and Spria; its kit; Turael swaps one it can't do.

- Slayer tasks

### Combat (1)

Monsters suited to its combat level, with its own gear, food and runes.

- Combat training

### Bosses (2)

Through the Gauntlet plugin's own play.

- The Corrupted Gauntlet 80, The Gauntlet 70

### Quests (1)

A new account's Tutorial Island (the Gielinor Guide's skip, for now).

- Tutorial Island

Construction has no task of its own yet: the house host (below) builds and keeps the party house.

## Where make tasks happen

Tasks that make something at a bank use `banking` in `data/task-places.json`; anvil smithing uses
`anvil` (Varrock's). Materials come from the bank; cheap shop consumables (feathers, vials of
water, thread, 50 coins or less) are bought when none are banked. Agility tasks start at their
course; pickpocketing goes where its targets spawn, found from the world's own NPCs. Weaving goes to
`loom` (Falador farm's, banking at Draynor); Runecraft to its altar's ruins.

Walking is kept moving: a queued step the character stands still on for 3 seconds (a door shut
across its walk after it was routed) is dropped, so the walk is routed again and the door opened;
stations and the ruins are reached by the brain's door-opening walk when a door is in the way.
Off its floor, a place counts 20 tiles a floor further for teleports (not out of reach). The
underground (dungeons, cellars, sewers: 6400 tiles north on plane 0) is the layer below the
ground floor: a walk there goes by the ladder or trapdoor nearest the goal's spot above (a closed
trapdoor opened first; one landing over 160 tiles from the goal isn't the way), and back up the
same way; reach checks and the Wilderness ditch go by those too. The ditch is crossed only on a
walk into or out of the Wilderness (a straight line from Taverley to Burthorpe clips its west
end), and on a long planned route a door is judged by the route's next stop, not the far goal. The bank
step waits a few ticks for its booths to load, and a working booth isn't written off for clicks
on earlier trips.

## The house host

One bot never takes a break: the house host (`host` in the population config, on by default,
named "Gilded Host"; `{ "host": { "name": "...", "enabled": false } }` changes or drops it). It
logs in with the population and straight back in if it drops. Its house is ::maxhouse's (one of
every room, the best piece in every space), in Rimmington, open to guests, through the
Construction plugin's `construction:host-house`; the chapel's incense burners are lit for good.

The others train Prayer there, a task per bone (Prayer: Gilded altar) open while the host is
hosting: noted bones and Phials' fee out of the bank, to Rimmington, in through the portal
(`construction:visit-house`), bones on the gilded altar (350% with both burners), out
(`construction:leave-house`), the notes on Phials, "Exchange all", and back in, until the trip's
bones are gone. A real player can join the party too: the host's name at the Rimmington portal.

## Minigames as tasks

- **Wintertodt** is a Firemaking task (50 Firemaking). The character gets its kit (axe,
  tinderbox, knife, hammer, a games necklace for the trip) from what it owns or can
  buy, travels to the camp and plays rounds through the Wintertodt plugin's own play
  (`wintertodt:play`), brewing its own rejuvenation potions inside, until it can't keep warm. The Wintertodt plugin's own crowd plays the same way, and fills the game when
  a real player goes into the prison (`Wintertodt:bots` in the world config sets how many; see
  docs/wintertodt.md). A task character isn't part of that count.
- **The Gauntlet** is a boss task (Combat: Bosses; 70 Ranged, Magic, Defence and Hitpoints,
  43 Prayer, 50 Agility for the crystal armour, and Song of the Elves). The character banks
  everything, travels to the Gauntlet Portal and plays runs through the Gauntlet plugin's own
  play (`gauntlet:play`, `plugins/minigames/gauntlet/Bots.Gauntlet.js`), every station, node and
  barrier clicked with its option. It follows the Wiki's standard strategy (The
  Gauntlet/Strategies), the same in both modes:
  - **run 1:** the "C" of the seven rooms round the start (the boss room is the gap), killing the
    weak monsters and gathering what it needs in each room (monsters or none), till it has a frame
    and 100 shards, has been round, or 250 ticks have gone;
  - **home:** the staff sung and attuned, and the vials;
  - **run 2:** straight out to the rim and a lap of it clockwise, in every room gathering what it
    still needs (fish, the armour's ore, bark and linum, a grym leaf a potion; the vials filled at
    the fishing spots, the potions made as it goes), killing the dark beast and the dragon for the
    bowstring and the orb, and the monsters while it's short of shards or its second frame (after
    a kill it walks to where the monster fell, to meet the drop as it lands). The
    sceptre and each tool go on the floor once done with; a full pack is a trip home (raw fish left
    by the range) and back, unless only a fish is missing. With everything, the teleport crystal home;
  - **the finish** (everything found, or only the time left that the finish needs: getting home,
    cooking, singing and potions estimated, with a margin): whatever it's doing is dropped, then the
    bow sung and attuned, both weapons perfected, the armour, the potions, the tools and leftovers
    dropped, the fish cooked, all worn; then through the barrier;
  - **the Hunllef:** auto-prayer (`combat:autopray-set`) keeps the right protection up, and only
    at the Hunllef the weapon's offensive prayer (dropped with no Egniol left and prayer low). The
    5:1 method: five attacks with the main weapon, then the sixth with the other while it protects
    against melee, or an unarmed kick while it protects against the other, so it never protects
    against the main one. The main weapon is the staff (on this server it hits about 16% harder
    than the bow), the bow if it's the higher tier; the bow on Rapid. It keeps off the lit tiles,
    out of the corners and from under the Hunllef, dodging without dropping its target (eating
    doesn't stop a dodge); the floor and the Hunllef's body cost it most (they hurt every tick), a
    tornado nearby much less (it hits only the tile it reaches), so it walks past tornadoes rather
    than stand on the floor, and with no tile clear takes the least bad; it eats below half health
    and drinks an Egniol when prayer runs low. A death in a run doesn't end bot mode: the run's own
    death handling puts it back in the lobby, for the chest and the next run;
  - **not the Wiki's:** Vengeance and Redemption (a bot has neither); no restart when the Hunllef
    starts on Protect from Missiles (the other weapon turns it); the staff as the main weapon; the
    bear's spike isn't crushed for shards (the server doesn't have that); the final phase's safe
    tiles (they lie against the Hunllef, where the tornadoes corner it: in test runs they cost more
    than the floor they save).

  In test runs with IronCronky's levels (90-96 combat, 85 Prayer) it completed 100% (32 of 32),
  and 47 of 48 at the task's minimum levels (70s).
- **The Corrupted Gauntlet** is the same play in its harder mode, a task of its own (80 Ranged,
  Magic and Hitpoints, 75 Defence, 70 Prayer, 50 Agility, Song of the Elves, and a Gauntlet
  completed, which opens Enter-corrupted), taking 24 fish (the Wiki gives no number; it's what the
  pack holds beside the other weapon and the potions), three Egniol potions, and attuned armour
  (the Wiki's "3-7" materials: the Hunllef's hits through prayer are most of the damage, and
  attuned armour takes a quarter off them). In 480 test runs with IronCronky's levels it completed
  97%; the losses are mostly preparation: a fish short of the pack, a piece of armour left basic for
  one material, or a weapon unperfected. Those are the map's, not the route's: the material it ends
  short of is almost never in a room it has lit, and the shards it fights for are needed.
  So it cheats there: a bot that reaches the Hunllef short (under 16 fish, 12 in the regular
  Gauntlet, armour under its goal, or a weapon unperfected) takes `::gauntletgear`'s loadout
  for the fight: perfected bow and staff, attuned armour, three potions and the rest fish (the
  run takes it when it ends). With that, 235 of 240 test runs won;
  every loss was a death in a run that went in fully kitted.
- **Tempoross** isn't a task yet: it needs a Tempoross play of its own (there's no Tempoross bot
  to reuse). Tempoross stays solo for now.

## Tutorial Island

A brand-new account on Tutorial Island gets the Tutorial Island task before anything else. For now
it takes the Gielinor Guide's skip, through the Tutorial Island plugin's `tutorial:skip` event: the
starter kit, Lumbridge, and Learning the Ropes completed. It then closes the welcome boxes and the
brain carries on. A world with `TutorialIsland:allowSkip` off locks the task. Playing the island
through step by step is still to come.

## Real progression

Nothing is conjured after the starting kit (above). A tool, bait, food, gear or runes come from the character's own inventory,
equipment or bank (`lib/Supplies.PlayerBots.js`), or are bought with its own coins at a shop that
stocks them (`brain/actions/BuyItems.PlayerBots.js`, through the normal shop code). A character
that can't get what a task needs doesn't get that task. Combat trainers wear the best gear they own
and carry, and only cast with their own runes. Gathered goods are dropped, sold, processed or
banked, and processing tasks work through what's banked.

## The population

`population/`, on with `"PlayerBots:population": { "enabled": true }` in the world config's
`pluginConfig` (`server/data/definitions/world.local.json`). Options: `count` (default 110),
`sessionMinutes` and `breakMinutes` (`[min, max]`, defaults `[45, 150]` and `[20, 90]`).

**How many:** about two thirds of `count` are online at once. Measured on the development PC
(the whole server, bots playing their tasks, 300 ticks timed; the game's budget is 600 ms):

| Online | Average tick | 95th percentile | Slowest | Heap |
|---|---|---|---|---|
| 100 | 25 ms | 60 ms | 137 ms | 0.9 GB |
| 300 | 52 ms | 116 ms | 223 ms | 0.9 GB |
| 500 | 134 ms | 213 ms | 323 ms | 1.1 GB |
| 600 | 125 ms | 236 ms | 345 ms | 1.1 GB |
| 1000 | 201 ms | 314 ms | 401 ms | 1.2 GB |

About 0.2 ms a bot. 500 online (`count` 750) keeps the slowest tick near half the budget, with
room for real players; that's what the local world runs.

**Crowding** (`lib/Crowd.PlayerBots.js` notes every agent's task and place): each four characters
on a task per place it's done at halve its weight with the brain, and at the task's cap (`crowd`,
default 12 a place; an Agility course 6, a stall 4, a pickpocket spot 5, Wintertodt 40, the house
party 20, the Gauntlet's instances none) the brain leaves it. The agent picks the nearest place
counting each character already there as 30 tiles further, and passes a place with 15 over for
another. Travel never lands in the Wilderness (a ring of dueling's Ferox Enclave) for a place
outside it.

- **Accounts:** each bot is a normal saved account with a realistic name (`lib/Names.PlayerBots.js`)
  and a locked password. The roster is `server/data/saves/player-bots.json`; levels and items are in
  the player save.
- **Stages:** a new account starts early, mid or late game (`data/stages.json`): rolled levels, the
  best gear and tools its levels allow, food, and coins in the bank. After its first login, it earns
  everything.
- **Starting kit:** with the stage come its quests and teleports (`quests`, `teleports` in
  `data/stages.json`), given once to new accounts and to ones made before them (its version is
  saved, `player-bots:kit-version`):
  - early: Rune Mysteries, Druidic Ritual, The Restless Ghost; a few tablets and a games necklace;
  - mid: also Priest in Peril, Lost City, The Fremennik Trials, Nature Spirit, Death Plateau,
    Eagles' Peak, Tree Gnome Village, Waterfall Quest, The Tourist Trap, Ernest the Chicken,
    Animal Magnetism, Enter the Abyss, The Dig Site; tablets, house tabs, glories, rings of
    dueling, a skills necklace, an enchanted gem and runes (laws, elementals);
  - late: also Troll Stronghold, Dragon Slayer I, Monkey Madness I, Shilo Village, Horror from the
    Deep, Ghosts Ahoy, Plague City, Underground Pass, Regicide, Mourning's End I and II, Desert
    Treasure I, Lunar Diplomacy, Song of the Elves; more of everything, plus combat bracelets,
    Slayer rings, a necklace of passage, a digsite pendant, natures, cosmics and astrals.

  Kit version 2 (`kitUpdates`) adds, for mid and late accounts with their prerequisites,
  Fairytale I and Fairytale II up to the Fairy Godfather's permission (where the rings open), and
  a dramen staff for those with Lost City.

  A quest is given only when the account's levels meet the Wiki's requirements (`levels`) and its
  prerequisites are done (`after`), through the quest's own complete() as a quest pack does (no XP,
  no scroll). Its unlocks follow: Herblore, the Canifis course, Slayer masters past a quest.
- **Profiles:** balanced, skiller or fighter, with a focus skill.
- **Sessions:** about two thirds are online at once. Each logs in and out on its own timers.
- **As real players:**
  - they count towards the world's population (`World.getPopulation`, through `world:population`);
  - they show online in friends lists;
  - a private message gets a short reply a few seconds later.
- **Owner command:** `::bots [name]` lists who is online, their stage and profile, and what they're
  doing.

## Bot mode

Any player can let their own character play itself while they watch:

- `::botmode` opens a picker: **Let the brain choose**, **Skills**, **Combat**, or **Resume** the
  last task. Skills lists every skill, then a skill's families where it has them (Fletching: Logs,
  Oak logs ... Arrows, Darts; Herblore: Cleaning herbs, Unfinished potions, Potions), then the
  tasks, three to a page (**More...** for the rest). Locked tasks show as locked and say why when
  picked.
- `::botmode <task>` starts a task directly (`::botmode list` shows the ids and what's locked).
- `::botmode brain` lets the brain choose and rotate tasks.
- `::botmode status` shows what it's doing. `::botmode off` stops.

Any click of the player's own in the world takes back control at once (`player:world-input`). It
also stops on logout, or when a picked task can't go on (with the reason). The character stays an
ordinary player: it isn't flagged as a bot, so it keeps its sounds and full updates.

## Adding a task

1. Write the task object (`tasks/Common.PlayerBots.js` describes it). Give it `id`, `name`, a
   `group` (Gathering, Processing, Activities, Combat), a `subgroup` (the skill) and optional
   `family` for the picker, `skill`, `level`, `places`, `minutes`, `check` and `build`. A product
   made at a bank is one `makingTask({ ... })` (`tasks/Making.PlayerBots.js`).
   Build activities from the registry (`registry.byId.get(id)` for one in
   `server/data/definitions/bot-activities.json`, or `registry.compile({ ... })` for its own).
2. Add it to `tasks/Catalogue.PlayerBots.js`, and its places to `data/task-places.json`.
3. It appears in the brain's choices and in the bot mode picker. Test `check` and `build` in
   `bot-agent.test.cjs`.

## What else is here

- **Wilderness PvP bots:** the PvP hotspots in `server/data/definitions/bot-sites.json`, still run
  by the PvP controller.
- **Minigame bots:** Castle Wars, Pest Control, Bounty Hunter, Soul Wars, Wintertodt and LMS build
  on the shared pieces kept here: the bot player factory, names, PvP loadouts.
- **Removed:** the old skilling sites, the residents and the language-model AI chat bots.

## Next

1. **Getting about:** the walking ways the route planner doesn't know (the passage under
   Paterdomus, boats, the Lost City's shed); fairy rings cover much of it (Morytania by CKS).
2. **The rest of the skills:** Construction; Farming's other patches (allotments, trees, fruit
   trees) and Tithe Farm (Hosidius); Hunter's other methods (box traps, nets,
   deadfalls, falconry); Slayer's other masters (Mazchna with Priest in Peril, Chaeldar,
   Duradel), keys and agility shortcuts
   into dungeons, and teleports to far tasks; Runecraft's other altars
   (cosmic, law, nature, chaos, death: a quest, a boat or the Wilderness) and the essence mine
   (Rune Mysteries); the other Agility courses (Ape Atoll, Pyramid, Werewolf, Wilderness; Shayzien and the
   Colossal Wyrm need a way to Kourend and Varlamore).
3. **Quests:** a task that plays a quest through its plugin's real dialogue and steps. The quest
   plugins' bot checks (mostly owner-only NPC spawns) need lifting.
4. **Minigames:** rebuild the minigame bots as tasks on the agent, starting with Wintertodt.
5. **Hiscores:** there are none yet; the bots are saved accounts, so they'll appear when one exists.
