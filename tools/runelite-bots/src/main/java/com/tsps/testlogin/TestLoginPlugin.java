package com.tsps.testlogin;

import javax.inject.Inject;
import net.runelite.api.Client;
import net.runelite.api.GameState;
import net.runelite.api.MenuAction;
import java.time.temporal.ChronoUnit;
import net.runelite.client.callback.ClientThread;
import net.runelite.client.task.Schedule;
import net.runelite.api.widgets.Widget;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;

/**
 * For the bots' test client only (tools/runelite-bots/test-client/test-client.sh): logs in as
 * -Dtsps.test.username / -Dtsps.test.password, retrying while a previous session is still in the
 * world, and presses Play on the welcome screen. Without those properties (any normal client) it
 * does nothing.
 */
@lombok.extern.slf4j.Slf4j
@PluginDescriptor(name = "TSPS Test Login", description = "Logs the bots' test client in (test client only)", hidden = true)
public class TestLoginPlugin extends Plugin
{
	/** Seconds between login attempts. */
	private static final int RETRY_SECONDS = 10;
	private static final int WELCOME_GROUP = 378;

	@Inject
	private Client client;
	@Inject
	private ClientThread clientThread;

	private final String username = System.getProperty("tsps.test.username");
	private final String password = System.getProperty("tsps.test.password");
	private int sinceAttempt = RETRY_SECONDS;

	@Override
	protected void startUp()
	{
		log.info("test login: started (user {})", username == null ? "none, idle" : username);
	}

	@Subscribe
	public void onGameStateChanged(net.runelite.api.events.GameStateChanged event)
	{
		if (username != null)
		{
			log.info("test login: game state {}", event.getGameState());
		}
	}

	/**
	 * Every second (RuneLite fires no client ticks on the login screen): on the login screen, log
	 * in, at most every 10 seconds; once in, press Play on the welcome screen.
	 */
	@Schedule(period = 1, unit = ChronoUnit.SECONDS)
	public void step()
	{
		if (username == null || password == null)
		{
			return;
		}
		clientThread.invoke(() ->
		{
			GameState state = client.getGameState();
			if (state == GameState.LOGIN_SCREEN && ++sinceAttempt >= RETRY_SECONDS)
			{
				sinceAttempt = 0;
				client.setUsername(username);
				client.setPassword(password);
				client.setGameState(GameState.LOGGING_IN);
				log.info("test login: attempt as {} (state now {})", username, client.getGameState());
			}
			else if (state == GameState.LOGGED_IN)
			{
				pressPlay();
			}
		});
	}

	/** The welcome screen's Play button: the widget in group 378 whose op says Play. */
	private void pressPlay()
	{
		for (int child = 0; child < 100; child++)
		{
			Widget widget = client.getWidget(WELCOME_GROUP, child);
			if (widget == null || widget.isHidden() || widget.getActions() == null)
			{
				continue;
			}
			String[] actions = widget.getActions();
			for (int i = 0; i < actions.length; i++)
			{
				if (actions[i] != null && actions[i].toLowerCase().contains("play"))
				{
					client.menuAction(-1, widget.getId(), MenuAction.CC_OP, i + 1, -1, actions[i], "");
					return;
				}
			}
		}
	}
}
