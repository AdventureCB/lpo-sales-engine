# LPO Queue Runner — rep machine setup (macOS)

## The easy way (~3 min)

1. Download the release zip and unzip it (contains the dmg + `install.command`).
2. Run **install.command**. macOS will block a double-click ("Apple could not
   verify…") because the script is unsigned — either:
   - open **Terminal** and run: `bash ` then drag `install.command` into the
     window and press Enter, **or**
   - try the double-click, then System Settings → Privacy & Security →
     scroll down → **Open Anyway**.
   It installs the app, installs BlackHole (the virtual audio device — may
   ask for your Mac password), and launches Queue Runner.
3. In Queue Runner: log in, then in the **Voicemail drop** panel click
   **⚙️ Create Mic + VM device** (one click, no admin needed).
4. In **Quo**: Settings → Audio → Microphone → choose **Mic + VM**.
5. Record your drops (Voicemail drop panel → Record new), one per queue type,
   under ~30 seconds each.

## Test it

Call your own cell, let it go to voicemail, click **Drop VM** at the beep,
hang up, then listen to the voicemail you received.

## Troubleshooting

- **"BlackHole ✗ not installed"** in the panel → rerun `install.command`, or
  install manually from https://existential.audio/blackhole/ then restart the app.
- **Voicemail recorded silence** → Quo's microphone isn't set to "Mic + VM" (step 4).
- **Contact hears you fine but drops are silent** → same as above.
- **First app launch blocked** → right-click the app → Open (unsigned app, one-time).
- The browser version of the dialer logs "VM left" but cannot play audio into
  a call — real drops are companion-only.
