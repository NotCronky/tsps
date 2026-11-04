/**
 * One Alchemical Hydra fight (Wiki: Alchemical Hydra, /Strategies):
 * - four phases, at 825, 550 and 275 hitpoints a head falls off and it changes form
 *   (serpentine -> electric -> flame -> enraged); each of the first three starts with 75% damage
 *   reduction, lost when the Hydra stands by its phase's chemical vent while the vents spray (red
 *   for serpentine, green for electric, blue for flame) and it roars; the wrong vent empowers it
 *   instead, up to 50% more damage for the rest of the phase;
 * - the vents spray every few ticks for as long as their geyser animation runs;
 * - its attacks are counted per phase: three auto-attacks, then the phase's special, then one
 *   every nine (the enraged phase repeats the poison); after every three basic attacks it sways
 *   its heads back before changing style;
 * - poison: blobs land in 3x3 splashes (up to 7, and poison 6 for the one aimed at the player,
 *   4 otherwise), leaving pools that hit for up to 12 a tick to whoever stands in them;
 * - lightning: four currents from the room's corners close in on the player; one reaching them
 *   hits for up to 22 and binds them; a phase change dissipates them;
 * - each vent acts on the Hydra once per spray for each phase, so a Hydra standing on the blue
 *   vent as it turns into the flame form is weakened by the same spray;
 * - fire: the Hydra walks to the centre of the chamber, its attacks paused, and on arriving faces
 *   and stuns the player (they can still attack; one underneath is pushed out a random way), then
 *   breathes walls of fire to their sides and a tracking fire that follows them: up to 25, then a
 *   burn of 5 five times; the Hydra idles for seven ticks after. A phase change cuts it short: the
 *   walk and the tracking fire stop, walls already burning stay (that is the "flame skip");
 * - its death or the player leaving clears every pool, current and fire.
 * Combat.AlchemicalHydra.js picks each attack; this keeps the count and runs the rest.
 */
const Common = require("./Common.AlchemicalHydra");

const PHASES = () => Common.data.phases;

class Fight {
  constructor(lair, npc, random = Math.random) {
    this.lair = lair;
    this.npc = npc;
    this.random = random;
    this.phase = 0;
    this.attacks = 0;
    this.basics = 0;
    this.style = "ranged";
    this.shielded = true;
    this.empowered = false;
    this.sprayUntil = 0;
    this.sprayed = new Set();
    this.transitionUntil = 0;
    this.tickCount = 0;
    this.pools = [];
    this.currents = [];
    this.walls = [];
    this.trackers = [];
    this.burns = [];
    /** The flame special's walk to the centre: { target, until }, or null. */
    this.flame = null;
    /** Arrived, the breath due: { target, at }, or null. */
    this.breatheDue = null;
    /** The tracking fire due after the side fires: { target, at }, or null. */
    this.launch = null;
    this.stopped = false;
    npc.__hydraFight = this;
  }

  get enraged() {
    return this.phase === 3;
  }

  // --- The attack count

  /** The attack the count says comes next: "special" or a basic style. */
  nextAttack() {
    const { specialAfter, specialEvery, styleSwitchEvery } = Common.data.combat;
    const n = this.attacks + 1;
    if (n > specialAfter && (n - specialAfter - 1) % specialEvery === 0) return "special";
    const every = this.enraged ? 1 : styleSwitchEvery;
    if (this.basics > 0 && this.basics % every === 0) return this.style === "ranged" ? "magic" : "ranged";
    return this.style;
  }

  counted(kind) {
    this.attacks += 1;
    if (kind === "special") return;
    this.style = kind;
    this.basics += 1;
  }

  /** Whether the attack just counted ends a group of three: the Hydra sways before switching. */
  switchesNext() {
    return !this.enraged && this.basics > 0 && this.basics % Common.data.combat.styleSwitchEvery === 0;
  }

  /** The heads sway back once the attack's own animation has run (Wiki: Alchemical Hydra/Strategies). */
  swayLater(ticks) {
    const phase = this.phase;
    Common.later(ticks, () => {
      if (this.stopped || this.phase !== phase || this.transitioning()) return;
      this.npc.performAnimation(new Common.core.Animation(Common.ids.seqs.switch[phase]));
    });
  }

  transitioning() {
    return this.tickCount < this.transitionUntil;
  }

  // --- Phases and vents

  /** Past this phase's threshold, a head falls and the next form comes (one a tick at most). */
  checkPhase() {
    if (this.enraged || this.stopped || this.transitioning()) return false;
    const below = PHASES()[this.phase].below;
    if (this.npc.getHitpoints() > below) return false;
    this.changePhase();
    return true;
  }

  changePhase() {
    const { ids } = Common;
    const transitions = [ids.npcs.toElectric, ids.npcs.toFlame, ids.npcs.toEnraged];
    const from = this.phase;
    this.npc.setNpcTransformationId(transitions[from]);
    this.npc.performAnimation(new Common.core.Animation(ids.seqs.phaseOut[from]));
    this.transitionUntil = this.tickCount + Common.data.combat.phaseChangeTicks;
    this.currents = [];
    // The flame special ends abruptly: its walk and tracking fire stop, walls already lit stay.
    if (this.flame) this.endFlameWalk();
    this.launch = null;
    this.breatheDue = null;
    this.pendingWalls = [];
    this.trackers = [];
    this.phase = from + 1;
    this.attacks = 0;
    this.basics = 0;
    this.shielded = !this.enraged && this.phase < 3;
    this.empowered = false;
    if (this.enraged) this.style = this.style === "ranged" ? "magic" : "ranged";
    Common.later(Common.data.combat.phaseChangeTicks, () => {
      if (this.stopped) return;
      this.npc.setNpcTransformationId(Common.phaseForms()[this.phase]);
      this.npc.performAnimation(new Common.core.Animation(ids.seqs.phaseIn[from]));
    });
  }

  /** The vents start spraying: their geyser plays, and acts on the Hydra until it ends. */
  startSpray(players) {
    const { combat } = Common.data;
    this.sprayUntil = this.tickCount + combat.geyserTicks;
    this.sprayed = new Set();
    this.animateVents(players, Common.ids.seqs.geyser);
  }

  spraying() {
    return this.tickCount < this.sprayUntil;
  }

  /** Each vent's loc plays `seq` for these players (the geyser, or back to its idle). */
  animateVents(players, seq) {
    const vents = this.lair.vents?.() ?? [];
    const { Animation } = Common.core;
    for (const player of players) {
      for (const vent of vents) player.getPacketSender().sendObjectAnimation?.(vent, new Animation(seq));
    }
  }

  /**
   * A spraying vent by the Hydra: its own takes the shield (it roars) and ends any empowerment;
   * another empowers it while it is still shielded.
   * `done` holds the vents that already acted this spray, so each acts once.
   */
  eruptVents(players, done = new Set()) {
    const want = PHASES()[this.phase].vent;
    if (!want) return;
    for (const [colour, tile] of Object.entries(Common.data.vents)) {
      // Once per phase per spray: a vent that was the wrong one still acts on the next form.
      const key = `${this.phase}:${colour}`;
      if (done.has(key)) continue;
      const near = Common.distanceToFootprint(Common.toLocation(tile), this.npc) <= Common.data.combat.ventRange;
      if (!near) continue;
      done.add(key);
      if (colour === want) {
        if (!this.shielded) continue;
        this.shielded = false;
        this.empowered = false;
        this.npc.forceChat?.(Common.message("roar"));
        for (const player of players) player.sendMessage(Common.message("weakened"));
      } else if (this.shielded && !this.empowered) {
        this.empowered = true;
        for (const player of players) player.sendMessage(Common.message("empowered"));
      }
    }
  }

  /**
   * The most a hit can take off the player: 35, 52 while an incorrect vent empowers it (up
   * to 50% more, the Wiki's infobox's 35 -> 52), 55 once enraged.
   */
  maxHit() {
    const { combat } = Common.data;
    if (this.enraged) return combat.enragedMaxHit;
    return this.empowered ? combat.empoweredMaxHit : combat.maxHit;
  }

  /** onNpcHitModify: 75% less damage while shielded (the enraged form keeps no shield). */
  reduce(damage) {
    if (!this.shielded || this.enraged) return damage;
    return Math.floor(damage * Common.data.combat.shieldedDamage);
  }

  // --- A tick

  tick(players) {
    if (this.stopped) return;
    this.tickCount += 1;
    if (this.npc.isDyingFunction?.() || this.npc.getHitpoints() <= 0) {
      this.clear();
      return;
    }
    this.checkPhase();
    this.tickVents(players);
    this.tickPools(players);
    this.tickCurrents(players);
    this.tickFlameWalk();
    this.tickFire(players);
  }

  tickVents(players) {
    if (this.tickCount % Common.data.combat.ventEvery === 0) this.startSpray(players);
    if (this.spraying()) this.eruptVents(players, this.sprayed);
    else if (this.tickCount === this.sprayUntil) this.animateVents(players, Common.ids.seqs.geyserOff);
  }

  // --- Poison

  spitPoison(target) {
    const { poison } = Common.data;
    const count = this.enraged ? poison.enragedBlobs : poison.blobs;
    const base = target.getLocation();
    const tiles = [base];
    for (let attempt = 0; tiles.length < count && attempt < 30; attempt++) {
      const tile = base.transform(Common.randomInt(-poison.spread, poison.spread), Common.randomInt(-poison.spread, poison.spread));
      if (!this.lair.contains(tile) || tiles.some((other) => sameTile(other, tile))) continue;
      tiles.push(tile);
    }
    const { Projectile } = Common.core;
    tiles.forEach((tile, index) => {
      new Projectile(Projectile.centreOf(this.npc), tile, null, Common.ids.spotanims.poisonFlight, 0, poison.landDelay * 30, 90, 0, this.npc.getPrivateArea?.() ?? null).sendProjectile();
      Common.later(poison.landDelay, () => this.landPoison(tile, index === 0 ? target : null));
    });
  }

  landPoison(centre, aimedAt) {
    if (this.stopped) return;
    const { poison } = Common.data;
    const players = this.lair.players();
    Common.tileGraphic(players, centre, Common.ids.spotanims.poisonSplash);
    for (const player of players) {
      if (chebyshev(player.getLocation(), centre) > 1) continue;
      Common.hurtPlayer(player, Common.randomInt(0, poison.splashMax), true);
      Common.core.CombatFactory.poisonEntity(player, player === aimedAt ? poison.poisonTargeted : poison.poisonNear);
    }
    const until = this.tickCount + poison.poolTicks;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const tile = centre.transform(dx, dy);
        if (this.lair.contains(tile)) this.pools.push({ tile, until });
      }
    }
    Common.tileGraphic(players, centre, Common.ids.spotanims.poisonPool);
  }

  tickPools(players) {
    if (this.pools.length === 0) return;
    const { poolMax } = Common.data.poison;
    for (const player of players) {
      if (this.pools.some((pool) => sameTile(pool.tile, player.getLocation()))) {
        Common.hurtPlayer(player, Common.randomInt(1, poolMax), true);
      }
    }
    this.pools = this.pools.filter((pool) => this.tickCount < pool.until);
  }

  // --- Lightning

  castLightning() {
    const { lightning } = Common.data;
    const until = this.tickCount + lightning.lifetime;
    this.currents = Common.data.room.corners.slice(0, lightning.currents).map(([x, y]) => ({ x, y, until }));
    Common.tileGraphic(this.lair.players(), this.npc.getLocation(), Common.ids.spotanims.lightningCaster);
  }

  tickCurrents(players) {
    if (this.currents.length === 0) return;
    const target = players[0];
    if (!target) return;
    const { lightning } = Common.data;
    const at = target.getLocation();
    const left = [];
    for (const current of this.currents) {
      if (this.tickCount >= current.until) continue;
      current.x += Math.sign(at.getX() - current.x);
      current.y += Math.sign(at.getY() - current.y);
      const tile = new Common.core.Location(current.x, current.y, at.getZ());
      Common.tileGraphic(players, tile, Common.ids.spotanims.lightning);
      if (current.x === at.getX() && current.y === at.getY()) {
        Common.hurtPlayer(target, Common.randomInt(0, lightning.max));
        Common.tileGraphic(players, tile, Common.ids.spotanims.shock);
        bind(target, lightning.bindTicks);
        continue;
      }
      left.push(current);
    }
    this.currents = left;
  }

  // --- Fire

  /** The flame special starts with a walk to the centre; its attacks wait until it arrives. */
  startFire(target) {
    const { fire } = Common.data;
    this.flame = { target, until: this.tickCount + fire.walkTicks };
    this.npc.setScriptedMovement?.(true);
    // It walks over a player in its way (one left underneath is pushed out on arrival).
    this.npc.setFlag?.(Common.core.NPC.WALK_THROUGH_ENTITIES_FLAG, true);
    this.npc.setMobileInteraction?.(null);
    this.npc.getMovementQueue?.().reset?.();
    this.routeToCentre();
  }

  atCentre() {
    return sameTile(this.npc.getLocation(), Common.toLocation(Common.data.room.centre));
  }

  /** Straight for the centre as an NPC walks: diagonally until in line, then straight on. */
  routeToCentre() {
    const centre = Common.toLocation(Common.data.room.centre);
    const queue = this.npc.getMovementQueue?.();
    if (queue?.addSteps) {
      queue.reset();
      queue.addSteps(centre);
      return;
    }
    Common.core.PathFinder?.calculateWalkRoute?.(this.npc, centre.getX(), centre.getY());
  }

  endFlameWalk() {
    this.flame = null;
    this.npc.setScriptedMovement?.(false);
    this.npc.removeFlag?.(Common.core.NPC.WALK_THROUGH_ENTITIES_FLAG);
    this.npc.getMovementQueue?.().reset?.();
  }

  /**
   * At the centre (or when the walk takes too long) it stops, and breathes a tick later: a melee
   * player following it takes their last step first, which from the corner's diagonal is east or
   * west onto the tile beside it (the Tile Packs melee pack's "2, center"). A stalled walk is re-routed.
   */
  tickFlameWalk() {
    if (this.breatheDue && this.tickCount >= this.breatheDue.at) {
      const { target } = this.breatheDue;
      this.breatheDue = null;
      if (target?.isRegistered?.() !== false) this.breatheFire(target);
      return;
    }
    const flame = this.flame;
    if (!flame) return;
    if (flame.target?.isRegistered?.() === false) {
      this.endFlameWalk();
      return;
    }
    if (this.atCentre() || this.tickCount >= flame.until) {
      const { breatheAfter } = Common.data.fire;
      this.endFlameWalk();
      this.breatheDue = { target: flame.target, at: this.tickCount + breatheAfter };
      this.npc.getCombat().setAttackDelay?.(breatheAfter + 1);
      return;
    }
    if ((this.npc.getMovementQueue?.().size?.() ?? 0) === 0) this.routeToCentre();
  }

  /** A player under the Hydra is pushed out one way at random, just past its footprint. */
  pushOut(player) {
    if (Common.distanceToFootprint(player.getLocation(), this.npc) !== 0) return;
    const base = this.npc.getLocation();
    const size = this.npc.getSize();
    const at = player.getLocation();
    const ways = [
      new Common.core.Location(base.getX() - 1, at.getY(), at.getZ()),
      new Common.core.Location(base.getX() + size, at.getY(), at.getZ()),
      new Common.core.Location(at.getX(), base.getY() - 1, at.getZ()),
      new Common.core.Location(at.getX(), base.getY() + size, at.getZ()),
    ].filter((tile) => this.lair.contains(tile));
    if (ways.length > 0) player.moveTo(ways[Math.floor(this.random() * ways.length)]);
  }

  /** The Hydra's footprint as { minX, maxX, minY, maxY }. */
  footprint() {
    const base = this.npc.getLocation();
    const size = Math.max(1, this.npc.getSize());
    return { minX: base.getX(), maxX: base.getX() + size - 1, minY: base.getY(), maxY: base.getY() + size - 1 };
  }

  underHydra(x, y) {
    const f = this.footprint();
    return x >= f.minX && x <= f.maxX && y >= f.minY && y <= f.maxY;
  }

  /**
   * The side fires, as two streams in turn, each a list of rows from the Hydra outward (Wiki: 5x5
   * layers to the player's sides; the Tile Packs "Alchemical Hydra (melee)" pack and its video,
   * Dehsow 2026). By a corner of the Hydra - on the tile diagonal to it or either tile beside that -
   * a stream runs out of each of the two sides at that corner to the chamber's wall, as wide as
   * the Hydra less its row or column nearest the player: by the north-west corner of the Hydra in
   * the centre, columns 1365-1369 north and rows 10265-10269 west. That leaves both tiles beside
   * the corner ("2, center" and "3, skip") and "4th attack" (1361, 10270) clear, and the west
   * stream meets the wall at (1356, 10267), the pack's "Skip when fire hits wall". Anywhere else
   * they are 5x5 layers right beside the player across the line to the Hydra.
   */
  wallSides(at) {
    const width = Common.data.fire.wallLength;
    const f = this.footprint();
    const [rx0, rx1, ry0, ry1] = Common.data.room.bounds;
    const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const corners = [[f.minX - 1, f.minY - 1, -1, -1], [f.maxX + 1, f.minY - 1, 1, -1], [f.minX - 1, f.maxY + 1, -1, 1], [f.maxX + 1, f.maxY + 1, 1, 1]];
    const corner = corners.find(([cx, cy]) => Math.max(Math.abs(at.getX() - cx), Math.abs(at.getY() - cy)) <= 1);
    let sides;
    if (corner && !this.underHydra(at.getX(), at.getY())) {
      const [, , dx, dy] = corner;
      const columns = range(f.minX, f.maxX).filter((x) => x !== (dx < 0 ? f.minX : f.maxX));
      const rows = range(f.minY, f.maxY).filter((y) => y !== (dy < 0 ? f.minY : f.maxY));
      const vertical = [];
      for (let y = dy > 0 ? f.maxY + 1 : f.minY - 1; y >= ry0 && y <= ry1; y += dy) vertical.push(columns.map((x) => [x, y]));
      const horizontal = [];
      for (let x = dx > 0 ? f.maxX + 1 : f.minX - 1; x >= rx0 && x <= rx1; x += dx) horizontal.push(rows.map((y) => [x, y]));
      sides = [vertical, horizontal];
    } else {
      const midX = (f.minX + f.maxX) / 2;
      const midY = (f.minY + f.maxY) / 2;
      const across = Math.abs(at.getX() - midX) >= Math.abs(at.getY() - midY);
      const half = Math.floor(width / 2);
      sides = [-1, 1].map((side) => range(1, width).map((out) => range(-half, half).map((along) => (across
        ? [at.getX() + along, at.getY() + side * out]
        : [at.getX() + side * out, at.getY() + along]))));
    }
    return sides.map((stream) => stream
      .map((row) => row
        .map(([x, y]) => new Common.core.Location(x, y, at.getZ()))
        .filter((tile) => this.lair.contains(tile) && !this.underHydra(tile.getX(), tile.getY())))
      .filter((row) => row.length > 0));
  }

  /** Every tile both side fires reach (what a player standing at `at` would have lit around them). */
  wallTiles(at) {
    return this.wallSides(at).flat(2);
  }

  /** Lights fire on these tiles until `until` (a tile already burning keeps the later end). */
  light(tiles, until) {
    for (const tile of tiles) {
      const lit = this.walls.find((wall) => sameTile(wall.tile, tile));
      if (lit) lit.until = Math.max(lit.until, until);
      else this.walls.push({ tile, until });
    }
    for (const tile of tiles) Common.tileGraphic(this.lair.players(), tile, Common.ids.spotanims.fire);
  }

  /** Arrived: it faces and stuns the player and breathes the side fires; the tracking fire follows. */
  breatheFire(target) {
    const { fire } = Common.data;
    this.npc.performAnimation(new Common.core.Animation(Common.ids.seqs.special[this.phase]));
    this.pushOut(target);
    this.npc.setPositionToFace?.(target.getLocation());
    bind(target, fire.stunTicks);
    // Each stream spreads `wallSpeed` rows a tick, the second once the first is out; the tracking
    // fire leaves as the second reaches the wall ("Skip when fire hits wall").
    this.pendingWalls = [];
    let at = this.tickCount + fire.firstWallAfter;
    for (const stream of this.wallSides(target.getLocation())) {
      for (let row = 0; row < stream.length; row += fire.wallSpeed) {
        this.pendingWalls.push({ at, tiles: stream.slice(row, row + fire.wallSpeed).flat() });
        at += 1;
      }
    }
    const launchAt = Math.max(this.tickCount + 1, at - 1);
    this.launch = { target, at: launchAt };
    this.npc.getCombat().setAttackDelay?.(launchAt - this.tickCount + 1);
  }

  /** The tile in front of its mouth toward the player: the nearest tile around its footprint. */
  mouthTile(at) {
    const f = this.footprint();
    const x = Math.min(f.maxX + 1, Math.max(f.minX - 1, at.getX()));
    const y = Math.min(f.maxY + 1, Math.max(f.minY - 1, at.getY()));
    return new Common.core.Location(x, y, at.getZ());
  }

  /** It turns to the player and launches the tracking fire from its mouth, then idles (Wiki: ~7 ticks). */
  launchTrackingFire() {
    const { fire } = Common.data;
    const { target } = this.launch;
    this.launch = null;
    if (target?.isRegistered?.() === false) return;
    this.npc.setPositionToFace?.(target.getLocation());
    this.npc.performAnimation(new Common.core.Animation(Common.ids.seqs.special[this.phase]));
    const start = this.mouthTile(target.getLocation());
    // It leaves the mouth here; the tile only burns once the fire gets going, so a player who
    // steps away as it launches isn't caught where they stood.
    this.trackers.push({ x: start.getX(), y: start.getY(), z: start.getZ(), until: this.tickCount + fire.trackTicks, target, wait: fire.trackDelay, lit: false, trapped: false });
    Common.tileGraphic(this.lair.players(), start, Common.ids.spotanims.fireTravel);
    this.npc.getCombat().setAttackDelay?.(fire.idleAfter);
  }

  /** Whether a tile touches the Hydra (Chebyshev distance 1 from its footprint). */
  besideHydra(x, y) {
    const f = this.footprint();
    const dx = Math.max(f.minX - x, 0, x - f.maxX);
    const dy = Math.max(f.minY - y, 0, y - f.maxY);
    return Math.max(dx, dy) === 1;
  }

  /**
   * One step of a tracking fire toward the player, or null when it can't take it. It leaves the
   * mouth and only travels outward: never into the Hydra nor onto another tile beside it. So a
   * player beside the Hydra who steps to the next tile along it as the fire launches leaves it
   * stuck on its first tile (Wiki: the flames can be trapped standing beside the Hydra at a corner;
   * Dehsow's video: from the corner's diagonal tile to the tile beside it).
   */
  trackStep(tracker, at) {
    const sx = Math.sign(at.getX() - tracker.x);
    const sy = Math.sign(at.getY() - tracker.y);
    const x = tracker.x + sx;
    const y = tracker.y + sy;
    if (this.underHydra(x, y) || this.besideHydra(x, y)) return null;
    return [x, y];
  }

  /** Fire on the player: up to 25 and a burn of 5 five times (one burn at a time). */
  burn(player) {
    const { fire } = Common.data;
    Common.hurtPlayer(player, Common.randomInt(0, fire.trackMax));
    if (!this.burns.some((burn) => burn.player === player)) this.burns.push({ player, left: fire.burnHits, next: this.tickCount + 2 });
  }

  tickFire(players) {
    const { fire } = Common.data;
    const { wallTicks } = fire;
    this.pendingWalls = (this.pendingWalls ?? []).filter((pending) => {
      if (this.tickCount < pending.at) return true;
      this.light(pending.tiles, this.tickCount + wallTicks);
      return false;
    });
    if (this.launch && this.tickCount >= this.launch.at) this.launchTrackingFire();
    const left = [];
    for (const tracker of this.trackers) {
      if (this.tickCount >= tracker.until || tracker.target?.isRegistered?.() === false) continue;
      left.push(tracker);
      if (tracker.wait > 0) {
        tracker.wait -= 1;
        continue;
      }
      if (!tracker.lit) {
        tracker.lit = true;
        this.light([new Common.core.Location(tracker.x, tracker.y, tracker.z)], tracker.until);
      }
      if (tracker.trapped) continue;
      const at = tracker.target.getLocation();
      // Faster the further the player is (Wiki): a step a tick, one more for every few tiles.
      const steps = 1 + Math.floor(Math.max(Math.abs(at.getX() - tracker.x), Math.abs(at.getY() - tracker.y)) / fire.fasterEvery);
      for (let step = 0; step < steps; step++) {
        if (tracker.x === at.getX() && tracker.y === at.getY()) break;
        const next = this.trackStep(tracker, at);
        if (!next) {
          tracker.trapped = true;
          break;
        }
        [tracker.x, tracker.y] = next;
        this.light([new Common.core.Location(tracker.x, tracker.y, tracker.z)], tracker.until);
      }
    }
    this.trackers = left;
    if (this.walls.length > 0) {
      for (const player of players) {
        if (this.walls.some((wall) => sameTile(wall.tile, player.getLocation()))) this.burn(player);
      }
      this.walls = this.walls.filter((wall) => this.tickCount < wall.until);
    }
    this.burns = this.burns.filter((burn) => {
      if (this.tickCount < burn.next) return true;
      Common.hurtPlayer(burn.player, fire.burnDamage);
      burn.left -= 1;
      burn.next = this.tickCount + 2;
      return burn.left > 0;
    });
  }

  // --- The end

  clear() {
    this.pools = [];
    this.currents = [];
    this.walls = [];
    this.trackers = [];
    this.burns = [];
    this.launch = null;
    this.breatheDue = null;
    this.pendingWalls = [];
  }

  stop() {
    if (this.flame) this.endFlameWalk();
    if (this.spraying()) this.animateVents(this.lair.players?.() ?? [], Common.ids.seqs.geyserOff);
    this.sprayUntil = 0;
    this.stopped = true;
    this.clear();
    if (this.npc.__hydraFight === this) this.npc.__hydraFight = null;
  }
}

function sameTile(a, b) {
  return a.getX() === b.getX() && a.getY() === b.getY();
}

function chebyshev(a, b) {
  return Math.max(Math.abs(a.getX() - b.getX()), Math.abs(a.getY() - b.getY()));
}

/**
 * A lightning hit or the flame stun holds the player in place (they can still attack what is in
 * reach): the engine's freeze timer, which runs out on its own - a death, logout or a tick that
 * runs early can't leave them stuck. A longer hold extends it, a shorter one doesn't cut it.
 */
function bind(player, ticks) {
  const timers = player.getTimers?.();
  if (!timers) return;
  const { TimerKey } = Common.core;
  if (timers.has(TimerKey.FREEZE) && timers.left(TimerKey.FREEZE) >= ticks) return;
  timers.registers(TimerKey.FREEZE, ticks);
  player.getMovementQueue?.().reset?.();
}

module.exports = { Fight, chebyshev, bind };
