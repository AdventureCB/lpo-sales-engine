"use client";

import { useState } from "react";

/**
 * ℹ️ Rep-facing explainer for how the three daily sprint lists are built —
 * button-triggered modal on /lists. Content mirrors lib/sprint-lists.ts;
 * update BOTH when the generation rules change.
 */

const H = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.09em", textTransform: "uppercase", color: "var(--accent)", margin: "14px 0 6px" }}>{children}</div>
);
const P = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--text-2)", marginBottom: 6 }}>{children}</div>
);
const B = ({ children }: { children: React.ReactNode }) => <b style={{ color: "var(--text-1)" }}>{children}</b>;

const TIERS: [string, string, string][] = [
  ["1a", "Fresh buy signal — cart, checkout started, 3D-builder save, or abandoned checkout. The strongest “call me now” a system can give.", "7 days"],
  ["1b", "Actively engaging — email clicks, product views, site activity, form fills, subscribes. Passive email opens deliberately don't count.", "7 days"],
  ["2", "Scheduled & due — a planned activity due today or overdue. The list keeps your calendar promises. Only activities scheduled in this app count.", "today"],
  ["3", "New, never called — deal created recently with zero call attempts. Speed-to-lead.", "14 days"],
  ["4", "Warm but untouched — a marketing signal landed recently, you haven't touched the deal in 7 days, nothing scheduled this week.", "14 days"],
  ["5", "Conversation gap — no actual conversation (answered call) in 60 days.", "60 days"],
  ["6", "Cap-fill — no activity of any kind in 60 days; only used to fill remaining slots.", "60 days"],
];

export function SprintLogicModal() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="btn ghost" style={{ padding: "4px 11px", fontSize: 12.5 }} onClick={() => setOpen(true)} title="Why deals show up on these lists">
        ℹ️ How lists are built
      </button>

      {open && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 8000, background: "color-mix(in srgb, #000 55%, transparent)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }}
          onClick={() => setOpen(false)}
        >
          <div
            className="card"
            style={{ maxWidth: 680, width: "100%", maxHeight: "86vh", overflowY: "auto", padding: "20px 24px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ fontSize: 16.5, fontWeight: 800 }}>How the three daily call lists are built</div>
              <button className="btn ghost" style={{ marginLeft: "auto", padding: "3px 10px", fontSize: 13 }} onClick={() => setOpen(false)}>✕</button>
            </div>
            <P>
              Every list is generated per-rep from your own open deals (the shared pool joins in List 3). A deal appears at its <B>highest qualifying tier only</B>,
              one deal per contact, capped at <B>60 calls</B> per list.
            </P>

            <H>List 1 — Morning ladder · ~9 AM PT · East + Central timezones</H>
            <P>While it&apos;s late morning back east, call the contacts whose local clock is furthest ahead. Deals qualify through the six-tier ladder — <B>first tier a deal qualifies for wins</B>:</P>
            <div style={{ display: "grid", gap: 5, margin: "4px 0 6px" }}>
              {TIERS.map(([t, desc, win]) => (
                <div key={t} style={{ display: "flex", gap: 10, fontSize: 13, alignItems: "baseline" }}>
                  <span className="chip stage" style={{ fontSize: 11.5, minWidth: 28, textAlign: "center", flexShrink: 0 }}>{t}</span>
                  <span style={{ color: "var(--text-2)", flex: 1 }}>{desc}</span>
                  <span style={{ color: "var(--text-3)", fontSize: 12, flexShrink: 0 }}>{win}</span>
                </div>
              ))}
            </div>
            <P>Ordering: tiers 1–2 always ride at the front; within a tier, most-recent signal first.</P>

            <H>List 2 — Midday ladder · ~12 PM PT · West timezones</H>
            <P>Identical ladder, identical rules — pointed at the western half of the map once their morning is underway. Everything is re-evaluated fresh at generation time.</P>
            <P>
              <B>Pool fill:</B> when your own deals don&apos;t fill the 60 slots (new rep, thin book), <B>unassigned pool deals</B> fill the rest — same
              marketing-signal ranking and 3-day exclusive checkout as List 3, limited to the list&apos;s timezones. Schedule any activity on one and it becomes <B>yours</B>.
            </P>

            <H>List 3 — Afternoon sweep · 1 PM PT (automatic)</H>
            <P><B>1 · Carryover:</B> everything from today&apos;s Lists 1–2 you haven&apos;t dialed yet, original tier order kept. Each deal is re-checked — anything won/lost or moved to the Confirmation Pipeline since morning is dropped.</P>
            <P><B>2 · Stale (60–90d):</B> your open deals whose last <B>customer</B> engagement — an answered call or inbound reply — was 60–90 days ago. Your own outbound emails deliberately don&apos;t count; this measures when the <B>buyer</B> last engaged.</P>
            <P>
              <B>3 · Reprospect pool:</B> fills remaining slots from the shared pool of unassigned open deals, ranked by most recent marketing signal. A pool deal on your list is <B>checked out to you for 3 days</B> — no other rep sees it.
              Schedule any activity and it becomes <B>yours</B>; do nothing and it releases back after 3 days.
            </P>

            <H>Why a deal you expect might NOT show</H>
            <P><B>Future plan:</B> a deal with a future-dated scheduled activity is hidden — you already have a plan; it resurfaces at tier 2 on its due date. Exception: a fresh buy signal (1a) with nothing scheduled in the next 7 days still surfaces, flagged 🔥.</P>
            <P><B>Call cooldown:</B> for every tier except 1a, a deal with <B>3 call attempts in the current week</B> rests for a week — no spam-calling someone who isn&apos;t picking up. A fresh buy signal overrides the rest.</P>
            <P><B>Snoozed:</B> a deal snoozed from its Actions card (&quot;exclude from sprint lists until…&quot;) stays off every list until that date.</P>

            <H>Never on any list</H>
            <P>
              Won or lost deals · Confirmation Pipeline deals (post-sale work, not sales calls) · contacts with no phone number · numbers struck as <B>bad</B> (a deal whose
              only numbers are bad drops off entirely) · duplicate contacts (one best-tier deal per person) · old Pipedrive-era scheduled activities (only activities created in this app count for scheduling rules).
            </P>

            <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 12, borderTop: "1px solid var(--border-soft)", paddingTop: 8 }}>
              Windows, the 60-call cap, the 3-day checkout, and generation times are tunable by admins in Settings → CRM.
            </div>
          </div>
        </div>
      )}
    </>
  );
}
