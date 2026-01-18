#!/usr/bin/env sh
set -euo pipefail

GIT_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "local")

GIT_COMMIT="$GIT_COMMIT" docker compose build "$@"
