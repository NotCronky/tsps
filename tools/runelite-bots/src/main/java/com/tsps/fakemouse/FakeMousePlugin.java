package com.tsps.fakemouse;

import java.awt.event.KeyEvent;
import java.awt.event.MouseEvent;
import javax.inject.Inject;
import net.runelite.api.Client;
import net.runelite.client.callback.ClientThread;
import net.runelite.client.input.KeyListener;
import net.runelite.client.input.KeyManager;
import net.runelite.client.input.MouseListener;
import net.runelite.client.input.MouseManager;
import net.runelite.client.plugins.Plugin;
import net.runelite.client.plugins.PluginDescriptor;
import net.runelite.client.ui.overlay.OverlayManager;

/**
 * Gives bot plugins (TSPS Farm Run, TSPS Agility) a mouse of their own. While one holds it, real
 * mouse events never reach the game, a cursor shows where the bot's mouse is, and Escape hands
 * control back.
 */
@PluginDescriptor(name = "TSPS Fake Mouse", description = "A mouse the TSPS bot plugins drive, so your real mouse can't get in the way",
	tags = {"tsps", "mouse", "bot"})
public class FakeMousePlugin extends Plugin
{
	@Inject
	private Client client;
	@Inject
	private ClientThread clientThread;
	@Inject
	private MouseManager mouseManager;
	@Inject
	private KeyManager keyManager;
	@Inject
	private OverlayManager overlayManager;
	@Inject
	private FakeMouseOverlay overlay;
	@Inject
	private FakeMouseConfig config;

	@com.google.inject.Provides
	FakeMouseConfig provideConfig(net.runelite.client.config.ConfigManager configManager)
	{
		return configManager.getConfig(FakeMouseConfig.class);
	}

	private FakeMouse mouse;

	/** First in line: swallows the real mouse while a bot holds the fake one. */
	private final MouseListener blocker = new MouseListener()
	{
		private MouseEvent filter(MouseEvent event)
		{
			if (mouse != null && mouse.held() && !(event instanceof FakeMouseEvent))
			{
				event.consume();
			}
			return event;
		}

		@Override
		public MouseEvent mouseClicked(MouseEvent event)
		{
			return filter(event);
		}

		@Override
		public MouseEvent mousePressed(MouseEvent event)
		{
			return filter(event);
		}

		@Override
		public MouseEvent mouseReleased(MouseEvent event)
		{
			return filter(event);
		}

		@Override
		public MouseEvent mouseEntered(MouseEvent event)
		{
			return filter(event);
		}

		@Override
		public MouseEvent mouseExited(MouseEvent event)
		{
			// The real mouse leaving the window would clear the game's hovered tile.
			return filter(event);
		}

		@Override
		public MouseEvent mouseDragged(MouseEvent event)
		{
			return filter(event);
		}

		@Override
		public MouseEvent mouseMoved(MouseEvent event)
		{
			return filter(event);
		}
	};

	private final KeyListener escape = new KeyListener()
	{
		@Override
		public void keyTyped(KeyEvent event)
		{
		}

		@Override
		public void keyPressed(KeyEvent event)
		{
			if (event.getKeyCode() == KeyEvent.VK_ESCAPE && mouse != null && mouse.held())
			{
				mouse.revoke("you took the mouse back (Escape)");
				event.consume();
			}
		}

		@Override
		public void keyReleased(KeyEvent event)
		{
		}
	};

	@Override
	protected void startUp()
	{
		mouse = new FakeMouse(client, clientThread);
		mouse.setSpeed(config::speed);
		FakeMouse.install(mouse);
		overlay.setMouse(mouse);
		mouseManager.registerMouseListener(0, blocker);
		keyManager.registerKeyListener(escape);
		overlayManager.add(overlay);
	}

	@Override
	protected void shutDown()
	{
		mouse.revoke("the TSPS Fake Mouse plugin was turned off");
		mouse.shutDown();
		FakeMouse.install(null);
		mouseManager.unregisterMouseListener(blocker);
		keyManager.unregisterKeyListener(escape);
		overlayManager.remove(overlay);
	}
}
