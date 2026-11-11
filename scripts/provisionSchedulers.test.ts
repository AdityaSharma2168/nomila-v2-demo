/**
 * provisionSchedulers.test.ts — scripts/provision-schedulers.sh driven with a stub `gcloud` first on PATH (PR 20,
 * docs/probes/ship.md, ADI-S20-SCHED). The stub serves a 64-character secret stored with a CRLF ending, as
 * INTERNAL_CRON_SECRET really is, and records every call; nothing reaches Google.
 *
 * ⚠️ MUTATIONS (docs/probes/ship.md, ADI-S20-SCHED): M-only — the ONLY filter removed: "ONLY=studio- touches the three
 * studio jobs and no other" reds; M-format — `--format=none` dropped from update: "every create and update runs with
 * --format=none" reds; M-strip — the `tr -d '[:space:]'` removed: "the secret reaches gcloud without its CRLF" reds.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(__dirname, "provision-schedulers.sh");
const SECRET = "a".repeat(40) + "b".repeat(24); // 64 chars, as the script requires

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Run the script with a stub gcloud. `existing` names jobs `describe` reports as present. */
function run(env: Record<string, string>, existing: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "provision-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "existing"), existing.join("\n") + "\n");
  writeFileSync(
    join(bin, "gcloud"),
    `#!/bin/bash\n` +
      `if [ "$1 $2 $3" = "secrets versions access" ]; then printf '${SECRET}\\r\\n'; exit 0; fi\n` +
      `if [ "$1 $2 $3" = "scheduler jobs describe" ]; then grep -qx "$4" "${dir}/existing"; exit $?; fi\n` +
      `printf '%s\\n' "$@" > "${dir}/call-$(ls "${dir}" | grep -c '^call-')"\n`,
  );
  chmodSync(join(bin, "gcloud"), 0o755);
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { NODE_ENV: "test", PATH: `${bin}:${process.env.PATH}`, ...env },
  });
  const calls: string[][] = [];
  for (let i = 0; existsSync(join(dir, `call-${i}`)); i++)
    calls.push(
      readFileSync(join(dir, `call-${i}`), "utf8")
        .trimEnd()
        .split("\n"),
    );
  return { status: r.status, out: r.stdout + r.stderr, calls };
}
const nameOf = (call: string[]) => call[4];
const header = (call: string[]) =>
  call.find(
    (a) => a.startsWith("--headers=") || a.startsWith("--update-headers="),
  ) ?? "";

describe("ONLY=<prefix>: a subset run touches nothing else (ADI-S20-SCHED)", () => {
  it("ONLY=studio- touches the three studio jobs and no other", () => {
    const r = run({ APPLY: "1", ONLY: "studio-" }, ["studio-video-tick"]);
    expect(r.status).toBe(0);
    expect(r.calls.map(nameOf).sort()).toEqual([
      "studio-edit-tick",
      "studio-stitch-tick",
      "studio-video-tick",
    ]);
    expect(r.calls.map((c) => `${c[2]} ${c[4]}`).sort()).toEqual([
      "create studio-edit-tick",
      "create studio-stitch-tick",
      "update studio-video-tick",
    ]);
  });

  it("without ONLY every declared job is applied, as before", () => {
    const r = run({ APPLY: "1" });
    expect(r.calls.map(nameOf)).toContain("inbox-cron-sync");
    expect(r.calls.map(nameOf)).toContain("research-planner");
    expect(r.calls.map(nameOf)).toContain("shopify-reconcile-cron");
    expect(r.calls.map(nameOf)).toContain("booking-session-cron");
    expect(r.calls.map(nameOf)).toContain("bookings-cron");
    expect(r.calls.map(nameOf)).toContain("partner-intake-cron");
    expect(r.calls.map(nameOf)).toContain("plan-refresh-cron");
    expect(r.calls.map(nameOf)).toContain("moments-scan-cron");
    expect(r.calls.map(nameOf)).toContain("post-ideas-cron");
    expect(r.calls.map(nameOf)).toContain("playbook-refresh-cron");
    expect(r.calls.map(nameOf)).toContain("post-kit-preview-cleanup-cron");
    expect(r.calls.map(nameOf)).toContain("email-code-purge-cron");
    expect(r.calls).toHaveLength(24); // eight declared before PR 20, the agent research refresh's daily sweep, the three studio ticks, the Shopify reconcile (her picks), the bookings clock, the Partner door sweep, the booking session sweep, the plan step's daily sweep, the moments scan's daily sweep, the post-kit ideas pass, the shared playbook's daily staleness check, the post-kit preview clean-up, the email-code purge, the push receipts check, the agent spend report
  });

  it("the email-code purge runs hourly at :35 against its endpoint, with a 60s deadline", () => {
    const r = run({ APPLY: "1", ONLY: "email-code-purge-cron" });
    expect(r.calls.map(nameOf)).toEqual(["email-code-purge-cron"]);
    expect(r.calls[0]).toEqual(expect.arrayContaining(["--schedule=35 * * * *", "--attempt-deadline=60s"]));
    expect(r.calls[0].some((a) => a.startsWith("--uri=") && a.endsWith("/api/internal/email-code-purge-cron"))).toBe(true);
    expect(header(r.calls[0])).toBe(`--headers=x-cron-secret=${SECRET},Content-Type=application/json`);
  });

  it("the post-kit preview clean-up runs daily at 03:30 UTC against its endpoint, with a 300s deadline", () => {
    const r = run({ APPLY: "1", ONLY: "post-kit-preview-cleanup-cron" });
    expect(r.calls.map(nameOf)).toEqual(["post-kit-preview-cleanup-cron"]);
    expect(r.calls[0]).toEqual(expect.arrayContaining(["--schedule=30 3 * * *", "--attempt-deadline=300s"]));
    expect(r.calls[0].some((a) => a.startsWith("--uri=") && a.endsWith("/api/internal/post-kit-preview-cleanup-cron"))).toBe(true);
    expect(header(r.calls[0])).toBe(`--headers=x-cron-secret=${SECRET},Content-Type=application/json`);
  });

  it("the moments scan's sweep runs daily at 12:00 UTC — first of moments → post ideas → plan — against its endpoint, with a 300s deadline", () => {
    const r = run({ APPLY: "1", ONLY: "moments-scan-cron" });
    expect(r.calls.map(nameOf)).toEqual(["moments-scan-cron"]);
    expect(r.calls[0]).toEqual(expect.arrayContaining(["--schedule=0 12 * * *", "--attempt-deadline=300s"]));
    expect(r.calls[0].some((a) => a.startsWith("--uri=") && a.endsWith("/api/internal/moments-scan-cron"))).toBe(true);
    expect(header(r.calls[0])).toBe(`--headers=x-cron-secret=${SECRET},Content-Type=application/json`);
  });

  it("the post-kit ideas pass runs daily at 13:00 UTC (after the moments scan, ahead of the plan sweep) against its endpoint, with a 300s deadline", () => {
    const r = run({ APPLY: "1", ONLY: "post-ideas-cron" });
    expect(r.calls.map(nameOf)).toEqual(["post-ideas-cron"]);
    expect(r.calls[0]).toEqual(expect.arrayContaining(["--schedule=0 13 * * *", "--attempt-deadline=300s"]));
    expect(r.calls[0].some((a) => a.startsWith("--uri=") && a.endsWith("/api/internal/post-ideas-cron"))).toBe(true);
    expect(header(r.calls[0])).toBe(`--headers=x-cron-secret=${SECRET},Content-Type=application/json`);
  });

  it("the daily order holds: moments 12:00 → post ideas 13:00 → plan 14:00 (each reads what the one before wrote)", () => {
    const r = run({ APPLY: "1" });
    const hourOf = (name: string) => Number(/^--schedule=0 (\d+) \* \* \*$/.exec(r.calls.find((c) => nameOf(c) === name)!.find((a) => a.startsWith("--schedule="))!)![1]);
    expect([hourOf("moments-scan-cron"), hourOf("post-ideas-cron"), hourOf("plan-refresh-cron")]).toEqual([12, 13, 14]);
  });

  it("the plan step's sweep runs daily at 14:00 UTC against its endpoint, with a 300s deadline", () => {
    const r = run({ APPLY: "1", ONLY: "plan-refresh-cron" });
    expect(r.calls.map(nameOf)).toEqual(["plan-refresh-cron"]);
    expect(r.calls[0]).toEqual(expect.arrayContaining(["--schedule=0 14 * * *", "--attempt-deadline=300s"]));
    expect(r.calls[0].some((a) => a.startsWith("--uri=") && a.endsWith("/api/internal/plan-refresh-cron"))).toBe(true);
    expect(header(r.calls[0])).toBe(`--headers=x-cron-secret=${SECRET},Content-Type=application/json`);
  });

  it("the shared playbook's staleness check runs DAILY at 11:00 UTC against its endpoint, with a 1800s deadline (review fix: a monthly cron on the 1st silently skipped keys — PR #929)", () => {
    const r = run({ APPLY: "1", ONLY: "playbook-refresh-cron" });
    expect(r.calls.map(nameOf)).toEqual(["playbook-refresh-cron"]);
    expect(r.calls[0]).toEqual(expect.arrayContaining(["--schedule=0 11 * * *", "--attempt-deadline=1800s"]));
    expect(r.calls[0].some((a) => a.startsWith("--uri=") && a.endsWith("/api/internal/playbook-refresh-cron"))).toBe(true);
    expect(header(r.calls[0])).toBe(`--headers=x-cron-secret=${SECRET},Content-Type=application/json`);
  });

  it("the -prod suffix applies after the filter: ONLY=studio- with JOB_SUFFIX=-prod names the three -prod jobs", () => {
    const r = run({ APPLY: "1", ONLY: "studio-", JOB_SUFFIX: "-prod" });
    expect(r.calls.map(nameOf).sort()).toEqual([
      "studio-edit-tick-prod",
      "studio-stitch-tick-prod",
      "studio-video-tick-prod",
    ]);
  });
});

describe("what reaches gcloud", () => {
  it("every create and update runs with --format=none — gcloud never echoes the header back", () => {
    const r = run({ APPLY: "1" }, ["inbox-cron-sync", "workflow-tick"]);
    expect(
      r.calls.filter((c) => !c.includes("--format=none")).map(nameOf),
    ).toEqual([]);
  });

  it("the secret reaches gcloud without its CRLF", () => {
    const r = run({ APPLY: "1", ONLY: "studio-stitch" });
    expect(header(r.calls[0])).toBe(
      `--headers=x-cron-secret=${SECRET},Content-Type=application/octet-stream`,
    );
  });

  it("the studio jobs carry application/octet-stream; every other job keeps application/json", () => {
    const r = run({ APPLY: "1" });
    const byType = (t: string) =>
      r.calls
        .filter((c) => header(c).endsWith(`Content-Type=${t}`))
        .map(nameOf)
        .sort();
    expect(byType("application/octet-stream")).toEqual([
      "studio-edit-tick",
      "studio-stitch-tick",
      "studio-video-tick",
    ]);
    expect(byType("application/json")).toHaveLength(21);
    expect(byType("application/json")).toContain("email-code-purge-cron");
    expect(byType("application/json")).toContain("shopify-reconcile-cron");
    expect(byType("application/json")).toContain("plan-refresh-cron");
    expect(byType("application/json")).toContain("moments-scan-cron");
    expect(byType("application/json")).toContain("post-ideas-cron");
    expect(byType("application/json")).toContain("playbook-refresh-cron");
  });

  it("the dry run calls nothing and never prints the secret", () => {
    const r = run({ ONLY: "studio-" });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("WOULD RUN");
    expect(r.out).not.toContain(SECRET);
  });
});
