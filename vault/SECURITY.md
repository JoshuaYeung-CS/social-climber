# Vault security model

Encryption protects against **post-hoc disclosure**: someone gets your Mac
months later, can't read what's inside without the passphrase. That's the
only thing it protects against. Everything below is the surface area
encryption *doesn't* cover, and what to do about each.

## Threat model

| Threat | Encryption helps? | Mitigation |
|---|---|---|
| Cold drive analysis (lost laptop, forensic team) | ✅ Yes — APFS AES-256 | Strong passphrase, eject when not in use |
| Cloud sync leaks (iCloud, Time Machine) | ✅ Yes — `make-vault.sh` excludes the bundle from both | Verify with `tmutil isexcluded` (script below) |
| Browser cache / temp files | ❌ No | The vault keeps bytes only inside the mounted volume; the browser still caches separately |
| Memory access while unlocked | ❌ No | Eject as soon as you're done; lock screen when away |
| Screen recording malware on your Mac | ❌ No | See "Screen recording" section |
| Shoulder surfing | ❌ No | See "Shoulder surfing" section |
| Coercion ("unlock it or else") | ❌ No | This is a hard limit of all crypto |
| Forgotten passphrase | ❌ No — there's no recovery | Memorize OR write on paper in a physical safe |
| Instagram knowing you viewed | ❌ No — viewing is independent of saving | Nothing to do; this is fundamental |

## Shoulder surfing

**What it is**: someone physically near you sees your screen — passphrase
typing, vault contents, anything visible. The most common breach for any
encrypted system.

**Defenses, easiest first:**

- **Be aware of your surroundings before unlocking.** If anyone is
  behind you, wait. Cafes, airports, classrooms, libraries — all common
  shoulder-surfing locations.
- **Privacy filter for your screen.** 3M makes ones that narrow the
  viewing angle to ~30°; people 60° off can't see anything. ~$30, fits
  most laptops. Search "3M privacy filter MacBook Pro 14".
- **Type the passphrase only — never write it on screen.** Don't paste
  from a notes file. Don't have it visible while you type.
- **Use TouchID/FaceID where possible.** macOS supports unlocking
  encrypted disk images via TouchID — biometrics can't be shoulder-surfed.
- **Cover the keyboard if you're on a phone or in tight quarters.**
  Sounds paranoid; works.

## Screen recording

**What it is**: software running on your Mac that records your screen
continuously. Could capture passphrase entry, vault contents, anything.
Sometimes legitimate (Zoom share-screen, screenshot tools); sometimes
malicious.

**Check what currently has Screen Recording permission:**

```bash
./scripts/check-screen-recording.sh
```

This script reads macOS's TCC (Transparency, Consent, and Control) database
to list every app you've granted Screen Recording to. Anything you don't
recognize → revoke in `Settings → Privacy & Security → Screen Recording`.

**Defenses:**

- **macOS sandboxes by default.** Apps need explicit permission for screen
  recording — when you grant it, macOS shows a dialog. If you've never
  said yes to anything, you're probably fine.
- **Audit periodically.** Run the check script monthly. macOS notifies
  when an app first records, so a brand-new permission grant should be
  visible.
- **Stay current.** macOS security updates patch the loopholes that let
  malware bypass the permission system. Don't ignore the update banner.
- **Don't install random `.dmg` files.** App Store and Homebrew are
  significantly safer than "this random tool I found on a forum".
- **Run a malware scan** if you're suspicious. Malwarebytes for Mac is
  free and doesn't require a subscription for on-demand scanning.
- **Network-level monitoring.** Tools like LuLu (free, open-source) or
  Little Snitch ($45) alert when an app makes an outbound network
  connection. A malicious screen recorder has to upload what it captures
  somewhere — these tools catch that egress.

## Daily checklist (5 seconds)

1. Eject the IGVault volume in Finder when you stop using the vault app.
2. Lock your Mac before walking away (Ctrl-Cmd-Q).
3. If anyone's watching your screen, don't unlock the vault.

## Emergency

**Compromised passphrase**: there's no "change passphrase" for an
existing sparse bundle. To rotate: create a new vault, copy contents
across, delete the old one. The old bundle on a backup drive (if you
made one) is still readable with the old passphrase forever.

**Lost passphrase**: data is unrecoverable. Period. This is the strength
and the danger of the design.
