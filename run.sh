#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-}"
if [[ -z "$PYTHON_BIN" ]]; then
    for candidate in python3.13 python3.12 python3.11 python3; do
        if command -v "$candidate" >/dev/null 2>&1; then
            ver="$($candidate -c 'import sys; print(sys.version_info[:2] >= (3, 10))' 2>/dev/null || echo False)"
            if [[ "$ver" == "True" ]]; then
                PYTHON_BIN="$candidate"
                break
            fi
        fi
    done
fi
if [[ -z "$PYTHON_BIN" ]]; then
    echo "Error: need Python 3.10+. Install with: brew install python@3.11"
    exit 1
fi

if [[ ! -d .venv ]]; then
    echo "First run — creating virtual environment in .venv ..."
    "$PYTHON_BIN" -m venv .venv
    .venv/bin/pip install --quiet --upgrade pip
    .venv/bin/pip install --quiet -r requirements.txt
fi

# Migrate v1 data on first run only (the script itself is a no-op if the v2 db
# already has snapshots, so it's safe to call every time).
.venv/bin/python -m instagram_tracker.migrate_v1 || true

PORT="${1:-8000}"
exec .venv/bin/python -m instagram_tracker "$PORT"
