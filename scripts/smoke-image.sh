#!/usr/bin/env bash
# Local smoke check used by the release workflow before pushing an image.
set -euo pipefail
exec node "$(dirname "$0")/smoke-image.mjs" "${1:?usage: smoke-image.sh <image>}"
