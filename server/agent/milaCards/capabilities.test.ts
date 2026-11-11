/**
 * capabilities.test.ts — the Turn-on presentations (pure: no database, no model).
 *   P1 every built capability a card switches on has exactly one presentation; planned ones and non-switches have none
 *   P2 each presentation builds a valid Turn-on card (the shared card schema: headline, line, three rows, legal line)
 *   P3 the sheet keeps its order and words: what it does · "You choose what Mila can do" · "Keep an eye on it"
 *   P4 the copy promises only what the consent covers: nothing claims to send, post, publish or charge on its own
 */
jest.mock("../../db", () => ({ db: {} }));

import { toMilaCardDto } from "../../../shared/milaCards";
import { CAPABILITIES, capability } from "../welcome/registry";
import { turnOnKeys } from "../welcome/turnOn";
import { CAPABILITY_KEYS, PRESENTATIONS, presentation, sheetConsent } from "./capabilities";

const BUILT_SWITCHES = turnOnKeys(CAPABILITIES).filter((k) => capability(k)!.status !== "planned");

test("P1 one presentation per built switch, none for anything else", () => {
  expect(PRESENTATIONS.map((p) => p.key).sort()).toEqual([...BUILT_SWITCHES].sort());
  expect(new Set(PRESENTATIONS.map((p) => p.key)).size).toBe(PRESENTATIONS.length);
  expect([...CAPABILITY_KEYS].sort()).toEqual([...BUILT_SWITCHES].sort());
  for (const k of ["studio_posts", "public_page", "get_paid", "reminders", "morning_brief", "calendar_read", "email_triage", "grey_area_rules", "deal_watch"]) {
    expect(presentation(k)).toBeNull();
  }
});

test.each(PRESENTATIONS.map((p) => p.key))("P2 %s builds a valid Turn-on card", (key) => {
  const p = presentation(key)!;
  const c = sheetConsent(key)!;
  const r = toMilaCardDto({
    id: `turn-on:${key}`, kind: "turn-on", title: "Mila can do more", links: [],
    payload: {
      decisionId: "d1", capability: key, accountRef: null, accountLabel: null,
      media: { kind: "atmosphere", url: null, mediaId: null, atmosphereId: null, brand: null, chart: null, hasFace: false, alt: p.headline },
      headline: p.headline, line: p.line, glyph: p.glyph, consentShort: p.consentShort, sheet: p.sheet,
      consent: { reads: c.reads, drafts: c.drafts, alwaysAsks: c.alwaysAsks, onRevoke: c.onRevoke },
      consentVersion: c.version, choiceVersion: 0, state: "unset",
    },
  });
  expect(r).toMatchObject({ ok: true });
  expect(c.reads.length + c.alwaysAsks.length).toBeGreaterThan(0);
});

test("P3 three rows in the fixed order, with the shared control and watch words", () => {
  for (const p of PRESENTATIONS) {
    expect({ key: p.key, titles: p.sheet.rows.slice(1).map((r) => r.title) }).toEqual({ key: p.key, titles: ["You choose what Mila can do", "Keep an eye on it"] });
    expect({ key: p.key, icons: p.sheet.rows.slice(1).map((r) => r.icon) }).toEqual({ key: p.key, icons: ["lock", "eye"] });
    expect(p.sheet.button).toBe("Turn on");
    expect(p.sheet.rows[1].line).toMatch(/Turn it off any time in Me\.$/);
    expect(p.glyph).toBeTruthy();
  }
});

test("P4 the copy never claims an outside action happens without a tap", () => {
  const ON_ITS_OWN = /\b(Mila|it|Nomila) (sends|posts|publishes|shares|charges|accepts)\b|\bautomatically\b|\bon (her|your) behalf\b/i;
  for (const p of PRESENTATIONS) {
    const text = [p.headline, p.line, p.sheet.purpose, ...p.sheet.rows.map((r) => r.line), p.sheet.legal].join(" ");
    expect({ key: p.key, hit: text.match(ON_ITS_OWN)?.[0] ?? null }).toEqual({ key: p.key, hit: null });
  }
  // A capability whose consent makes drafts says nothing goes out without a tap.
  for (const p of PRESENTATIONS.filter((x) => capability(x.key)!.consent.drafts)) expect(p.sheet.rows[1].line).toMatch(/without your tap/);
});
