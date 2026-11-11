/**
 * landingResearchCard.test.ts — the join flow's wait screen (landing/research-card.js, painted by landing/index.html):
 * the REAL status line and the "Is this you?" handle rows. The module is plain browser ESM with no imports; it is
 * loaded here as source in a sandbox. The handles contract is main's (#1142, server/agent/research/publicPlatform.ts):
 * GET progress `handles`, POST /waitlist/handles/:platform → { handles, lookup?, measured? }; R3b feeds the server's own
 * waitlistHandlesFrom output through the rows.
 *
 *   R1 the status line is the runner's stage word for word (1–3 words, a count only when sent); nothing without it
 *   R2 the checklist shows a live stage only on its own row
 *   R3 handles: suggested + confirmed Instagram / YouTube rows; rejected, unknown platforms and junk are dropped; flag
 *      off ([] / absent) ⇒ no rows
 *   R4 after confirming: not_business_account ⇒ the professional-account line; any other miss ⇒ "try again later";
 *      found / connected ⇒ nothing
 *   R5 the page uses the module, sends the contract's POST, and shows no timer-rotated text on any run
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "landing", "research-card.js"), "utf8");
const m = vm.runInNewContext(`${src.replace(/^export /gm, "")}\n;({ HANDLE_COPY, handleRowsOf, liveLineOf, liveRowOf, liveSubOf, lookupNoteOf })`) as any;
const html = fs.readFileSync(path.join(ROOT, "landing", "index.html"), "utf8");

test("R1: the status line is the runner's real stage, in 1–3 words", () => {
  expect(m.liveLineOf({ stage: "finding" })).toBe("Finding you");
  expect(m.liveLineOf({ stage: "reading", count: 12 })).toBe("Reading 12 pages");
  expect(m.liveLineOf({ stage: "reading", count: 1 })).toBe("Reading 1 page");
  expect(m.liveLineOf({ stage: "reading" })).toBe("Reading your pages");
  expect(m.liveLineOf({ stage: "pulling", count: 40 })).toBe("Pulling facts");
  expect(m.liveLineOf({ stage: "checking", count: 18 })).toBe("Checking 18 facts");
  expect(m.liveLineOf({ stage: "scoring" })).toBe("Scoring");
  expect(m.liveLineOf({ stage: "quick_ready" })).toBe("Preliminary score ready");
  expect(m.liveLineOf({ stage: "final_ready" })).toBe("Score ready");
  for (const s of ["finding", "reading", "pulling", "checking", "scoring", "quick_ready", "final_ready"]) {
    expect(m.liveLineOf({ stage: s, count: 3 }).split(" ").length).toBeLessThanOrEqual(3);
  }
  expect(m.liveLineOf(null)).toBeNull();                         // no live (v2 / flag off): the page's own line
  expect(m.liveLineOf({ stage: "made_up" })).toBeNull();
  expect(m.liveSubOf({ quickScore: {} })).toBe("Your preliminary score is ready. Your full score is still processing.");
  for (const s of ["finding", "reading", "pulling", "checking", "scoring", "quick_ready", "final_ready"]) expect(m.liveLineOf({ stage: s, count: 2 })).not.toMatch(/quick/i);
  expect(m.liveSubOf({ score: {} })).toBe("Your full score is ready.");
  expect(m.liveSubOf({})).toBe("");
});

test("R2: a live stage belongs to one checklist row", () => {
  expect(m.liveRowOf({ stage: "finding" })).toBe("web");
  expect(m.liveRowOf({ stage: "reading" })).toBe("web");
  expect(m.liveRowOf({ stage: "pulling" })).toBe("merge");
  expect(m.liveRowOf({ stage: "checking" })).toBe("merge");
  expect(m.liveRowOf({ stage: "scoring" })).toBe("score");
  expect(m.liveRowOf({ stage: "final_ready" })).toBeNull();
  expect(m.liveRowOf(null)).toBeNull();
});

// The contract as the server builds it (stub; the endpoint lands in its own PR).
const HANDLES = [
  { platform: "instagram", handle: "jordan.lee", source: "research", status: "suggested" },
  { platform: "youtube", handle: "@jordanleeplays", source: "signup", status: "confirmed" },
  { platform: "instagram", handle: "someone.else", source: "research", status: "rejected" },
  { platform: "tiktok", handle: "jl", source: "research", status: "suggested" },
  { platform: "youtube", handle: "  ", source: "research", status: "suggested" },
  null,
];

test("R3: Is this you? rows — suggested and confirmed only; flag off shows nothing", () => {
  const rows = m.handleRowsOf(HANDLES);
  expect(rows).toEqual([
    { platform: "instagram", service: "Instagram", handle: "@jordan.lee", raw: "jordan.lee", source: "Found on the web", status: "suggested", ask: true },
    { platform: "youtube", service: "YouTube", handle: "@jordanleeplays", raw: "@jordanleeplays", source: "You told us", status: "confirmed", ask: false },
  ]);
  expect(m.handleRowsOf([])).toEqual([]);
  expect(m.handleRowsOf(undefined)).toEqual([]);
});

test("R4: what confirming says, from the server's lookup outcome — never blocks", () => {
  expect(m.lookupNoteOf("found")).toBeNull();
  expect(m.lookupNoteOf("connected")).toBeNull();
  expect(m.lookupNoteOf(undefined)).toBeNull();
  expect(m.lookupNoteOf("not_business_account")).toBe("To share your Instagram numbers, switch it to a professional account (Business or Creator) in Instagram settings.");
  for (const miss of ["not_found", "rate_limited", "token_expired", "no_token", "not_configured", "failed"]) {
    expect(m.lookupNoteOf(miss)).toBe("Thanks. I couldn't read this account just now. I'll try again later.");
  }
  for (const line of Object.values(m.HANDLE_COPY) as string[]) {
    expect(line).not.toMatch(/AI[- ]generated/i);
    expect(line[0]).toBe(line[0].toUpperCase());
  }
});

test("R3b: the rows render the server's REAL handle list (#1142 waitlistHandlesFrom): confirmed, suggested, rejected", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { waitlistHandlesFrom } = require("../server/agent/research/publicPlatform");
  const NAME = "Avery Example";
  const fact = (o: Record<string, unknown>) => ({ id: `f${Math.random()}`, athleteId: "a", subject: { kind: "athlete", name: NAME }, type: "said", date: "2026-10-26",
    confidence: 1, status: "active", supersededBy: null, runId: null, createdAt: "2026-10-26T00:00:00Z", ...o });
  const facts = [
    fact({ claim: `${NAME}'s Instagram handle is @avery.rows.`, source: { ref: "onboarding/run#handle:instagram", title: "You told us" } }),
    fact({ claim: `${NAME} says @avery.fake is not their YouTube account.`, source: { ref: "me/handles#not-handle:youtube", title: "You told us" } }),
  ];
  const server = waitlistHandlesFrom(facts, [{ platform: "youtube", handle: "averyrows", source: "social_identities/1" }]);
  expect(server).toEqual(expect.arrayContaining([
    { platform: "instagram", handle: "avery.rows", source: "signup", status: "confirmed" },
    { platform: "youtube", handle: "averyrows", source: "research", status: "suggested" },
    { platform: "youtube", handle: "avery.fake", source: "research", status: "rejected" },
  ]));
  expect(m.handleRowsOf(server)).toEqual([
    { platform: "instagram", service: "Instagram", handle: "@avery.rows", raw: "avery.rows", source: "You told us", status: "confirmed", ask: false },
    { platform: "youtube", service: "YouTube", handle: "@averyrows", raw: "averyrows", source: "Found on the web", status: "suggested", ask: true },
  ]);
});

test("R5: the page paints from the module, posts the contract, and rotates no text on any run", () => {
  expect(html).toContain("import { HANDLE_COPY, handleRowsOf, liveLineOf, liveRowOf, liveSubOf, lookupNoteOf } from './research-card.js';");
  expect(html).toContain("api(`/api/v1/waitlist/handles/${encodeURIComponent(h.platform)}`, { method: 'POST', body: { action, handle: h.raw } })");
  expect(html).toContain("if (r.status === 404) { S.handlesGone = true; return; }");
  // A running row shows the runner's real stage on a live run, otherwise nothing: no scripted lines on any run.
  expect(html).toContain("const sub = x.status === 'running' ? (hasLive && liveRowOf(live) === x.key ? liveLineOf(live) || '' : '')");
  expect(html).not.toMatch(/\bc\.lines|lines: \[/);
});
