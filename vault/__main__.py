"""Run with: python -m vault

Refuses to start unless the encrypted volume is mounted at the expected
path. The volume is created once via scripts/make-vault.sh and unlocked
by opening the .sparsebundle in Finder (you type the passphrase there).
"""

import os
import sys
from pathlib import Path

import uvicorn


VAULT_VOLUME = Path(os.environ.get("IG_VAULT_VOLUME", "/Volumes/IGVault"))


def main() -> None:
    if not VAULT_VOLUME.exists() or not VAULT_VOLUME.is_dir():
        print("=" * 60)
        print("  IG Vault — volume not mounted.")
        print("=" * 60)
        print()
        print(f"  Expected:  {VAULT_VOLUME}")
        print()
        print("  To unlock the vault, open the sparsebundle in Finder:")
        print()
        print("      open ~/Documents/IG\\ Vault.sparsebundle")
        print()
        print("  Finder will prompt for your passphrase. Once mounted,")
        print("  re-run this command.")
        print()
        print("  If you've never created the vault, run:")
        print()
        print("      ./scripts/make-vault.sh")
        print()
        sys.exit(1)

    port = int(os.environ.get("IG_VAULT_PORT", "8765"))

    print()
    print("=" * 60)
    print("  IG Vault — UNLOCKED")
    print("=" * 60)
    print(f"  URL:     http://localhost:{port}")
    print(f"  Volume:  {VAULT_VOLUME}")
    print()
    print("  To LOCK the vault: stop this server (Ctrl-C) AND eject the")
    print("  volume in Finder (or 'hdiutil eject /Volumes/IGVault').")
    print("  Without ejecting, contents stay readable to anyone with")
    print("  access to your Mac while it's unlocked.")
    print()
    print("=" * 60)
    print()

    uvicorn.run(
        "vault.server:app",
        host="127.0.0.1",  # local-only on purpose; never expose vault on LAN
        port=port,
        log_level="info",
        reload=False,
    )


if __name__ == "__main__":
    main()
