package com.tsps.botcore;

/**
 * A bot for one activity (a boss, a fight). The host calls tick() each game tick while it runs and
 * no click is still on its way; it does at most what one hand can (one click, plus a prayer).
 */
public interface Profile
{
	/** The name for ::tspsbot (one word, lower case) and the fake mouse's banner. */
	String key();

	String name();

	default void start(Bot bot)
	{
	}

	/** One tick of the activity. Returns null to keep going, or why it stopped. */
	String tick(Bot bot);

	/** Tidies up when the profile stops (protection prayers off, say). */
	default void stop(Bot bot)
	{
	}

	/** A game message (chat box), for profiles that react to them. */
	default void message(Bot bot, String text)
	{
	}
}
