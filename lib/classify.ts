/**
 * Call classification heuristic, validated against a week of real transcripts
 * (see docs/FRAMEWORK.md). A call is a conversation iff the contact has ≥2
 * utterances containing none of the voicemail phrases AND the rep also speaks.
 * We store the classification only — never transcript text (transcripts have
 * contained spoken credit-card numbers).
 */

const VM_PHRASES = [
  "voice mail",
  "voicemail",
  "record your message",
  "record your name",
  "leave a message",
  "leave your message",
  "can't take your call",
  "at the tone",
  "please stay on the line",
  "is not available",
  "press pound",
  "forwarded",
  "please leave",
  "reached",
];

export type CallClassification = "conversation" | "voicemail" | "no_answer" | "screening";

export interface Utterance {
  speaker: "rep" | "contact";
  text: string;
}

export function classifyTranscript(utterances: Utterance[]): CallClassification {
  const repSpoke = utterances.some((u) => u.speaker === "rep" && u.text.trim().length > 0);
  const humanContactUtterances = utterances.filter(
    (u) =>
      u.speaker === "contact" &&
      u.text.trim().length > 0 &&
      !VM_PHRASES.some((p) => u.text.toLowerCase().includes(p))
  );
  if (repSpoke && humanContactUtterances.length >= 2) return "conversation";
  const hasVmPhrase = utterances.some(
    (u) => u.speaker === "contact" && VM_PHRASES.some((p) => u.text.toLowerCase().includes(p))
  );
  return hasVmPhrase ? "voicemail" : "screening";
}
