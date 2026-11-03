package com.cronky.tspsagility;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.runelite.api.CollisionDataFlag;
import org.junit.jupiter.api.Test;

class ReachTest
{
	private static int[][] open()
	{
		return new int[20][20];
	}

	@Test
	void aMarkOnTheSameRoofIsReachable()
	{
		assertTrue(Reach.reachable(open(), 2, 2, 8, 5, 24));
	}

	@Test
	void aMarkAcrossAGapIsNot()
	{
		int[][] flags = open();
		// The gap between two roofs: a column of tiles nobody can stand on.
		for (int y = 0; y < 20; y++)
		{
			flags[10][y] = CollisionDataFlag.BLOCK_MOVEMENT_FULL;
		}
		assertFalse(Reach.reachable(flags, 5, 5, 15, 5, 24));
		assertTrue(Reach.reachable(flags, 5, 5, 9, 12, 24), "this side of the gap is fine");
	}

	@Test
	void wallsBlockAndDistanceIsCapped()
	{
		int[][] flags = open();
		// A wall along x=4/5, all the way down: east side of x=4, west side of x=5.
		for (int y = 0; y < 20; y++)
		{
			flags[4][y] |= CollisionDataFlag.BLOCK_MOVEMENT_EAST;
			flags[5][y] |= CollisionDataFlag.BLOCK_MOVEMENT_WEST;
		}
		assertFalse(Reach.reachable(flags, 3, 3, 6, 3, 24));
		assertFalse(Reach.reachable(open(), 0, 0, 19, 19, 24), "38 steps is beyond the cap");
	}
}
