# LPO Queue Runner — rep machine setup (macOS)

One-time setup per rep machine (~15 min). After this, "Drop VM" plays the
rep's recorded voicemail straight into the call.

## 1. Install the app

Open `LPO Queue Runner.dmg`, drag the app to Applications. First launch:
right-click → Open (unsigned app warning appears once). Log in with your
sales-engine account.

## 2. Install BlackHole (virtual audio device)

Download **BlackHole 2ch** (free): https://existential.audio/blackhole/
(or `brew install blackhole-2ch`). Restart isn't usually required.

## 3. Create the merged microphone

Quo needs to hear BOTH the real mic and the VM recordings:

1. Open **Audio MIDI Setup** (Applications → Utilities).
2. Click **+** (bottom left) → **Create Aggregate Device**.
3. Check **both** your built-in microphone AND **BlackHole 2ch**.
4. Rename it "Mic + VM".
5. Enable **Drift Correction** on BlackHole.

## 4. Point Quo at it

Quo desktop → Settings → Audio → Microphone → select **Mic + VM**.
Speaker/output stays unchanged.

## 5. Record your drops

In Queue Runner → Dialer → Voicemail drop panel → **Record new**. Record one
per queue type (first touch, recovery, …). Keep them under ~30 seconds.

## 6. Test

Call your own cell, let it hit voicemail, click **Drop VM** at the beep,
then check the voicemail you received. Adjust mic/BlackHole volumes in
Audio MIDI Setup if levels are off.

## Troubleshooting

- **"audio device 'BlackHole 2ch' not found"** → step 2 didn't finish; check
  System Settings → Sound → Input lists BlackHole.
- **Voicemail got silence** → Quo's mic isn't the aggregate device (step 4).
- **Contact hears you fine but no drop** → same as above.
- The web version of the dialer (browser) logs "VM left" but cannot play
  audio into the call — that's companion-only.
