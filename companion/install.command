#!/bin/bash
# LPO Queue Runner — one-shot installer.
# Double-click me (must be in the same folder as the "LPO Queue Runner" dmg).
set -e
cd "$(dirname "$0")"

echo "=== LPO Queue Runner installer ==="

# 1. App → /Applications
DMG=$(ls "LPO Queue Runner"*.dmg 2>/dev/null | head -1)
if [ -z "$DMG" ]; then
  echo "ERROR: put this script in the same folder as the LPO Queue Runner dmg."
  exit 1
fi
echo "→ Installing app from $DMG"
MOUNT=$(hdiutil attach "$DMG" -nobrowse | grep -o "/Volumes/.*" | head -1)
rm -rf "/Applications/LPO Queue Runner.app"
cp -R "$MOUNT/LPO Queue Runner.app" /Applications/
hdiutil detach "$MOUNT" -quiet
xattr -dr com.apple.quarantine "/Applications/LPO Queue Runner.app" 2>/dev/null || true
echo "   ✓ installed to /Applications"

# 2. BlackHole 2ch (virtual audio device)
if system_profiler SPAudioDataType 2>/dev/null | grep -q "BlackHole 2ch"; then
  echo "→ BlackHole 2ch already installed ✓"
elif command -v brew >/dev/null 2>&1; then
  echo "→ Installing BlackHole 2ch via Homebrew (may ask for your password)"
  brew install --cask blackhole-2ch
else
  echo "→ Downloading BlackHole 2ch"
  PKG_URL=$(curl -s https://formulae.brew.sh/api/cask/blackhole-2ch.json | grep -o '"url":"[^"]*\.pkg"' | head -1 | cut -d'"' -f4)
  if [ -z "$PKG_URL" ]; then
    echo "   Could not resolve download URL — install manually from https://existential.audio/blackhole/"
  else
    curl -sL "$PKG_URL" -o /tmp/blackhole.pkg
    echo "   Installing (asks for your password)…"
    sudo installer -pkg /tmp/blackhole.pkg -target /
    rm -f /tmp/blackhole.pkg
    echo "   ✓ BlackHole installed"
  fi
fi

# 3. Launch — audio device creation is one click inside the app
echo ""
echo "=== Almost done — two clicks left ==="
echo "1. In Queue Runner (opening now): log in, then in the Voicemail Drop"
echo "   panel click '⚙️ Create Mic + VM device'."
echo "2. In Quo: Settings → Audio → Microphone → choose 'Mic + VM'."
open "/Applications/LPO Queue Runner.app"
