#!/usr/bin/env bash
#
# Generate a self-signed TLS cert for the IG Tracker local server.
#
# Run once. Creates `data/cert.pem` and `data/key.pem` in the repo root,
# valid for 10 years, covering localhost + 127.0.0.1 + your Mac's current
# LAN IP + any custom hostnames passed as args.
#
#   ./scripts/make-cert.sh                  # localhost + 127.0.0.1 + auto-detected LAN IP
#   ./scripts/make-cert.sh joshua-mac.local # add a custom hostname
#
# The cert is what your phone has to TRUST so the HTTPS connection works
# without warnings. Trust steps for iPhone are documented in the README.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/data"
mkdir -p "$OUT_DIR"

CERT_PATH="$OUT_DIR/cert.pem"
KEY_PATH="$OUT_DIR/key.pem"

if [[ -f "$CERT_PATH" || -f "$KEY_PATH" ]]; then
  echo "Existing cert + key already at:"
  echo "  $CERT_PATH"
  echo "  $KEY_PATH"
  read -r -p "Overwrite? (y/N) " ans
  if [[ "${ans,,}" != "y" ]]; then
    echo "Aborted. Existing files untouched."
    exit 0
  fi
fi

# Auto-detect the Mac's primary LAN IP (works on macOS + Linux).
LAN_IP=""
if command -v ipconfig >/dev/null 2>&1 && [[ "$(uname -s)" == "Darwin" ]]; then
  for iface in en0 en1 en2 en3; do
    ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    [[ -n "$ip" ]] && { LAN_IP="$ip"; break; }
  done
fi
if [[ -z "$LAN_IP" ]]; then
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi

# Build the SAN (Subject Alternative Name) list. Browsers verify against
# SAN entries, not the CN, so this is what really matters for trust.
SAN_DNS=("localhost")
SAN_IP=("127.0.0.1")
[[ -n "$LAN_IP" ]] && SAN_IP+=("$LAN_IP")
for arg in "$@"; do SAN_DNS+=("$arg"); done

# Compose the openssl SAN extension string.
SAN_LIST=""
for d in "${SAN_DNS[@]}"; do SAN_LIST+="DNS:$d,"; done
for i in "${SAN_IP[@]}"; do SAN_LIST+="IP:$i,"; done
SAN_LIST="${SAN_LIST%,}"

echo
echo "Generating cert valid for:"
for d in "${SAN_DNS[@]}"; do echo "  DNS  $d"; done
for i in "${SAN_IP[@]}"; do echo "  IP   $i"; done
echo

openssl req -x509 -newkey rsa:4096 -sha256 -nodes \
  -keyout "$KEY_PATH" \
  -out    "$CERT_PATH" \
  -days   3650 \
  -subj   "/CN=IG Tracker Local" \
  -addext "subjectAltName=$SAN_LIST" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  >/dev/null 2>&1

chmod 600 "$KEY_PATH"
chmod 644 "$CERT_PATH"

echo "✓ Wrote $CERT_PATH"
echo "✓ Wrote $KEY_PATH"
echo
echo "Next steps:"
echo "  1. Start the server in HTTPS mode:"
echo "       IG_HTTPS=1 ./run.sh"
echo "     (server now listens on https://0.0.0.0:8443 instead of plain http:8000)"
echo
echo "  2. Trust the cert on your iPhone — see README.md → 'iPhone HTTPS setup'"
echo "     (one-time, ~5 taps)"
echo
echo "  3. Visit from your phone:    https://$LAN_IP:8443"
echo "     Visit from your Mac:      https://localhost:8443"
echo
