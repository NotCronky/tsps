package com.tsps.bossdifficulty;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.util.HashMap;
import java.util.Map;
import javax.inject.Inject;
import javax.swing.SwingUtilities;
import net.runelite.api.Client;
import net.runelite.api.GameState;
import net.runelite.api.Player;
import net.runelite.api.events.GameStateChanged;
import net.runelite.api.events.GameTick;
import net.runelite.api.events.VarbitChanged;
import net.runelite.client.callback.ClientThread;
import net.runelite.client.config.ConfigManager;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;
import net.runelite.client.ui.ClientToolbar;
import net.runelite.client.ui.NavigationButton;

@PluginDescriptor(
	name = "Boss Difficulty",
	description = "Ranks bosses from easiest to hardest with tips, and suggests the next one to learn",
	tags = {"boss", "pvm", "difficulty", "learn", "kill count"}
)
public class BossDifficultyPlugin extends Plugin
{
	@Inject
	private Client client;

	@Inject
	private ClientThread clientThread;

	@Inject
	private ClientToolbar clientToolbar;

	@Inject
	private ConfigManager configManager;

	private BossDifficultyPanel panel;
	private NavigationButton button;
	private boolean refreshQueued;
	/** Logged in, but the character's name (which picks the saved counts) isn't known yet. */
	private boolean awaitingName;

	@Override
	protected void startUp()
	{
		panel = new BossDifficultyPanel();
		button = NavigationButton.builder()
			.tooltip("Boss Difficulty")
			.icon(icon())
			.priority(7)
			.panel(panel)
			.build();
		clientToolbar.addNavigation(button);
		clientThread.invokeLater(this::refreshKills);
	}

	@Override
	protected void shutDown()
	{
		clientToolbar.removeNavigation(button);
		panel = null;
		button = null;
	}

	@Subscribe
	public void onGameStateChanged(GameStateChanged event)
	{
		if (event.getGameState() == GameState.LOGGED_IN)
		{
			refreshKills();
		}
	}

	@Subscribe
	public void onGameTick(GameTick event)
	{
		if (awaitingName)
		{
			refreshKills();
		}
	}

	@Subscribe
	public void onVarbitChanged(VarbitChanged event)
	{
		if (event.getVarbitId() != -1 || refreshQueued)
		{
			return;
		}
		for (Boss boss : Bosses.ALL)
		{
			if (boss.killVarp == event.getVarpId())
			{
				// Several counts arrive together at login: read them all once, next tick.
				refreshQueued = true;
				clientThread.invokeLater(this::refreshKills);
				return;
			}
		}
	}

	/**
	 * Runs on the client thread: reads every kill-count varp, merges them into this account's
	 * saved counts (KillStore) and hands the result to the panel.
	 */
	private void refreshKills()
	{
		refreshQueued = false;
		awaitingName = false;
		if (panel == null)
		{
			return;
		}
		boolean loggedIn = client.getGameState() == GameState.LOGGED_IN;
		Map<Boss, Integer> kills = new HashMap<>();
		if (loggedIn)
		{
			Player local = client.getLocalPlayer();
			String name = local == null ? null : local.getName();
			if (name == null || name.isEmpty())
			{
				// The name arrives a tick or so after LOGGED_IN.
				awaitingName = true;
				return;
			}
			String key = KillStore.key(name);
			Map<Integer, Integer> saved = KillStore.parse(configManager.getConfiguration(KillStore.GROUP, key));
			boolean changed = false;
			for (Boss boss : Bosses.ALL)
			{
				if (boss.killVarp >= 0)
				{
					changed |= KillStore.merge(saved, boss.killVarp, client.getVarpValue(boss.killVarp));
					kills.put(boss, saved.getOrDefault(boss.killVarp, 0));
				}
			}
			if (changed)
			{
				configManager.setConfiguration(KillStore.GROUP, key, KillStore.format(saved));
			}
		}
		BossDifficultyPanel target = panel;
		SwingUtilities.invokeLater(() -> target.setKills(kills, loggedIn));
	}

	/** A small rising bar chart: easy to hard. */
	private static BufferedImage icon()
	{
		BufferedImage image = new BufferedImage(16, 16, BufferedImage.TYPE_INT_ARGB);
		Graphics2D g = image.createGraphics();
		g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
		Tier[] tiers = {Tier.BEGINNER, Tier.MEDIUM, Tier.HARD, Tier.MASTER};
		for (int i = 0; i < tiers.length; i++)
		{
			int height = 4 + i * 3;
			g.setColor(tiers[i].color);
			g.fillRect(1 + i * 4, 15 - height, 3, height);
		}
		g.setColor(new Color(0, 0, 0, 120));
		g.setStroke(new BasicStroke(1));
		g.drawLine(0, 15, 15, 15);
		g.dispose();
		return image;
	}
}
