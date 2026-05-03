#!/usr/bin/env bash
#
# Create the encrypted disk image that holds the IG Vault contents.
#
# macOS-only. Uses the OS's built-in AES-256 sparse bundle — no Python
# crypto code, no third-party libraries, just hdiutil. Encryption is
# handled by APFS at the filesystem level.
#
# Run once. Default location: ~/Documents/IG Vault.sparsebundle.
# To change: set IG_VAULT_PATH env var.

set -euo pipefail

VAULT_PATH="${IG_VAULT_PATH:-$HOME/Documents/IG Vault.sparsebundle}"
SIZE_GB="${IG_VAULT_SIZE_GB:-10}"
VOLNAME="IGVault"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script uses macOS's hdiutil. For Linux/Windows you'd need a different encryption approach (LUKS / VeraCrypt / age)."
  exit 1
fi

if [[ -e "$VAULT_PATH" ]]; then
  echo "Vault already exists at: $VAULT_PATH"
  echo "Delete it manually if you want to start over (this DESTROYS all saved media)."
  exit 0
fi

mkdir -p "$(dirname "$VAULT_PATH")"

cat <<EOF

Creating a $SIZE_GB GB encrypted sparse bundle at:
  $VAULT_PATH

You'll be prompted for a passphrase next.

PASSPHRASE GUIDANCE:
  - 16+ characters minimum, ideally a multi-word passphrase
    (e.g. "correct horse battery staple", but yours, not famous)
  - There is NO RECOVERY if you forget it. The data is unrecoverable.
  - DO NOT save it anywhere that syncs to the cloud.
  - DO NOT save it in a notes app on your phone.
  - Memorize it OR write it on paper and put the paper in a physical
    safe / locked drawer.

EOF

read -r -p "Press Enter when ready, or Ctrl-C to abort." _

# Sparse bundle — grows on demand up to the size cap, doesn't pre-allocate.
# AES-256 with the passphrase you'll type. APFS as the inner filesystem
# so it works with modern macOS.
hdiutil create \
  -size "${SIZE_GB}g" \
  -encryption AES-256 \
  -fs APFS \
  -type SPARSEBUNDLE \
  -volname "$VOLNAME" \
  "$VAULT_PATH"

# Tell Time Machine + iCloud not to back up the sparsebundle. The whole
# point is local-only; an automatic upload to iCloud would defeat it.
xattr -w com.apple.metadata:com_apple_backup_excludeItem "com.apple.backupd" "$VAULT_PATH" 2>/dev/null || true
# This sets the "Do Not Back Up" attribute that Time Machine respects.
tmutil addexclusion "$VAULT_PATH" 2>/dev/null || true

cat <<EOF

✓ Created $VAULT_PATH

NEXT STEPS:

  1. Mount the vault (Finder will prompt for your passphrase):
       open "$VAULT_PATH"

  2. Start the vault server:
       python -m vault

  3. Open in browser:
       http://localhost:8765

  4. When you're done, eject the volume so the data is encrypted again:
       Finder → sidebar → click the eject icon next to "IGVault"
     OR via terminal:
       hdiutil eject /Volumes/$VOLNAME

The vault server REFUSES to run if the volume isn't mounted. So locking
the vault = ejecting the volume.

EOF
