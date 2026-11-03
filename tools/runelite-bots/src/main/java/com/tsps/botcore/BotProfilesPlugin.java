package com.tsps.botcore;

import com.tsps.fakemouse.FakeMouse;
import com.tsps.farmrun.ServerGuard;
import com.tsps.profiles.KingBlackDragon;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.time.LocalTime;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;
import javax.inject.Inject;
import lombok.extern.slf4j.Slf4j;
import net.runelite.api.ChatMessageType;
import net.runelite.api.Client;
import net.runelite.api.events.ChatMessage;
import net.runelite.api.events.CommandExecuted;
import net.runelite.api.events.GameTick;
import net.runelite.client.callback.ClientThread;
import net.runelite.client.eventbus.Subscribe;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;

/**
 * Hosts the bot profiles (bosses, fights). "::tspsbot <profile> on" starts one, "off" stops it;
 * a running profile holds the fake mouse (Escape stops it). Each run logs to
 * ~/.rlcustom/tsps-bots.log. Does nothing off the TSPS server.
 */
@Slf4j
@PluginDescriptor(name = "TSPS Bot Profiles", description = "Bosses and fights played by bot profiles, on the TSPS server",
	tags = {"tsps", "bot", "boss"})
public class BotProfilesPlugin extends Plugin
{
	/** Every profile, by its ::tspsbot key. */
	static final Map<String, Supplier<Profile>> PROFILES = new LinkedHashMap<>();

	static
	{
		PROFILES.put("kbd", KingBlackDragon::new);
		PROFILES.put("pvp", com.tsps.profiles.PvpFighter::new);
		PROFILES.put("lms", com.tsps.profiles.LastManStanding::new);
	}

	@Inject
	private Client client;
	@Inject
	private ClientThread clientThread;
	@Inject
	private net.runelite.client.game.ItemManager itemManager;

	private Profile running;
	private Bot bot;

	@Override
	protected void shutDown()
	{
		stop("the plugin was turned off");
	}

	@Subscribe
	public void onCommandExecuted(CommandExecuted event)
	{
		String[] args = event.getArguments();
		if (!"tspsbot".equalsIgnoreCase(event.getCommand()) || args.length < 2 || !PROFILES.containsKey(args[0].toLowerCase()))
		{
			return;
		}
		if ("on".equalsIgnoreCase(args[1]) || "start".equalsIgnoreCase(args[1]))
		{
			start(PROFILES.get(args[0].toLowerCase()).get());
		}
		else
		{
			stop("stopped from chat");
		}
	}

	private void say(String text)
	{
		client.addChatMessage(ChatMessageType.GAMEMESSAGE, "", text, null);
	}

	private void start(Profile profile)
	{
		if (!ServerGuard.onTsps(client))
		{
			say("TSPS bots only run on the TSPS server.");
			return;
		}
		FakeMouse mouse = FakeMouse.get();
		if (mouse == null)
		{
			say("Turn on the TSPS Fake Mouse plugin first.");
			return;
		}
		if (mouse.held() && (running == null || !mouse.owner().equals(running.name())))
		{
			say(mouse.owner() + " has the mouse; stop it first.");
			return;
		}
		if (running != null)
		{
			stop("another profile started");
		}
		running = profile;
		bot = new Bot(client, new Actions(client), this::log, itemManager::getItemPrice);
		mouse.take(profile.name(), why -> clientThread.invoke(() -> stop(why)));
		log("---- " + profile.name() + " started at " + bot.position());
		say(profile.name() + " started.");
		profile.start(bot);
	}

	private void stop(String why)
	{
		if (running == null)
		{
			return;
		}
		Profile was = running;
		running = null;
		try
		{
			was.stop(bot);
		}
		catch (RuntimeException e)
		{
			log.warn("bot profile stop failed", e);
		}
		FakeMouse mouse = FakeMouse.get();
		if (mouse != null)
		{
			mouse.release(was.name());
		}
		log("stopped: " + why);
		if (client.getGameState() == net.runelite.api.GameState.LOGGED_IN)
		{
			say(was.name() + " stopped: " + why + ".");
		}
	}

	@Subscribe
	public void onChatMessage(ChatMessage event)
	{
		if (running != null && (event.getType() == ChatMessageType.GAMEMESSAGE || event.getType() == ChatMessageType.SPAM
			|| event.getType() == ChatMessageType.BROADCAST))
		{
			running.message(bot, event.getMessage());
		}
	}

	@Subscribe
	public void onGameTick(GameTick event)
	{
		if (running == null)
		{
			return;
		}
		if (!ServerGuard.onTsps(client))
		{
			stop("not on the TSPS server");
			return;
		}
		bot.tick();
		if (bot.actions.busy())
		{
			return;
		}
		try
		{
			String why = running.tick(bot);
			if (why != null)
			{
				stop(why);
			}
		}
		catch (RuntimeException e)
		{
			log.warn("bot profile failed", e);
			stop("error: " + e);
		}
	}

	void log(String line)
	{
		Path file = Paths.get(System.getProperty("user.home"), ".rlcustom", "tsps-bots.log");
		try
		{
			Files.createDirectories(file.getParent());
			Files.write(file, (LocalTime.now().withNano(0) + " " + line + "\n").getBytes(StandardCharsets.UTF_8),
				StandardOpenOption.CREATE, StandardOpenOption.APPEND);
		}
		catch (java.io.IOException e)
		{
			log.debug("couldn't write the bot log", e);
		}
	}
}
