package com.tsps.bossdifficulty;

import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Cursor;
import java.awt.Dimension;
import java.awt.FlowLayout;
import java.awt.event.MouseAdapter;
import java.awt.event.MouseEvent;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import javax.swing.BorderFactory;
import javax.swing.Box;
import javax.swing.BoxLayout;
import javax.swing.JButton;
import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JTextField;
import javax.swing.event.DocumentEvent;
import javax.swing.event.DocumentListener;
import net.runelite.client.ui.ColorScheme;
import net.runelite.client.ui.FontManager;
import net.runelite.client.ui.PluginPanel;
import net.runelite.client.util.LinkBrowser;

/** The side panel: filters, the "learn next" pointer and the ranked list. */
class BossDifficultyPanel extends PluginPanel
{
	private static final String ALL = "All types";

	private final JTextField search = new JTextField();
	private final JComboBox<String> category = new JComboBox<>();
	private final JCheckBox unkilledOnly = new JCheckBox("Only bosses I haven't killed");
	private final JLabel next = new JLabel();
	private final JPanel list = new JPanel();
	private final Set<Boss> expanded = new HashSet<>();

	private Map<Boss, Integer> kills = Collections.emptyMap();
	private boolean loggedIn;

	BossDifficultyPanel()
	{
		setBorder(BorderFactory.createEmptyBorder(8, 8, 8, 8));
		setLayout(new BorderLayout(0, 8));

		JPanel top = new JPanel();
		top.setLayout(new BoxLayout(top, BoxLayout.Y_AXIS));

		JLabel title = new JLabel("Boss Difficulty");
		title.setFont(FontManager.getRunescapeBoldFont());
		title.setForeground(Color.WHITE);
		top.add(left(title));
		JLabel subtitle = new JLabel("<html>Easiest first. Click a boss for tips.</html>");
		subtitle.setForeground(ColorScheme.LIGHT_GRAY_COLOR);
		subtitle.setFont(FontManager.getRunescapeSmallFont());
		top.add(left(subtitle));
		top.add(Box.createVerticalStrut(6));

		next.setFont(FontManager.getRunescapeSmallFont());
		next.setForeground(Color.WHITE);
		next.setBorder(BorderFactory.createCompoundBorder(
			BorderFactory.createMatteBorder(0, 3, 0, 0, Tier.EASY.color),
			BorderFactory.createEmptyBorder(4, 6, 4, 4)));
		next.setOpaque(true);
		next.setBackground(ColorScheme.DARKER_GRAY_COLOR);
		top.add(left(next));
		top.add(Box.createVerticalStrut(6));

		search.setToolTipText("Search bosses");
		search.getDocument().addDocumentListener(new DocumentListener()
		{
			public void insertUpdate(DocumentEvent e)
			{
				rebuild();
			}

			public void removeUpdate(DocumentEvent e)
			{
				rebuild();
			}

			public void changedUpdate(DocumentEvent e)
			{
				rebuild();
			}
		});
		top.add(left(search));
		top.add(Box.createVerticalStrut(4));

		category.addItem(ALL);
		for (Boss.Category value : Boss.Category.values())
		{
			category.addItem(value.label);
		}
		category.addActionListener(e -> rebuild());
		top.add(left(category));

		unkilledOnly.setFont(FontManager.getRunescapeSmallFont());
		unkilledOnly.addActionListener(e -> rebuild());
		top.add(left(unkilledOnly));

		add(top, BorderLayout.NORTH);

		list.setLayout(new BoxLayout(list, BoxLayout.Y_AXIS));
		add(list, BorderLayout.CENTER);
		rebuild();
	}

	void setKills(Map<Boss, Integer> kills, boolean loggedIn)
	{
		this.kills = kills;
		this.loggedIn = loggedIn;
		rebuild();
	}

	private int killsOf(Boss boss)
	{
		Integer value = kills.get(boss);
		return value == null ? 0 : value;
	}

	private boolean tracked(Boss boss)
	{
		return loggedIn && boss.killVarp >= 0;
	}

	private void rebuild()
	{
		Boss suggestion = null;
		for (Boss boss : Bosses.ALL)
		{
			if (tracked(boss) && killsOf(boss) == 0)
			{
				suggestion = boss;
				break;
			}
		}
		if (!loggedIn)
		{
			next.setText("<html>Log in to see your kill counts and what to learn next.</html>");
		}
		else if (suggestion == null)
		{
			next.setText("<html>You've killed every boss on the list. Impressive.</html>");
		}
		else
		{
			next.setText("<html>Learn next: <b>" + suggestion.name + "</b> (" + suggestion.tier().label + ")</html>");
		}

		String query = search.getText().trim().toLowerCase(Locale.ROOT);
		String type = (String) category.getSelectedItem();

		list.removeAll();
		Tier shown = null;
		for (Boss boss : Bosses.ALL)
		{
			if (!query.isEmpty() && !boss.name.toLowerCase(Locale.ROOT).contains(query))
			{
				continue;
			}
			if (type != null && !ALL.equals(type) && !boss.category.label.equals(type))
			{
				continue;
			}
			if (unkilledOnly.isSelected() && tracked(boss) && killsOf(boss) > 0)
			{
				continue;
			}
			if (boss.tier() != shown)
			{
				shown = boss.tier();
				list.add(tierHeader(shown));
			}
			list.add(row(boss, boss == suggestion));
			list.add(Box.createVerticalStrut(3));
		}
		if (shown == null)
		{
			JLabel none = new JLabel("No bosses match.");
			none.setForeground(ColorScheme.LIGHT_GRAY_COLOR);
			list.add(left(none));
		}
		list.revalidate();
		list.repaint();
	}

	private JPanel tierHeader(Tier tier)
	{
		JLabel label = new JLabel(tier.label.toUpperCase(Locale.ROOT));
		label.setFont(FontManager.getRunescapeBoldFont());
		label.setForeground(tier.color);
		label.setBorder(BorderFactory.createEmptyBorder(8, 0, 3, 0));
		return left(label);
	}

	private JPanel row(Boss boss, boolean suggested)
	{
		JPanel row = new JPanel(new BorderLayout());
		row.setBackground(suggested ? ColorScheme.DARK_GRAY_HOVER_COLOR : ColorScheme.DARKER_GRAY_COLOR);
		row.setBorder(BorderFactory.createCompoundBorder(
			BorderFactory.createMatteBorder(0, 3, 0, 0, boss.tier().color),
			BorderFactory.createEmptyBorder(5, 6, 5, 6)));

		JPanel head = new JPanel(new BorderLayout(4, 0));
		head.setOpaque(false);
		JLabel name = new JLabel(boss.name);
		name.setForeground(Color.WHITE);
		name.setFont(FontManager.getRunescapeSmallFont());
		head.add(name, BorderLayout.CENTER);

		JLabel kc = new JLabel(tracked(boss) ? killsOf(boss) + " kc" : "");
		kc.setFont(FontManager.getRunescapeSmallFont());
		kc.setForeground(tracked(boss) && killsOf(boss) > 0 ? Tier.EASY.color : ColorScheme.MEDIUM_GRAY_COLOR);
		head.add(kc, BorderLayout.EAST);

		JLabel meta = new JLabel(boss.category.label + " · " + boss.score + "/100");
		meta.setFont(FontManager.getRunescapeSmallFont());
		meta.setForeground(ColorScheme.LIGHT_GRAY_COLOR);
		head.add(meta, BorderLayout.SOUTH);
		row.add(head, BorderLayout.NORTH);

		if (expanded.contains(boss))
		{
			row.add(details(boss), BorderLayout.CENTER);
		}

		row.setCursor(Cursor.getPredefinedCursor(Cursor.HAND_CURSOR));
		row.addMouseListener(new MouseAdapter()
		{
			@Override
			public void mouseClicked(MouseEvent e)
			{
				if (!expanded.remove(boss))
				{
					expanded.add(boss);
				}
				rebuild();
			}
		});
		row.setMaximumSize(new Dimension(Integer.MAX_VALUE, row.getPreferredSize().height));
		return row;
	}

	private JPanel details(Boss boss)
	{
		JPanel details = new JPanel();
		details.setOpaque(false);
		details.setLayout(new BoxLayout(details, BoxLayout.Y_AXIS));
		details.setBorder(BorderFactory.createEmptyBorder(6, 0, 0, 0));

		StringBuilder html = new StringBuilder("<html><body style='width:150px'>");
		html.append("<b>Bring:</b> ").append(boss.bring).append("<br>");
		for (String tip : boss.tips)
		{
			html.append("&bull; ").append(tip).append("<br>");
		}
		html.append("</body></html>");
		JLabel text = new JLabel(html.toString());
		text.setFont(FontManager.getRunescapeSmallFont());
		text.setForeground(ColorScheme.LIGHT_GRAY_COLOR);
		details.add(left(text));

		JButton wiki = new JButton("Open wiki guide");
		wiki.setFont(FontManager.getRunescapeSmallFont());
		wiki.setFocusable(false);
		wiki.addActionListener(e -> LinkBrowser.browse(boss.wikiUrl()));
		JPanel buttonRow = new JPanel(new FlowLayout(FlowLayout.LEFT, 0, 4));
		buttonRow.setOpaque(false);
		buttonRow.add(wiki);
		details.add(buttonRow);
		return details;
	}

	private static JPanel left(java.awt.Component component)
	{
		JPanel wrap = new JPanel(new BorderLayout());
		wrap.setOpaque(false);
		wrap.add(component, BorderLayout.CENTER);
		return wrap;
	}
}
