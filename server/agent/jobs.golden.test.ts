/**
 * jobs.golden.test.ts — every job prompt the loader serves matches the committed golden (jobs/served.golden.json)
 * byte for byte: the same ids, and for each id the same front-matter fields (version, description, inputs, outputs,
 * effort, model tier, tools, limits), the same expanded instructions, the same full served text (instructionsFor) and
 * the same promptDigest.
 *
 * The golden was written from origin/main's loader BEFORE server/agent/skills/ moved to server/agent/jobs/ (2 Nov
 * 2026), so the move is proven to change no served byte. A deliberate text change regenerates it on purpose
 * (`npm run jobs:golden`, which stamps the generating git sha) in the same PR, with the Prompt Register entry; never to
 * make this test pass. Line endings are compared as LF (a Windows checkout has CRLF on disk), as the generator wrote.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearJobCache, instructionsFor, jobsDir, listJobs, loadJob, promptDigest } from "./jobs";

const golden = JSON.parse(readFileSync(join(jobsDir(), "served.golden.json"), "utf8")) as {
  generated_at: string;
  jobs: Record<string, Record<string, unknown> & { instructions: string; served_text: string; prompt_digest: string }>;
};
const lf = (s: string) => s.replace(/\r\n/g, "\n");

beforeAll(() => clearJobCache());

describe("every job prompt is served exactly as the golden records it", () => {
  test("the golden covers every job (chat and waitlist included) and nothing else", () => {
    expect(listJobs().map((j) => j.id)).toEqual(Object.keys(golden.jobs).sort((a, b) => a.localeCompare(b)));
    expect(Object.keys(golden.jobs)).toEqual(expect.arrayContaining(["chat", "waitlist", "research", "echo/health"]));
  });

  test.each(Object.keys(golden.jobs).map((id) => [id]))("%s: same fields, same text, same digest", (id) => {
    const job = loadJob(id);
    const served = { ...job, instructions: lf(job.instructions) };
    const { served_text, prompt_digest, ...fields } = golden.jobs[id];
    expect(served).toEqual(fields);
    expect(served.instructions).toBe(fields.instructions);
    expect(instructionsFor(served)).toBe(served_text);
    expect(promptDigest(served)).toBe(prompt_digest);
  });
});
