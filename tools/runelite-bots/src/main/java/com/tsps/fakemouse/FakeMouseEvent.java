package com.tsps.fakemouse;

import java.awt.Component;
import java.awt.event.MouseEvent;

/** A mouse event the fake mouse made; the blocker lets these through while it shuts out the real mouse. */
final class FakeMouseEvent extends MouseEvent
{
	FakeMouseEvent(Component source, int id, int modifiers, int x, int y, int clickCount, int button)
	{
		super(source, id, System.currentTimeMillis(), modifiers, x, y, clickCount, false, button);
	}
}
