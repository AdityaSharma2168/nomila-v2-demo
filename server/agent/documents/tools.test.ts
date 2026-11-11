/**
 * documents/tools.test.ts — Mila's documents toolset on an IN-MEMORY source (no provider, no database, no engine is
 * reached; a model's call goes through callTool, the per-call path every engine shares). Made-up brands and documents
 * only.
 *
 *   G1  guard: one source of truth — every documents tool has a description with what it does, "Use" and "Don't use";
 *       the preamble (the documents skill) names every tool; the chat skill lists every tool; permissions are as designed
 *   G2  always offered (AGENT_DOCUMENTS_TOOLS retired 2 Nov 2026); the proposed card's flag is off in both yamls
 *       schemas, the preamble once; off, a call naming one anyway is refused and nothing is built
 *   D1  documents_status: an overview with a card per existing document; pages on request; a pitch needs a brand; an
 *       unknown or ambiguous brand is an actionable error
 *   D2  documents_make: a pitch for an unconfirmed or unresearched brand is refused BEFORE anything starts; a good call
 *       starts the background build with the chat's conversation, shows a progress card, and a second ask joins it
 *   D3  documents_edit: badly formed changes are refused with the next step; pick_line / write_line / next_photo save at
 *       once and show the document's card; the brand book has no photo swap
 *   D4  documents_share is QUEUED (act, verb publish): nothing is shared or published until her tap; the tap runs it
 *   D5  the proposed document card is sent only while AGENT_DOCUMENTS_CARD is on; otherwise today's ready card
 */
jest.mock("../../db", () => ({ db: new Proxy({}, { get: () => { throw new Error("tests here never touch the database"); } }) }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { ApprovalItem } from "../../../shared/agent";
import { createDefaultRegistry } from "../coreTools";
import { callTool } from "../callTool";
import { instructionsFor, loadJob } from "../jobs";
import { readSkill } from "../mila/load";
import { checkToolCall } from "../policy";
import type { AgentTool, TurnState } from "../tools";
import { createMemoryDocumentsSource, memoryBrandId, type MemoryDocsFixture } from "./memorySource";
import * as P from "./prompts";
import { DOCUMENTS_TOOL_NAMES } from "./tools";

const ATHLETE = "00000000-0000-4000-a000-000000000002";
const FIXTURE = (): MemoryDocsFixture => ({
  brands: [
    { key: "north", name: "Northpeak Apparel", confirmed: true, researched: true },
    { key: "trail", name: "Trailmark Running", confirmed: false },
    { key: "bare", name: "Barebones Bottles", confirmed: true, researched: false },
    { key: "trailx", name: "Trailmark Outdoor", confirmed: true, researched: true },
  ],
  brandBook: { state: "ready", updatedAt: "2026-10-21T10:00:00.000Z" },
  publicPage: { state: "ready", published: false, canPublish: true },
  pitches: [{ brand: "north", opens: 2, updatedAt: "2026-10-22T10:00:00.000Z" }],
});
const KEYS = ["north", "trail", "bare", "trailx"];

/** The approval queue, in memory: the item queueApproval builds, nothing written. */
function memoryApprovals(): { approvals: ApprovalItem[]; queueApproval: (ctx: { athleteId: string; runId: string }, tool: AgentTool, args: Record<string, unknown>) => Promise<ApprovalItem> } {
  const approvals: ApprovalItem[] = [];
  return {
    approvals,
    async queueApproval(ctx, tool, args) {
      const item: ApprovalItem = { id: `a${approvals.length + 1}`, athleteId: ctx.athleteId, verb: tool.approval!.verb, tool: tool.name, args, title: tool.approval!.title(args), summary: tool.approval!.summary(args), status: "pending", runId: ctx.runId, createdAt: "", expiresAt: null };
      approvals.push(item);
      return item;
    },
  };
}

function setup(f: MemoryDocsFixture = FIXTURE()) {
  const docs = createMemoryDocumentsSource(f);
  const registry = createDefaultRegistry({ documents: docs });
  const tool = (n: string) => registry.get(n)!;
  return { docs, registry, tool };
}

const turn = (conversationId: string | null = "conv-1"): TurnState => ({ factKeys: new Map(), conversationId, offeredConnectors: [], today: "2026-10-23", herWords: [] });
const ctx = () => ({ athleteId: ATHLETE, runId: "run-1", skillId: "chat", turn: turn() });

async function run(tool: AgentTool, args: Record<string, unknown>) {
  const c = ctx();
  const parsed = tool.args.parse(args);
  if (tool.prepare) {
    const p = await tool.prepare(c, parsed);
    if ("error" in p) return { result: { status: "error", reason: p.error } as any, cards: [] };
  }
  const result = (await tool.execute!(c, parsed)) as any;
  const cards = [...(tool.card?.(result, c) ? [tool.card!(result, c)!] : []), ...(tool.cards?.(result, c) ?? [])];
  return { result, cards };
}

const ENV = ["AGENT_DOCUMENTS_CARD"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV) saved[k] = process.env[k]; delete process.env.AGENT_DOCUMENTS_CARD; });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe("G1: one source of truth, and every tool wired", () => {
  it("every documents tool has a description with Use and Don't use, the preamble names it, and the chat skill lists it", () => {
    const { registry } = setup();
    const skill = loadJob("chat");
    const descriptions: Record<string, string> = {
      documents_status: P.DOCUMENTS_STATUS_DESCRIPTION, documents_make: P.DOCUMENTS_MAKE_DESCRIPTION,
      documents_edit: P.DOCUMENTS_EDIT_DESCRIPTION, documents_share: P.DOCUMENTS_SHARE_DESCRIPTION,
    };
    const docTools = registry.all().filter((t) => t.toolset?.id === P.DOCUMENTS_TOOLSET_ID);
    expect(docTools.map((t) => t.name).sort()).toEqual([...DOCUMENTS_TOOL_NAMES].sort());
    for (const t of docTools) {
      expect([t.name, t.description]).toEqual([t.name, descriptions[t.name]]);
      expect(t.description).toMatch(/\bUse\b/);
      expect(t.description).toMatch(/Don't use/);
      expect(t.description.length).toBeGreaterThan(200);
      expect(readSkill("documents")).toContain(t.name);
      expect(skill.tools).toContain(t.name);
    }
    // Every description is wired to exactly one tool (nothing exported and unused).
    const exported = Object.entries(P).filter(([k]) => k.endsWith("_DESCRIPTION")).map(([, v]) => v);
    expect(exported.sort()).toEqual(docTools.map((t) => t.description).sort());
  });

  it("permissions: status read · make draft · edit draft · share act (verb publish, queued by the policy)", () => {
    const { registry, tool } = setup();
    expect(DOCUMENTS_TOOL_NAMES.map((n) => [n, tool(n).permission])).toEqual([
      ["documents_status", "read"], ["documents_make", "draft"], ["documents_edit", "draft"], ["documents_share", "act"],
    ]);
    expect(tool("documents_share").approval?.verb).toBe("publish");
    const v = checkToolCall({ skill: loadJob("chat"), tool: tool("documents_share"), name: "documents_share", args: { document: "public_page" } });
    expect(v).toMatchObject({ decision: "queue", rule: "tap_to_send" });
    expect(registry.all().length).toBeGreaterThan(4);
  });

  it("no generic copy genders the athlete or Mila, and no tool takes an athlete or brand id", () => {
    const text = [readSkill("documents"), P.DOCUMENTS_STATUS_DESCRIPTION, P.DOCUMENTS_MAKE_DESCRIPTION, P.DOCUMENTS_EDIT_DESCRIPTION, P.DOCUMENTS_SHARE_DESCRIPTION].join("\n");
    expect(text).not.toMatch(/\b(she|her|hers|he|him|his)\b/i);
    const { tool } = setup();
    for (const n of DOCUMENTS_TOOL_NAMES) expect(Object.keys((tool(n).args as any).shape)).not.toEqual(expect.arrayContaining(["athlete_id", "brand_id"]));
  });
});

describe("G2: always offered", () => {
  it("no AGENT_DOCUMENTS_* flag is set in either yaml (the tools' flag is retired; the proposed card is off)", () => {
    const envOf = (f: string) => (parse(readFileSync(join(__dirname, "..", "..", "..", "gcp", f), "utf8")).spec.template.spec.containers[0].env as Array<{ name: string; value?: string }>);
    for (const f of ["cloud-run-dev.yaml", "cloud-run-prod.yaml"]) expect(envOf(f).filter((e) => /^AGENT_DOCUMENTS_/.test(e.name))).toEqual([]);
  });

  it("offered; the rules are the documents playbook, not a preamble", () => {
    const { registry } = setup();
    const skill = loadJob("chat");
    for (const n of DOCUMENTS_TOOL_NAMES) expect(registry.forSkill(skill).map((t) => t.name)).toContain(n);
    expect(instructionsFor(skill)).not.toContain("# Documents: what you can do with them");
  });
});

describe("D1: documents_status", () => {
  it("all: each document's standing, the brands a pitch could be made for, and a card per existing document", async () => {
    const { tool } = setup();
    const { result, cards } = await run(tool("documents_status"), { document: "all" });
    expect(result.status).toBe("ok");
    expect(result.brand_book).toMatchObject({ state: "ready", updated: "2026-10-21" });
    expect(result.public_page).toMatchObject({ state: "ready", published: false, can_publish: true });
    expect(result.pitches).toEqual([expect.objectContaining({ brand: "Northpeak Apparel", state: "ready", shared: true, opens: 2 })]);
    expect(result.pitch_ready_brands).toEqual(["Trailmark Outdoor"]);
    expect(cards.map((c) => [c.kind, c.title])).toEqual([["ready", "Your brand book"], ["ready", "Your public page"], ["ready", "Northpeak Apparel pitch"]]);
    expect(cards[2].links[0].target).toEqual({ screen: "pitches" });
    expect(result.cards).toBe("3 document cards shown under your reply");
  });

  it("nothing made yet: no card, and the result says so, so the reply never points at one (6 Nov dev run)", async () => {
    const { tool } = setup({ ...FIXTURE(), brandBook: null, publicPage: null, pitches: [] });
    const all = await run(tool("documents_status"), { document: "all" });
    expect(all.cards).toEqual([]);
    expect(all.result.cards).toMatch(/^no card is shown .*say it in words$/);
    const one = await run(tool("documents_status"), { document: "brand_book" });
    expect(one.cards).toEqual([]);
    expect(one.result.cards).toMatch(/^no card is shown/);
  });

  it("pages on request, narrowed to one page; a pitch needs a brand; unknown and ambiguous names are actionable", async () => {
    const { tool } = setup();
    const pages = await run(tool("documents_status"), { document: "pitch", brand: "northpeak", detail: "pages", page: "cover" });
    expect(pages.result.pages).toEqual([expect.objectContaining({ page: "cover", photo: true, lines: expect.arrayContaining([expect.objectContaining({ slot: "hook", options: expect.any(Array) })]) })]);
    expect((await run(tool("documents_status"), { document: "pitch" })).result.reason).toMatch(/^bad_input: a pitch needs brand/);
    expect((await run(tool("documents_status"), { document: "pitch", brand: "Nobody Co" })).result.reason).toMatch(/^not_found: none of their brands/);
    expect((await run(tool("documents_status"), { document: "pitch", brand: "Trailmark" })).result.reason).toMatch(/^ambiguous: .*Trailmark Running, Trailmark Outdoor/);
    expect((await run(tool("documents_status"), { document: "all", detail: "pages" })).result.reason).toMatch(/^bad_input/);
  });
});

describe("D2: documents_make", () => {
  it("refuses an unconfirmed or unresearched brand before anything starts", async () => {
    const { tool, docs } = setup();
    expect((await run(tool("documents_make"), { document: "pitch", brand: "Trailmark Running" })).result.reason).toMatch(/^brand_not_confirmed/);
    expect((await run(tool("documents_make"), { document: "pitch", brand: "Barebones" })).result.reason).toMatch(/^no_research/);
    expect((await run(tool("documents_make"), { document: "brand_book", angles: ["leadership"] })).result.reason).toMatch(/^bad_input: angles are for a pitch only/);
    expect(docs.builds).toEqual([]);
  });

  it("starts the background build for this chat with a progress card; a second ask joins it", async () => {
    const { tool, docs } = setup();
    const first = await run(tool("documents_make"), { document: "pitch", brand: "Trailmark Outdoor", angles: ["Trail community"] });
    expect(first.result).toMatchObject({ status: "ok", started: true, joined: false, brand: "Trailmark Outdoor" });
    expect(first.result.note).toMatch(/NOT ready yet/);
    expect(docs.builds).toEqual([expect.objectContaining({ angles: ["Trail community"], conversationId: "conv-1", ref: expect.objectContaining({ kind: "pitch", brand: expect.objectContaining({ id: memoryBrandId(KEYS, "trailx") }) }) })]);
    expect(first.cards).toEqual([expect.objectContaining({ kind: "progress", title: "Building your pitch for Trailmark Outdoor", payload: expect.objectContaining({ state: "running", workflowRunId: "memrun-1" }) })]);
    const again = await run(tool("documents_make"), { document: "pitch", brand: "Trailmark Outdoor" });
    expect(again.result).toMatchObject({ joined: true });
    expect(again.cards[0].payload).toMatchObject({ workflowRunId: "memrun-1" });
  });
});

describe("D3: documents_edit", () => {
  it("refuses badly formed changes with the next step", async () => {
    const { tool, docs } = setup();
    const e = (a: Record<string, unknown>) => run(tool("documents_edit"), a).then((r) => r.result.reason as string);
    expect(await e({ document: "brand_book", change: "next_photo", page: "cover" })).toMatch(/^bad_input: the brand book's photos/);
    expect(await e({ document: "public_page", change: "write_line", page: "cover" })).toMatch(/^bad_input: write_line needs slot/);
    expect(await e({ document: "public_page", change: "write_line", page: "cover", slot: "hook" })).toMatch(/^bad_input: write_line needs text/);
    expect(await e({ document: "public_page", change: "pick_line", page: "cover", slot: "hook" })).toMatch(/^bad_input: pick_line needs option/);
    expect(await e({ document: "public_page", change: "pick_line", page: "cover", slot: "hook", option: 9 })).toMatch(/^not_found: that line has 3 stored options/);
    expect(await e({ document: "public_page", change: "pick_line", page: "nope", slot: "hook", option: 0 })).toMatch(/^not_found: no page "nope". Pages: cover, story/);
    expect(await e({ document: "public_page", change: "next_photo", page: "story" })).toMatch(/^bad_input: that page has no photo/);
    expect(await e({ document: "pitch", brand: "Trailmark Outdoor", change: "next_photo", page: "cover" })).toMatch(/^not_built/);
    expect(docs.edits).toEqual([]);
  });

  it("saves at once and shows the document's card", async () => {
    const { tool, docs } = setup();
    const w = await run(tool("documents_edit"), { document: "pitch", brand: "Northpeak", change: "write_line", page: "cover", slot: "hook", text: "  Built  for the long run, together. " });
    expect(w.result).toMatchObject({ status: "ok", changed: true, now_reads: "Built for the long run, together." });
    expect(w.cards.map((c) => c.title)).toEqual(["Northpeak Apparel pitch"]);
    const p = await run(tool("documents_edit"), { document: "brand_book", change: "pick_line", page: "cover", slot: "line", option: 1 });
    expect(p.result).toMatchObject({ status: "ok", now_reads: "Your effort is the story." });
    const ph = await run(tool("documents_edit"), { document: "public_page", change: "next_photo", page: "cover" });
    expect(ph.result.status).toBe("ok");
    expect(docs.edits.map((x) => x.change.change)).toEqual(["write_line", "pick_line", "next_photo"]);
  });
});

describe("D4: documents_share waits for her tap", () => {
  it("queued in a run (nothing shared), with the brand named on the card; her tap runs it", async () => {
    const { registry, docs, tool } = setup();
    const rt = memoryApprovals();
    // The model's call, on the per-call path every engine shares (callTool): the policy queues it for her tap.
    const skill = loadJob("chat");
    const r = await callTool({ skill, tool: registry.get("documents_share"), name: "documents_share", args: { document: "pitch", brand: "northpeak" }, ctx: ctx(), neverTerms: [], queueApproval: rt.queueApproval, citing: skill.tools.includes("cite_facts"), isDeleting: async () => false });
    expect(r.outcome).toBe("queued_for_approval");
    expect(docs.shares).toEqual([]);
    expect(rt.approvals[0]).toMatchObject({ verb: "publish", title: "Create a link to your Northpeak Apparel pitch?", args: { document: "pitch", brand: "Northpeak Apparel", brand_label: "Northpeak Apparel" } });
    // Her tap (executeAgentAction runs the stored arguments).
    const tapped = await tool("documents_share").execute!({ athleteId: ATHLETE, runId: "r", skillId: "chat" }, rt.approvals[0].args);
    expect(tapped).toMatchObject({ status: "ok", shared: true, url: expect.stringMatching(/^https:\/\//) });
    expect(docs.shares).toHaveLength(1);
  });

  it("refuses at call time what the tap could not do: an unbuilt pitch, a page that can't be published", async () => {
    const f = FIXTURE();
    f.publicPage = { state: "ready", canPublish: false, blockedReason: "Add at least one chapter first" };
    const { tool } = setup(f);
    expect((await run(tool("documents_share"), { document: "pitch", brand: "Trailmark Outdoor" })).result.reason).toMatch(/^not_built/);
    expect((await run(tool("documents_share"), { document: "public_page" })).result.reason).toBe("blocked: Add at least one chapter first. Say what's missing in one line.");
  });
});

describe("D5: the proposed card", () => {
  it("is sent only while AGENT_DOCUMENTS_CARD is on", async () => {
    process.env.AGENT_DOCUMENTS_CARD = "true";
    const { tool } = setup();
    const { cards } = await run(tool("documents_status"), { document: "pitch", brand: "Northpeak" });
    expect(cards[0]).toMatchObject({
      kind: "document", title: "Northpeak Apparel pitch",
      payload: { kind: "pitch", state: "ready", shared: { opens: 2 }, actions: { change: "Change something on my Northpeak Apparel pitch", share: "Share my Northpeak Apparel pitch" } },
    });
    expect((cards[0].payload as any).statusLine).toMatch(/^Ready · updated .* · opened 2 times$/);
  });
});
