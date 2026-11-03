package com.tsps.botcore;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.runelite.api.HeadIcon;
import net.runelite.api.Prayer;
import org.junit.jupiter.api.Test;

class StyleTest
{
	@Test
	void weaponsByName()
	{
		assertEquals(Style.MELEE, Style.ofWeapon("Abyssal whip"));
		assertEquals(Style.MELEE, Style.ofWeapon("Armadyl godsword"));
		assertEquals(Style.MELEE, Style.ofWeapon(""), "empty hands punch");
		assertEquals(Style.RANGED, Style.ofWeapon("Armadyl crossbow"));
		assertEquals(Style.RANGED, Style.ofWeapon("Magic shortbow"));
		assertEquals(Style.RANGED, Style.ofWeapon("Toxic blowpipe"));
		assertEquals(Style.RANGED, Style.ofWeapon("Rune knife"));
		assertEquals(Style.MAGIC, Style.ofWeapon("Ancient staff"));
		assertEquals(Style.MAGIC, Style.ofWeapon("Kodai wand"));
		assertEquals(Style.MAGIC, Style.ofWeapon("Trident of the swamp"));
		assertEquals(Style.MAGIC, Style.ofWeapon("Mystic smoke staff"));
	}

	@Test
	void prayersAndOverheads()
	{
		assertEquals(Prayer.PROTECT_FROM_MELEE, Style.MELEE.protection());
		assertEquals(Prayer.PROTECT_FROM_MISSILES, Style.RANGED.protection());
		assertTrue(Style.MELEE.blockedBy(HeadIcon.MELEE));
		assertTrue(Style.RANGED.blockedBy(HeadIcon.RANGE_MELEE));
		assertTrue(Style.MAGIC.blockedBy(HeadIcon.MAGIC));
		assertFalse(Style.MELEE.blockedBy(HeadIcon.RANGED));
		assertFalse(Style.MAGIC.blockedBy(HeadIcon.SMITE));
		assertFalse(Style.RANGED.blockedBy(null));
	}
}
