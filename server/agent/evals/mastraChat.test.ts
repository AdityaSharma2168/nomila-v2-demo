/**
 * mastraChat.test.ts — the evals play Mila's chat as Mastra gives it (evals/mastraChat.ts). Pure: no model, no
 * database, no Mastra runtime (only Mastra's own tool factory, never executed).
 *
 *   C1  the playbook tools' argument shapes are Mastra's own (@mastra/core/workspace createSkillTools): same names, same
 *       fields, same optional fields
 *   C2  the system text is the Mastra agent's instructions plus the chat surface's playbooks message
 */
jest.mock("../../db", () => ({ db: new Proxy({}, { get: () => { throw new Error("these tests never touch the database"); } }) }));

import { buildMilaInstructions } from "../mila/build";
import { MASTRA_SKILL_TOOLS, PLAYBOOKS_LEAD } from "../engine/mastra/skills";
import { MASTRA_SKILL_TOOL_ARGS, mastraChatSystem, mastraSkillTools } from "./mastraChat";
import { loadJob } from "../jobs";

const fields = (shape: Record<string, { isOptional(): boolean }>) =>
  Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, v.isOptional() ? "optional" : "required"]));

test("C1 the playbook tools' shapes are Mastra's own", async () => {
  const { createSkillTools } = await import("@mastra/core/workspace");
  const real = createSkillTools({} as never) as unknown as Record<string, { inputSchema: { shape: Record<string, { isOptional(): boolean }> } }>;
  expect(Object.keys(real).sort()).toEqual([...MASTRA_SKILL_TOOLS].sort());
  for (const name of MASTRA_SKILL_TOOLS) {
    expect([name, fields(MASTRA_SKILL_TOOL_ARGS[name].shape as never)]).toEqual([name, fields(real[name].inputSchema.shape)]);
  }
  expect(mastraSkillTools().map((t) => t.name)).toEqual([...MASTRA_SKILL_TOOLS]);
  expect(loadJob("chat").tools).not.toContain("get_playbook");   // went with TrueForge (Mastra-only PR 3)
});

test("C2 the system text: the Mastra agent's instructions, then the chat surface's playbooks", () => {
  const sys = mastraChatSystem(loadJob("chat").tools);
  expect(sys.startsWith(buildMilaInstructions({ surface: "chat", engine: "mastra" }).trimEnd())).toBe(true);
  expect(sys).toContain(PLAYBOOKS_LEAD);
  const listed = [...sys.matchAll(/^- ([a-z0-9-]+): /gm)].map((m) => m[1]);
  expect(listed).toEqual(expect.arrayContaining(["bookings", "deals", "documents", "onboarding", "public-page"]));
  expect(sys).not.toContain("get_playbook");
});
