package com.tsps.profiles;

import com.tsps.botcore.Actions;
import com.tsps.botcore.Bot;
import com.tsps.botcore.Profile;
import net.runelite.api.Actor;
import net.runelite.api.NPC;
import net.runelite.api.Prayer;

/**
 * King Black Dragon, in melee: the server's KBD (server/plugins/bosses/KingBlackDragon.plugin.js)
 * bites at melee range two times in three and otherwise breathes one of four dragonfires, all
 * cut by an anti-dragon shield and antifire; ice freezes and poison poisons. So: Protect from
 * Melee, the shield, antifire kept up, prayer potions, food, antidote, and attack.
 *
 * Each tick, the most urgent of: get out (no food and low), eat, cure poison, antifire, prayer
 * potion; then, with the dragon alive, Protect from Melee, the shield and attack, or between kills,
 * prayer off, loot and wait for it to come back.
 */
public final class KingBlackDragon implements Profile
{
	static final String NPC_NAME = "King Black Dragon";
	static final int ANTI_DRAGON_SHIELD = 1540;
	/** Eat at this share of max Hitpoints; get out below the second with nothing left to eat. */
	static final double EAT_AT = 0.55;
	static final double FLEE_AT = 0.40;
	static final int PRAYER_POTION_AT = 15;
	/** Ticks after drinking before antifire is drunk again: 20 seconds early (a tick is 0.6s). */
	private static final int ANTIFIRE_MARGIN_TICKS = 33;
	private static final String[] ANTIFIRES = {
		"Extended super antifire", "Super antifire", "Extended antifire", "Antifire",
	};
	private static final String[] PRAYER_RESTORES = {"Prayer potion", "Super restore"};
	private static final String[] ANTIPOISONS = {"Antidote++", "Antidote+", "Anti-venom", "Superantipoison", "Antipoison", "Sanfew serum"};

	/** Loot worth taking: always these, else anything worth this much a stack. */
	static final java.util.Set<String> ALWAYS_LOOT = java.util.Set.of("Dragon bones", "Black dragonhide");
	static final long LOOT_MIN_VALUE = 2000;
	/** Hitpoints missing before a piece of food is eaten just to make room for loot. */
	static final int EAT_FOR_ROOM_MISSING = 20;
	/** How long to wait for the dragon to come back before giving up (90 seconds). */
	static final int RESPAWN_WAIT_TICKS = 150;

	private int antifireUntil = -1;
	private int lastEat = -10;
	private int lastCure = -10;
	private int kills;
	private boolean fighting;
	private net.runelite.api.coords.WorldPoint diedAt;
	private int goneSince = -1;
	private final java.util.Map<String, Integer> lootTries = new java.util.HashMap<>();

	@Override
	public String key()
	{
		return "kbd";
	}

	@Override
	public String name()
	{
		return "TSPS King Black Dragon";
	}

	/** Seconds of protection the server gives each antifire (Potions.plugin.js). */
	static int antifireSeconds(String potion)
	{
		if (potion.startsWith("Extended super antifire"))
		{
			return 360;
		}
		if (potion.startsWith("Super antifire"))
		{
			return 180;
		}
		if (potion.startsWith("Extended antifire"))
		{
			return 720;
		}
		return 360;
	}

	@Override
	public String tick(Bot bot)
	{
		Actions act = bot.actions;
		int hp = bot.hitpoints();
		int maxHp = bot.maxHitpoints();
		int food = act.slotWhere(item -> Actions.hasOption(item, "Eat"));

		if (hp < maxHp * FLEE_AT && food < 0)
		{
			int tab = act.slotWhere(item -> Actions.hasOption(item, "Break"));
			if (tab >= 0)
			{
				act.itemOption(tab, "Break");
				return "out of food, teleported out";
			}
			return "out of food, and no teleport tablet to leave with";
		}
		if (hp <= maxHp * EAT_AT && food >= 0 && bot.tickCount() - lastEat >= 3)
		{
			lastEat = bot.tickCount();
			bot.log("eat at " + hp + "/" + maxHp);
			act.itemOption(food, "Eat");
			return null;
		}
		// The poison varp updates a tick or two after the antidote: don't drink twice.
		if (bot.poisoned() && bot.tickCount() - lastCure >= 4)
		{
			int cure = act.slotNamed(ANTIPOISONS);
			if (cure >= 0)
			{
				lastCure = bot.tickCount();
				bot.log("cure poison (varp 102 = " + bot.client.getVarpValue(102) + ")");
				act.itemOption(cure, "Drink");
				return null;
			}
		}
		if (bot.tickCount() >= antifireUntil)
		{
			int antifire = act.slotNamed(ANTIFIRES);
			if (antifire >= 0)
			{
				String name = bot.client.getItemDefinition(act.inventory()[antifire].getId()).getName();
				antifireUntil = bot.tickCount() + antifireSeconds(name) * 10 / 6 - ANTIFIRE_MARGIN_TICKS;
				bot.log("drink " + name);
				act.itemOption(antifire, "Drink");
				return null;
			}
		}
		if (bot.prayerPoints() <= PRAYER_POTION_AT)
		{
			int restore = act.slotNamed(PRAYER_RESTORES);
			if (restore >= 0)
			{
				bot.log("prayer potion at " + bot.prayerPoints());
				act.itemOption(restore, "Drink");
				return null;
			}
		}
		NPC dragon = bot.npc(NPC_NAME, 20);
		if (dragon == null || dragon.isDead())
		{
			if (fighting)
			{
				fighting = false;
				kills++;
				bot.log("kill " + kills + " (hp " + hp + ", prayer " + bot.prayerPoints() + ")");
			}
			if (goneSince < 0)
			{
				goneSince = bot.tickCount();
			}
			return between(bot, food);
		}
		goneSince = -1;
		fighting = true;
		diedAt = dragon.getWorldLocation();
		// Only while it's alive: between kills the prayer is off, saving points.
		if (bot.prayerPoints() > 0 && act.prayer(Prayer.PROTECT_FROM_MELEE, true))
		{
			bot.log("Protect from Melee on");
			return null;
		}
		int shield = act.slotOf(ANTI_DRAGON_SHIELD);
		if (shield >= 0 && !act.wearing(ANTI_DRAGON_SHIELD))
		{
			bot.log("wear anti-dragon shield");
			act.equip(shield);
			return null;
		}
		Actor target = bot.target();
		if (target != dragon)
		{
			bot.log("attack (hp " + hp + ", prayer " + bot.prayerPoints() + ")");
			act.npcOption(dragon, "Attack");
		}
		return null;
	}

	/** Between kills: prayer off, loot what's worth it, wait for the respawn. */
	private String between(Bot bot, int food)
	{
		Actions act = bot.actions;
		if (act.prayer(Prayer.PROTECT_FROM_MELEE, false))
		{
			return null;
		}
		// One pick-up at a time: let the walk to the last one finish.
		if (diedAt != null && bot.client.getLocalDestinationLocation() == null)
		{
			for (Bot.Loot loot : bot.groundItems(diedAt, 6))
			{
				int id = loot.item.getId();
				String name = bot.client.getItemDefinition(id).getName();
				String key = loot.tile.getWorldLocation() + ":" + id;
				boolean wanted = ALWAYS_LOOT.contains(name) || bot.value(id) * loot.item.getQuantity() >= LOOT_MIN_VALUE;
				if (!wanted || lootTries.merge(key, 1, Integer::sum) > 3)
				{
					continue;
				}
				boolean stacks = bot.client.getItemDefinition(id).isStackable() && act.slotOf(id) >= 0;
				if (act.freeSlots() == 0 && !stacks)
				{
					// Eat for room only when the food isn't wasted; otherwise leave it.
					if (food >= 0 && bot.hitpoints() <= bot.maxHitpoints() - EAT_FOR_ROOM_MISSING)
					{
						bot.log("eat to make room for " + name);
						act.itemOption(food, "Eat");
						return null;
					}
					continue;
				}
				bot.log("loot " + loot.item.getQuantity() + " x " + name);
				act.take(loot.tile, loot.item);
				return null;
			}
		}
		if (bot.tickCount() - goneSince > RESPAWN_WAIT_TICKS)
		{
			return kills > 0 ? "the King Black Dragon didn't come back (" + kills + " kills)" : "no King Black Dragon here";
		}
		return null;
	}

	@Override
	public void stop(Bot bot)
	{
		bot.actions.prayer(Prayer.PROTECT_FROM_MELEE, false);
		bot.log(kills + " kills");
	}

	@Override
	public void message(Bot bot, String text)
	{
		// The server's potion messages: an antifire that wore off is drunk again at once.
		if (text.toLowerCase().contains("antifire") && (text.contains("run out") || text.contains("worn off") || text.contains("expired")))
		{
			antifireUntil = bot.tickCount();
		}
	}
}
