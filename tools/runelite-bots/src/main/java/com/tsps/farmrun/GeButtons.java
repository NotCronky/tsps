package com.tsps.farmrun;

import java.util.ArrayList;
import java.util.List;

/**
 * The offer panel's quantity buttons (465:34 slots, as the server's GrandExchange plugin reads
 * them): 2 is +1, 4 is +10, 5 is +100. A new offer starts at 1, and the first +10 or +100 from 1
 * sets it to 10 or 100 rather than adding.
 */
public final class GeButtons
{
	public static final int PLUS_1 = 2;
	public static final int PLUS_10 = 4;
	public static final int PLUS_100 = 5;
	/** +5% on the price; two of them make an offer fill in seconds. */
	public static final int PRICE_PLUS_5_PERCENT = 13;

	private GeButtons()
	{
	}

	/** The button presses that take a new offer's quantity from 1 to `quantity`. */
	public static List<Integer> quantityPresses(int quantity)
	{
		List<Integer> presses = new ArrayList<>();
		int current = 1;
		int[][] steps = {{PLUS_100, 100}, {PLUS_10, 10}, {PLUS_1, 1}};
		for (int[] step : steps)
		{
			while (true)
			{
				int next = step[1] > 1 && current == 1 ? step[1] : current + step[1];
				if (next > quantity)
				{
					break;
				}
				presses.add(step[0]);
				current = next;
			}
		}
		return presses;
	}
}
