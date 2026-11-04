package com.tsps.gauntlethelper;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.Graphics2D;
import java.awt.Polygon;
import java.util.Map;
import javax.inject.Inject;
import net.runelite.api.Client;
import net.runelite.api.GroundObject;
import net.runelite.api.NPC;
import net.runelite.api.Perspective;
import net.runelite.api.coords.LocalPoint;
import net.runelite.client.ui.overlay.Overlay;
import net.runelite.client.ui.overlay.OverlayLayer;
import net.runelite.client.ui.overlay.OverlayPosition;

/** In the arena: tornado tiles, and floor tiles about to burn (yellow) and burning (red). */
class ArenaOverlay extends Overlay
{
	private static final Color TORNADO = new Color(255, 60, 60);
	private static final Color WARNING = new Color(255, 210, 60);
	private static final Color BURNING = new Color(255, 60, 30);

	private final Client client;
	private final GauntletHelperPlugin plugin;
	private final GauntletHelperConfig config;

	@Inject
	ArenaOverlay(Client client, GauntletHelperPlugin plugin, GauntletHelperConfig config)
	{
		this.client = client;
		this.plugin = plugin;
		this.config = config;
		setPosition(OverlayPosition.DYNAMIC);
		setLayer(OverlayLayer.ABOVE_SCENE);
	}

	@Override
	public Dimension render(Graphics2D graphics)
	{
		if (!plugin.fighting())
		{
			return null;
		}
		if (config.highlightFloor())
		{
			for (Map.Entry<GroundObject, Integer> tile : plugin.floor.entrySet())
			{
				Color colour = tile.getValue() == 2 ? BURNING : WARNING;
				fill(graphics, tile.getKey().getCanvasTilePoly(), colour, tile.getValue() == 2 ? 70 : 35);
			}
		}
		if (config.highlightTornadoes())
		{
			for (NPC tornado : plugin.tornadoes)
			{
				LocalPoint at = tornado.getLocalLocation();
				if (at != null)
				{
					fill(graphics, Perspective.getCanvasTilePoly(client, at), TORNADO, 60);
				}
			}
		}
		return null;
	}

	private static void fill(Graphics2D graphics, Polygon poly, Color colour, int alpha)
	{
		if (poly == null)
		{
			return;
		}
		graphics.setColor(new Color(colour.getRed(), colour.getGreen(), colour.getBlue(), alpha));
		graphics.fill(poly);
		graphics.setColor(colour);
		graphics.setStroke(new BasicStroke(2));
		graphics.draw(poly);
	}
}
