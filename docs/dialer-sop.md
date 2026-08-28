# Dialer SOP — Sales Rep Guide

*How to run a dial session in the LPO Sales Engine. This is the detailed companion to the general [Rep SOP](https://app.clickup.com/90141363968/docs/2kydg3r0-2594) — read that first for the daily rhythm; this one is the dialer itself, button by button. Questions and corrections → Kyle.*

---

## What the dialer is

The dialer walks you through a queue of deals one at a time. For each one it shows you everything the CRM knows (the full deal page is embedded right there), lets you call in one click, and after you hang up it captures the outcome and your next follow-up — then advances to the next deal. Your whole day's calling lives on this one screen; you should rarely need to leave it.

Calls place **in your browser** — no separate phone app, no cell phone. Every call auto-logs to the deal with a recording and transcript.

---

## 1. Starting a session

1. Open **Dialer** from the sidebar.
2. Pick your **queue** at the top. Most days this is your **sprint list** (generated on the Sprint Lists page — press the **ℹ️** there to see exactly how deals are chosen and ranked). You can also open a sprint list directly from the Sprint Lists page and it drops you straight into the dialer.
3. The header shows your progress: `Queue: <name> · Call 3 / 40`. It also tells you if any deals were **excluded** (no phone number, or owned by another rep) so the count is never a mystery.
4. **First click**: click anywhere once when the app opens — browsers block call audio until your first interaction.

> **Shared pool queues** show extra detail — how many deals are eligible, how many are cooling down (recently dialed, 2-day rest), and how many another rep currently has checked out. You only ever get deals that are truly yours to work.

---

## 2. The dial cycle

Every deal follows the same loop. Learn this rhythm and you can run it almost entirely from the keyboard.

### Step 1 — Review the lead

Before you dial, the deal page is right in front of you: contact, marketing signals, ad journey, timeline, and the **AI buyer profile**. While you read, the AI pre-builds a **call outline** in the **🗒 Scripts & drafts** card — their likely story, your plan, discovery questions, and objections to expect. Glance at it; it's built for this specific buyer.

### Step 2 — Dial

Press **📞 Dial** (or hit <kbd>Enter</kbd>). The call connects in your browser. A live timer shows the call length.

While on the call you have three actions:

| Button | Key | What it does |
|---|---|---|
| 🎙 **Drop VM** | <kbd>V</kbd> | Plays your pre-recorded voicemail into the call, then ends it — for when you reach their voicemail and don't want to talk live. |
| ⏹ **End call** | <kbd>E</kbd> | Hangs up. |

### Step 3 — Disposition (required, every call)

The moment the call ends, pick what happened. **Never skip this** — dispositions drive cooldowns, your stats, and how lists get ranked.

| Disposition | Key | Use when |
|---|---|---|
| ✅ **Connected** | <kbd>1</kbd> | You had a real conversation. |
| 🎙 **VM left** | <kbd>2</kbd> | You left a voicemail. |
| 🚫 **Bad number** | <kbd>3</kbd> | Number doesn't reach them — flags it so it stops getting dialed. |
| 📅 **Callback set** | <kbd>4</kbd> | They asked to be called back at a specific time. |
| 📋 **Confirmation call** | <kbd>5</kbd> | A post-sale confirmation call. |
| 📵 **No answer** | <kbd>6</kbd> | Rang out, no voicemail left. |

**↺ Redial** (<kbd>R</kbd>) re-calls the same contact without logging anything — for when the line dropped or you misdialed.

If you pick **No answer**, you'll be asked why: **Ignored** vs **VM full / not set**. This is useful signal — a full mailbox is a different problem than someone screening you.

### Step 4 — Note + next step

After the disposition:

- **Add a note** about the call (optional). Type `@name` to tag a teammate — they get a notification.
- **Set the next step.** Choose the activity type (📞 Call / 💬 Text / 📋 Task / ✉️ Email / 📅 Meeting) and when: **1 week**, **2 weeks**, **1 month**, **📅 Custom** date, or **No follow-up** (<kbd>Enter</kbd>).

> **Always schedule the follow-up before you move on.** Future-you will not remember to call this person back. A deal with no next step is a deal that quietly dies.

### Step 5 — Continue

- In **normal mode**, you land on a brief review pause: *"✓ Logged — send an email, add another activity, or update the deal, then continue."* This is your moment to fire off a follow-up email, add a second task, or edit the deal while it's fresh. Press **Next →** (<kbd>Enter</kbd>) when done.
- In **Fast mode** (toggle in the session panel), you skip straight to the next dial. Use it when you're heads-down grinding voicemails.

While you're on the review pause, the dialer is already loading the *next* deal in the background, so advancing is instant.

---

## 3. Skipping a deal

Press **Skip** (<kbd>S</kbd>) before dialing to get a choice:

- **↓ End of list** — moves them to the end of this session; you'll circle back before you finish.
- **✕ Remove today** — drops them from today's sprint list entirely.

Use *End of list* when now's a bad time (you'll retry today), *Remove today* when they shouldn't be called today at all.

---

## 4. Manual dial (off-list)

Need to call a number that isn't in your queue? Open the **keypad**, type the number, and call. The dialer tries to match it to an existing deal automatically; if there's no match, you can attach the call to a deal or just log it standalone. Same disposition flow applies.

---

## 5. Keyboard cheat-sheet

The dialer is built to run from the keyboard. **Hotkeys pause automatically while you're typing in any text box** (notes, email, search), so you never fire an accidental command mid-sentence.

| Key | Action |
|---|---|
| <kbd>Enter</kbd> | Dial · confirm disposition · Next (context-aware) |
| <kbd>1</kbd>–<kbd>6</kbd> | Set disposition |
| <kbd>R</kbd> | Redial (no log) |
| <kbd>V</kbd> | Drop voicemail |
| <kbd>E</kbd> | End call |
| <kbd>S</kbd> | Skip |
| <kbd>N</kbd> / <kbd>Enter</kbd> | Next deal (on the review pause) |

---

## 6. Your session panel (right side)

Live scoreboard for the day, so you always know where you stand:

- **Today**: dials vs. your daily goal and bonus goal, talk-time progress, connects, day streak, and your personal best. Hit a milestone and you get a little celebration — that's intentional; calling is a numbers game and momentum matters.
- **This session**: dials, connects, voicemails, and talk time for the current run.
- **Fast mode** toggle lives here.

The panel dims while you're on a call so nothing distracts you from the conversation.

---

## 7. Habits that separate good reps from great ones

- **Disposition every call — no exceptions.** It's two keystrokes and it's what makes the whole system work for you.
- **Schedule the next step before advancing.** Every deal leaves the dialer with a future date attached.
- **Read the AI profile and call outline before you dial.** Thirty seconds of prep changes the call.
- **Speed to lead beats everything.** Fresh leads and hot-flag deals get called first — a lead called within a day wins far more often than one that sat.
- **Use the review pause.** Sending the follow-up email *right after* the call, while it's fresh, is worth more than a dozen you'll "get to later."
- **Correct the AI when it's wrong** (✕ on a bad tag, ✎ to tell it a fact). It learns your deals and gets sharper — and it only learns if you teach it.

---

## 8. Troubleshooting

| Symptom | Do this |
|---|---|
| Dialer feels slow or stuck | Fully quit the companion (⌘Q) and reopen. Fixes the large majority of issues. |
| No audio on calls | Click anywhere in the app once (audio unlocks on first click); check your mic permission. |
| "Phone active in another window" | Your phone lives in one window — dial from your main window, or close the other and it takes over. |
| A call didn't log | It logs a moment after you hang up; give it a few seconds and refresh the deal. If it's still missing, tell Kyle the time. |
| Queue is empty | Generate a fresh sprint list on the Sprint Lists page. New reps: lists auto-fill from the unassigned pool. |
| "Connection hiccup — reconnecting…" | Your network blipped; the app recovers itself. If it's frequent, switch to a wired connection. |

---

*Everything happens in the app — it is the single source of truth. No personal phones, no outside tools.*
