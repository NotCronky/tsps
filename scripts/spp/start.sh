#!/usr/bin/env bash
# Server and gateway together, without the web client: play through RuneLite via RSProx
# (target "spp-bots"). Ctrl+C stops both.
set -euo pipefail
cd "$(dirname "$0")/../.."
yarn --cwd server ensure-cache
AGENT_MCP="${AGENT_MCP:-1}" exec yarn concurrently --kill-others --names server,gateway -c blue,green \
  "yarn --cwd server dev" "yarn gateway"
