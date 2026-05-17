#!/usr/bin/env bash
# Bump version markers so a Chrome-extension reload (or browser hard-refresh
# of the local web app) visibly confirms you're running fresh code.
#
# Touches:
#   - extension/chrome/manifest.json      ("version": "x.y.PATCH" → patch+1)
#   - social_climber/static/index.html (?v=N → N+1 on app.js / styles.css)
#
# Usage:
#   ./scripts/bump_version.sh          # bump both extension + web cache-buster
#   ./scripts/bump_version.sh ext      # extension manifest only
#   ./scripts/bump_version.sh web      # web cache-buster only
#
# Run it BEFORE reloading the extension at chrome://extensions or hitting
# Cmd-Shift-R in the browser. The popup's footer (and the OpenAPI /docs
# title) will then show the new version, confirming the reload picked up
# your changes.

set -euo pipefail
cd "$(dirname "$0")/.."

target="${1:-all}"

bump_ext() {
  local mf="extension/chrome/manifest.json"
  if [[ ! -f "$mf" ]]; then
    echo "skip ext: $mf not found" >&2
    return
  fi
  local curr new major minor patch
  curr=$(grep -E '"version":' "$mf" | head -1 | sed -E 's/.*"([0-9.]+)".*/\1/')
  IFS=. read -r major minor patch <<< "$curr"
  patch=$((patch + 1))
  new="${major}.${minor}.${patch}"
  # In-place sed (BSD sed on macOS needs the empty backup arg).
  sed -i '' "s|\"version\": \"${curr}\"|\"version\": \"${new}\"|" "$mf"
  echo "ext manifest:   $curr → $new"
}

bump_web() {
  local ih="social_climber/static/index.html"
  if [[ ! -f "$ih" ]]; then
    echo "skip web: $ih not found" >&2
    return
  fi
  local asset curr new
  for asset in "app.js" "styles.css"; do
    curr=$(grep -oE "${asset}\?v=[0-9]+" "$ih" | head -1 | sed -E "s|${asset}\?v=||")
    if [[ -z "$curr" ]]; then
      echo "skip ${asset}: no ?v= marker found in $ih" >&2
      continue
    fi
    new=$((curr + 1))
    sed -i '' "s|${asset}?v=${curr}|${asset}?v=${new}|g" "$ih"
    echo "${asset}:    ?v=${curr} → ?v=${new}"
  done
}

case "$target" in
  ext) bump_ext ;;
  web) bump_web ;;
  all) bump_ext; bump_web ;;
  *)   echo "usage: $0 [ext|web|all]" >&2; exit 2 ;;
esac
