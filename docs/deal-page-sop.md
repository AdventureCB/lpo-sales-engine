# Deal Page SOP — Sales Rep Guide

*Everything on a CRM deal page, top to bottom, and what it means. The deal page is your cockpit for one customer — the same view appears embedded in the dialer, so learning it once covers both. Companion to the [Rep SOP](https://app.clickup.com/90141363968/docs/2kydg3r0-2594), [Dialer SOP](docs/dialer-sop.md), and [AI Features SOP](docs/ai-features-sop.md). Questions and corrections → Kyle.*

---

## How the page is laid out

A deal page has three zones:

- **The header** — the deal's identity and outcome controls (title, stage, owner, value, source, and the Open / Deposit / Confirmed / Lost buttons).
- **The main column** — the communication bar, the AI profile, the timeline (the running history), and marketing/ad context.
- **The side panel** — quick actions, upcoming follow-ups, call-effort stats, and the contact card.

Everything you can edit saves instantly — there's no separate "Save deal" button for most fields.

---

## 1. The header — identity & outcome

### Title, stage line, and value

- **Deal title** — press **✏️ Rename** to change it. Titles usually name the customer or the lead source (e.g. *"Saved Build - James Maloney"*).
- Under the title: **Pipeline ▸ Stage · status · value** at a glance.
- **🎯 Close likelihood** (admin-only) may appear here on open deals — an AI estimate of how likely this deal is to close, with the factors behind it. Reps won't see it.

### Editable properties (the labeled row)

| Field | What it is |
|---|---|
| **Pipeline** | Which pipeline the deal lives in. Changing it lets you re-pick the stage. |
| **Stage** | Where the deal sits in that pipeline's flow. |
| **Owner** | The rep who owns the deal. **Unassigned (pool)** means it's in the shared re-prospecting pool — fair game for sprint lists. |
| **Source** | Where the lead came from (Quote Survey, Saved Build, Abandoned Cart, etc.). |
| **Ad** | If we know the ad that brought them in: the channel/source, campaign, and rough lead cost. Pulled from our ad tracking. |
| **Value ($)** | The deal's dollar value. Type a number and press Enter or Save. |

### Outcome buttons (right side)

These are how you move a deal to its conclusion. The current state is highlighted.

- **🔄 Open** — the deal is in play. Pressing it on a closed deal *reopens* it (you pick which pipeline and stage it returns to).
- **💰 Deposit** — the customer placed a deposit. Pressing it **requires you to schedule the confirmation follow-up** — the deposit and the follow-up are recorded together so nothing slips.
- **✓ Confirmed** — the deal is done and executed; it archives as **Won**.
- **✗ Lost** — opens the loss flow. You pick a **category** first, and each does something different (see below). Always categorize honestly — the automation depends on it.
- **⧉ Merge** — fold a *duplicate* deal into this one. Merge moves the other deal's entire history onto this deal and deletes the duplicate — use this instead of "Lost → Duplicate" when you want to keep both timelines combined.

### The Lost categories

| Category | What happens |
|---|---|
| **DNC** — asked us to stop | Marked lost immediately; the contact is protected forever — never called, texted, or listed again. **Absolute.** |
| **No interest** | Unassigned → back to the re-prospecting pool. |
| **No contact made** | Unassigned → back to the pool. |
| **Competitor purchase** | Requires the competitor's name, then marks lost. That name feeds our positioning. |
| **Not qualified** | Unassigned → back to the pool. |
| **Duplicate** | Marked lost automatically. (If the *other* deal is the keeper, use **⧉ Merge** instead to preserve this timeline.) |

> **DNC is sacred.** Any version of "stop contacting me" → DNC, immediately, no exceptions.

---

## 2. The communication bar

Right under the header is the comm bar — your one-stop to reach this customer without leaving the page. It has a **call** button (opens the floating call panel with the disposition flow), and buttons to send a **text**, **email**, or add a **note**. Texts and emails go out through your own line/Gmail and log to the timeline instantly. Details on the send flows are in the [Rep SOP](https://app.clickup.com/90141363968/docs/2kydg3r0-2594).

---

## 3. 🧠 AI Buyer Profile

Below the comm bar: who this buyer is, built from transcripts, ads, and signals — with a confidence band, archetype fit, tags, and a suggested next action that tells you what to ask to raise its confidence. This has its own full guide: **[AI Features SOP](docs/ai-features-sop.md).** The short version: read it before you dial, correct it when it's wrong (✕ / ✎), and use the "Missing:" line as your discovery checklist.

---

## 4. The timeline — the deal's whole story

The heart of the page: **every interaction, newest at top.** Each entry has an icon telling you what it is:

- **📞 Calls** — with a recording and full transcript once processed. Click to expand. Calls with a real transcript show a **⚖ Review call** button (StoryBrand coaching — see the AI SOP).
- **💬 Texts** — inbound and outbound, including photos/videos (expand to see them).
- **✉️ Emails** — 📥 inbound, 📤 outbound. **Inbound emails have a ↩ Reply button** that threads your reply into their inbox. Sent emails show **👁 open and 🔗 click tracking** once the customer engages.
- **📝 Notes** — yours and the team's. Expand to edit your own.
- **📼 Voicemails** — with audio and a transcript.
- **System events** — deal created, merged, source changed, lost-category set, etc. — so the record is always honest about what happened and why.

Click any entry to expand it — full text, media, audio player, the review button, and the exact timestamp.

> **Everything the customer and team did lives here.** Before any call, skim the recent timeline — you'll never be caught not knowing the last thing that happened.

### Saved-build links

When a saved-build link appears in the timeline, **click it to copy the complete URL** — always share the full link, never retype a shortened one.

---

## 5. Marketing signals & ad interactions

Below the timeline (or in the side context) you'll find what the customer has been doing *outside* your conversations:

- **Marketing signals** — their Klaviyo activity: emails opened, links clicked, builder saves, checkouts started. This is buying-intent gold — someone opening every email is warm. Occasionally it surfaces a fact worth adding to the deal (e.g. *"Klaviyo has truck model: Tacoma — + Add to deal"*).
- **Ad interactions** — the customer's ad and site journey with rough cost per click, newest first. Click any interaction to expand it. **📋 marks a survey response** — and if they answered a "how did you hear about us" style question, their actual words show right there in quotes. This tells you which ad or channel actually brought them in.

---

## 6. The side panel

### Actions

- **📝 Add note** — log something (tag teammates with `@name`).
- **📅 Schedule activity** — set a future task/call/email/meeting.
- **⚡ Add to sprint** — put this deal on a sprint call list (shows how many lists it's already on).
- **😴 Snooze lists** — keep this deal *off* the daily sprint call lists until a date you pick (1 week / 2 weeks / 1 month / 3 months, or custom). It stays visible everywhere else — this just says "don't surface it for calling yet." Useful when a customer says "check back next month."

### Upcoming

Your scheduled follow-ups for this deal, with due dates. **Overdue ones are flagged in red.** Completing one logs it to the timeline. This is your promise-keeping list — a deal with nothing upcoming is a deal with no next step.

### Call effort

A quick scoreboard for this specific deal: **Dials**, **Talk time**, and **Answer rate**. Tells you at a glance how hard this deal has been worked.

### Contact

The customer's details — name, company, **phones** and **emails** (with the primary marked, and bad numbers flagged), plus **SMS consent** status so you know whether you can legally text them. You can add/edit contact info here.

Also in this area:

- **Truck model** — the customer's vehicle; it drives fitment and archetype fit. If Klaviyo knows the truck and the deal doesn't, you'll get a one-click "+ Add to deal."
- **Primary interests** — toggle chips (hunting, overlanding, family camping, etc.). These are **rep-verified ground truth** — they weigh heavily in the AI profile, so set them when you learn something real.

### Record

The deal's vital stats: when it was **created**, when the **stage last changed**, **last activity**, and the internal **Deal #**.

---

## What to check before every call (the 20-second scan)

1. **AI profile** — who is this, and what's it missing?
2. **Recent timeline** — what was the last thing that happened?
3. **Upcoming** — is there a promise I made to follow up on?
4. **Marketing signals** — have they been opening/clicking lately? (A warm deal calls differently.)
5. **Interests & truck** — do I know their setup?

That scan turns a cold dial into an informed conversation, and it's all on one screen.

---

*Everything happens in the app — it is the single source of truth. Log every interaction; if it isn't on the deal page, it didn't happen.*
