package com.tsps.profiles;

import static org.junit.jupiter.api.Assertions.assertEquals;

import net.runelite.api.coords.WorldPoint;
import org.junit.jupiter.api.Test;

class PvpFighterTest
{
	@Test
	void wildernessLevelsFromTheTile()
	{
		assertEquals(0, PvpFighter.wildernessLevel(new WorldPoint(3093, 3500, 0)), "Edgeville");
		assertEquals(1, PvpFighter.wildernessLevel(new WorldPoint(3108, 3525, 0)), "just over the ditch");
		assertEquals(2, PvpFighter.wildernessLevel(new WorldPoint(3108, 3531, 0)), "the bot site: the client shows 124-126 for a 126");
		assertEquals(11, PvpFighter.wildernessLevel(new WorldPoint(3100, 3600, 0)));
		assertEquals(46, PvpFighter.wildernessLevel(new WorldPoint(3017, 3880, 0)));
		assertEquals(6, PvpFighter.wildernessLevel(new WorldPoint(3100, 9965, 0)), "underground");
	}
}
