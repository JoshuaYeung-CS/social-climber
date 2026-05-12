#!/bin/bash
# Cron-able watchdog for the Social Climber export bot.
#
# Polls /api/bot-health. If consecutive_failures >= 2, gathers
# diagnostic context (recent audit log, git head, extension version,
# server logs) and pipes the bundle to Claude via the `claude` CLI.
# Claude writes a diagnosis report; ntfy push notifies the user with
# a short summary and the path to the full report.
#
# Setup:
#   1. Ensure `claude` CLI on PATH (npm i -g @anthropic-ai/claude-code).
#   2. Configure delivery in ~/.config/social-climber/push.json — see the
#      server's /api/push docstring. iMessage is the recommended
#      no-app-on-phone option.
#   3. Install the launchd timer (social-climber-watchdog.plist) to run
#      this every 30 min.
#
# By design this DOES NOT auto-apply any patch — Claude only writes
# a report. You decide whether to act on it in the morning.

set -euo pipefail

TRACKER="${TRACKER_URL:-http://127.0.0.1:8000}"
DIAG_DIR="$HOME/Library/Logs/social-climber-diag"
REPO_DIR="$HOME/git-repos/instagram-tracker"

mkdir -p "$DIAG_DIR"
TS=$(date +%Y%m%d-%H%M%S)
CTX_FILE="$DIAG_DIR/ctx-$TS.txt"
DIAG_FILE="$DIAG_DIR/diag-$TS.md"
LOG_FILE="$DIAG_DIR/run.log"

log() { echo "[$(date +'%H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

HEALTH=$(curl -sS "$TRACKER/api/bot-health" 2>/dev/null || echo "{}")
CONSEC=$(echo "$HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('consecutive_failures', 0))" 2>/dev/null || echo 0)

if [ "$CONSEC" -lt 2 ]; then
  log "Healthy (consecutive_failures=$CONSEC). No action."
  exit 0
fi

log "Bot in trouble: $CONSEC consecutive failures. Gathering context."

{
  echo "=== /api/bot-health ==="
  echo "$HEALTH" | python3 -m json.tool 2>&1 || echo "$HEALTH"
  echo
  echo "=== /api/audit-log (last 30) ==="
  curl -sS "$TRACKER/api/audit-log?limit=30" | python3 -m json.tool 2>&1 || true
  echo
  echo "=== Git head ==="
  ( cd "$REPO_DIR" && git log --oneline -10 ) 2>&1 || true
  echo
  echo "=== Extension version ==="
  python3 -c "import json; print(json.load(open('$REPO_DIR/extension/chrome/manifest.json'))['version'])" 2>&1 || true
  echo
  echo "=== Recent server log (last 100 lines) ==="
  tail -100 "$HOME/Library/Logs/social-climber.err.log" 2>/dev/null || true
} > "$CTX_FILE"

log "Context: $CTX_FILE"

PROMPT="The Social Climber export bot has failed $CONSEC times in a row. You are being invoked autonomously by a watchdog to diagnose. Read the diagnostic context below and write a short report.

Format your report as:
1. ROOT CAUSE (1-2 sentences)
2. RECOMMENDED FIX (specific file path + change, OR 'requires manual user action: …')
3. CONFIDENCE: low / medium / high

DO NOT apply any code changes. Just write the report. Be terse — the user is asleep and will read this in the morning. If you can't determine root cause from the context, say so and list what data would help.

DIAGNOSTIC CONTEXT:
$(cat "$CTX_FILE")"

log "Invoking Claude (this costs API tokens)…"
if claude --print "$PROMPT" > "$DIAG_FILE" 2>&1; then
  log "Diagnosis written to $DIAG_FILE"
else
  log "claude CLI failed (exit $?). Check $DIAG_FILE."
fi

# Short summary for the push: first 200 chars of the report, single line.
SUMMARY=$(head -c 400 "$DIAG_FILE" | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-220)

PAYLOAD=$(python3 -c "
import json, sys
print(json.dumps({
  'title': 'IG Bot diagnosed ($CONSEC failures)',
  'message': '''$SUMMARY

Full report: $DIAG_FILE''',
  'priority': 'high',
}))")
PUSH_RESULT=$(curl -sS -X POST "$TRACKER/api/push" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>&1 || echo '{"ok":false,"error":"curl failed"}')
log "push result: $PUSH_RESULT"
