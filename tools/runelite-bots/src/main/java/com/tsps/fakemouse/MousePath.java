package com.tsps.fakemouse;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/**
 * A human-like mouse movement from one point to another, as timed frames.
 *
 * - Duration follows Fitts's law: a + b * log2(distance / width + 1), so long moves to small
 *   targets take longer than short hops onto big ones, with a little variation.
 * - Speed follows the minimum-jerk profile hands move with: it builds up, then eases into the target.
 * - The path bends (a cubic curve with two control points off the straight line) and carries a slight
 *   tremor that fades as it closes in.
 * - Long moves sometimes overshoot and correct with a second, short movement.
 */
public final class MousePath
{
	/** How fast the hand is: Fitts's law intercept and slope, in milliseconds. */
	public enum Speed
	{
		RELAXED(110, 150), HUMAN(70, 105), FAST(35, 55);

		final int intercept;
		final int slope;

		Speed(int intercept, int slope)
		{
			this.intercept = intercept;
			this.slope = slope;
		}
	}

	public static final class Frame
	{
		public final int x;
		public final int y;
		/** Milliseconds after the movement starts. */
		public final int at;

		Frame(int x, int y, int at)
		{
			this.x = x;
			this.y = y;
			this.at = at;
		}
	}

	static final int FRAME_MS = 8;
	/** Moves at least this long (in pixels) may overshoot. */
	static final double OVERSHOOT_MIN_DISTANCE = 150;
	static final double OVERSHOOT_CHANCE = 0.25;

	private MousePath()
	{
	}

	/** Fitts's law movement time in milliseconds, before variation. */
	static double duration(Speed speed, double distance, double width)
	{
		return speed.intercept + speed.slope * (Math.log(distance / Math.max(4, width) + 1) / Math.log(2));
	}

	/** The frames from (fromX, fromY) to (toX, toY) onto a target `width` pixels across. Ends exactly on the target. */
	public static List<Frame> plan(int fromX, int fromY, int toX, int toY, double width, Speed speed, Random random)
	{
		List<Frame> frames = new ArrayList<>();
		double distance = Math.hypot(toX - fromX, toY - fromY);
		if (distance < 1)
		{
			frames.add(new Frame(toX, toY, 0));
			return frames;
		}
		if (distance >= OVERSHOOT_MIN_DISTANCE && random.nextDouble() < OVERSHOOT_CHANCE)
		{
			// Past the target along the line, a little to one side, then a short correction back.
			double past = distance * (0.04 + random.nextDouble() * 0.06);
			double ux = (toX - fromX) / distance;
			double uy = (toY - fromY) / distance;
			double side = (random.nextDouble() - 0.5) * past;
			int overX = (int) Math.round(toX + ux * past - uy * side);
			int overY = (int) Math.round(toY + uy * past + ux * side);
			segment(frames, fromX, fromY, overX, overY, width, speed, random, 0);
			int pause = 20 + random.nextInt(40);
			segment(frames, overX, overY, toX, toY, width, speed, random, frames.get(frames.size() - 1).at + pause);
		}
		else
		{
			segment(frames, fromX, fromY, toX, toY, width, speed, random, 0);
		}
		return frames;
	}

	private static void segment(List<Frame> frames, int fromX, int fromY, int toX, int toY, double width, Speed speed,
		Random random, int start)
	{
		double dx = toX - fromX;
		double dy = toY - fromY;
		double distance = Math.hypot(dx, dy);
		int time = (int) Math.max(FRAME_MS, duration(speed, distance, width) * (0.85 + random.nextDouble() * 0.3));
		// Two control points off to the sides bend the path; bigger moves bend more.
		double nx = -dy / Math.max(1, distance);
		double ny = dx / Math.max(1, distance);
		double bend1 = (random.nextDouble() - 0.5) * Math.min(120, distance * 0.25);
		double bend2 = (random.nextDouble() - 0.5) * Math.min(120, distance * 0.25);
		double c1x = fromX + dx * 0.3 + nx * bend1;
		double c1y = fromY + dy * 0.3 + ny * bend1;
		double c2x = fromX + dx * 0.7 + nx * bend2;
		double c2y = fromY + dy * 0.7 + ny * bend2;
		int count = Math.max(1, time / FRAME_MS);
		for (int i = 1; i <= count; i++)
		{
			double t = (double) i / count;
			// Minimum jerk: 10t^3 - 15t^4 + 6t^5.
			double s = t * t * t * (10 - 15 * t + 6 * t * t);
			double u = 1 - s;
			double x = u * u * u * fromX + 3 * u * u * s * c1x + 3 * u * s * s * c2x + s * s * s * toX;
			double y = u * u * u * fromY + 3 * u * u * s * c1y + 3 * u * s * s * c2y + s * s * s * toY;
			if (i < count)
			{
				// Tremor, fading out on the approach.
				double tremor = 1.2 * (1 - s);
				x += random.nextGaussian() * tremor;
				y += random.nextGaussian() * tremor;
			}
			frames.add(new Frame(i == count ? toX : (int) Math.round(x), i == count ? toY : (int) Math.round(y),
				start + i * FRAME_MS));
		}
	}

	/** A point inside `width` x `height` around (cx, cy), clustered towards the middle as people aim. */
	public static int[] aimInside(double cx, double cy, double width, double height, Random random)
	{
		double x = cx + clamp(random.nextGaussian() / 3, -1, 1) * width * 0.4;
		double y = cy + clamp(random.nextGaussian() / 3, -1, 1) * height * 0.4;
		return new int[]{(int) Math.round(x), (int) Math.round(y)};
	}

	private static double clamp(double value, double min, double max)
	{
		return Math.max(min, Math.min(max, value));
	}
}
