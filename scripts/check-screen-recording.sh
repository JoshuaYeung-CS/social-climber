#!/usr/bin/env bash
#
# List every app currently granted Screen Recording permission on macOS.
# Reads the TCC (Transparency, Consent, and Control) database directly —
# same list that Settings → Privacy & Security → Screen Recording shows,
# but with timestamps so you can spot recent grants.
#
# If anything in the output is unfamiliar, revoke it in Settings.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is macOS-only."
  exit 1
fi

TCC_DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"

if [[ ! -r "$TCC_DB" ]]; then
  echo "Can't read $TCC_DB"
  echo "macOS protects this file — try running with full disk access:"
  echo "  Settings → Privacy & Security → Full Disk Access → add Terminal."
  echo "  (You can revoke that permission again afterward.)"
  exit 1
fi

echo "Apps with Screen Recording permission:"
echo "============================================"

sqlite3 -separator "|" "$TCC_DB" "
  SELECT
    client,
    auth_value,
    datetime(last_modified, 'unixepoch', 'localtime')
  FROM access
  WHERE service = 'kTCCServiceScreenCapture'
  ORDER BY last_modified DESC;
" | while IFS='|' read -r client auth modified; do
  case "$auth" in
    2) status="✓ allowed" ;;
    0) status="✗ denied " ;;
    *) status="? auth=$auth" ;;
  esac
  printf "  %s  %-50s  granted %s\n" "$status" "$client" "$modified"
done

echo
echo "To revoke: Settings → Privacy & Security → Screen Recording → toggle off the app."
echo "Re-prompt: just run any app that wants the permission again."
