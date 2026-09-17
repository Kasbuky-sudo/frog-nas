#!/bin/sh
# POSIX wrapper around scripts/fetch-source.js (the real implementation).
set -e
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$ROOT/scripts/fetch-source.js" "$@"
