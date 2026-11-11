/**
 * agentLogic.test — the pure rules behind the agent UI: which cards are drawable, verb words, money at every scale,
 * progress, the onboarding checkpoints; plus two source scans over the agent UI: the goal chain's words come from
 * NAMING (never "objectives", "strategy" or "recommendations" in athlete-facing copy) and no copy assumes a pronoun.
 */
import fs from "node:fs";
import path from "node:path";
import { connectorName, drawableCards, formatMoney, progressFraction, progressLine, VERB_COPY, hostOf, serviceGlyph } from "./cardLogic";
import { awaitsAgentOnboardingRead, coveredA11y, coveredLabel, latchesAgentOnboardingGate, needsAgentOnboardingGate, onboardingScreen, ownGoalTurnIndex, showsMilaLabel } from "./onboardingLogic";
import { BANNED_WORDS, NAMING } from "./naming";
import { activityCard, fromWire, sharpenConnectors } from "./onboardingAdapter";
import { APPROVAL_VERBS } from "../../../shared/agent";

describe("cards", () => {
  it("drawableCards keeps known kinds with an id and a payload, in order", () => {
    const ok = { id: "a", kind: "ready", payload: {} };
    expect(drawableCards([ok, { id: "b", kind: "nope", payload: {} }, { kind: "action", payload: {} }, null, { id: "c", kind: "positioning", payload: {} }])).toEqual([ok, { id: "c", kind: "positioning", payload: {} }]);
    expect(drawableCards(undefined)).toEqual([]);
  });

  it("every approval verb has its own words", () => {
    for (const v of APPROVAL_VERBS) expect(VERB_COPY[v].approve.length).toBeGreaterThan(0);
  });

  it("money reads the same at every scale", () => {
    expect(formatMoney(5000, "usd")).toBe("$50");
    expect(formatMoney(8050, "usd")).toBe("$80.50");
    expect(formatMoney(5_000_000, "usd")).toBe("$50,000");
    expect(formatMoney(100, "zzz")).toMatch(/^ZZZ\s1$/);
  });

  it("progress: a running step is half done; done is full; failed stays where it stopped", () => {
    expect(progressFraction({ step: 2, of: 4, state: "running" })).toBeCloseTo(0.375);
    expect(progressFraction({ step: 4, of: 4, state: "done" })).toBe(1);
    expect(progressFraction({ step: 3, of: 4, state: "failed" })).toBe(0.75);
    expect(progressLine({ step: 2, of: 4, label: "Writing copy", state: "running" })).toBe("Step 2 of 4 · Writing copy");
  });

  it("source hosts and service glyphs", () => {
    expect(hostOf("https://www.example.org/a?b")).toBe("example.org");
    expect(serviceGlyph("gmail")).toBe("mail");
    expect(serviceGlyph("something_new")).toBe("link-2");
  });
});

describe("onboarding", () => {
  const cps = [{ id: "name_sport" as const, label: "Who you are", covered: true }, { id: "goal" as const, label: "Your goals", covered: false }];
  it("checkpoint progress is subtle and readable", () => {
    expect(coveredLabel(cps)).toBe("1 of 2 covered");
    expect(coveredLabel([])).toBeNull();
    expect(coveredA11y(cps)).toBe("1 of 2 covered. Covered: Who you are. Still to cover: Your goals");
  });

  it("which screen: name until there is one, then the conversation, done releases", () => {
    expect(onboardingScreen(undefined)).toBe("loading");
    expect(onboardingScreen({ status: "needs_name" })).toBe("name");
    expect(onboardingScreen({ status: "active" })).toBe("conversation");
    expect(onboardingScreen({ status: "done" })).toBe("done");
  });

  it("the own-goal composer sits under the LAST turn that proposes goals; Mila's label once per run", () => {
    const t = (role: "mila" | "athlete", kinds: string[] = []) => ({ id: Math.random().toString(), role, text: "x", at: "", cards: kinds.map((k) => ({ id: k, kind: k, payload: {} })) as any });
    const turns = [t("mila", ["goal-proposal"]), t("athlete"), t("mila"), t("mila", ["goal-proposal"]), t("athlete")];
    expect(ownGoalTurnIndex(turns)).toBe(3);
    expect(showsMilaLabel(turns, 2)).toBe(true);
    expect(showsMilaLabel(turns, 3)).toBe(false);
  });
});

describe("App.tsx's root gate (fix/existing-users-skip-onboarding: existing goes straight in, new goes through)", () => {
  const base = { agentV3: true, inApp: true, isError: false, isLoading: false };

  it("an existing athlete (status done, read from fromWire's required: false) is never gated", () => {
    expect(needsAgentOnboardingGate({ ...base, data: { status: "done" } })).toBe(false);
  });

  it("a new athlete (status needs_name) is gated", () => {
    expect(needsAgentOnboardingGate({ ...base, data: { status: "needs_name" } })).toBe(true);
  });

  it("mid-conversation (status active) stays gated", () => {
    expect(needsAgentOnboardingGate({ ...base, data: { status: "active" } })).toBe(true);
  });

  it("an optional conversation (opt-in, or an athlete who already finished onboarding) never gates or latches a launch", () => {
    expect(needsAgentOnboardingGate({ ...base, data: { status: "active", optional: true } })).toBe(false);
    expect(latchesAgentOnboardingGate({ ...base, data: { status: "active", optional: true } })).toBe(false);
    expect(needsAgentOnboardingGate({ ...base, data: { status: "active", optional: false } })).toBe(true);
  });

  it("fromWire carries optional; an older server without it reads as not optional", () => {
    const wire = { started: true as const, runId: "r", status: "waiting", waitingOn: null, progress: null, passes: [], briefPending: false, turns: [], checkpoints: {}, done: false };
    expect(fromWire({ ...wire, optional: true }).optional).toBe(true);
    expect(fromWire(wire).optional).toBe(false);
    expect(fromWire({ started: false, required: false }).optional).toBe(false);
  });

  it("still loading the first read holds a neutral splash: neither the conversation nor the app mounts", () => {
    expect(needsAgentOnboardingGate({ ...base, isLoading: true, data: undefined })).toBe(false);
    expect(awaitsAgentOnboardingRead({ ...base, isLoading: true, data: undefined })).toBe(true);
    expect(awaitsAgentOnboardingRead({ ...base, isLoading: true, isError: true, data: undefined })).toBe(false);
    expect(awaitsAgentOnboardingRead({ ...base, inApp: false, isLoading: true, data: undefined })).toBe(false);
    expect(awaitsAgentOnboardingRead({ ...base, data: { status: "active", optional: true } })).toBe(false);
  });

  it("an already-onboarded athlete with an unfinished opt-in run goes straight to the app once the read lands", () => {
    const read = { ...base, data: { status: "active" as const, optional: true } };
    expect(awaitsAgentOnboardingRead(read)).toBe(false);
    expect(needsAgentOnboardingGate(read)).toBe(false);
    expect(latchesAgentOnboardingGate(read)).toBe(false);
  });

  it("only a landed not-done read latches; the loading moment never does", () => {
    expect(latchesAgentOnboardingGate({ ...base, isLoading: true, data: undefined })).toBe(false);
    expect(latchesAgentOnboardingGate({ ...base, data: { status: "done" } })).toBe(false);
    expect(latchesAgentOnboardingGate({ ...base, data: { status: "needs_name" } })).toBe(true);
    expect(latchesAgentOnboardingGate({ ...base, data: { status: "active" } })).toBe(true);
  });

  it("App's render sequence: an existing athlete (loading, then done) ends ungated; a new one (loading, then needs_name, then done) stays latched", () => {
    const run = (reads: Array<Parameters<typeof needsAgentOnboardingGate>[0]>) => {
      let latch = false;
      let gated = false;
      for (const r of reads) {
        if (latchesAgentOnboardingGate(r)) latch = true;
        gated = needsAgentOnboardingGate(r) || latch;
      }
      return gated;
    };
    const loading = { ...base, isLoading: true, data: undefined };
    expect(run([loading, { ...base, data: { status: "done" } }])).toBe(false);
    expect(run([loading, { ...base, data: { status: "needs_name" } }, { ...base, data: { status: "done" } }])).toBe(true);
  });

  it("fails open: a failed read, AGENT_V3 off, or not yet in the app are never gated", () => {
    expect(needsAgentOnboardingGate({ ...base, isError: true, data: undefined })).toBe(false);
    expect(needsAgentOnboardingGate({ ...base, agentV3: false, data: { status: "needs_name" } })).toBe(false);
    expect(needsAgentOnboardingGate({ ...base, inApp: false, data: { status: "needs_name" } })).toBe(false);
  });
});

describe("the onboarding adapter (#890 wire → view)", () => {
  it("not started, required (the new agent front, or an opt-in) → the name screen", () => {
    const v = fromWire({ started: false, required: true });
    expect(v.status).toBe("needs_name");
    expect(v.everStarted).toBe(false);
  });

  it("not started, NOT required (an existing athlete — fix/existing-users-skip-onboarding) → done, straight into the app", () => {
    const v = fromWire({ started: false, required: false });
    expect(v.status).toBe("done");
    expect(v.everStarted).toBe(false);
  });

  it("turns become the athlete's bubble then Mila's turn; the progress card carries the passes; checkpoints count declined as covered", () => {
    const v = fromWire({
      started: true, runId: "r1", status: "running", waitingOn: null, briefPending: false, done: false,
      progress: { id: "p", kind: "progress", title: "Mila is researching", links: [], runId: null, payload: { step: 1, of: 3, label: "Searching the web for you", state: "running" } },
      passes: [{ step: "research_a", label: "Pass A", status: "done" }, { step: "research_b", label: "Pass B", status: "waiting" }],
      turns: [{ turn: 1, athlete: { message: "Hi", actions: [] }, message: "Hello.", cards: [] }, { turn: 2, athlete: { message: null, actions: ["consent"] }, message: "Thanks.", cards: [] }],
      checkpoints: { name_sport: "done", consent: "declined", reveal: "offered" },
    });
    expect(v.turns.map((t) => `${t.role}:${t.text}`)).toEqual(["athlete:Hi", "mila:Hello.", "mila:Thanks.", "mila:null"]);
    expect((v.turns[3].cards[0].payload as any).steps).toEqual([{ label: "Pass A", state: "done" }, { label: "Pass B", state: "pending" }]);
    expect(coveredLabel(v.checkpoints)).toBe("2 of 7 covered");
    expect(v.working).toEqual({ label: "Looking things up…" });
    expect(v.canFinish).toBe(false);
  });

  it("done → every checkpoint met: Go to Home", () => {
    const v = fromWire({ started: true, runId: "r", status: "done", waitingOn: null, progress: null, passes: [], briefPending: false, turns: [], checkpoints: {}, done: true });
    expect(v.status).toBe("done");
    expect(v.canFinish).toBe(true);
    expect(v.everStarted).toBe(true);
  });
});

describe("#891 shapes through the adapter", () => {
  it("research events → reading now, counts, discoveries", () => {
    const at = "2026-10-09T10:00:00Z";
    const c = activityCard("r", [
      { kind: "reading", at, pass: "a", domain: "a.example", url: "https://a.example/" },
      { kind: "discovery", at, pass: "a", text: "Found one", source: { domain: "a.example", url: "https://a.example/x", title: "A" } },
      { kind: "reading", at, pass: "b", domain: "b.example", url: "https://b.example/" },
      { kind: "pass_done", at, pass: "a", facts: 4 },
    ], "running");
    expect(c.payload.reading).toEqual({ domain: "b.example", title: null });
    expect(c.payload.counts).toEqual({ sources: 2, finds: 1, passesDone: 1 });
    expect(c.payload.discoveries[0].source).toEqual({ label: "A", url: "https://a.example/x" });
  });

  it("sharpen steps → one entry per connector, in order; evidence steps carry none", () => {
    expect(sharpenConnectors([
      { kind: "evidence", connector: null, text: "x" },
      { kind: "connect", connector: "tiktok", service: "TikTok", reason: "measured_audience" },
      { kind: "awaiting_data", connector: "instagram", service: "Instagram", reason: "connected_not_yet_read" },
      { kind: "connect", connector: "tiktok", service: "TikTok", reason: "measured_audience" },
    ])).toEqual([{ connector: "tiktok", service: "TikTok" }]);
  });

  it("connector names in words, never guessed", () => {
    expect(connectorName("tiktok")).toBe("TikTok");
    expect(connectorName("new_service")).toBe("New Service");
  });
});

describe("source scans over the agent UI", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const DIRS = ["components/agent", "screens/agent", "lib/agent"];
  const files = DIRS.flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f) && f !== "fixtures.ts" && f !== "fixtureApi.ts" && f !== "naming.ts" && f !== "types.ts").map((f) => path.join(d, f)));
  /** Every string literal in a file (comments stripped), roughly — what could reach the screen. */
  const strings = (f: string) => {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    return [...src.matchAll(/"([^"\n]{3,})"|`([^`]{3,})`/g)].map((m) => m[1] ?? m[2]).filter((s) => /\s/.test(s));
  };

  it("the goal chain's words come from NAMING: no objectives, strategy or recommendations in copy", () => {
    expect(NAMING.tab).toBe("Goals");
    const re = new RegExp(`\\b(${BANNED_WORDS.join("|")})\\b`, "i");
    for (const f of files) for (const s of strings(f)) expect({ f, s, banned: re.test(s) }).toEqual({ f, s, banned: false });
  });

  it("no pronoun assumptions in copy: it speaks to the athlete as you", () => {
    const re = /\b(she|her|hers|he|him|his)\b/i;
    for (const f of files) for (const s of strings(f)) expect({ f, s, pronoun: re.test(s) }).toEqual({ f, s, pronoun: false });
  });
});
