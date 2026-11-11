/**
 * mila/load.test.ts — the served text matches the committed served-text golden (served.golden.json): every surface's
 * built instructions, every playbook's served text and version (the first 12 hex of its digest), the proactive
 * preface, the waitlist preface and the waitlist pass's prompt must equal it exactly.
 *
 * The golden was first written from origin/main before the move to instructions/ + skills/ (one Mila definition,
 * 30 Oct 2026), so the move is proven byte-identical. A deliberate text change regenerates it on purpose
 * (`npm run mila:golden`, which stamps the generating git sha) in the same PR, with the Prompt Register entry; never
 * to make this test pass.
 */
jest.mock("../../db", () => ({ db: {} }));   // the preface modules import the db; nothing here touches it

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MILA_DIR, MILA_SURFACES, buildMilaInstructions, digestOf, listPlaybooks } from "./build";
import { loadPlaybook } from "../engine/tools/playbooks";
import { proactivePreface } from "../proactive/turn";
import { waitlistPreface } from "../waitlist/turn";
import { loadJob, promptDigest } from "../jobs";

const golden = JSON.parse(readFileSync(join(MILA_DIR, "served.golden.json"), "utf8"));
const lf = (s: string) => s.replace(/\r\n/g, "\n");

describe("one Mila definition: the served text matches the committed served-text golden", () => {
  test.each(MILA_SURFACES.map((s) => [s]))("the %s surface's built instructions", (surface) => {
    const built = buildMilaInstructions({ surface });
    expect(built).toBe(golden.instructions[surface]);
    expect(digestOf(built)).toBe(golden.instructions_sha256[surface]);
  });

  test("the chat job's instructions (jobs/chat.yaml) are the Mastra agent's chat text (engine \"mastra\")", () => {
    const built = buildMilaInstructions({ surface: "chat", engine: "mastra" });
    expect(lf(loadJob("chat").instructions)).toBe(built.trim());
  });

  test("the same playbooks, by name", () => {
    expect(listPlaybooks()).toEqual(Object.keys(golden.playbooks).sort());
  });

  test.each(Object.keys(golden.playbooks).map((n) => [n]))("playbook %s: same text and same version digest", (name) => {
    const p = loadPlaybook(name);
    expect(p.text).toBe(golden.playbooks[name].text);
    expect(p.version).toBe(golden.playbooks[name].version);
  });

  test("the proactive preface and the waitlist preface", () => {
    expect(proactivePreface()).toBe(golden.proactive_preface);
    expect(waitlistPreface(true)).toEqual(golden.waitlist_preface.new);
    expect(waitlistPreface(false)).toEqual(golden.waitlist_preface.resumed);
  });

  test("the waitlist pass's prompt (jobs/waitlist.md, now one include of the waitlist SKILL.md)", () => {
    const s = loadJob("waitlist");
    const instructions = lf(s.instructions);
    expect(instructions).toBe(golden.waitlist_skill.instructions);
    expect(s.version).toBe(golden.waitlist_skill.version);
    expect(s.tools).toEqual(golden.waitlist_skill.tools);
    expect(promptDigest({ ...s, instructions })).toBe(golden.waitlist_skill.prompt_digest);
  });
});
