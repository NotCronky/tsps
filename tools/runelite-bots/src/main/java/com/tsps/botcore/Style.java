package com.tsps.botcore;

import java.util.Locale;
import net.runelite.api.HeadIcon;
import net.runelite.api.Prayer;

/** A combat style, worked out from a weapon's name, and the prayers on either side of it. */
public enum Style
{
	MELEE, RANGED, MAGIC;

	private static final String[] RANGED_WORDS = {
		"bow", "ballista", "blowpipe", "dart", "knife", "thrownaxe", "chinchompa", "javelin", "blowpipe", "toktz-xil-ul",
	};
	private static final String[] MAGIC_WORDS = {
		"staff", "wand", "sceptre", "trident", "sanguinesti", "kodai", "tumeken", "shadow", "nightmare", "volatile", "eldritch",
		"harmonised", "tome",
	};

	/** The style a weapon attacks with, from its name; empty hands punch (melee). */
	public static Style ofWeapon(String name)
	{
		if (name == null || name.isEmpty() || name.equals("null"))
		{
			return MELEE;
		}
		String lower = name.toLowerCase(Locale.ROOT);
		// "Crossbow" contains "bow"; "battlestaff" contains "staff"; checked in that order.
		for (String word : RANGED_WORDS)
		{
			if (lower.contains(word))
			{
				return RANGED;
			}
		}
		for (String word : MAGIC_WORDS)
		{
			if (lower.contains(word))
			{
				return MAGIC;
			}
		}
		return MELEE;
	}

	/** The protection prayer against this style. */
	public Prayer protection()
	{
		switch (this)
		{
			case RANGED:
				return Prayer.PROTECT_FROM_MISSILES;
			case MAGIC:
				return Prayer.PROTECT_FROM_MAGIC;
			default:
				return Prayer.PROTECT_FROM_MELEE;
		}
	}

	/** Whether an overhead prayer icon protects against this style. */
	public boolean blockedBy(HeadIcon overhead)
	{
		if (overhead == null)
		{
			return false;
		}
		String icon = overhead.name();
		switch (this)
		{
			case RANGED:
				return icon.contains("RANGE");
			case MAGIC:
				return icon.contains("MAGE") || icon.equals("MAGIC");
			default:
				return icon.contains("MELEE");
		}
	}
}
