// Lava Maze ladder (3017, 3849) leads straight into the lair; the lair's lever (2271, 4680)
// sends the player back to the tile north of that ladder.
const KBD_LADDER_DOWN_OBJECT_ID = 18987;
const KBD_LAIR_LEVER_OBJECT_ID = 1817;

const KING_BLACK_DRAGON_LAIR = [2271, 4680, 0];
const KING_BLACK_DRAGON_LADDER = [3017, 3850, 0];

const Breath = {
  DRAGON: 0,
  ICE: 1,
  POISON: 2,
  SHOCK: 3,
};

const {
  resolveChromaticDragonfireDamage,
  sendDragonfireMessages,
  initDragonfireProtectionCoreAccess,
} = require("../combat/DragonfireProtection");

/** Wiki (King Black Dragon): unprotected dragonfire hits up to 65. */
const KBD_DRAGONFIRE_MAX_HIT = 65;

let api = null;
let Location, Misc, PendingHit, Projectile;
let CombatFactory;

function climbDownToLair({ player }) {
  const [x, y, z] = KING_BLACK_DRAGON_LAIR;
  api.emitCustomEvent("ladders:climbDown", { player, destination: new Location(x, y, z) });
  return true;
}

function pullLairLever({ player }) {
  const [x, y, z] = KING_BLACK_DRAGON_LADDER;
  api.emitCustomEvent("lever:teleport", { player, destination: new Location(x, y, z) });
  return true;
}

/** The combat method, built on api.core's classes. */
function combatClass(pluginApi) {
  api = pluginApi;
  ({ Location, Misc, PendingHit, Projectile } = pluginApi.core);
  initDragonfireProtectionCoreAccess(pluginApi);
  CombatFactory = pluginApi.getCombatFactory();
  const { Animation, CombatMethod, CombatType } = pluginApi.core;

  class KingBlackDragonCombatMethod extends CombatMethod {
    constructor() {
      super();
      this.currentAttackType = CombatType.MAGIC;
      this.currentBreath = Breath.DRAGON;
    }

    start(character, target) {
      if (this.currentAttackType === CombatType.MAGIC) {
        character.performAnimation(new Animation(84));
        let projectileId = 393;
        switch (this.currentBreath) {
          case Breath.DRAGON:
            projectileId = 393;
            break;
          case Breath.ICE:
            projectileId = 396;
            break;
          case Breath.POISON:
            projectileId = 394;
            break;
          case Breath.SHOCK:
            projectileId = 395;
            break;
          default:
            break;
        }
        // Leaves the head (43) for the target's chest (31), not the ground for their scalp.
        Projectile.createProjectile(
          character,
          target,
          projectileId,
          40,
          Projectile.arrivalCycles(character, target),
          43,
          31
        ).sendProjectile();
      } else if (this.currentAttackType === CombatType.MELEE) {
        character.performAnimation(new Animation(91));
      }
    }

    attackDistance() {
      return 8;
    }

    type() {
      return this.currentAttackType;
    }

    hits(character, target) {
      // The burn lands when the fire does, not before it.
      const hitDelay =
        this.currentAttackType === CombatType.MAGIC ? Projectile.arrivalTicks(character, target) : 1;
      const breath = this.currentAttackType === CombatType.MAGIC;
      const hit = new PendingHit(character, target, this, { delay: hitDelay, rollAccuracy: !breath });
      if (target.isPlayer()) {
        const player = target.getAsPlayer();
        if (breath) {
          // Wiki (King Black Dragon): all four breaths are dragonfire, up to 65, cut by the
          // shield, Protect from Magic and antifire like any chromatic dragon's.
          const dragonfire = resolveChromaticDragonfireDamage(character, player, { maxHit: KBD_DRAGONFIRE_MAX_HIT });
          hit.setTotalDamage(dragonfire.damage);
          // The resolver already applied Protect from Magic; impact must not cut it again.
          hit.markProtectionBypassed();
          sendDragonfireMessages(player, dragonfire.messages);
        }
        if (breath) {
          switch (this.currentBreath) {
            case Breath.ICE:
              CombatFactory.freeze(player, 5);
              break;
            case Breath.POISON:
              CombatFactory.poisonEntity(player, 30);
              break;
            default:
              break;
          }
        }
      }
      return [hit];
    }

    finished(character, target) {
      // Distance from the dragon's body, not its south-west corner: standing at its east
      // side read as 5 tiles away, so it breathed on you point blank instead of biting.
      if (character.calculateDistance(target) <= 1) {
        if (Misc.randomInclusive(0, 2) === 0) {
          this.currentAttackType = CombatType.MAGIC;
        } else {
          this.currentAttackType = CombatType.MELEE;
        }
      } else {
        this.currentAttackType = CombatType.MAGIC;
      }
      if (this.currentAttackType === CombatType.MAGIC) {
        const random = Misc.randomInclusive(0, 10);
        if (random >= 0 && random <= 3) {
          this.currentBreath = Breath.DRAGON;
        } else if (random >= 4 && random <= 6) {
          this.currentBreath = Breath.SHOCK;
        } else if (random >= 7 && random <= 9) {
          this.currentBreath = Breath.POISON;
        } else {
          this.currentBreath = Breath.ICE;
        }
      }
    }
  }

  return KingBlackDragonCombatMethod;
}

module.exports = {
  name: "KingBlackDragon",
  members: true,
  register(pluginApi) {
    const { NpcIdentifiers } = pluginApi.core;
    pluginApi.registerNpcCombatMethodProvider(
      [NpcIdentifiers.KING_BLACK_DRAGON, NpcIdentifiers.KING_BLACK_DRAGON_2, NpcIdentifiers.KING_BLACK_DRAGON_3],
      combatClass(pluginApi),
    );
    pluginApi.onObjectFirstClick(KBD_LADDER_DOWN_OBJECT_ID, climbDownToLair);
    pluginApi.onObjectFirstClick(KBD_LAIR_LEVER_OBJECT_ID, pullLairLever);
  },
};
