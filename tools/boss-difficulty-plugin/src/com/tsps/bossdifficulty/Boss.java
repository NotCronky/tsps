package com.tsps.bossdifficulty;

/** One ranked boss. {@code score} (1-100) orders the list; the tier comes from it. */
final class Boss
{
	final String name;
	final int score;
	final Category category;
	/** Kill-count varp (what the boss log reads); -1 when there is none. */
	final int killVarp;
	final String bring;
	final String[] tips;
	final String wikiPage;

	Boss(String name, int score, Category category, int killVarp, String bring, String wikiPage, String... tips)
	{
		this.name = name;
		this.score = score;
		this.category = category;
		this.killVarp = killVarp;
		this.bring = bring;
		this.tips = tips;
		this.wikiPage = wikiPage;
	}

	Tier tier()
	{
		return Tier.of(score);
	}

	String wikiUrl()
	{
		return "https://oldschool.runescape.wiki/w/" + wikiPage.replace(' ', '_');
	}

	enum Category
	{
		SOLO("Solo"),
		SLAYER("Slayer"),
		WILDERNESS("Wilderness"),
		GROUP("Group"),
		MINIGAME("Minigame"),
		RAID("Raid");

		final String label;

		Category(String label)
		{
			this.label = label;
		}
	}
}
