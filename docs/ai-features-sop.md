# AI Features SOP — Sales Rep Guide

*How to use and understand the AI assistant built into the LPO Sales Engine. This is the detailed companion to the general [Rep SOP](https://app.clickup.com/90141363968/docs/2kydg3r0-2594) and the [Dialer SOP](docs/dialer-sop.md). Questions and corrections → Kyle.*

---

## The one idea to hold onto

The AI is a **research assistant and a writer**, not an autopilot. It reads everything on a deal so you don't have to, tells you who the buyer likely is and what to do next, drafts your calls/emails/texts in our voice, and grades your calls so you get better. **You are always the decision-maker** — you approve every word before it goes out, and when the AI is wrong you tell it, and it listens. It genuinely gets sharper on your deals the more you correct it.

Nothing the AI does is ever sent to a customer on its own. Every draft waits for you to review, edit, and send.

There are four things a rep touches:

1. **🧠 AI Buyer Profile** — who this buyer is and what to do next
2. **🗒 Scripts & drafts** — call outlines, emails, and texts written for you
3. **⚖ Review call** — coaching on a call you had
4. **✕ / ✎ corrections** — how you teach it

---

## 1. 🧠 AI Buyer Profile

Below the marketing signals on every worked deal (and in the dialer as you review a lead) is the buyer profile. It's assembled from **call transcripts, the ad journey, engagement signals, and everything on the deal**.

### The header tells you how much to trust it

At the top you'll see two things:

- **A confidence band** — `Thin`, `Developing`, `Solid`, or `Rich`. This is how much real information the AI had to work with. A *Thin* profile is a first guess from almost nothing; a *Rich* one is built on real conversations.
- **A % confidence** — the AI's overall certainty in this read.

> **This is the honest part.** The AI does not pretend to know things it doesn't. A thin profile with 40% confidence is telling you the truth — *"I don't have much yet"* — which is exactly what makes it trustworthy when it *does* say it's confident.

### What it shows you

- **Archetype fit** — bars showing which of our buyer personas this person blends (e.g. Weekend Warrior 45%, Overland Family 30%). Buyers are a *mix*, not one label. Hover a bar to see the evidence behind it.
- **A short summary** — the buyer in a couple of sentences.
- **#tags** — specific memorable details the buyer mentioned: `#surfing`, `#has-two-dogs`, `#tows-a-boat`, `#lives-in-bend`. These are the things you'd want at a glance before dialing.
- **Attribute chips** — structured facts (timeline, budget, vehicle, decision role, etc.). The **fainter a chip, the less sure the AI is** about it — opacity literally tracks confidence. Hover for the exact % and the evidence.

### The most important part: what it needs to get smarter

Every profile ends with two things that make it self-improving:

- **Suggested next action** + **"Ask on the next touch:"** — a concrete recommendation plus the exact discovery questions to ask. When the profile is thin, these questions are *chosen to fill the biggest gaps* — the AI is literally telling you what to find out to raise its own confidence.
- **A coverage note and a "Missing:" line** — e.g. *"Missing: timeline, budget, decision role."* These are the high-value facts still unknown. **Ask about them on your next call**, log what you learn, and the profile rebuilds sharper.

So the loop is: read the profile → it tells you what it's missing → you ask those things on the call → you log the answers → the profile levels up. A *Thin* profile isn't a failure; it's a to-do list.

### Building and refreshing

- Profiles **build automatically** the first time you open a deal that qualifies, and **refresh on their own** as new calls and signals come in (usually within ~20 minutes of a call's transcript landing).
- The **Build profile / ↻ Refresh** button (top-right of the card) forces it to re-read right now — useful right after a call when you want the latest read before your next move.

---

## 2. Teaching the AI (✕ and ✎) — your corrections are law

This is the single most valuable thing you do with the AI, and it takes seconds.

- **✕ on anything wrong** — an archetype that doesn't fit, a bad tag, an incorrect attribute. It disappears immediately **and the AI never re-asserts it.** Your judgment overrides the model, permanently, on that deal.
- **✎ "Tell the AI something it got wrong"** — type a plain-English fact and press **Teach**. Examples:
  - *"not a hunter — that was his brother"*
  - *"budget is firm at ~$15k"*
  - *"already has a Tacoma, shopping for his son"*

  The AI treats your note as **verified truth**, re-reads the whole deal in light of it, and the profile updates in a few seconds.

> **Why bother?** Because it compounds. Every correction makes this deal's profile — and the scripts and next actions built from it — more accurate. The AI is only as good as the ground truth you give it, and you're the one on the phone.

---

## 3. 🗒 Scripts & Drafts

The **🗒 Scripts & drafts** card writes for you, voiced like our team, tailored to *this* buyer. It's collapsed on the deal page and open in the dialer.

### Call outline (StoryBrand)

When you review a lead in the dialer, the AI **pre-builds a call outline** so it's ready before you dial. It's structured on StoryBrand — the buyer is the hero, you're the guide:

- **🪝 Hook** — how to open
- **🧭 Their story** — where this buyer is coming from
- **🤝 Guide move** — how to position yourself as the expert who gets them there
- **🗺 The plan** — the simple path forward
- **❓ Ask** — discovery questions for this buyer
- **🛡 If they push back** — likely objections and how to answer them
- **🎯 The ask** — your clear call to action
- **📼 If voicemail** — what to say if you get their machine

It's a **scan-in-10-seconds** guide, not a script to read word-for-word — the load-bearing words are bolded. Use **↻ Rebuild outline** to regenerate, and **👎** (with an optional note) when it misses.

### Email & text drafts

Press **✉️ Draft email** or **💬 Draft text**. You'll pick an **angle** first:

- **✨ Auto** — let the AI choose the best angle for where this deal stands
- **Theme chips** — pick a specific angle (follow-up on a build, financing, schedule a call, handle an objection, re-engage a cold deal, breakup email, etc.). A **⭐ marks the angle the AI suggests** for this deal based on its context.
- **Optional direction box** — type anything specific: *"mention the Tacoma bed length"* or *"keep it short, he's busy."*

Then **Generate**. The draft appears; press **Use in email composer →** (email lands in the comm bar with your signature) or the text drops into the chat dock. **Edit before sending — you own every word.** Press **👎** with a note when a draft misses.

### What the AI uses to write these

The drafts aren't generic. They're built from:

- **This buyer's profile** — their archetype, interests, tags, and where the conversation stands
- **Our team's real macros and examples** — so the voice sounds like us, not like a robot
- **Our asset library** — it only links a build, a guide, or a page when it genuinely helps this buyer's next step, and it knows what each link contains
- **The angle you chose** (theme + direction)
- **What the team has learned** — feedback from 👎s across the team quietly shapes future drafts

Because it recompiles from the live library each time, the drafts improve automatically as our macros and assets get better — you don't have to do anything.

---

## 4. ⚖ Review call

After a real conversation, open that call on the deal timeline and press **⚖ Review call**. The AI reads the transcript and coaches you against StoryBrand — the same principles your outlines are built on.

You get:

- **A snapshot** — what happened on the call
- **👍 What worked** — your strong moments
- **📖 StoryBrand scorecard** — five principles, each graded **✓ hit / ◐ partial / ✗ missed**, with a note:
  - **Guide positioning** — did you come across as the trusted expert?
  - **Problem articulation** — did you surface what the buyer actually needs?
  - **Simple plan** — did you give them a clear path?
  - **Clear CTA** — did you ask for a specific next step?
  - **Discovery** — did you learn what you needed to?
- **🔁 Do differently** — specific moments and what to try instead next time
- **🎯 Suggested next move** — where to take the deal from here

**Review your good calls and your rough ones both.** After a few reviews, the AI starts tailoring your *call outlines* to your personal coaching focus — if discovery is consistently your weak spot, your future outlines lean into it. It's a private coach that learns your game. (Reviews are on-demand — press the button when you want one.)

---

## Habits that make the AI worth having

- **Read the profile before you dial** — 30 seconds of "who is this" changes the call.
- **Ask what it's missing.** The "Missing:" line and the discovery questions are a gap-closing checklist. Log the answers.
- **Correct it the instant it's wrong** (✕ / ✎). Two seconds now, a sharper deal forever.
- **Use the drafts as a strong first pass**, then make them yours before sending.
- **Review your calls** — it's the fastest coaching you'll get, and it makes your outlines personal.
- **Trust the confidence bands.** When it says *Thin*, it means it — go get more. When it says *Rich* and *Solid*, lean in.

---

*The AI never contacts a customer on its own. Every draft is yours to review, edit, and send. You're the closer — it's the assistant.*
