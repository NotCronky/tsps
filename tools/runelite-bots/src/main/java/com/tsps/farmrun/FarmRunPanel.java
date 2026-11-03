package com.tsps.farmrun;

import java.awt.BorderLayout;
import java.awt.GridLayout;
import javax.swing.BorderFactory;
import javax.swing.JButton;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JTextArea;
import net.runelite.client.ui.PluginPanel;

/** Start/Stop, what the run is doing, and when each patch is ready. */
final class FarmRunPanel extends PluginPanel
{
	private final JLabel status = new JLabel("Idle");
	private final JTextArea patches = new JTextArea();

	FarmRunPanel(Runnable start, Runnable stop)
	{
		setLayout(new BorderLayout(0, 8));
		setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
		JPanel buttons = new JPanel(new GridLayout(1, 2, 6, 0));
		JButton startButton = new JButton("Start run");
		JButton stopButton = new JButton("Stop");
		startButton.addActionListener(e -> start.run());
		stopButton.addActionListener(e -> stop.run());
		buttons.add(startButton);
		buttons.add(stopButton);
		JPanel top = new JPanel(new BorderLayout(0, 6));
		top.add(buttons, BorderLayout.NORTH);
		top.add(status, BorderLayout.SOUTH);
		patches.setEditable(false);
		patches.setLineWrap(true);
		patches.setWrapStyleWord(true);
		add(top, BorderLayout.NORTH);
		add(patches, BorderLayout.CENTER);
	}

	void setStatus(String text)
	{
		status.setText("<html>" + text + "</html>");
	}

	void setPatches(String text)
	{
		if (!text.equals(patches.getText()))
		{
			patches.setText(text);
		}
	}
}
