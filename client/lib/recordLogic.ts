// Pure helpers for the athlete record (Brand › Facts). No React, no I/O — unit-tested.

import type { RecordEntry, RecordGroup, RecordKind } from "../hooks/use-athlete-record";

/** The chip text next to a fact: who it came from, in the athlete's words. */
export function kindLabel(kind: RecordKind | null): string {
  switch (kind) {
    case "said":  return "You said";
    case "found": return "Found";
    case "made":  return "Mila made";
    case "proof": return "Proof";
    default:      return "Not yet";
  }
}

/** The muted line under a value: "You said · 3 days ago", "Found online", "Not yet". */
export function sourceLine(entry: Pick<RecordEntry, "kind" | "source" | "at">, now = Date.now()): string {
  if (!entry.kind) return "Not yet";
  const parts = [entry.source || kindLabel(entry.kind)];
  if (entry.at) parts.push(formatAgo(entry.at, now));
  return parts.join(" · ");
}

export function formatAgo(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

/** "4 of 6 filled" for a group header. Non-editable rows still count when they have a value. */
export function groupSummary(group: Pick<RecordGroup, "entries">): { filled: number; total: number; text: string } {
  const total  = group.entries.length;
  const filled = group.entries.filter((e) => e.value !== null && e.value !== "").length;
  return { filled, total, text: `${filled} of ${total}` };
}

/** A list field typed as one line: split on commas / newlines, trim, drop empties and dupes. */
export function parseListInput(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const v = raw.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** The value the sheet should send for a field, given what the athlete typed. */
export function toWriteValue(shape: RecordEntry["shape"], text: string): string | string[] {
  if (shape === "list") return parseListInput(text);
  return text.trim();
}

/** The text to seed the editor with, from the entry's raw value. */
export function toEditText(entry: Pick<RecordEntry, "shape" | "raw" | "value">): string {
  if (entry.shape === "list" && Array.isArray(entry.raw)) return entry.raw.join(", ");
  if (typeof entry.raw === "string") return entry.raw;
  return entry.value ?? "";
}

/** The draft "Tell Mila" opens with — names the field, never the value (Mila reads the record). */
export function tellMilaDraft(entry: Pick<RecordEntry, "label" | "value">): string {
  return entry.value
    ? `I want to update my ${entry.label.toLowerCase()}.`
    : `Let me tell you my ${entry.label.toLowerCase()}.`;
}
