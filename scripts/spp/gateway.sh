#!/usr/bin/env bash
# The RuneLite gateway for this checkout (port 43920 from the root .env). RSProx target: "spp-bots".
set -euo pipefail
cd "$(dirname "$0")/../.."
exec yarn gateway
