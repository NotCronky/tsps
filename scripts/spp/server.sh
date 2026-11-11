#!/usr/bin/env bash
# The spp-bots server on its own (no web client), with the agent MCP. Ports come from the root
# .env (43720 game, 49820 MCP). Set SPP_BOTS_LOG=1 for every bot login/logout in the log.
set -euo pipefail
cd "$(dirname "$0")/../.."
yarn --cwd server ensure-cache
AGENT_MCP="${AGENT_MCP:-1}" exec yarn --cwd server dev
