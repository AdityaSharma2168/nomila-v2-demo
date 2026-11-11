/**
 * registry.test.ts — the capability registry as data (design "Mila welcome flow" §3 + §5). Pure: no database, no
 * provider, no engine.
 *
 *   R1 the seeded catalogue validates: no cycles, every need / unlock resolves, AND / OR have two or more children,
 *      unlocks agree with needs both ways, per-account entries only need per-account things, consent blocks complete
 *   R2 the validator catches each kind of mistake (a cycle, an unknown reference, a one-child OR, an unlock that does
 *      not need its source, a per-account entry needing an athlete-wide one, a bad consent version)
 *   R3 flags: every feature flag the registry names is declared in both Cloud Run yamls; planned ⇒ never available;
 *      a flagged feature is available only with its flag exactly "true"
 *   R4 opt-in targets resolve to real tables in shared/schema.ts (or none); core entries are never offered
 *   R5 ONE model: the core set is exactly the owner's list; every other capability is optional (starts unset)
 *   R6 the gated jobs (gate.ts OPTIONAL_JOBS) name built, optional, athlete-wide capabilities whose consent lists the
 *      job's action; dependentsOf follows needs, not better-with
 *   R7 every Turn-on capability's consent fits the sheet's pinned foot: at most 2 reads + 2 always-asks (TURN_ON_CONSENT_MAX),
 *      the drafts line (DRAFTS_SAYS) counted as a read; it appears exactly when consent.drafts is true
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { parse } from "yaml";
import * as schema from "../../../shared/schema";
import {
  availableNow, CAPABILITIES, capability, dependentsOf, DRAFTS_SAYS, isAvailable, OPT_IN_TARGETS, validateRegistry, type CapabilityEntry,
} from "./registry";
import { OPTIONAL_JOBS } from "./gate";
import { consentWords, turnOnKeys } from "./turnOn";
import { MILA_CARD_SCHEMAS, TURN_ON_CONSENT_MAX } from "../../../shared/milaCards";

const GCP = join(__dirname, "..", "..", "..", "gcp");
const envNames = (file: string) =>
  new Set((parse(readFileSync(join(GCP, file), "utf8")).spec.template.spec.containers[0].env as { name: string }[]).map((e) => e.name));

const base = (key: string, over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  key, name: key, core: false, scope: "athlete", needs: null, betterWith: null, unlocks: [], skill: "content", tools: [], workers: [],
  offer: { signals: ["pick_content"], reasonKey: `${key}.reason`, firstSession: false },
  consent: { version: `${key}/1`, automatic: [{ action: "do_it", says: "Do it" }], drafts: false, internalRecords: false, alwaysApprove: [], onRevoke: "stop_and_keep" },
  optInTarget: "choice", status: "built", flag: null, ...over,
});

describe("R1 the seeded catalogue", () => {
  it("validates with no problems", () => {
    expect(validateRegistry()).toEqual([]);
  });

  it("covers the design's catalogue, with draft replies on deal watch OR DM intake", () => {
    for (const k of ["deal_watch", "dm_intake", "draft_replies", "auto_archive", "grey_area_rules", "email_triage", "moments_scan", "post_ideas",
      "studio_posts", "pitch_deck", "brand_book", "plan_refresh", "public_page", "bookings", "get_paid", "shop", "post_took_off",
      "profile_refresh", "calendar_read", "reminders", "morning_brief"]) expect(capability(k)).toBeDefined();
    expect(capability("draft_replies")!.needs).toEqual({ any: [{ capability: "deal_watch" }, { capability: "dm_intake" }] });
    expect(capability("draft_replies")!.scope).toBe("per_account");
    expect(capability("bookings")!.needs).toEqual({ all: [{ conn: "payouts" }, { data: "public_page_live" }] });
  });
});

describe("R2 the validator catches mistakes", () => {
  it("a cycle", () => {
    const p = validateRegistry([base("a", { needs: { capability: "b" }, unlocks: ["b"] }), base("b", { needs: { capability: "a" }, unlocks: ["a"] })]);
    expect(p.some((x) => x.startsWith("cycle:"))).toBe(true);
  });
  it("an unknown capability, connection or data", () => {
    const p = validateRegistry([base("a", { needs: { all: [{ capability: "nope" }, { conn: "fax" as any }, { data: "vibes" as any }] } })]);
    expect(p).toEqual(expect.arrayContaining([
      "a: needs names unknown capability nope", "a: needs names unknown connection fax", "a: needs names unknown data vibes",
    ]));
  });
  it("an AND / OR with one child", () => {
    expect(validateRegistry([base("a", { needs: { any: [{ conn: "mailbox" }] } })])).toContain("a: needs has an AND/OR with fewer than two children");
  });
  it("unlocks and needs that disagree, either way", () => {
    expect(validateRegistry([base("a", { unlocks: ["b"] }), base("b")])).toContain("a: unlocks b, but b does not need it");
    expect(validateRegistry([base("a"), base("b", { needs: { capability: "a" } })])).toContain("a: does not list b in unlocks, but b needs it");
  });
  it("a per-account entry that needs no account, or an athlete-wide capability", () => {
    expect(validateRegistry([base("a", { scope: "per_account" })])).toContain("a: per-account but needs no account");
    const p = validateRegistry([base("w", { unlocks: ["a"] }), base("a", { scope: "per_account", needs: { all: [{ conn: "mailbox" }, { capability: "w" }] } })]);
    expect(p).toContain("a: per-account but needs athlete-wide w");
  });
  it("a consent version that is not <key>/<n>, an item without wording, a core entry with an offer", () => {
    expect(validateRegistry([base("a", { consent: { ...base("a").consent, version: "x/1" } })])).toContain('a: consent version must be "a/<n>"');
    expect(validateRegistry([base("a", { consent: { ...base("a").consent, automatic: [{ action: "x", says: " " }] } })])).toContain("a: consent item without an action key or wording");
    expect(validateRegistry([base("a", { core: true, optInTarget: "none" })])).toContain("a: core capabilities are never offered");
    expect(validateRegistry([base("a", { offer: null })])).toContain("a: optional capability has no offer rule");
  });
});

describe("R3 flags", () => {
  const dev = envNames("cloud-run-dev.yaml");
  const prod = envNames("cloud-run-prod.yaml");
  it("every feature flag the registry names is declared in both Cloud Run yamls", () => {
    const flags = CAPABILITIES.map((c) => c.flag).filter((f): f is string => !!f);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.filter((f) => !dev.has(f))).toEqual([]);
    expect(flags.filter((f) => !prod.has(f))).toEqual([]);
  });
  it("planned is never available; a flagged feature only with its flag exactly \"true\"", () => {
    for (const c of CAPABILITIES.filter((x) => x.status === "planned")) expect(isAvailable(c.key, { [c.flag ?? "X"]: "true" })).toBe(false);
    const moments = capability("moments_scan")!;
    expect(availableNow(moments, { AGENT_MOMENTS: "true" })).toBe(true);
    for (const v of [undefined, "false", "TRUE", "1"]) expect(availableNow(moments, { AGENT_MOMENTS: v })).toBe(false);
    expect(availableNow(capability("draft_replies")!, {})).toBe(true);   // no feature flag of its own
  });
});

describe("R4 opt-in targets", () => {
  it("each target resolves to a real table, or none", () => {
    const tables = new Set(Object.values(schema).filter((v) => is(v as any, PgTable)).map((t) => getTableConfig(t as PgTable).name));
    for (const [, table] of Object.entries(OPT_IN_TARGETS)) if (table) expect(tables.has(table)).toBe(true);
    for (const c of CAPABILITIES) expect(Object.keys(OPT_IN_TARGETS)).toContain(c.optInTarget);
  });
});

describe("R5 one model for everyone", () => {
  it("core is exactly sign-up research, the first plan, the score, data upkeep, alerts and deal detection on a connected inbox / DM account", () => {
    expect(CAPABILITIES.filter((c) => c.core).map((c) => c.key).sort())
      .toEqual(["account_data_upkeep", "business_alerts", "deal_watch", "dm_intake", "first_plan", "score_upkeep", "signup_research"]);
  });
  it("every core entry says why it is core; no optional one does", () => {
    for (const c of CAPABILITIES) expect([c.key, c.core ? !!c.coreReason?.trim() : c.coreReason === undefined]).toEqual([c.key, true]);
    expect(validateRegistry([base("a", { core: true, offer: null, optInTarget: "none" })])).toContain("a: a core capability must say why it is core (coreReason)");
  });
  it("onboarding's first plan is core sign-up service; every later refresh is the optional plan_refresh", () => {
    expect(capability("first_plan")).toMatchObject({ core: true, offer: null, tools: [], workers: ["planner"] });
    expect(capability("first_plan")!.coreReason).toMatch(/sign-up/i);
    expect(capability("plan_refresh")).toMatchObject({ core: false, optInTarget: "choice" });
  });
  it("every other capability is optional: offered, and its yes covers an explicit consent version", () => {
    for (const c of CAPABILITIES.filter((x) => !x.core)) {
      expect(c.offer).not.toBeNull();
      expect(c.consent.version).toMatch(new RegExp(`^${c.key}/\\d+$`));
    }
  });
  it("external actions always need a tap: replies, publishing, sharing, charging are never automatic", () => {
    const automatic = CAPABILITIES.flatMap((c) => c.consent.automatic.map((i) => i.action));
    for (const a of ["send_reply", "publish_post", "publish_page", "share_document", "charge", "send_invoice"]) expect(automatic).not.toContain(a);
  });
});

describe("R6 gated jobs and dependents", () => {
  it("each gated job is a built, optional, athlete-wide capability whose consent lists the job's action", () => {
    for (const [job, { capability: key, action }] of Object.entries(OPTIONAL_JOBS)) {
      const c = capability(key);
      expect({ job, core: c?.core, scope: c?.scope, status: c?.status }).toEqual({ job, core: false, scope: "athlete", status: "built" });
      expect(c!.consent.automatic.map((i) => i.action)).toContain(action);
    }
  });
  it("dependentsOf follows needs, not better-with", () => {
    expect(dependentsOf("deal_watch").sort()).toEqual(["auto_archive", "draft_replies", "grey_area_rules"]);
    expect(dependentsOf("post_ideas")).toEqual([]);   // studio_posts is only better with it
  });
});

describe("R7 the Turn-on sheet's consent fits its pinned foot", () => {
  it("every Turn-on capability needs at most 2 reads + 2 always-asks, each line within the schema's length", () => {
    const over = turnOnKeys(CAPABILITIES).map((key) => consentWords(capability(key)!)).filter((w) =>
      w.automatic.length > TURN_ON_CONSENT_MAX.reads || w.alwaysAsks.length > TURN_ON_CONSENT_MAX.alwaysAsks
      || [...w.automatic, ...w.alwaysAsks].some((t) => t.length > TURN_ON_CONSENT_MAX.chars));
    expect(over).toEqual([]);
  });
  it("every Turn-on capability's consent passes the card schema, with at least one line to show", () => {
    const consent = MILA_CARD_SCHEMAS["turn-on"].shape.fields.shape.consent;
    const bad = turnOnKeys(CAPABILITIES).filter((key) => {
      const w = consentWords(capability(key)!);
      const parsed = consent.safeParse({ reads: w.automatic, drafts: w.drafts, alwaysAsks: w.alwaysAsks, onRevoke: w.onRevoke });
      return !parsed.success || w.automatic.length + w.alwaysAsks.length === 0;
    });
    expect(bad).toEqual([]);
  });
  it("the drafts line is one of the reads exactly when consent.drafts is true, after the registry's own lines", () => {
    for (const c of CAPABILITIES) {
      const w = consentWords(c);
      expect({ key: c.key, reads: w.automatic }).toEqual({ key: c.key, reads: [...c.consent.automatic.map((i) => i.says), ...(c.consent.drafts ? [DRAFTS_SAYS] : [])] });
    }
    expect(DRAFTS_SAYS).toBe("Write drafts for you to check. Nothing is sent without your tap.");
    expect(turnOnKeys(CAPABILITIES).filter((k) => capability(k)!.consent.drafts).sort()).toEqual(["brand_book", "draft_replies", "pitch_deck"]);
    expect(consentWords(base("x", { consent: { ...base("x").consent, drafts: true } })).automatic).toEqual(["Do it", DRAFTS_SAYS]);
    expect(consentWords(base("x")).automatic).toEqual(["Do it"]);
  });
  it("the card schema refuses a third read or a third always-ask", () => {
    const consent = MILA_CARD_SCHEMAS["turn-on"].shape.fields.shape.consent;
    const ok = { reads: ["a", "b"], drafts: false, alwaysAsks: ["c", "d"], onRevoke: "stop_and_keep" };
    expect(consent.safeParse(ok).success).toBe(true);
    expect(consent.safeParse({ ...ok, reads: ["a", "b", "e"] }).success).toBe(false);
    expect(consent.safeParse({ ...ok, alwaysAsks: ["c", "d", "e"] }).success).toBe(false);
  });
});

describe("R8 a tool serving several documents is owned per use", () => {
  it("documents: status is core, pitch and brand book uses are their capability's, the public page use is core", () => {
    const owners = new Map([...CAPABILITIES.filter((c) => !c.core).flatMap((c) => c.tools.map((t) => [t, c.key] as const))]);
    expect(owners.has("documents_status")).toBe(false);
    for (const t of ["documents_make", "documents_edit", "documents_share"]) {
      expect(owners.has(t)).toBe(false);
      expect(owners.get(`${t}:pitch`)).toBe("pitch_deck");
      expect(owners.get(`${t}:brand_book`)).toBe("brand_book");
      expect(owners.has(`${t}:public_page`)).toBe(false);
    }
  });
  it("the validator refuses a tool owned whole and per use, a core use, or a bad name", () => {
    const whole = validateRegistry([base("a", { tools: ["t"] }), base("b", { tools: ["t:x"] })]);
    expect(whole).toContain("tool t is listed whole and per use");
    const core = validateRegistry([base("c", { core: true, coreReason: "r", offer: null, optInTarget: "none", tools: ["t:x"] })]);
    expect(core).toContain("c: a core capability lists whole tools, not uses (t:x)");
    expect(validateRegistry([base("d", { tools: ["T:x"] })]).some((p) => p.includes("is not \"name\" or \"name:kind\""))).toBe(true);
    const shadow = validateRegistry([base("e", { core: true, coreReason: "r", offer: null, optInTarget: "none", tools: ["t"] }), base("f", { tools: ["t:x"] })]);
    expect(shadow).toContain("f: tool t:x is also listed by a core capability");
  });
});
