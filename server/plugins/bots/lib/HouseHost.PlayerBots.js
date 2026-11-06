"use strict";

/**
 * The house host: one bot, always online, whose max house in Rimmington is open to everyone
 * (population/Population.PlayerBots.js logs it in). Guests find it here.
 */
const RIMMINGTON = 1;
// Rimmington's house portal and Phials, who unnotes bones beside it.
const PORTAL = { x: 2954, y: 3224, z: 0 };
const PHIALS = { x: 2949, y: 3213, z: 0 };

let current = null;

function setHost(player) {
  current = player ?? null;
}

/** The host while it's online and in its house, or null. */
function host() {
  if (!current || current.isRegistered?.() === false) return null;
  return current.getPrivateArea?.() ? current : null;
}

module.exports = { setHost, host, RIMMINGTON, PORTAL, PHIALS };
