package com.cronky.tspsagility;

/**
 * Generated from the server's server/plugins/skills/agility/courses/. Each step lists the loc ids
 * of one obstacle, in lap order; a step with two ids is a choice of two. Every course here has
 * been run for a real lap on the server. Left out: Barbarian Outpost (a ladder between obstacles and
 * three steps with one id), and the courses that need items, fail, or branch.
 */
final class Courses
{
	static final Course[] ALL = {
		new Course("Gnome Stronghold Agility", false, new int[][]{{23145}, {23134}, {23559}, {23557}, {23560}, {23135}, {23138, 23139}}),
		new Course("Draynor Village Rooftop", true, new int[][]{{11404}, {11405}, {11406}, {11430}, {11630}, {11631}, {11632}}),
		new Course("Al Kharid Rooftop", true, new int[][]{{11633}, {14398}, {14402}, {14403}, {14404}, {11634}, {14409}, {14399}}),
		new Course("Varrock Rooftop", true, new int[][]{{14412}, {14413}, {14414}, {14832}, {14833}, {14834}, {14835}, {14836}, {14841}}),
		new Course("Canifis Rooftop", true, new int[][]{{14843}, {14844}, {14845}, {14848}, {14846}, {14894}, {14847}, {14897}}),
		new Course("Falador Rooftop", true, new int[][]{{14898}, {14899}, {14901}, {14903}, {14904}, {14905}, {14911}, {14919}, {14920}, {14921}, {14922, 14923}, {14924}, {14925}}),
		new Course("Seers' Village Rooftop", true, new int[][]{{14927}, {14928}, {14932}, {14929}, {14930}, {14931}}),
		new Course("Pollnivneach Rooftop", true, new int[][]{{14935}, {14936}, {14937}, {14938}, {14939}, {14940}, {14941}, {14944}, {14945}}),
		new Course("Rellekka Rooftop", true, new int[][]{{14946}, {14947}, {14987}, {14990}, {14991}, {14992}, {14994}}),
		new Course("Ardougne Rooftop", true, new int[][]{{15608}, {15609}, {26635}, {15610}, {15611}, {28912}, {15612}}),
	};

	private Courses()
	{
	}

	static final class Course
	{
		final String name;
		final boolean marks;
		final int[][] steps;

		Course(String name, boolean marks, int[][] steps)
		{
			this.name = name;
			this.marks = marks;
			this.steps = steps;
		}
	}
}
