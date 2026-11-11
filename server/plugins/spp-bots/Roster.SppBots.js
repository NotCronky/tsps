"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Who the spp-bots are, in data/saves/spp-bots/roster.json (plugins have no world store, as for AI
 * bots' ai-bots.json): each bot's name, its profile (seed, stage, archetype, ironman, tastes),
 * whether its account has been generated, and where it logged out. Levels and items are in its
 * player save.
 */
const SAVE_DIRECTORY = path.join(process.cwd(), "data", "saves", "spp-bots");
const DEFAULT_FILE = path.join(SAVE_DIRECTORY, "roster.json");
const SAVE_DELAY_MS = 2000;

/**
 * spp-bots' own folder under data/saves, ignored by a .gitignore inside it, so saves stay out of
 * git without changing upstream's server/.gitignore (a merge conflict waiting to happen).
 */
function ensureSaveDirectory(directory = SAVE_DIRECTORY) {
  fs.mkdirSync(directory, { recursive: true });
  const ignore = path.join(directory, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  return directory;
}

class SppBotRoster {
  constructor(file = DEFAULT_FILE) {
    this.file = file;
    this.bots = [];
    this.saveTimer = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      this.bots = Array.isArray(raw?.bots) ? raw.bots.filter((bot) => typeof bot?.name === "string") : [];
    } catch (error) {
      if (error?.code !== "ENOENT") console.error(`[spp-bots] could not read ${file}; starting a new roster`, error);
    }
  }

  has(name) {
    return this.get(name) !== null;
  }

  get(name) {
    const key = String(name).toLowerCase();
    return this.bots.find((bot) => bot.name.toLowerCase() === key) ?? null;
  }

  add(entry) {
    const bot = { location: null, generated: null, createdAt: new Date().toISOString(), ...entry };
    this.bots.push(bot);
    this.save();
    return bot;
  }

  update(name, changes) {
    const bot = this.get(name);
    if (!bot) return null;
    Object.assign(bot, changes);
    this.save();
    return bot;
  }

  /** Coalesces writes; `now` writes straight away (shutdown). */
  save(now = false) {
    if (now) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.write();
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.write();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  write() {
    try {
      ensureSaveDirectory(path.dirname(this.file));
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ bots: this.bots }, null, 2));
      fs.renameSync(temp, this.file);
    } catch (error) {
      console.error(`[spp-bots] could not write ${this.file}`, error);
    }
  }
}

module.exports = { SppBotRoster, ensureSaveDirectory, SAVE_DIRECTORY };
