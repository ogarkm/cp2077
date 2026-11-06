#!/usr/bin/env bash
set -e

# Run directory check
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$DIR"

# Launch Python server
if command -v python3 >/dev/null 2>&1; then
    exec python3 serve.py "$@"
elif command -v python >/dev/null 2>&1; then
    exec python serve.py "$@"
else
    echo "Error: Python 3 is required to run Cyberpunk 2077 local server."
    exit 1
fi
