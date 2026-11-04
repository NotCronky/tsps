package com.tsps.bossdifficulty;

import java.awt.Color;

enum Tier
{
	BEGINNER("Beginner", 1, new Color(0x5BC0EB)),
	EASY("Easy", 20, new Color(0x7BC950)),
	MEDIUM("Medium", 40, new Color(0xF2C14E)),
	HARD("Hard", 55, new Color(0xF78154)),
	ELITE("Elite", 70, new Color(0xD7263D)),
	MASTER("Master", 85, new Color(0xB15EFF));

	final String label;
	final int from;
	final Color color;

	Tier(String label, int from, Color color)
	{
		this.label = label;
		this.from = from;
		this.color = color;
	}

	static Tier of(int score)
	{
		Tier found = BEGINNER;
		for (Tier tier : values())
		{
			if (score >= tier.from)
			{
				found = tier;
			}
		}
		return found;
	}
}
