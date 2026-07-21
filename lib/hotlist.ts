/**
 * Hot-list scoring (Module 2). Pure functions over engagement_events rows —
 * thresholds come from app_config.hot_rules, never hardcoded.
 */

export interface HotRules {
  opens_in_window: number;
  opens_window_days: number;
  click_window_hours: number;
  distinct_signal_types: number;
  distinct_signal_window_hours: number;
  cooldown_days: number;
  quiet_clear_days: number;
}

export const DEFAULT_RULES: HotRules = {
  opens_in_window: 3,
  opens_window_days: 7,
  click_window_hours: 72,
  distinct_signal_types: 2,
  distinct_signal_window_hours: 72,
  cooldown_days: 7,
  quiet_clear_days: 7,
};

export interface SignalEvent {
  source: string;
  type: string; // email_open | email_click | ...
  occurred_at: string;
}

export interface HotVerdict {
  hot: boolean;
  reason: string;
  signals: { opens: number; clicks: number; distinctTypes: string[] };
}

export function evaluateDeal(events: SignalEvent[], rules: HotRules, now: Date): HotVerdict {
  const ms = now.getTime();
  const inWindow = (e: SignalEvent, hours: number) =>
    ms - Date.parse(e.occurred_at) <= hours * 3600_000;

  const opens = events.filter(
    (e) => e.type.endsWith("open") && inWindow(e, rules.opens_window_days * 24)
  );
  const clicks = events.filter(
    (e) => e.type.endsWith("click") && inWindow(e, rules.click_window_hours)
  );
  const distinctTypes = [
    ...new Set(
      events
        .filter((e) => inWindow(e, rules.distinct_signal_window_hours))
        .map((e) => `${e.source}:${e.type}`)
    ),
  ];

  const reasons: string[] = [];
  if (opens.length >= rules.opens_in_window)
    reasons.push(`${opens.length} opens in ${rules.opens_window_days}d`);
  if (clicks.length > 0) reasons.push(`click in last ${rules.click_window_hours}h`);
  if (distinctTypes.length >= rules.distinct_signal_types)
    reasons.push(`${distinctTypes.length} signal types in ${rules.distinct_signal_window_hours}h`);

  return {
    hot: reasons.length > 0,
    reason: reasons.join(" · "),
    signals: { opens: opens.length, clicks: clicks.length, distinctTypes },
  };
}
