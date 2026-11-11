/**
 * tools.test.ts — one tool format, and what the registry refuses at registration: athlete ids in arguments (tenancy),
 * a built-in with an executor, a non-built-in without one, a connector without its connector, an act or money tool
 * without an approval descriptor, duplicates. Plus the zod → JSON Schema the model sees, and a skill naming a tool that
 * does not exist.
 */
jest.mock("../db", () => ({ db: {} }));

import { z } from "zod";
import { dropStrictNulls, NO_DETAIL, strictJsonSchema, toToolResult, ToolRegistry, specOf, zodToJsonSchema, type AgentTool } from "./tools";
import { createDefaultRegistry } from "./coreTools";

const base: AgentTool = { name: "read_thing", description: "d", kind: "ours", permission: "read", args: z.object({}), execute: async () => ({}) };

describe("ToolRegistry.register", () => {
  it("accepts a well-formed tool of each kind", () => {
    const r = new ToolRegistry()
      .register(base)
      .register({ name: "web_search", description: "d", kind: "builtin", permission: "read", builtin: "web_search", args: z.object({}) })
      .register({ ...base, name: "calendar_free_busy", kind: "connector", connector: { id: "calendar", access: ["See when you are busy"] } })
      .register({ ...base, name: "send_message", permission: "act", approval: { verb: "send_message", title: () => "Send", summary: () => "Sends it" } });
    expect(r.all().map((t) => t.name)).toEqual(["read_thing", "web_search", "calendar_free_busy", "send_message"]);
  });

  it.each([
    ["athleteId", z.object({ athleteId: z.string() })],
    ["athlete_id", z.object({ athlete_id: z.string() })],
    ["nested", z.object({ filter: z.object({ AthleteID: z.string() }) })],
    ["in an array", z.object({ rows: z.array(z.object({ athlete_id: z.string() })) })],
  ])("refuses an argument schema naming an athlete id (%s)", (_label, args) => {
    expect(() => new ToolRegistry().register({ ...base, args })).toThrow(/athlete comes from the run/);
  });

  it("refuses a built-in with an executor, and an ours/connector tool without one", () => {
    expect(() => new ToolRegistry().register({ ...base, kind: "builtin", builtin: "web_search" })).toThrow(/takes no executor/);
    expect(() => new ToolRegistry().register({ ...base, execute: undefined })).toThrow(/needs an executor/);
    expect(() => new ToolRegistry().register({ ...base, kind: "connector" })).toThrow(/must name its connector/);
  });

  it("refuses an act or money tool without an approval descriptor", () => {
    expect(() => new ToolRegistry().register({ ...base, permission: "act" })).toThrow(/approval descriptor/);
    expect(() => new ToolRegistry().register({ ...base, permission: "propose", money: true })).toThrow(/approval descriptor/);
  });

  it("refuses duplicates and non-snake_case names", () => {
    expect(() => new ToolRegistry().register(base).register(base)).toThrow(/already registered/);
    expect(() => new ToolRegistry().register({ ...base, name: "readThing" })).toThrow(/snake_case/);
  });

  it("forSkill returns the skill's tools in order, and throws on an unknown one", () => {
    const r = new ToolRegistry().register(base).register({ ...base, name: "other" });
    expect(r.forSkill({ id: "s", tools: ["other", "read_thing"] }).map((t) => t.name)).toEqual(["other", "read_thing"]);
    expect(() => r.forSkill({ id: "s", tools: ["missing"] })).toThrow(/unknown tool "missing"/);
  });
});

describe("zodToJsonSchema / specOf", () => {
  it("maps the supported subset", () => {
    const schema = z.object({
      a: z.string().describe("A"),
      b: z.number().int().optional(),
      c: z.enum(["x", "y"]),
      d: z.array(z.boolean()),
      e: z.string().nullable(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        a: { type: "string", description: "A" },
        b: { type: "integer" },
        c: { type: "string", enum: ["x", "y"] },
        d: { type: "array", items: { type: "boolean" } },
        e: { type: ["string", "null"] },
      },
      required: ["a", "c", "d", "e"],
      additionalProperties: false,
    });
  });

  it("throws on an unsupported type so it fails in tests, not at the model", () => {
    expect(() => zodToJsonSchema(z.object({ d: z.date() }))).toThrow(/unsupported/);
  });

  it("a spec carries kind, permission and the schema — never an executor", () => {
    const spec = specOf(base);
    expect(spec).toEqual({ name: "read_thing", description: "d", kind: "ours", permission: "read", schema: { type: "object", properties: {}, additionalProperties: false } });
  });
});

describe("the default registry", () => {
  it("registers the core tools with their permissions, and none takes an athlete id", () => {
    const r = createDefaultRegistry();
    expect(r.all().map((t) => [t.name, t.kind, t.permission])).toEqual([
      ["health_check", "ours", "read"],
      ["web_search", "builtin", "read"],
      // The chat's tools: saving anything the athlete told Mila is PROPOSE (queued; saved only on their tap).
      ["recall_facts", "ours", "read"],
      ["remember_fact", "ours", "propose"],
      ["correct_fact", "ours", "propose"],
      ["remember_preference", "ours", "propose"],
      ["cite_facts", "ours", "read"],
      ["read_scouting", "ours", "read"],
      ["offer_connection", "ours", "read"],
      ["ask_quick_question", "ours", "read"],
      ["open_screen", "ours", "read"],
      // The plan step's goal tools: read to list, draft (private, reversible) to change anything.
      ["list_goals", "ours", "read"],
      ["keep_goal", "ours", "draft"],
      ["change_goal", "ours", "draft"],
      ["set_aside_goal", "ours", "draft"],
      ["drop_goal", "ours", "draft"],
      ["bring_back_goal", "ours", "draft"],
      ["add_goal", "ours", "draft"],
      ["suggest_goal", "ours", "draft"],
      ["refresh_plan", "ours", "draft"],
      // Lean research refresh (LEAN_SIGNUP_RESEARCH): starts our own runner workflow; off ⇒ left out of every run and /mcp.
      ["refresh_research", "ours", "draft"],
      // The post-kit (creative) tools: reads of the product's own catalogue.
      ["find_music", "ours", "read"],
      // Media (CAMERA_ROLL_INTAKE): registered always; forSkill leaves it out of a run while the flag is off.
      ["check_camera_roll", "ours", "read"],
      // Deals (AGENT_DEALS_TOOLS): read · draft (a reply for her approval; her own "no", at once, with Undo) · propose
      // (signed / completed / reopen, on her tap). Registered always; left out of every run while the flag is off.
      ["deals_find", "ours", "read"],
      ["deals_get", "ours", "read"],
      ["deals_terms", "ours", "read"],
      ["deals_waiting", "ours", "read"],
      ["deals_draft_reply", "ours", "draft"],
      ["deals_close", "ours", "draft"],
      ["deals_mark", "ours", "propose"],
      ["deals_open", "ours", "read"],
      ["brand_get", "ours", "read"],
      // Bookings (AGENT_BOOKINGS_TOOLS): reads; respond only shows the card (her taps answer on the existing routes).
      ["bookings_list", "ours", "read"],
      ["bookings_get", "ours", "read"],
      ["bookings_waiting", "ours", "read"],
      ["bookings_respond", "ours", "draft"],
      // Documents (AGENT_DOCUMENTS_TOOLS): read · draft (a background build; one line or photo on a private draft) · act
      // (a pitch link or publishing the page — queued: runs only on her tap). Registered always; off ⇒ left out of runs.
      ["documents_status", "ours", "read"],
      ["documents_make", "ours", "draft"],
      ["documents_edit", "ours", "draft"],
      ["documents_share", "ours", "act"],
      // Reads over what Nomila holds (MILA_READ_TOOLS): registered always; off ⇒ left out of every run.
      ["media_search", "ours", "read"],
      ["posts_performance", "ours", "read"],
      ["money_summary", "ours", "read"],
      ["whats_next", "ours", "read"],
      // The card system v2's producers (MILA_CARDS_V2): draft — private to Nomila; a card's taps are the athlete's own.
      ["share_insight", "ours", "draft"],
      ["ideas_suggest", "ours", "draft"],
      ["offer_capability", "ours", "draft"],
      ["ask_once", "ours", "draft"],
      ["answer_with_sources", "ours", "draft"],
      // The landing's Mila-hosted waitlist (MILA_TF_WAITLIST): reads, and start_research (draft: our own runner workflow,
      // idempotent). Registered always; off ⇒ left out of every run and /mcp. No tool confirms a handle (her tap only).
      ["waitlist_status", "ours", "read"],
      ["start_research", "ours", "draft"],
      ["show_waitlist_card", "ours", "read"],
    ]);
    for (const t of r.all()) expect(Object.keys((specOf(t).schema.properties ?? {}) as object).filter((k) => /athlete/i.test(k))).toEqual([]);
    // Every propose tool says what its "Want me to save that?" card shows.
    // (deals_mark is the one propose tool that isn't a save: its card asks her to confirm a stage change.)
    for (const t of r.all().filter((x) => x.permission === "propose")) expect([t.name, t.approval?.verb]).toEqual([t.name, t.name === "deals_mark" ? "other_act" : "save_memory"]);
  });

  it("every function tool's schema is strict-ready: all properties required, optional ones nullable, no extra keys", () => {
    const r = createDefaultRegistry();
    const check = (s: any, path: string) => {
      if (s?.type === "object" || (Array.isArray(s?.type) && s.type.includes("object"))) {
        expect([path, s.additionalProperties]).toEqual([path, false]);
        expect([path, [...(s.required ?? [])].sort()]).toEqual([path, Object.keys(s.properties ?? {}).sort()]);
        for (const [k, v] of Object.entries(s.properties ?? {})) check(v, `${path}.${k}`);
      }
      if (s?.items) check(s.items, `${path}[]`);
    };
    for (const t of r.all().filter((x) => x.kind !== "builtin")) check(strictJsonSchema(specOf(t).schema), t.name);
    // An optional field comes back nullable; a null for it is dropped before the zod schema validates.
    const strict = strictJsonSchema(zodToJsonSchema(z.object({ a: z.string(), b: z.enum(["x", "y"]).optional() })));
    expect(strict).toMatchObject({ required: ["a", "b"], properties: { b: { type: ["string", "null"], enum: ["x", "y", null] } } });
    expect(dropStrictNulls(z.object({ a: z.string(), b: z.string().optional(), c: z.string().nullable().optional() }), { a: "1", b: null, c: null })).toEqual({ a: "1", c: null });
  });
});

describe("tool results: an explicit status, never an empty ok", () => {
  it("passes ok and error through, turns the old ok:false into an error, and words an empty result", () => {
    expect(toToolResult({ status: "ok", saved: true })).toEqual({ status: "ok", saved: true });
    expect(toToolResult({ status: "error", reason: "nope" })).toEqual({ status: "error", reason: "nope" });
    expect(toToolResult({ ok: false, why: "weekly limit" })).toEqual({ status: "error", reason: "weekly limit" });
    expect(toToolResult({ facts: [] })).toEqual({ status: "ok", facts: [] });
    expect(toToolResult(null)).toEqual({ status: "ok", result: NO_DETAIL });
    expect(toToolResult({ ok: true })).toEqual({ ok: true, status: "ok", result: NO_DETAIL });
  });
});
