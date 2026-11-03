package com.cronky.tspsagility;

import java.util.ArrayDeque;
import java.util.Deque;
import net.runelite.api.CollisionDataFlag;

/**
 * Whether one scene tile can be walked to from another within a few steps, over the client's
 * collision flags (scene x/y). A rooftop course's sections sit on the same floor with gaps
 * between them, so a mark of grace counts as on "this part of the course" only if it is reachable.
 */
final class Reach
{
	private static final int FULL = CollisionDataFlag.BLOCK_MOVEMENT_FULL;
	private static final int NORTH = CollisionDataFlag.BLOCK_MOVEMENT_NORTH;
	private static final int EAST = CollisionDataFlag.BLOCK_MOVEMENT_EAST;
	private static final int SOUTH = CollisionDataFlag.BLOCK_MOVEMENT_SOUTH;
	private static final int WEST = CollisionDataFlag.BLOCK_MOVEMENT_WEST;

	private Reach()
	{
	}

	static boolean reachable(int[][] flags, int fromX, int fromY, int toX, int toY, int maxSteps)
	{
		int size = flags.length;
		if (!inside(size, fromX, fromY) || !inside(size, toX, toY))
		{
			return false;
		}
		int[][] steps = new int[size][size];
		for (int[] column : steps)
		{
			java.util.Arrays.fill(column, -1);
		}
		Deque<int[]> queue = new ArrayDeque<>();
		steps[fromX][fromY] = 0;
		queue.add(new int[]{fromX, fromY});
		while (!queue.isEmpty())
		{
			int[] at = queue.poll();
			int x = at[0];
			int y = at[1];
			if (x == toX && y == toY)
			{
				return true;
			}
			if (steps[x][y] >= maxSteps)
			{
				continue;
			}
			// A step is blocked by a wall on this tile's side, the next tile's facing wall, or a solid next tile.
			visit(flags, steps, queue, x, y, 0, 1, NORTH, SOUTH);
			visit(flags, steps, queue, x, y, 1, 0, EAST, WEST);
			visit(flags, steps, queue, x, y, 0, -1, SOUTH, NORTH);
			visit(flags, steps, queue, x, y, -1, 0, WEST, EAST);
		}
		return false;
	}

	private static void visit(int[][] flags, int[][] steps, Deque<int[]> queue, int x, int y, int dx, int dy, int leaving, int entering)
	{
		int nx = x + dx;
		int ny = y + dy;
		if (!inside(flags.length, nx, ny) || steps[nx][ny] >= 0)
		{
			return;
		}
		if ((flags[x][y] & leaving) != 0 || (flags[nx][ny] & (entering | FULL)) != 0)
		{
			return;
		}
		steps[nx][ny] = steps[x][y] + 1;
		queue.add(new int[]{nx, ny});
	}

	private static boolean inside(int size, int x, int y)
	{
		return x >= 0 && y >= 0 && x < size && y < size;
	}
}
