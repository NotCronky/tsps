package com.tsps.fakemouse;

import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.Graphics2D;
import java.awt.Polygon;
import javax.inject.Inject;
import net.runelite.api.Point;
import net.runelite.client.ui.overlay.Overlay;
import net.runelite.client.ui.overlay.OverlayLayer;
import net.runelite.client.ui.overlay.OverlayPosition;

/** The bot's cursor, and a banner saying a bot has the mouse. */
final class FakeMouseOverlay extends Overlay
{
	private FakeMouse mouse;

	@Inject
	FakeMouseOverlay()
	{
		setPosition(OverlayPosition.DYNAMIC);
		setLayer(OverlayLayer.ALWAYS_ON_TOP);
	}

	void setMouse(FakeMouse mouse)
	{
		this.mouse = mouse;
	}

	@Override
	public Dimension render(Graphics2D g)
	{
		if (mouse == null || !mouse.held())
		{
			return null;
		}
		String banner = mouse.owner() + " has the mouse - press Escape to take it back";
		g.setColor(new Color(0, 0, 0, 160));
		g.fillRect(6, 6, g.getFontMetrics().stringWidth(banner) + 12, 20);
		g.setColor(Color.YELLOW);
		g.drawString(banner, 12, 21);
		Point at = mouse.position();
		if (at != null)
		{
			int x = at.getX();
			int y = at.getY();
			Polygon arrow = new Polygon(new int[]{x, x, x + 4, x + 7, x + 9, x + 6, x + 11},
				new int[]{y, y + 16, y + 12, y + 18, y + 17, y + 11, y + 11}, 7);
			g.setColor(Color.WHITE);
			g.fill(arrow);
			g.setColor(Color.BLACK);
			g.setStroke(new BasicStroke(1));
			g.draw(arrow);
		}
		return null;
	}
}
