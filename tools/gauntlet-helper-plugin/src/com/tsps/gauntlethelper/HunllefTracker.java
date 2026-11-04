package com.tsps.gauntlethelper;

import com.tsps.gauntlethelper.GauntletIds.Style;

/**
 * Follows the Hunllef fight from what the client sees: it attacks with Ranged first and switches
 * to the other style every 4 attacks (tornado summons count, the stomp doesn't); it protects
 * against one style and switches to the style of the 6th hit it doesn't protect against.
 * A projectile of the other style re-syncs the count (e.g. after joining mid-fight).
 */
final class HunllefTracker
{
	Style attackStyle = Style.RANGED;
	/** Attacks of {@link #attackStyle} still to come before it switches. */
	int attacksLeft = GauntletIds.ATTACKS_PER_STYLE;
	Style protecting;
	/** Off-prayer hits still needed before it changes what it protects against. */
	int hitsLeft = GauntletIds.HITS_PER_PROTECTION_SWITCH;
	/** Game tick of its last tornado summon, or of the fight's start before the first. */
	int tornadoTick;
	/** It has attacked at least once this fight. */
	boolean attacked;

	void start(Style protecting, int tick)
	{
		attackStyle = Style.RANGED;
		attacksLeft = GauntletIds.ATTACKS_PER_STYLE;
		this.protecting = protecting;
		hitsLeft = GauntletIds.HITS_PER_PROTECTION_SWITCH;
		tornadoTick = tick;
		attacked = false;
	}

	/** One of its attacks: {@code seen} is the projectile's style, or null for a tornado summon. */
	void onAttack(Style seen)
	{
		attacked = true;
		if (seen != null && seen != attackStyle)
		{
			attackStyle = seen;
			attacksLeft = GauntletIds.ATTACKS_PER_STYLE;
		}
		attacksLeft--;
		if (attacksLeft <= 0)
		{
			attackStyle = attackStyle == Style.RANGED ? Style.MAGIC : Style.RANGED;
			attacksLeft = GauntletIds.ATTACKS_PER_STYLE;
		}
	}

	void onTornadoes(int tick)
	{
		tornadoTick = tick;
		onAttack(null);
	}

	/** It took a new form: what it protects against changed. */
	void onProtection(Style style)
	{
		if (style != protecting)
		{
			protecting = style;
			hitsLeft = GauntletIds.HITS_PER_PROTECTION_SWITCH;
		}
	}

	/** One of the player's hits landed on it, with a weapon of {@code style}. */
	void onPlayerHit(Style style)
	{
		if (style != protecting && hitsLeft > 0)
		{
			hitsLeft--;
		}
	}

	boolean blocked(Style weapon)
	{
		return weapon == protecting;
	}

	int ticksToTornadoes(int tick)
	{
		return Math.max(0, tornadoTick + GauntletIds.TORNADO_EVERY - tick);
	}
}
