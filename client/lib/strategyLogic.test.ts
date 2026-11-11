/**
 * strategyLogic.test — the pure helpers behind Home's briefing and the Strategy tab.
 *
 *   rail      open + unanswered only, oldest first, three at most; openCount for "See all N"
 *   chips     from open requests with a way in (contract · document) + imputed connectable signals; one per kind; never a
 *             request with no CTA (the "who are they" question), never anything about an injury or a health matter;
 *             empty when nothing applies
 *   copy      domain labels; quotation marks only for her wording; confidence lines; state lines
 */
import { confidenceHomeLine, connectedPlatformIds, domainLabel, goalText, homeRail, horizonWords, insightsConnected, milaChips, openCount, stateLine, waitingByGoal } from "./strategyLogic";

const rec = (id: string, over: Record<string, unknown> = {}): any => ({
  id, title: id, what: "w", why: "y", notSeen: [], sourceCount: 1, evidence: [], executionPath: "specialized_plan", relationToExistingWork: "new_work",
  source: "the Objective loop", createdAt: "2026-09-27T10:00:00.000Z", objectiveIds: ["o1"], objective: { id: "o1", domain: "impact", text: "t", owner: "objectives", sourceMethod: null, quoted: false, horizon: null, lifecycle: "active", disposition: "accepted" },
  response: { state: "none", at: null, actor: null }, authorization: { state: "none", at: null, actor: null }, execution: { state: "none", refs: [] }, outcome: null, closed: false,
  readiness: { state: "unavailable", capability: null, reason: "r", domain: "impact", words: "Nomila can't start preparing this yet." }, mayPrepare: false, visual: { kind: "goal_tile", domain: "impact" }, ...over,
});

describe("the rail", () => {
  it("open + unanswered, oldest first, capped at three; openCount is the uncapped number", () => {
    const items = [
      rec("d", { createdAt: "2026-09-27T10:04:00.000Z" }),
      rec("accepted", { response: { state: "accepted", at: "x", actor: "a" } }),
      rec("a", { createdAt: "2026-09-27T10:01:00.000Z" }),
      rec("closed", { closed: true }),
      rec("c", { createdAt: "2026-09-27T10:03:00.000Z" }),
      rec("b", { createdAt: "2026-09-27T10:02:00.000Z" }),
      rec("deferred", { response: { state: "deferred", at: "x", actor: "a" } }),
    ];
    expect(homeRail(items).map((v) => v.id)).toEqual(["a", "b", "c"]);
    expect(openCount(items)).toBe(4);
    expect(homeRail([])).toEqual([]);
  });

  it("waitingByGoal counts open unanswered items per goal", () => {
    const m = waitingByGoal([rec("1"), rec("2", { objectiveIds: ["o2"] }), rec("3", { response: { state: "accepted", at: "x", actor: "a" } }), rec("4", { closed: true })]);
    expect([...m.entries()]).toEqual([["o1", 1], ["o2", 1]]);
  });
});

describe("Mila can help with…", () => {
  const req = (id: string, cta: any, over: Record<string, unknown> = {}): any => ({ requestId: id, status: "open", sheAsked: null, nomilaSays: "You asked me to prompt you for your contract.", cta, ...over });
  const assumed = (keys: string[]): any => ({ assessment: { dimensions: [{ key: "engagement_quality", components: keys.map((key) => ({ key, evidenceClass: "ASSUMED" })) }] } });

  it("a contract request → Add contract; a document request → Share performance data; one chip per kind; order fixed", () => {
    const chips = milaChips([
      req("r2", { kind: "add_document", label: "Add document" }, { nomilaSays: "your performance data" }),
      req("r1", { kind: "add_contract", label: "Add contract" }),
      req("r3", { kind: "add_contract", label: "Add contract" }),
    ], null);
    expect(chips.map((c) => [c.kind, c.label, c.requestId])).toEqual([["add_contract", "Add contract", "r1"], ["share_performance", "Share performance data", "r2"]]);
  });

  it("Connect insights is never offered once an insights platform is connected (its button would only open Settings)", () => {
    const v: any = { assessment: { dimensions: [{ components: [{ key: "engagement_quality.video_retention", evidenceClass: "ASSUMED" }] }] } };
    expect(milaChips([], v).map((c) => c.kind)).toEqual(["connect_insights"]);
    expect(milaChips([], v, ["instagram"]).map((c) => c.kind)).toEqual([]);
    expect(milaChips([], v, ["gmail"]).map((c) => c.kind)).toEqual(["connect_insights"]);   // an inbox is not an insights account
    expect(connectedPlatformIds([{ platform: "Instagram", status: "active" }, { platform: "tiktok", status: "revoked" }, { platform: "gmail", status: "active" }])).toEqual(["instagram", "gmail"]);
    expect(connectedPlatformIds(null)).toEqual([]);
    expect(insightsConnected(["gmail"])).toBe(false);
    expect(insightsConnected(["youtube"])).toBe(true);
  });

  it("imputed connectable signals → Connect insights; an imputed signal connecting can't fix is not a chip", () => {
    expect(milaChips([], assumed(["engagement_quality.video_retention", "engagement_quality.story_efficiency"])).map((c) => c.kind)).toEqual(["connect_insights"]);
    expect(milaChips([], assumed(["cultural_relevance.media_volume_percentile"]))).toEqual([]);
    expect(milaChips([], { assessment: { dimensions: [{ key: "engagement_quality", components: [{ key: "engagement_quality.video_retention", evidenceClass: "MEASURED" }] }] } } as any)).toEqual([]);
  });

  it("never: a request with no way in (who they are), a closed request, or anything about an injury or health", () => {
    expect(milaChips([
      req("startx", null, { nomilaSays: "You asked me to prompt you for who they are. I can't take this one in the app yet." }),
      req("done", { kind: "add_contract", label: "Add contract" }, { status: "evidenced" }),
      req("hurt", { kind: "add_document", label: "Add document" }, { nomilaSays: "your injury report" }),
      req("hurt2", { kind: "add_document", label: "Add document" }, { sheAsked: "remind me about my health check" }),
    ], null)).toEqual([]);
    expect(milaChips(null, null)).toEqual([]);
    expect(milaChips(undefined, undefined)).toEqual([]);
  });
});

describe("copy", () => {
  it("domain labels", () => {
    expect(domainLabel("audience")).toBe("Audience");
    expect(domainLabel("owned_venture")).toBe("Owned venture");
  });

  it("quotation marks only for her wording", () => {
    expect(goalText({ text: "Grow it.", quoted: true })).toBe("“Grow it.”");
    expect(goalText({ text: "Grow it.", quoted: false })).toBe("Grow it.");
    expect(goalText(null)).toBe("");
  });

  it("horizon words", () => {
    expect(horizonWords({ kind: "period", period: "multi_year", why: "" })).toBe("Over several years");
    expect(horizonWords({ kind: "period", period: "next_12_months", why: "" })).toBe("Next 12 months");
    expect(horizonWords({ kind: "period", period: "this_season", why: "" })).toBe("This season");
    expect(horizonWords(null)).toBeNull();
  });

  it("confidence: HIGH as agreed, MEDIUM and LOW proposed, nothing otherwise", () => {
    expect(confidenceHomeLine("HIGH")).toBe("Nomila is confident in this read.");
    expect(confidenceHomeLine("MEDIUM")).toBe("Nomila is fairly confident in this read.");
    expect(confidenceHomeLine("LOW")).toBe("Nomila's read is still early.");
    expect(confidenceHomeLine(null)).toBeNull();
  });

  it("state lines", () => {
    expect(stateLine(rec("x"))).toEqual({ text: "Waiting for your response", tone: "waiting" });
    expect(stateLine(rec("x", { response: { state: "accepted", at: "x", actor: "a" } }))).toEqual({ text: "Accepted · Nomila can't prepare this yet", tone: "accepted" });
    expect(stateLine(rec("x", { response: { state: "accepted", at: "x", actor: "a" }, readiness: { state: "available", capability: "c", reason: null, domain: "outreach", words: "" } }))).toEqual({ text: "Accepted", tone: "accepted" });
    expect(stateLine(rec("x", { response: { state: "deferred", at: "x", actor: "a" } }))).toEqual({ text: "Not now", tone: "later" });
  });
});
