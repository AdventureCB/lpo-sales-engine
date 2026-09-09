"use client";

/**
 * Time picker as a plain dropdown — replaces native <input type="time">,
 * whose segmented control silently reports EMPTY until every segment incl.
 * AM/PM is typed (a rep who didn't type "PM" saved an all-day activity).
 * A select can't half-commit. Value format stays "HH:MM" (24h).
 * 15-minute steps, 6:00 AM – 9:00 PM; an out-of-range current value is
 * included so editing an odd time never loses it.
 */
export function TimeSelect({
  value,
  onChange,
  allowEmpty = false,
  emptyLabel = "All day",
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  style?: React.CSSProperties;
}) {
  const opts: string[] = [];
  for (let h = 6; h <= 21; h++) {
    for (const m of [0, 15, 30, 45]) {
      if (h === 21 && m > 0) continue;
      opts.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  if (value && !opts.includes(value)) opts.unshift(value);

  const label = (v: string) => {
    const [h, m] = v.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  };

  return (
    <select className="vmsel" style={{ width: "auto", ...style }} value={value} onChange={(e) => onChange(e.target.value)}>
      {allowEmpty && <option value="">{emptyLabel}</option>}
      {!allowEmpty && !value && <option value="" disabled>Time…</option>}
      {opts.map((v) => (
        <option key={v} value={v}>{label(v)}</option>
      ))}
    </select>
  );
}
