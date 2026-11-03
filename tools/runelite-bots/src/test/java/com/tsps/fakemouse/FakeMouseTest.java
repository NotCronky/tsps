package com.tsps.fakemouse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.awt.Dimension;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import net.runelite.api.Client;
import net.runelite.api.Point;
import org.junit.jupiter.api.Test;

class FakeMouseTest
{
	private static Client client(boolean stretched, Dimension real, Dimension window)
	{
		return (Client) Proxy.newProxyInstance(Client.class.getClassLoader(), new Class<?>[]{Client.class}, (proxy, method, args) ->
		{
			switch (method.getName())
			{
				case "isStretchedEnabled": return stretched;
				case "getRealDimensions": return real;
				case "getStretchedDimensions": return window;
				default: return null;
			}
		});
	}

	@Test
	void scalesGamePointsToAStretchedWindow()
	{
		// The farm run's log: it aimed at 752,404 and the client, stretched 2x, read the mouse at 375,202.
		FakeMouse mouse = new FakeMouse(client(true, new Dimension(960, 540), new Dimension(1920, 1080)), null);
		assertEquals(new Point(1504, 808), mouse.toWindow(new Point(752, 404)));
		FakeMouse unstretched = new FakeMouse(client(false, new Dimension(960, 540), new Dimension(1920, 1080)), null);
		assertEquals(new Point(752, 404), unstretched.toWindow(new Point(752, 404)));
	}

	@Test
	void oneHolderAtATimeAndEscapeTellsThem()
	{
		FakeMouse mouse = new FakeMouse(client(false, null, null), null);
		List<String> lost = new ArrayList<>();
		assertTrue(mouse.take("TSPS Farm Run", lost::add));
		assertFalse(mouse.take("TSPS Agility", why -> {}), "agility can't take it from the farm run");
		assertTrue(mouse.take("TSPS Farm Run", lost::add), "the holder can take it again");
		mouse.revoke("you took the mouse back (Escape)");
		assertFalse(mouse.held());
		assertEquals(List.of("you took the mouse back (Escape)"), lost);
		assertTrue(mouse.take("TSPS Agility", why -> {}));
		mouse.release("TSPS Farm Run");
		assertTrue(mouse.held(), "only the holder can release it");
		mouse.release("TSPS Agility");
		assertFalse(mouse.held());
	}
}
