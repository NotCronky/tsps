package com.tsps.gauntlethelper;

/**
 * The Gauntlet's ids, per mode (regular, corrupted), as the TSPS server uses them
 * (server/plugins/minigames/gauntlet: Items, Hunllef).
 */
final class GauntletIds
{
	private GauntletIds()
	{
	}

	enum Mode
	{
		REGULAR, CORRUPTED
	}

	enum Style
	{
		MELEE("Melee"), RANGED("Ranged"), MAGIC("Magic");

		final String label;

		Style(String label)
		{
			this.label = label;
		}
	}

	/** One mode's items: shards, resources and gear by tier (basic, attuned, perfected). */
	static final class Items
	{
		final int shards, dust, frame, grymLeaf, linum, ore, bark, vial, spike, bowstring, orb, sceptre;
		final int[] helm, body, legs, halberd, staff, bow;

		Items(int shards, int dust, int frame, int grymLeaf, int linum, int ore, int bark, int vial,
			int spike, int bowstring, int orb, int sceptre,
			int[] helm, int[] body, int[] legs, int[] halberd, int[] staff, int[] bow)
		{
			this.shards = shards;
			this.dust = dust;
			this.frame = frame;
			this.grymLeaf = grymLeaf;
			this.linum = linum;
			this.ore = ore;
			this.bark = bark;
			this.vial = vial;
			this.spike = spike;
			this.bowstring = bowstring;
			this.orb = orb;
			this.sceptre = sceptre;
			this.helm = helm;
			this.body = body;
			this.legs = legs;
			this.halberd = halberd;
			this.staff = staff;
			this.bow = bow;
		}
	}

	static final Items REGULAR_ITEMS = new Items(23866, 23867, 23871, 23875, 23876, 23877, 23878, 23879,
		23868, 23869, 23870, 23861,
		new int[]{23886, 23887, 23888}, new int[]{23889, 23890, 23891}, new int[]{23892, 23893, 23894},
		new int[]{23895, 23896, 23897}, new int[]{23898, 23899, 23900}, new int[]{23901, 23902, 23903});

	static final Items CORRUPTED_ITEMS = new Items(23824, 23830, 23834, 23835, 23836, 23837, 23838, 23839,
		23831, 23832, 23833, 23820,
		new int[]{23840, 23841, 23842}, new int[]{23843, 23844, 23845}, new int[]{23846, 23847, 23848},
		new int[]{23849, 23850, 23851}, new int[]{23852, 23853, 23854}, new int[]{23855, 23856, 23857});

	static Items items(Mode mode)
	{
		return mode == Mode.CORRUPTED ? CORRUPTED_ITEMS : REGULAR_ITEMS;
	}

	// Shared by both modes.
	static final int WATER_VIAL = 23880;
	static final int GRYM_POTION_UNF = 23881;
	static final int EGNIOL_FIRST = 23882;
	static final int EGNIOL_LAST = 23885;
	static final int RAW_PADDLEFISH = 23872;
	static final int PADDLEFISH = 23874;
	static final int COMBO_FISH_REGULAR = 25960;
	static final int COMBO_FISH_CORRUPTED = 25958;

	/** Armour cost per piece and tier (helm, body, legs x basic, attuned, perfected): resources each, shards. */
	static final int[][][] ARMOUR_COST = {
		{{1, 50}, {1, 50}, {2, 100}},
		{{1, 50}, {2, 100}, {2, 100}},
		{{1, 50}, {1, 50}, {2, 100}},
	};
	static final int WEAPON_ATTUNE_SHARDS = 50;
	static final int SHARDS_PER_VIAL = 10;
	static final int DUST_PER_POTION = 10;

	// The Hunllef: its forms by what it protects against, tornadoes, floor, projectiles, animations.
	static final int[] HUNLLEF_REGULAR = {9021, 9022, 9023};
	static final int[] HUNLLEF_CORRUPTED = {9035, 9036, 9037};
	static final int TORNADO_REGULAR = 9025;
	static final int TORNADO_CORRUPTED = 9039;
	static final int FLOOR_REGULAR = 36149;
	static final int FLOOR_CORRUPTED = 36046;
	static final int PROJECTILE_RANGED_REGULAR = 1711;
	static final int PROJECTILE_RANGED_CORRUPTED = 1712;
	static final int PROJECTILE_MAGIC_REGULAR = 1707;
	static final int PROJECTILE_MAGIC_CORRUPTED = 1708;
	static final int PROJECTILE_DISABLE_REGULAR = 1713;
	static final int PROJECTILE_DISABLE_CORRUPTED = 1714;
	static final int ANIM_TORNADO = 8418;
	/** Ticks between tornado summons (the server's). */
	static final int TORNADO_EVERY = 56;
	static final int HITS_PER_PROTECTION_SWITCH = 6;
	static final int ATTACKS_PER_STYLE = 4;

	/** What a Hunllef form protects against, or null if the id isn't the Hunllef. */
	static Style hunllefProtection(int npcId)
	{
		for (int i = 0; i < 3; i++)
		{
			if (HUNLLEF_REGULAR[i] == npcId || HUNLLEF_CORRUPTED[i] == npcId)
			{
				return Style.values()[i];
			}
		}
		return null;
	}

	static Mode hunllefMode(int npcId)
	{
		for (int id : HUNLLEF_CORRUPTED)
		{
			if (id == npcId)
			{
				return Mode.CORRUPTED;
			}
		}
		return Mode.REGULAR;
	}

	static boolean isTornado(int npcId)
	{
		return npcId == TORNADO_REGULAR || npcId == TORNADO_CORRUPTED;
	}

	/** Floor look: 0 plain/other, 1 about to burn (blue or crimson), 2 burning (orange). */
	static int floorLook(int objectId)
	{
		if (objectId == FLOOR_REGULAR + 1 || objectId == FLOOR_CORRUPTED + 1)
		{
			return 1;
		}
		if (objectId == FLOOR_REGULAR + 2 || objectId == FLOOR_CORRUPTED + 2)
		{
			return 2;
		}
		return 0;
	}

	/** The style of a Hunllef projectile, or null if it isn't one. */
	static Style projectileStyle(int projectileId)
	{
		switch (projectileId)
		{
			case PROJECTILE_RANGED_REGULAR:
			case PROJECTILE_RANGED_CORRUPTED:
				return Style.RANGED;
			case PROJECTILE_MAGIC_REGULAR:
			case PROJECTILE_MAGIC_CORRUPTED:
			case PROJECTILE_DISABLE_REGULAR:
			case PROJECTILE_DISABLE_CORRUPTED:
				return Style.MAGIC;
			default:
				return null;
		}
	}

	static boolean isPrayerDisable(int projectileId)
	{
		return projectileId == PROJECTILE_DISABLE_REGULAR || projectileId == PROJECTILE_DISABLE_CORRUPTED;
	}

	/** The style of a wielded Gauntlet weapon; anything else (or nothing) is melee. */
	static Style weaponStyle(int weaponId)
	{
		for (Items items : new Items[]{REGULAR_ITEMS, CORRUPTED_ITEMS})
		{
			if (contains(items.bow, weaponId))
			{
				return Style.RANGED;
			}
			if (contains(items.staff, weaponId))
			{
				return Style.MAGIC;
			}
		}
		return Style.MELEE;
	}

	static boolean contains(int[] ids, int id)
	{
		for (int value : ids)
		{
			if (value == id)
			{
				return true;
			}
		}
		return false;
	}

	/** The mode of a run from what the player carries, or null when nothing is from the Gauntlet. */
	static Mode modeOf(java.util.Map<Integer, Integer> held)
	{
		if (held.containsKey(CORRUPTED_ITEMS.sceptre) || held.containsKey(CORRUPTED_ITEMS.shards))
		{
			return Mode.CORRUPTED;
		}
		if (held.containsKey(REGULAR_ITEMS.sceptre) || held.containsKey(REGULAR_ITEMS.shards))
		{
			return Mode.REGULAR;
		}
		return null;
	}
}
