/**
 * jobs.guard.test.ts — job prompts and Mila's skills stay apart.
 *
 *   server/agent/jobs/<id>.md                  job prompts (and waitlist.md; chat.yaml, Mila's definition), served by jobs.ts loadJob
 *   server/agent/mila/skills/<name>/SKILL.md   Mila's playbooks, served by mila/load.ts readSkill (Mastra's skill tool)
 *
 * Nothing under mila/skills is a job (no file there parses or loads as one), and nothing under jobs/ is loadable as a
 * Mila skill (the Mila skill loader and loadPlaybook only ever read mila/skills, and jobs/ holds no skill folder).
 * Two names exist on both sides (onboarding, waitlist): the guard is by location, never by name.
 */
jest.mock("../db", () => ({ db: {} }));   // nothing here touches the db module

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { JOB_ID_RE, jobsDir, listJobs, loadJob, parseJob } from "./jobs";
import { MILA_DIR, SKILLS_SUBDIR, SKILL_FILE, SIDECAR_FILE, listSkillNames, readSkill, skillPath } from "./mila/load";
import { loadPlaybook } from "./engine/tools/playbooks";

const JOBS = resolve(jobsDir());
const MILA_SKILLS = resolve(MILA_DIR, SKILLS_SUBDIR);
const inside = (child: string, parent: string) => { const r = relative(parent, resolve(child)); return r === "" || (!r.startsWith("..") && !r.startsWith(sep) && !/^[A-Za-z]:/.test(r)); };
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

describe("job prompts and Mila's skills are two separate folders", () => {
  test("neither folder contains the other", () => {
    expect(existsSync(JOBS)).toBe(true);
    expect(existsSync(MILA_SKILLS)).toBe(true);
    expect(inside(JOBS, MILA_SKILLS)).toBe(false);
    expect(inside(MILA_SKILLS, JOBS)).toBe(false);
  });
});

describe("nothing under mila/skills is a job", () => {
  const milaFiles = walk(MILA_SKILLS).filter((f) => f.endsWith(".md"));

  test("there are Mila skill files to check", () => {
    expect(milaFiles.length).toBeGreaterThan(0);
  });

  test.each(milaFiles.map((f) => [relative(MILA_DIR, f).split(sep).join("/"), f]))("%s does not parse as a job prompt", (_rel, f) => {
    expect(() => parseJob(readFileSync(f, "utf8"))).toThrow();
  });

  test("no job the loader lists lives under mila/skills, and no job id reaches it", () => {
    for (const { id } of listJobs()) expect(inside(join(JOBS, ...id.split("/")) + ".md", MILA_SKILLS)).toBe(false);
    for (const name of listSkillNames()) {
      // the id a Mila skill file would need to be loaded as a job is not a valid job id (SKILL is upper case), and
      // the nearest valid spelling does not exist under jobs/
      expect(JOB_ID_RE.test(`mila/skills/${name}/SKILL`)).toBe(false);
      expect(() => loadJob(`mila/skills/${name}/skill`)).toThrow(/unknown skill/);
    }
    expect(() => loadJob("../mila/skills/deals/SKILL")).toThrow(/invalid skill id/);
  });
});

describe("nothing under jobs/ is loadable as a Mila skill", () => {
  test("jobs/ holds no skill folder: no SKILL.md and no nomila.yaml anywhere", () => {
    const names = walk(JOBS).map((f) => f.split(sep).pop());
    expect(names).not.toContain(SKILL_FILE);
    expect(names).not.toContain(SIDECAR_FILE);
  });

  test("the Mila skill loader, even pointed at the jobs folder's parent layout, finds no skill there", () => {
    expect(listSkillNames(JOBS)).toEqual([]);
  });

  test("every Mila skill the loader lists resolves under mila/skills, never under jobs/", () => {
    const names = listSkillNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(inside(skillPath(name), MILA_SKILLS)).toBe(true);
      expect(inside(skillPath(name), JOBS)).toBe(false);
    }
  });

  test("loadPlaybook serves only mila/skills names: a job id that is not also a playbook name is refused", () => {
    const playbooks = new Set(listSkillNames());
    const jobOnly = listJobs().map((j) => j.id).filter((id) => !playbooks.has(id));
    expect(jobOnly).toEqual(expect.arrayContaining(["chat", "research", "plan", "playbook", "echo/health"]));
    for (const id of jobOnly) expect(() => loadPlaybook(id)).toThrow();
  });

  test("a name on both sides (onboarding) is served from mila/skills, not from the job prompt", () => {
    const p = loadPlaybook("onboarding");
    expect(p.text).toBe(readSkill("onboarding").replace(/\r\n/g, "\n"));
    expect(p.text.trim()).not.toBe(loadJob("onboarding").instructions.replace(/\r\n/g, "\n").trim());
  });
});
