package com.tsps.botcore;

import static org.junit.jupiter.api.Assertions.assertEquals;

import net.runelite.api.Prayer;
import org.junit.jupiter.api.Test;

class ActionsTest
{
	@Test
	void prayerLabelsMatchTheirButtons()
	{
		assertEquals("Protect from Melee", Actions.label(Prayer.PROTECT_FROM_MELEE));
		assertEquals("Protect from Missiles", Actions.label(Prayer.PROTECT_FROM_MISSILES));
		assertEquals("Protect from Magic", Actions.label(Prayer.PROTECT_FROM_MAGIC));
		assertEquals("Eagle Eye", Actions.label(Prayer.EAGLE_EYE));
		assertEquals("Piety", Actions.label(Prayer.PIETY));
	}
}
