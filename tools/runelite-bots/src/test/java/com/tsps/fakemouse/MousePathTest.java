package com.tsps.fakemouse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Random;
import org.junit.jupiter.api.Test;

class MousePathTest
{
	private static int time(List<MousePath.Frame> path)
	{
		return path.get(path.size() - 1).at;
	}

	@Test
	void endsExactlyOnTheTargetWithTimeMovingForward()
	{
		for (int seed = 0; seed < 200; seed++)
		{
			List<MousePath.Frame> path = MousePath.plan(10, 20, 640, 410, 20, MousePath.Speed.HUMAN, new Random(seed));
			MousePath.Frame last = path.get(path.size() - 1);
			assertEquals(640, last.x);
			assertEquals(410, last.y);
			for (int i = 1; i < path.size(); i++)
			{
				assertTrue(path.get(i).at > path.get(i - 1).at, "frames move forward in time");
			}
		}
	}

	@Test
	void timingFollowsFittsLaw()
	{
		assertTrue(MousePath.duration(MousePath.Speed.HUMAN, 600, 20) > MousePath.duration(MousePath.Speed.HUMAN, 100, 20), "further is slower");
		assertTrue(MousePath.duration(MousePath.Speed.HUMAN, 300, 60) < MousePath.duration(MousePath.Speed.HUMAN, 300, 10), "bigger targets are quicker");
		double fast = MousePath.duration(MousePath.Speed.FAST, 400, 20);
		double human = MousePath.duration(MousePath.Speed.HUMAN, 400, 20);
		assertTrue(fast < human * 0.6, "Fast is about twice as quick: " + fast + " vs " + human);
		// A 400px move onto a 20px target: about a third of a second at human speed.
		assertTrue(human > 250 && human < 600, "human-scale timing: " + human);
	}

	@Test
	void longMovesSometimesOvershootAndCorrect()
	{
		// One generator for the lot, as the fake mouse keeps one: Random's first draw barely varies across small seeds.
		Random random = new Random(42);
		int overshoots = 0;
		for (int i = 0; i < 400; i++)
		{
			List<MousePath.Frame> path = MousePath.plan(0, 0, 500, 0, 20, MousePath.Speed.HUMAN, random);
			if (path.stream().anyMatch(f -> f.x > 510))
			{
				overshoots++;
			}
		}
		assertTrue(overshoots > 40 && overshoots < 180, "about a quarter overshoot: " + overshoots + "/400");
		for (int i = 0; i < 100; i++)
		{
			List<MousePath.Frame> path = MousePath.plan(0, 0, 60, 0, 20, MousePath.Speed.HUMAN, random);
			assertTrue(path.stream().noneMatch(f -> f.x > 70), "short hops don't overshoot");
		}
	}

	@Test
	void aimsInsideTheTargetTowardsItsMiddle()
	{
		Random random = new Random(7);
		double total = 0;
		for (int i = 0; i < 1000; i++)
		{
			int[] aim = MousePath.aimInside(100, 100, 40, 20, random);
			assertTrue(Math.abs(aim[0] - 100) <= 16 && Math.abs(aim[1] - 100) <= 8, "inside the middle 80%");
			total += Math.abs(aim[0] - 100);
		}
		assertTrue(total / 1000 < 6, "clustered towards the middle");
	}
}
