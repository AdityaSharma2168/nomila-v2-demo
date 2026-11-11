/**
 * skills.test.ts — Mila's playbooks as Mastra's NATIVE agent skills (skills.ts), on the REAL Mastra Agent loop with the
 * runtime's own definition (testRuntime mila: true) and a scripted model: no provider, no network, no database.
 *
 *   S1 each turn is offered only the skills its surface and flags allow (nomila.yaml surfaces + flag); none without a
 *      scope (fails closed)
 *   S2 the served body is byte-identical to the playbook's served text (served.golden.json): `skill` returns it whole,
 *      skill_read returns it under the two-field front-matter and pages it by line
 *   S3 the job prompts (server/agent/jobs) are never discoverable: not listed, not loadable, not readable by path, not
 *      found by search
 *   S4 a forged skill name fails cleanly (a plain "not found" result; the turn goes on)
 *   S5 Mastra's words are the only words (TrueForge and its get_playbook went in Mastra-only PR 3): every surface's
 *      instructions and the waitlist preface name the skill tool, never get_playbook
 *   S6 display: the skill tools' arguments and results never reach chat v2's client stream; Mila's reply does
 *   S7 the model-facing skill text is OURS, pinned exactly: one catalog message and three tool descriptions in our
 *      calm words, in place of Mastra's SkillsProcessor catalog, its "IMPORTANT: Skills are NOT tools…" message and
 *      its tool descriptions
 */
jest.mock("../../../db", () => ({ db: {} }));
jest.mock("openai", () => jest.fn(() => { throw new Error("tests never construct the real OpenAI client"); }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { approxTokens, buildMilaInstructions, MILA_SURFACES } from "../../mila/build";
import { MILA_DIR, MILA_SKILL_SURFACES, listSkillNames, readSidecar, readSkill } from "../../mila/load";
import { loadPlaybook } from "../tools/playbooks";
import { issueAthletePass } from "../tools/pass";
import { passRegistry, passSkill, visibleTools } from "../tools/registry";
import { listJobs, loadJob, instructionsFor } from "../../jobs";
import { CHAT_SCOPES } from "../turnTypes";
import { waitlistPreface } from "../../waitlist/turn";
import { scriptedModel, testRuntime, type ScriptedStep } from "../../../testUtils/mastraScripted";
import { createChatV2Stream, type UiPart } from "./chatV2Stream";
import { displayChunk } from "./display";
import { contextFromPass } from "./guards";
import { MILA_SKILL_TOOL_DESCRIPTIONS, SKILLS_CONTEXT_KEY, allowedSkillNames, flagOn, milaSkillsFor, playbooksCatalog, scopeFrom, turnSurface, type MilaSkillScope } from "./skills";
import { readSkillFrontMatter } from "../../mila/load";
import { TOOL_RESULT_MAX_CHARS_DEFAULT } from "../tools/config";

const KEY = "mastra-skills-test-pass-key-0123456789-0123456789";
const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const THREAD = "a1a1a1a1-0000-4000-8000-0000000000a1";
const RUN = "a2a2a2a2-0000-4000-8000-0000000000a2";
const golden = JSON.parse(readFileSync(join(MILA_DIR, "served.golden.json"), "utf8")) as { playbooks: Record<string, { text: string; version: string }> };

const registry = passRegistry();
/** The chat pass's visible tools as turn.ts computes them. */
const chatTools = visibleTools(passSkill(loadJob("chat"), registry), registry, { scopes: [...CHAT_SCOPES] }).map((t) => t.name);
const WAITLIST_TOOLS = readSidecar("waitlist").tools;
const CHAT: MilaSkillScope = { surface: "chat", tools: chatTools };

async function turn(steps: ScriptedStep[], scope: MilaSkillScope | null) {
  const m = scriptedModel(steps);
  const rt = await testRuntime(m.model, { mila: true });
  const pass = issueAthletePass({ athleteId: A, sessionId: THREAD, runId: RUN, skillId: "chat", scopes: ["read"] }, KEY);
  const { requestContext } = await contextFromPass(pass, { athleteId: A, threadId: THREAD }, KEY);
  if (scope) requestContext.set(SKILLS_CONTEXT_KEY, scope);
  const out: any = await rt.agent.stream("Hi", { memory: { thread: THREAD, resource: A }, runId: RUN, requestContext, maxSteps: 4 } as never);
  const chunks: any[] = [];
  for await (const c of out.fullStream) chunks.push(c);
  const results = chunks.filter((c) => c.type === "tool-result").map((c) => ({ tool: c.payload.toolName as string, args: c.payload.args, result: c.payload.result }));
  const errors = chunks.filter((c) => c.type === "tool-error").map((c) => ({ tool: c.payload.toolName as string, error: String(c.payload.error?.message ?? c.payload.error) }));
  const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.payload.text).join("");
  return { m, chunks, results, errors, text };
}
const call = (name: string, args: Record<string, unknown>, id?: string) => ({ name, args, ...(id ? { id } : {}) });
/** The system messages the model received. */
const systemOf = (prompt: unknown): string[] =>
  (prompt as Array<{ role: string; content: unknown }>).filter((m) => m.role === "system").map((m) => String(m.content));
/** The playbook names in the catalog (our one system message, playbooksCatalog) in front of the model. */
const catalogOf = (prompt: unknown): string[] => {
  const block = systemOf(prompt).map((c) => /<available_playbooks>\n([\s\S]*?)\n<\/available_playbooks>/.exec(c)).find(Boolean);
  return block ? [...block[1].matchAll(/^- ([a-z0-9-]+): /gm)].map((x) => x[1]).sort() : [];
};

describe("S1 per surface and per flag", () => {
  it("chat: the five chat playbooks, not the waitlist's", () => {
    expect(allowedSkillNames(CHAT)).toEqual(["bookings", "deals", "documents", "onboarding", "public-page"]);
  });

  it("a flag is read from the skill's own tools: a flagged skill whose tools are off this turn is not offered", () => {
    const noDeals = chatTools.filter((t) => !t.startsWith("deals_") && t !== "brand_get");
    expect(allowedSkillNames({ surface: "chat", tools: noDeals })).toEqual(["bookings", "documents", "onboarding", "public-page"]);
    // flag null (onboarding, public-page): offered with no tools at all
    expect(allowedSkillNames({ surface: "chat", tools: [] })).toEqual(["onboarding", "public-page"]);
    // the waitlist surface: its playbook only while MILA_TF_WAITLIST's tools are on
    expect(allowedSkillNames({ surface: "waitlist", tools: WAITLIST_TOOLS })).toEqual(["waitlist"]);
    expect(allowedSkillNames({ surface: "waitlist", tools: [] })).toEqual([]);
    expect(allowedSkillNames({ surface: "waitlist", tools: chatTools })).toEqual([]);
    // proactive: what nomila.yaml lists for it; public and voice never run on Mastra but filter the same way
    expect(allowedSkillNames({ surface: "proactive", tools: chatTools })).toEqual(["bookings", "deals", "documents"]);
    expect(allowedSkillNames({ surface: "public", tools: chatTools })).toEqual([]);
  });

  it("a flagged skill that names no tools reads the flag itself (exact \"true\" only)", () => {
    const sc = { flag: "MILA_SKILLS_TEST_FLAG", tools: [] as string[] };
    const before = process.env.MILA_SKILLS_TEST_FLAG;
    try {
      delete process.env.MILA_SKILLS_TEST_FLAG;
      expect(flagOn(sc, chatTools)).toBe(false);
      process.env.MILA_SKILLS_TEST_FLAG = "1";
      expect(flagOn(sc, chatTools)).toBe(false);
      process.env.MILA_SKILLS_TEST_FLAG = "true";
      expect(flagOn(sc, chatTools)).toBe(true);
    } finally { if (before === undefined) delete process.env.MILA_SKILLS_TEST_FLAG; else process.env.MILA_SKILLS_TEST_FLAG = before; }
    expect(flagOn({ flag: null, tools: ["x"] }, [])).toBe(true);
  });

  it("the turn's surface: the waitlist pass, an isolated (proactive) turn, else the chat", () => {
    expect(turnSurface({ skillId: "waitlist", waitlistSkillId: "waitlist" })).toBe("waitlist");
    expect(turnSurface({ skillId: "chat", isolated: true, waitlistSkillId: "waitlist" })).toBe("proactive");
    expect(turnSurface({ skillId: "chat", waitlistSkillId: "waitlist" })).toBe("chat");
  });

  it("the agent lists exactly the allowed skills to the model, per scope, and offers Mastra's skill tools", async () => {
    const chat = await turn([{ text: "ok" }], CHAT);
    expect(catalogOf(chat.m.prompts[0])).toEqual(allowedSkillNames(CHAT));
    expect(chat.m.toolNames[0]).toEqual(expect.arrayContaining(["skill", "skill_read", "skill_search"]));
    expect(chat.m.toolNames[0]).not.toContain("get_playbook");

    const waitlist = await turn([{ text: "ok" }], { surface: "waitlist", tools: WAITLIST_TOOLS });
    expect(catalogOf(waitlist.m.prompts[0])).toEqual(["waitlist"]);
    const proactive = await turn([{ text: "ok" }], { surface: "proactive", tools: chatTools });
    expect(catalogOf(proactive.m.prompts[0])).toEqual(["bookings", "deals", "documents"]);
  });

  it("no scope in the requestContext (or a forged one): no skills, no skill tools", async () => {
    for (const scope of [null, { surface: "admin", tools: chatTools } as never]) {
      const r = await turn([{ text: "ok" }], scope);
      expect(JSON.stringify(r.m.prompts[0])).not.toMatch(/<available_skills>|<available_playbooks>|Your playbooks are listed below/);
      expect(r.m.toolNames[0]).not.toContain("skill");
    }
    expect(scopeFrom(undefined)).toBeNull();
    expect(scopeFrom({ get: () => ({ surface: "chat", tools: [1] }) })).toBeNull();
    expect(scopeFrom({ get: () => ({ surface: "chat", tools: ["deals_get"] }) })).toEqual({ surface: "chat", tools: ["deals_get"] });
  });
});

describe("S2 the served body is the playbook's, byte for byte", () => {
  it("skill returns each playbook's whole served text (golden), the same text loadPlaybook reads", async () => {
    const chatNames = allowedSkillNames(CHAT);
    const chat = await turn([{ tools: chatNames.map((n, i) => call("skill", { name: n }, `s${i}`)) }, { text: "ok" }], CHAT);
    const waitlist = await turn([{ tools: [call("skill", { name: "waitlist" })] }, { text: "ok" }], { surface: "waitlist", tools: WAITLIST_TOOLS });
    const served = [...chat.results, ...waitlist.results];
    expect(served.map((r) => r.args.name).sort()).toEqual(Object.keys(golden.playbooks).sort());
    for (const r of served) {
      const name = r.args.name as string;
      expect(r.result).toBe(golden.playbooks[name].text.trim());
      expect(r.result).toBe(loadPlaybook(name).text.trim());
    }
  });

  it("every playbook loads whole within the tool-result budget our own tools keep to (Mastra does not cut skill results)", () => {
    for (const name of listSkillNames()) expect(readSkill(name).trim().length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS_DEFAULT);
  });

  it("skill_read returns the golden body under a front-matter of name and description only, and pages it by line", async () => {
    const r = await turn([{ tools: [
      call("skill_read", { skillName: "deals", path: "SKILL.md" }, "r1"),
      call("skill_read", { skillName: "onboarding", path: "SKILL.md", startLine: 1, endLine: 20 }, "r2"),
    ] }, { text: "ok" }], CHAT);
    const whole = r.results.find((x) => x.args.skillName === "deals")!.result as string;
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(whole)!;
    expect(m).not.toBeNull();
    expect(m[2]).toBe(golden.playbooks.deals.text);
    expect(parseYaml(m[1])).toEqual({ name: "deals", description: expect.any(String) });
    expect(m[1]).not.toMatch(/version|register_id|surfaces|flag|owner/);   // nomila.yaml and metadata never reach the model
    const page = r.results.find((x) => x.args.skillName === "onboarding")!.result as string;
    expect(page).toMatch(/^SKILL\.md \(lines 1-20 of \d+\)\n/);
  });

  it("the inline skills are built from server/agent/mila/skills by the one loader, with no file-system path", async () => {
    const skills = await milaSkillsFor({ surface: "chat", tools: chatTools });
    for (const s of skills) {
      expect(s.instructions).toBe(readSkill(s.name));
      expect(s.path).toBe(`inline/${s.name}`);
      expect(listSkillNames()).toContain(s.name);
    }
  });
});

describe("S3 job prompts are never discoverable", () => {
  const jobIds = listJobs().map((j) => j.id);
  // The harness's base rules open every job prompt (jobs.ts HARNESS_RULES) and no Mila skill: the chat job's own line.
  const chatJobLine = "You act for one athlete: the person whose account this is.";

  it("no surface ever lists a job that is not also one of Mila's own skills, and a shared name serves Mila's text", async () => {
    expect(instructionsFor(loadJob("chat"))).toContain(chatJobLine);
    for (const surface of MILA_SKILL_SURFACES) {
      const skills = await milaSkillsFor({ surface, tools: [...chatTools, ...WAITLIST_TOOLS] });
      for (const s of skills) {
        expect(listSkillNames()).toContain(s.name);
        expect(s.instructions).toBe(readSkill(s.name));
        expect(s.instructions).not.toContain(chatJobLine);
      }
    }
    expect(jobIds).toContain("chat");
    expect(listSkillNames()).not.toContain("chat");
  });

  it("not loadable by name or path, not readable by a path out of a skill, not found by search", async () => {
    const r = await turn([{ tools: [
      call("skill", { name: "chat" }, "j1"),
      call("skill", { name: "plan" }, "j2"),
      call("skill", { name: "../jobs/chat" }, "j3"),
      call("skill", { name: join(process.cwd(), "server", "agent", "jobs", "chat") }, "j4"),
      call("skill_read", { skillName: "deals", path: "../../jobs/chat.yaml" }, "j5"),
      call("skill_read", { skillName: "chat", path: "SKILL.md" }, "j6"),
      call("skill_search", { query: "act for one athlete, whose account this is; follow the skill below" }, "j7"),
    ] }, { text: "ok" }], CHAT);
    expect(r.results.length + r.errors.length).toBe(7);
    const everything = JSON.stringify([r.results, r.errors]);
    expect(everything).not.toContain(chatJobLine);
    expect(everything).not.toContain("What you have each turn");
    for (const x of r.results.filter((x) => x.tool === "skill")) expect(x.result).toMatch(/^Skill ".*" not found\. Available skills: /);
    const search = r.results.find((x) => x.tool === "skill_search")?.result as string;
    for (const hit of search.matchAll(/^\[([^\]]+)\]/gm)) expect(allowedSkillNames(CHAT)).toContain(hit[1]);
    expect(r.text).toBe("ok");
  });
});

describe("S4 a forged skill name fails cleanly", () => {
  it("is a plain not-found result naming only the turn's skills; the turn carries on", async () => {
    const r = await turn([{ tools: [call("skill", { name: "waitlist" }), call("skill", { name: "deals; drop table" }, "f2")] }, { text: "carry on" }], CHAT);
    expect(r.errors).toEqual([]);
    for (const x of r.results) {
      expect(x.result).toMatch(/not found/);
      const listed = [...String(x.result).matchAll(/(\S+) \(inline\//g)].map((m) => m[1]).sort();
      expect(listed).toEqual(allowedSkillNames(CHAT));
    }
    expect(r.text).toBe("carry on");
  });
});

describe("S5 Mastra's words are the only words", () => {
  it("every surface's instructions and the waitlist preface name the skill tool; nothing offers or names get_playbook", () => {
    for (const surface of MILA_SURFACES) {
      const mastra = buildMilaInstructions({ surface, engine: "mastra" });
      expect(buildMilaInstructions({ surface })).toBe(mastra);   // the default is Mastra's
      expect(mastra).not.toMatch(/\{\{|get_playbook/);
    }
    const chatMastra = buildMilaInstructions({ surface: "chat", engine: "mastra" });
    expect(chatMastra).toContain("For these areas, call the skill tool with the area's name before you act, and follow it:");
    expect(approxTokens(chatMastra)).toBeLessThanOrEqual(4400);   // build.test.ts B3's budget holds on Mastra too
    expect(waitlistPreface(true)).toEqual(waitlistPreface(true, "mastra"));
    expect(waitlistPreface(true, "mastra")[0]).toContain('call the skill tool with name "waitlist"');
    expect(waitlistPreface(true).join("\n")).not.toContain("get_playbook");
    expect(passSkill(loadJob("chat"), registry).tools).not.toContain("get_playbook");
    expect(registry.get("get_playbook")).toBeUndefined();
  });
});

describe("S6 display: no skill text in the client stream", () => {
  it("chat v2 gets the fixed status line for each skill call and Mila's reply; never the playbook or the arguments", async () => {
    const r = await turn([
      { tools: [call("skill", { name: "deals" }, "d1"), call("skill_read", { skillName: "deals", path: "SKILL.md" }, "d2"), call("skill_search", { query: "minimum" }, "d3")] },
      { text: ["Here is where your deal stands."] },
    ], CHAT);
    expect(r.results).toHaveLength(3);
    const parts: UiPart[] = [];
    const stream = await createChatV2Stream((p) => parts.push(p));
    stream.tap.run(RUN);
    // as turn.ts taps a turn: every chunk but text through the display rules; the text as the reply
    for (const c of r.chunks) {
      if (c.type === "text-delta") stream.tap.text(c.payload.text);
      else if (c.type !== "text-start" && c.type !== "text-end") stream.tap.chunk(displayChunk(c, () => []));
    }
    await stream.end({ runId: RUN, status: "completed" }, []);
    const wire = JSON.stringify(parts);
    expect(wire).toContain("Here is where your deal stands.");
    expect(parts.filter((p) => p.type === "data-mila-status").map((p: any) => p.data.label)).toContain("Getting ready…");
    const bodyLines = golden.playbooks.deals.text.split("\n").filter((l) => l.trim().length > 30);
    expect(bodyLines.length).toBeGreaterThan(3);
    for (const line of bodyLines) expect(wire).not.toContain(line.trim());
    for (const leak of ["SKILL.md", "minimum", "inline/deals", "available_skills", "available_playbooks"]) expect(wire).not.toContain(leak);
  });
});

describe("S7 the model-facing skill text is ours, pinned exactly", () => {
  const LEAD = "Your playbooks are listed below. Load one with the skill tool when you start that kind of work; they are instructions, not actions, so give a playbook's name to the skill tool rather than calling it.";
  const TOOLS = {
    skill: "Load one of your playbooks by name: the full instructions for one area of your work. Free; reads nothing about the athlete. Use when you start a kind of work whose playbook you have not loaded in this conversation; don't reload one you already have.",
    skill_read: "Read some lines of a playbook again: skillName is the playbook, path is SKILL.md, startLine and endLine pick the lines. Use only when you need one part again; the skill tool loads a playbook whole.",
    skill_search: "Search the text of your playbooks for one detail. Use only when you need a specific rule and don't know which playbook has it.",
  };

  it("the catalog renders as one lead line and one '- name: description' line per playbook, sorted", () => {
    expect(playbooksCatalog([{ name: "deals", description: "D." }, { name: "bookings", description: "B." }]))
      .toBe(`${LEAD}\n\n<available_playbooks>\n- bookings: B.\n- deals: D.\n</available_playbooks>`);
    expect(MILA_SKILL_TOOL_DESCRIPTIONS).toEqual(TOOLS);
  });

  it("the model gets exactly our catalog message and our three tool descriptions, on every step; none of Mastra's text", async () => {
    const r = await turn([{ tools: [call("skill", { name: "deals" })] }, { text: "ok" }], CHAT);
    const expected = `${LEAD}\n\n<available_playbooks>\n${allowedSkillNames(CHAT).map((n) => `- ${n}: ${readSkillFrontMatter(n).description}`).join("\n")}\n</available_playbooks>`;
    for (const step of [0, 1]) {
      const system = systemOf(r.m.prompts[step]);
      expect(system.filter((c) => c.includes("playbook") && c.includes("<available_playbooks>"))).toEqual([expected]);
      const all = JSON.stringify(r.m.prompts[step]);
      for (const theirs of ["IMPORTANT", "Skills are NOT tools", "<available_skills>", "<location>", "activate it immediately", "Activate a skill"]) expect(all).not.toContain(theirs);
      const d = r.m.toolDescriptions[step];
      expect({ skill: d.skill, skill_read: d.skill_read, skill_search: d.skill_search }).toEqual(TOOLS);
    }
    // the tool still works under our description (Mastra's execute, the golden body)
    expect(r.results.map((x) => x.result)).toEqual([golden.playbooks.deals.text.trim()]);
    // only the three skill tools are re-described (this harness gives the agent no toolsets of ours)
    expect(Object.keys(r.m.toolDescriptions[0]).sort()).toEqual(["skill", "skill_read", "skill_search"]);
  });
});
