package com.tsps.profiles;

import com.tsps.botcore.Actions;
import com.tsps.botcore.Bot;
import com.tsps.botcore.Profile;
import com.tsps.botcore.Style;
import net.runelite.api.HeadIcon;
import net.runelite.api.Item;
import net.runelite.api.ItemComposition;
import net.runelite.api.Player;
import net.runelite.api.coords.WorldPoint;
import net.runelite.api.Prayer;
import net.runelite.api.kit.KitType;

/**
 * Wilderness PvP, first version: the server's PvP bots (server/plugins/bots/behaviours/pvp) read
 * your protection prayer and switch away from it, freeze, spec and pray against you themselves.
 *
 * Each tick, the most urgent of: eat, restore prayer, then against the opponent (whoever is
 * attacking you, else the nearest player in the Wilderness): pray against their weapon's style,
 * switch to a weapon whose style their overhead doesn't block (putting on ammo for it), attack.
 */
public final class PvpFighter implements Profile
{
	/** Where the fight is: the Wilderness (level ranges, "Attack"), or an arena like LMS ("Fight", anyone). */
	public static final class Rules
	{
		final String attackOption;
		final boolean wilderness;

		public Rules(String attackOption, boolean wilderness)
		{
			this.attackOption = attackOption;
			this.wilderness = wilderness;
		}
	}

	public static final Rules WILDERNESS = new Rules("Attack", true);
	public static final Rules ARENA = new Rules("Fight", false);

	private final Rules rules;
	/** Where to head when there's nobody to fight (null: where it started). */
	private java.util.function.Function<Bot, WorldPoint> roamTo;

	public PvpFighter()
	{
		this(WILDERNESS);
	}

	public PvpFighter(Rules rules)
	{
		this.rules = rules;
	}

	/** Sets where to head when idle (the LMS safe zone's centre, say). */
	public PvpFighter roamTo(java.util.function.Function<Bot, WorldPoint> roamTo)
	{
		this.roamTo = roamTo;
		return this;
	}
	static final double EAT_AT = 0.50;
	static final int PRAYER_RESTORE_AT = 20;
	static final int SEARCH_RADIUS = 15;
	static final int WILDERNESS_VARBIT = 5963;
	/** Varp 301: the special attack bar is armed (1). */
	static final int SPEC_ENABLED_VARP = 301;
	private static final String[] PRAYER_RESTORES = {"Super restore", "Prayer potion", "Sanfew serum"};

	/** Players the game refused us (level range, already in combat), by name -> tick to try again. */
	private final java.util.Map<String, Integer> refusedUntil = new java.util.HashMap<>();
	private static final int REFUSED_TICKS = 20;
	private int lastAttack = -10;
	/** Where the profile was started: it walks back here when there's nobody to fight. */
	private WorldPoint home;
	private int idleSince = -1;
	static final int ROAM_AFTER_TICKS = 20;
	static final int HOME_RADIUS = 5;
	private int lastEat = -10;
	private int lastCure = -10;
	private int lastRestore = -10;
	/** The weapon to go back to after a special attack, or -1. */
	private int mainWeapon = -1;
	private int specArmed = -10;
	/** Offensive prayers that didn't come on when clicked (not unlocked): skipped from then on. */
	private final java.util.Set<Prayer> unavailable = java.util.EnumSet.noneOf(Prayer.class);
	private Prayer offensiveTried;
	private int offensiveTriedAt = -10;
	private static final String[] ANTIPOISONS = {"Anti-venom", "Antidote++", "Antidote+", "Superantipoison", "Antipoison", "Sanfew serum"};
	static final double SPEC_AT = 0.55;
	/** Ancient Magicks, best first; a staff's casts are 5 ticks apart. */
	static final String[] SPELLS = {"Ice Barrage", "Ice Blitz", "Blood Barrage", "Blood Blitz"};
	static final int CAST_TICKS = 5;
	/** How far a staff's spell and a crossbow reach, for when frozen. */
	static final int MAGIC_REACH = 10;
	static final int RANGED_REACH = 7;
	/** Ice Barrage freezes for 20 seconds (33 ticks); "You have been frozen!" starts it. */
	static final int FREEZE_TICKS = 33;
	private int frozenUntil = -1;
	/** Run when under this share of Hitpoints with nothing left to eat. */
	static final double ESCAPE_AT = 0.30;
	static final int ESCAPE_STEP = 10;
	private boolean escape;
	private int lastSwitch = -10;
	private int kills;
	private Player lastOpponent;

	@Override
	public String key()
	{
		return "pvp";
	}

	@Override
	public String name()
	{
		return "TSPS PvP";
	}

	@Override
	public void start(Bot bot)
	{
		home = bot.position();
	}

	@Override
	public String tick(Bot bot)
	{
		Actions act = bot.actions;
		int hp = bot.hitpoints();
		int maxHp = bot.maxHitpoints();
		if (hp <= maxHp * EAT_AT && bot.tickCount() - lastEat >= 3)
		{
			// A combo eat: food, then a karambwan in the same tick (they're on separate delays).
			int food = act.slotWhere(item -> Actions.hasOption(item, "Eat") && !item.getName().startsWith("Cooked karambwan"));
			int karambwan = act.slotWhere(item -> item.getName().startsWith("Cooked karambwan"));
			int brew = act.slotNamed("Saradomin brew");
			if (food >= 0 || karambwan >= 0 || brew >= 0)
			{
				lastEat = bot.tickCount();
				bot.log("eat at " + hp + "/" + maxHp + (food >= 0 && karambwan >= 0 ? " (combo)" : ""));
				if (food >= 0)
				{
					act.itemOption(food, "Eat");
				}
				else if (brew >= 0)
				{
					act.itemOption(brew, "Drink");
				}
				if (karambwan >= 0)
				{
					act.itemOption(karambwan, "Eat");
				}
				return null;
			}
		}
		if (bot.poisoned() && bot.tickCount() - lastCure >= 4)
		{
			int cure = act.slotNamed(ANTIPOISONS);
			if (cure >= 0)
			{
				lastCure = bot.tickCount();
				bot.log("cure poison");
				act.itemOption(cure, "Drink");
				return null;
			}
		}
		// Prayer low, or brews have drained Attack: a restore.
		boolean drained = bot.client.getBoostedSkillLevel(net.runelite.api.Skill.ATTACK)
			< bot.client.getRealSkillLevel(net.runelite.api.Skill.ATTACK) - 10;
		if ((bot.prayerPoints() <= PRAYER_RESTORE_AT || drained) && bot.tickCount() - lastRestore >= 3)
		{
			int restore = act.slotNamed(PRAYER_RESTORES);
			if (restore >= 0)
			{
				lastRestore = bot.tickCount();
				act.itemOption(restore, "Drink");
				return null;
			}
		}

		Player opponent = opponent(bot);
		// Single-way combat: an NPC on us (a Wilderness skeleton) blocks attacking any player until
		// it's dead, so it's the fight unless a player is already on us.
		if (opponent == null || opponent.getInteracting() != bot.self())
		{
			net.runelite.api.NPC npc = npcAttacker(bot);
			if (npc != null)
			{
				if (bot.target() != npc && bot.tickCount() - lastAttack >= 3)
				{
					lastAttack = bot.tickCount();
					bot.log("an NPC is on us: attack " + npc.getName());
					act.npcOrPlayerAttack(npc);
				}
				return null;
			}
		}
		if (opponent == null)
		{
			// Nobody to fight for a while: back to where it was started (the bots gather there).
			if (idleSince < 0)
			{
				idleSince = bot.tickCount();
			}
			WorldPoint goal = roamTo != null ? roamTo.apply(bot) : home;
			if (goal != null && bot.tickCount() - idleSince >= ROAM_AFTER_TICKS && bot.position().distanceTo2D(goal) > HOME_RADIUS
				&& bot.client.getLocalDestinationLocation() == null && act.walkStep(goal))
			{
				return null;
			}
			if (lastOpponent != null && (lastOpponent.isDead() || lastOpponent.getHealthRatio() == 0))
			{
				kills++;
				bot.log("kill " + kills + ": " + lastOpponent.getName());
			}
			lastOpponent = null;
			for (Style style : Style.values())
			{
				if (act.prayer(style.protection(), false))
				{
					return null;
				}
			}
			return null;
		}
		idleSince = -1;
		if (opponent != lastOpponent)
		{
			bot.log("fighting " + opponent.getName() + " (level " + opponent.getCombatLevel() + ")");
			lastOpponent = opponent;
		}

		// Pray against what they're holding.
		Style theirs = Style.ofWeapon(weaponName(bot, opponent));
		if (bot.prayerPoints() > 0 && act.prayer(theirs.protection(), true))
		{
			bot.log("pray against " + theirs + " (" + weaponName(bot, opponent) + ")");
			return null;
		}

		// Losing with nothing left to eat: stop fighting and get away (prayer stays up, above).
		if (escaping(bot, opponent))
		{
			return null;
		}

		// Hit with a style their overhead doesn't block.
		Style mine = Style.ofWeapon(weaponName(bot, bot.self()));
		HeadIcon overhead = opponent.getOverheadIcon();
		// A special attack first when they're low, before the everyday switching below can undo it.
		if (special(bot, opponent, overhead))
		{
			return null;
		}

		boolean frozen = bot.tickCount() < frozenUntil;
		boolean meleeWhileFrozen = frozen && mine == Style.MELEE
			&& bot.position().distanceTo2D(opponent.getWorldLocation()) > 1;
		if ((mine.blockedBy(overhead) || meleeWhileFrozen) && bot.tickCount() - lastSwitch >= 2)
		{
			// Everyday weapons first: a spec weapon is for specs.
			// Frozen and out of reach: a weapon that hits from where we stand.
			java.util.function.Predicate<net.runelite.api.ItemComposition> fits = item -> isWeapon(item)
				&& !Style.ofWeapon(item.getName()).blockedBy(overhead)
				&& (!meleeWhileFrozen || Style.ofWeapon(item.getName()) != Style.MELEE);
			int weapon = act.slotWhere(item -> fits.test(item) && com.tsps.botcore.Specials.cost(item.getName()) < 0);
			if (weapon < 0)
			{
				weapon = act.slotWhere(fits);
			}
			if (weapon >= 0)
			{
				lastSwitch = bot.tickCount();
				String name = bot.client.getItemDefinition(act.inventory()[weapon].getId()).getName();
				bot.log("switch to " + name + " (they pray " + overhead + ")");
				act.equip(weapon);
				return null;
			}
		}
		if (mine == Style.RANGED && !wearingAmmo(bot))
		{
			int ammo = act.slotWhere(PvpFighter::isAmmo);
			if (ammo >= 0)
			{
				act.equip(ammo);
				return null;
			}
		}
		if (offensivePrayer(bot, mine))
		{
			return null;
		}
		// Frozen: only someone within this weapon's reach can be hit; otherwise wait it out.
		int reach = mine == Style.MAGIC ? MAGIC_REACH : mine == Style.RANGED ? RANGED_REACH : 1;
		if (frozen && bot.position().distanceTo2D(opponent.getWorldLocation()) > reach)
		{
			return null;
		}
		// A magic weapon isn't for hitting: cast (an ice spell freezes them too).
		if (mine == Style.MAGIC)
		{
			if (bot.tickCount() - lastAttack >= CAST_TICKS)
			{
				for (String spell : SPELLS)
				{
					if (act.castOn(spell, opponent))
					{
						lastAttack = bot.tickCount();
						bot.log("cast " + spell + " on " + opponent.getName());
						return null;
					}
				}
			}
			else
			{
				return null;
			}
		}
		if (bot.target() != opponent && bot.tickCount() - lastAttack >= 3)
		{
			lastAttack = bot.tickCount();
			net.runelite.api.Actor current = bot.target();
			bot.log("attack " + opponent.getName() + " (targeting " + (current == null ? "nothing" : current.getName())
				+ ", anim " + bot.self().getAnimation() + ", their hp " + opponent.getHealthRatio() + "/" + opponent.getHealthScale() + ")");
			boolean clicked = act.playerOption(opponent, rules.attackOption);
			if (!clicked)
			{
				bot.log("no Attack option on " + opponent.getName() + ": player options " + java.util.Arrays.toString(bot.client.getPlayerOptions()) + ", wilderness varbit " + bot.client.getVarbitValue(WILDERNESS_VARBIT) + ", attack options varp 1107 = " + bot.client.getVarpValue(1107) + " at " + bot.position());
			}
		}
		return null;
	}

	/**
	 * A special attack when they're low: equip a spec weapon their overhead doesn't block (keeping
	 * the main weapon to go back to), press the spec orb, and after it's spent, the main weapon again.
	 */
	private boolean special(Bot bot, Player opponent, HeadIcon overhead)
	{
		Actions act = bot.actions;
		int energy = bot.client.getVarpValue(com.tsps.botcore.Specials.ENERGY_VARP) / 10;
		String wielded = weaponName(bot, bot.self());
		int wieldedCost = com.tsps.botcore.Specials.cost(wielded);
		// Spent: back to the main weapon.
		if (mainWeapon > 0 && wieldedCost > 0 && (energy < wieldedCost || bot.tickCount() - specArmed > 8))
		{
			int slot = act.slotOf(mainWeapon);
			mainWeapon = -1;
			if (slot >= 0)
			{
				bot.log("back to " + bot.client.getItemDefinition(act.inventory()[slot].getId()).getName());
				act.equip(slot);
				return true;
			}
		}
		boolean low = opponent.getHealthScale() > 0 && opponent.getHealthRatio() >= 0
			&& opponent.getHealthRatio() <= opponent.getHealthScale() * SPEC_AT;
		if (!low)
		{
			return false;
		}
		if (wieldedCost > 0 && energy >= wieldedCost && !Style.ofWeapon(wielded).blockedBy(overhead))
		{
			if (bot.client.getVarpValue(SPEC_ENABLED_VARP) == 0 && bot.tickCount() - specArmed > 1)
			{
				specArmed = bot.tickCount();
				bot.log("special attack with " + wielded + " (energy " + energy + ")");
				act.widgetOp(com.tsps.botcore.Specials.SPEC_BAR, 1, "Use");
				return true;
			}
			return false;
		}
		int spec = act.slotWhere(item -> com.tsps.botcore.Specials.cost(item.getName()) > 0
			&& com.tsps.botcore.Specials.cost(item.getName()) <= energy && !Style.ofWeapon(item.getName()).blockedBy(overhead));
		if (spec >= 0 && mainWeapon < 0)
		{
			int worn = bot.self().getPlayerComposition().getEquipmentId(KitType.WEAPON);
			mainWeapon = worn;
			specArmed = bot.tickCount();
			bot.log("switch to " + bot.client.getItemDefinition(act.inventory()[spec].getId()).getName() + " to spec");
			act.equip(spec);
			return true;
		}
		return false;
	}

	/** The best offensive prayer for the weapon's style that's unlocked (Piety, Rigour, Augury, else the older ones). */
	private boolean offensivePrayer(Bot bot, Style style)
	{
		if (bot.prayerPoints() <= PRAYER_RESTORE_AT)
		{
			return false;
		}
		// A prayer clicked a few ticks ago that still isn't on isn't unlocked.
		if (offensiveTried != null && bot.tickCount() - offensiveTriedAt >= 3 && !bot.client.isPrayerActive(offensiveTried))
		{
			bot.log(offensiveTried + " isn't available");
			unavailable.add(offensiveTried);
			offensiveTried = null;
		}
		Prayer[] choices;
		switch (style)
		{
			case RANGED:
				choices = new Prayer[]{Prayer.RIGOUR, Prayer.EAGLE_EYE};
				break;
			case MAGIC:
				choices = new Prayer[]{Prayer.AUGURY, Prayer.MYSTIC_MIGHT};
				break;
			default:
				choices = new Prayer[]{Prayer.PIETY, Prayer.CHIVALRY};
		}
		for (Prayer prayer : choices)
		{
			if (unavailable.contains(prayer))
			{
				continue;
			}
			if (bot.client.isPrayerActive(prayer))
			{
				return false;
			}
			if (bot.tickCount() - offensiveTriedAt < 3)
			{
				return false;
			}
			if (!bot.actions.prayer(prayer, true))
			{
				bot.log(prayer + " has no button here");
				unavailable.add(prayer);
				continue;
			}
			offensiveTried = prayer;
			offensiveTriedAt = bot.tickCount();
			bot.log("offensive prayer " + prayer);
			return true;
		}
		return false;
	}

	@Override
	public void message(Bot bot, String text)
	{
		if (text.contains("You have been frozen"))
		{
			frozenUntil = bot.tickCount() + FREEZE_TICKS;
			bot.log("frozen");
			return;
		}
		// Frozen, "can't reach" is the freeze, not them.
		if (text.contains("can't reach that") && bot.tickCount() < frozenUntil)
		{
			return;
		}
		// The game refused the last attack: leave that player alone a while.
		if (lastOpponent != null && (text.contains("level difference is too great") || text.contains("deeper into the Wilderness")
			|| text.contains("game has not started") || text.contains("can't attack") || text.contains("cannot attack")
			|| text.contains("can't reach that")
			|| text.contains("already under attack") || text.contains("already in combat") || text.contains("already fighting")))
		{
			refusedUntil.put(lastOpponent.getName(), bot.tickCount() + REFUSED_TICKS);
			bot.log("refused " + lastOpponent.getName() + ": " + text);
			if (lastOpponent.getInteracting() != bot.self())
			{
				lastOpponent = null;
			}
		}
	}

	/**
	 * Who to fight. Single-way combat: a player attacking us is the opponent. Otherwise keep the
	 * current one while they're alive and near, else the nearest player we're allowed to attack.
	 */
	private Player opponent(Bot bot)
	{
		Player self = bot.self();
		WorldPoint at = bot.position();
		if (self == null || at == null)
		{
			return null;
		}
		Player attacker = null;
		Player nearest = null;
		for (Player player : bot.client.getTopLevelWorldView().players())
		{
			if (player == null || player == self || player.isDead() || player.getWorldLocation().distanceTo2D(at) > SEARCH_RADIUS)
			{
				continue;
			}
			if (player.getInteracting() == self && (attacker == null || attacker != lastOpponent))
			{
				attacker = player;
			}
			boolean refused = refusedUntil.getOrDefault(player.getName(), -1) > bot.tickCount();
			// Single-way combat: a player already fighting someone else can't be attacked.
			boolean busy = player.getInteracting() != null && player.getInteracting() != self;
			if (!refused && !busy && (!rules.wilderness || attackable(self, player)) && (nearest == null
				|| player.getWorldLocation().distanceTo2D(at) < nearest.getWorldLocation().distanceTo2D(at)))
			{
				nearest = player;
			}
		}
		if (attacker != null)
		{
			return attacker;
		}
		if (lastOpponent != null && !lastOpponent.isDead() && lastOpponent.getWorldLocation().distanceTo2D(at) <= SEARCH_RADIUS
			&& refusedUntil.getOrDefault(lastOpponent.getName(), -1) <= bot.tickCount())
		{
			return lastOpponent;
		}
		return !rules.wilderness || bot.client.getVarbitValue(WILDERNESS_VARBIT) == 1 ? nearest : null;
	}

	/**
	 * Escaping: under ESCAPE_AT of max Hitpoints with no food, brew or karambwan left. In the
	 * Wilderness a teleport tablet if it works there (level 20 and below), else run: away from the
	 * opponent, or, where there's somewhere safe to head (the LMS safe zone's centre), there.
	 * Back to fighting once Hitpoints are over half again (a kill refills them in LMS).
	 */
	private boolean escaping(Bot bot, Player opponent)
	{
		Actions act = bot.actions;
		int hp = bot.hitpoints();
		int maxHp = bot.maxHitpoints();
		boolean noFood = act.slotWhere(item -> Actions.hasOption(item, "Eat")) < 0 && act.slotNamed("Saradomin brew") < 0;
		if (escape && hp > maxHp / 2)
		{
			escape = false;
			bot.log("back to fighting (hp " + hp + ")");
		}
		if (!escape && (hp > maxHp * ESCAPE_AT || !noFood))
		{
			return false;
		}
		if (!escape)
		{
			escape = true;
			bot.log("escaping at " + hp + "/" + maxHp + " with nothing left to eat");
		}
		if (rules.wilderness && wildernessLevel(bot.position()) <= 20)
		{
			int tab = act.slotWhere(item -> Actions.hasOption(item, "Break"));
			if (tab >= 0)
			{
				bot.log("teleport out");
				act.itemOption(tab, "Break");
				return true;
			}
		}
		if (bot.client.getLocalDestinationLocation() != null || bot.tickCount() < frozenUntil)
		{
			return true;
		}
		WorldPoint at = bot.position();
		WorldPoint safe = roamTo != null ? roamTo.apply(bot) : null;
		WorldPoint goal;
		if (safe != null && at.distanceTo2D(safe) > HOME_RADIUS)
		{
			goal = safe;
		}
		else
		{
			WorldPoint them = opponent.getWorldLocation();
			int dx = Integer.signum(at.getX() - them.getX());
			int dy = Integer.signum(at.getY() - them.getY());
			if (dx == 0 && dy == 0)
			{
				dy = 1;
			}
			goal = new WorldPoint(at.getX() + dx * ESCAPE_STEP, at.getY() + dy * ESCAPE_STEP, at.getPlane());
		}
		act.walkStep(goal);
		return true;
	}

	/** An NPC attacking us, or null. */
	private static net.runelite.api.NPC npcAttacker(Bot bot)
	{
		for (net.runelite.api.NPC npc : bot.client.getTopLevelWorldView().npcs())
		{
			if (npc != null && !npc.isDead() && npc.getInteracting() == bot.self())
			{
				return npc;
			}
		}
		return null;
	}

	/** The Wilderness level of a surface or underground tile (0 outside it). */
	static int wildernessLevel(WorldPoint tile)
	{
		int y = tile.getY();
		if (y >= 3520 && y < 4000)
		{
			return (y - 3520) / 8 + 1;
		}
		if (y >= 9920 && y < 10400)
		{
			return (y - 9920) / 8 + 1;
		}
		return 0;
	}

	/** Wilderness rule: the combat levels must be within the lower of the two Wilderness levels. */
	static boolean attackable(Player self, Player other)
	{
		int range = Math.min(wildernessLevel(self.getWorldLocation()), wildernessLevel(other.getWorldLocation()));
		return range > 0 && Math.abs(self.getCombatLevel() - other.getCombatLevel()) <= range;
	}

	static String weaponName(Bot bot, Player player)
	{
		if (player == null || player.getPlayerComposition() == null)
		{
			return "";
		}
		int id = player.getPlayerComposition().getEquipmentId(KitType.WEAPON);
		return id <= 0 ? "" : bot.client.getItemDefinition(id).getName();
	}

	private static boolean isWeapon(ItemComposition item)
	{
		return Actions.hasOption(item, "Wield") && !isAmmo(item) && !item.getName().toLowerCase().contains("shield")
			&& !item.getName().toLowerCase().contains("defender");
	}

	static boolean isAmmo(ItemComposition item)
	{
		String name = item.getName().toLowerCase();
		return Actions.hasOption(item, "Wield") && (name.contains("bolts") || name.contains("arrow"));
	}

	private static boolean wearingAmmo(Bot bot)
	{
		net.runelite.api.ItemContainer worn = bot.client.getItemContainer(94);
		if (worn == null)
		{
			return false;
		}
		for (Item item : worn.getItems())
		{
			if (item.getId() > 0 && isAmmo(bot.client.getItemDefinition(item.getId())))
			{
				return true;
			}
		}
		return false;
	}

	@Override
	public void stop(Bot bot)
	{
		for (Style style : Style.values())
		{
			bot.actions.prayer(style.protection(), false);
		}
		for (Prayer prayer : new Prayer[]{Prayer.PIETY, Prayer.CHIVALRY, Prayer.RIGOUR, Prayer.EAGLE_EYE, Prayer.AUGURY, Prayer.MYSTIC_MIGHT})
		{
			if (bot.client.isPrayerActive(prayer))
			{
				bot.actions.prayer(prayer, false);
			}
		}
		bot.log(kills + " kills");
	}
}
