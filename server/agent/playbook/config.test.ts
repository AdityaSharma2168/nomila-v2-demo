/**
 * config.test.ts — PLAYBOOK.FAILURE_BACKOFF_DAYS is floored at 1, so a fractional or zero env override can never
 * back a key off for no time at all (review fix, PR #929).
 */
import { PLAYBOOK } from "./config";

const saved = process.env.AGENT_PLAYBOOK_FAILURE_BACKOFF_DAYS;
afterEach(() => { if (saved === undefined) delete process.env.AGENT_PLAYBOOK_FAILURE_BACKOFF_DAYS; else process.env.AGENT_PLAYBOOK_FAILURE_BACKOFF_DAYS = saved; });

describe("PLAYBOOK.FAILURE_BACKOFF_DAYS", () => {
  it("defaults to 3", () => {
    delete process.env.AGENT_PLAYBOOK_FAILURE_BACKOFF_DAYS;
    expect(PLAYBOOK.FAILURE_BACKOFF_DAYS).toBe(3);
  });
  it("respects a whole-day override", () => {
    process.env.AGENT_PLAYBOOK_FAILURE_BACKOFF_DAYS = "7";
    expect(PLAYBOOK.FAILURE_BACKOFF_DAYS).toBe(7);
  });
  it("floors a fractional override at 1, never 0", () => {
    process.env.AGENT_PLAYBOOK_FAILURE_BACKOFF_DAYS = "0.5";
    expect(PLAYBOOK.FAILURE_BACKOFF_DAYS).toBe(1);
  });
  it("a zero or negative override falls back to the default (positive()'s own guard), not to 0", () => {
    process.env.AGENT_PLAYBOOK_FAILURE_BACKOFF_DAYS = "0";
    expect(PLAYBOOK.FAILURE_BACKOFF_DAYS).toBe(3);
    process.env.AGENT_PLAYBOOK_FAILURE_BACKOFF_DAYS = "-5";
    expect(PLAYBOOK.FAILURE_BACKOFF_DAYS).toBe(3);
  });
});
