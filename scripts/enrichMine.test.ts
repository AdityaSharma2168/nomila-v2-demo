/**
 * enrichMine.test.ts — tools/enrich/enrich-mine.sh, driven end to end with a stub psql and a stub curl (PR 20,
 * docs/probes/ship.md item 7, ADI-S20-GO). Nothing here reaches a database or a server: the stubs record what the script
 * asked and answer canned replies. (jest's roots are server/, scripts/ and client/, so the tool's test lives here.)
 *
 * ⚠️ MUTATIONS (docs/probes/ship.md, item 7): M-body — the body's athleteId dropped: "every request carries her
 * athleteId…" reds; M-url — the localhost guard removed: "refuses a non-local server URL" reds; M-secret — the secret
 * passed on curl's argv: "the secret never reaches argv or stdout" reds.
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

import {
  VIDEO_OUTPUT_TOKENS_FLAT,
  VIDEO_OUTPUT_TOKENS_PER_SECOND,
  VIDEO_PROMPT_TOKENS,
  VIDEO_TOKENS_PER_SECOND,
  VIDEO_ASSUMED_SECONDS,
  videoEnrichUsdPerInputToken,
  videoEnrichUsdPerOutputToken,
} from "../server/studio/enrich/config";
import { RETAG_USD_PER_ROW } from "../server/studio/enrich/retag";

jest.mock("../server/db", () => ({ db: {} }));

const SCRIPT = join(__dirname, "..", "tools", "enrich", "enrich-mine.sh");
const ME = "11111111-2222-4333-8444-555555555555";
const SECRET = "sekrit-cron-7731";
const DB_PASSWORD = "pw-for-the-db-9902";

type Opts = {
  args: string[];
  input?: string;
  lookup?: string; // what psql answers for the email lookup
  counts?: string; // photos|clips|seconds|setdown
  replies?: string[]; // curl answers, in order: "<json>\n<http code>"
  cap?: string | null;
  crlf?: boolean; // write the fixture env file with CRLF line endings
  slowPython?: boolean; // a python3 that takes > 1 s, so time passes between reading the counts and printing them
};
const REAL_PYTHON = spawnSync("bash", ["-c", "command -v python3"], {
  encoding: "utf8",
}).stdout.trim();

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * One run of the script against a fixture env file (NOT named .env) and stub `psql` / `curl` first on PATH. The result's
 * `exits(code)` asserts the exit status and, on a mismatch, re-runs the same case with ENRICH_MINE_TRACE=1 and fails
 * with the output and the trace — so a silent exit reads in jest's own report (ADI-S20-HOLD1).
 */
function run(o: Opts, trace = false) {
  const dir = mkdtempSync(join(tmpdir(), "enrich-mine-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const env = [
    `DATABASE_URL=postgresql://u:${DB_PASSWORD}@127.0.0.1:5440/nomila_v2`,
    `INTERNAL_CRON_SECRET=${SECRET}`,
    ...(o.cap === null ? [] : [`STUDIO_ENRICH_DAILY_CAP_USD=${o.cap ?? "5"}`]),
  ].join("\n");
  writeFileSync(
    join(dir, "fixture.env"),
    o.crlf ? env.split("\n").join("\r\n") + "\r\n" : env + "\n",
  );
  writeFileSync(join(dir, "lookup"), o.lookup ?? ME);
  writeFileSync(join(dir, "counts"), o.counts ?? "3|2|10|1");
  (o.replies ?? []).forEach((r, i) =>
    writeFileSync(join(dir, `reply-${i}`), r),
  );
  // psql: record stdin and PGOPTIONS, answer the lookup or the counts by what was asked.
  writeFileSync(
    join(bin, "psql"),
    `#!/bin/bash\nSQL="$(cat)"\necho "$SQL" >> "${dir}/psql.log"\necho "PGOPTIONS=$PGOPTIONS" >> "${dir}/psql.log"\n` +
      `if echo "$SQL" | grep -q 'from athletes'; then cat "${dir}/lookup"; else cat "${dir}/counts"; fi\n`,
  );
  // curl: record argv and the header file, answer the next canned reply.
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/bash\nN=$(ls "${dir}"/call-* 2>/dev/null | wc -l | tr -d ' ')\n` +
      `printf '%s\\n' "$@" > "${dir}/call-$N"\n` +
      `for a in "$@"; do case "$a" in @*) cat "\${a#@}" >> "${dir}/headers";; esac; done\n` +
      `if [ -f "${dir}/reply-$N" ]; then cat "${dir}/reply-$N"; else printf '{"ok":true,"remaining":0,"tagged":0}\\n200'; fi\n`,
  );
  if (o.slowPython) {
    writeFileSync(
      join(bin, "python3"),
      `#!/bin/bash\nsleep 1.2\nexec "${REAL_PYTHON}" "$@"\n`,
    );
    chmodSync(join(bin, "python3"), 0o755);
  }
  chmodSync(join(bin, "psql"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  const r = spawnSync("bash", [SCRIPT, ...o.args], {
    input: o.input ?? "",
    encoding: "utf8",
    env: {
      NODE_ENV: "test",
      PATH: `${bin}:${process.env.PATH}`,
      ENV_FILE: join(dir, "fixture.env"),
      ...(trace ? { ENRICH_MINE_TRACE: "1" } : {}),
    },
  });
  const calls: string[] = [];
  for (let i = 0; existsSync(join(dir, `call-${i}`)); i++)
    calls.push(readFileSync(join(dir, `call-${i}`), "utf8"));
  const read = (f: string) =>
    existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "";
  const out = r.stdout + r.stderr;
  return {
    status: r.status,
    stdout: r.stdout,
    out,
    calls,
    headers: read("headers"),
    psql: read("psql.log"),
    exits(code: number, says?: RegExp) {
      if (r.status === code && (!says || says.test(out))) return;
      const t = trace ? { out } : run(o, true);
      throw new Error(
        `enrich-mine exited ${r.status}, expected ${code}${says ? ` saying ${says}` : ""}\n--- output ---\n${out}\n--- trace (ENRICH_MINE_TRACE=1) ---\n${t.out}`,
      );
    },
  };
}
const reply = (o: Record<string, unknown>, code = 200) =>
  `${JSON.stringify({ ok: true, tagged: 0, embedded: 0, failed: 0, ...o })}\n${code}`;

describe("it refuses before it sends anything", () => {
  it("refuses to run without one athlete", () => {
    const r = run({ args: [] });
    r.exits(1, /refusing to run without one athlete/);
    expect(r.calls).toEqual([]);
  });

  it.each([
    "https://api-dev.nomila.co",
    "http://10.0.0.5:8080",
    "http://localhost.evil.com",
  ])("refuses a non-local server URL: %s", (url) => {
    const r = run({ args: ["--athlete", ME, "--url", url], input: "y\n" });
    r.exits(1, /refusing a non-local server URL/);
    expect(r.calls).toEqual([]);
  });

  it.each([
    ["no athlete", ""],
    ["two athletes", `${ME}\n${ME.replace("1111", "9999")}`],
  ])(
    "refuses an email that does not name exactly one athlete: %s",
    (_n, lookup) => {
      const r = run({
        args: ["--email", "x@example.com"],
        lookup,
        input: "y\n",
      });
      r.exits(1, /expected exactly one athlete/);
      expect(r.calls).toEqual([]);
    },
  );

  it("refuses to trace against the real ./.env — a trace prints the secret", () => {
    const r = spawnSync("bash", [SCRIPT, "--athlete", ME, "--dry-run"], {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        ENRICH_MINE_TRACE: "1",
      },
    });
    expect({ status: r.status, err: r.stderr }).toEqual({
      status: 1,
      err: expect.stringMatching(/refusing to trace against .*\/\.env/),
    });
  });

  it("refuses something that is not an athlete id", () => {
    const r = run({ args: ["--athlete", "1 or 1=1"], input: "y\n" });
    r.exits(1);
    expect(r.calls).toEqual([]);
  });

  it("the lookups and counts are read-only and bound by psql, her email never spliced into SQL", () => {
    const r = run({ args: ["--email", "o'brien@example.com", "--dry-run"] });
    r.exits(0);
    expect(r.psql).toContain("default_transaction_read_only=on");
    expect(r.psql).toContain("lower(:'email')");
    expect(r.psql).not.toContain("o'brien");
  });
});

describe("the dry run: counts, quote and cap, and nothing sent", () => {
  it("prints the three counts, the quote and the cap in effect, and sends nothing", () => {
    const r = run({ args: ["--athlete", ME, "--dry-run"], counts: "3|2|10|1" });
    r.exits(0, /photos left\s+3/);
    expect(r.out).toMatch(/clips left\s+2\s+\(10 s/);
    expect(r.out).toMatch(/set down\s+1/);
    // 3 × 0.0049 + 2 × 0.00465 + 10 × 0.000558 = 0.02958
    expect(r.out).toMatch(/quote\s+≈ \$0\.0296/);
    expect(r.out).toMatch(/STUDIO_ENRICH_DAILY_CAP_USD=5/);
    expect(r.out).toMatch(/dry run — nothing sent/);
    expect(r.calls).toEqual([]);
  });

  it("the clip seconds print as counted even when a second passes first — never bash's self-incrementing SECONDS", () => {
    const r = run({
      args: ["--athlete", ME, "--dry-run"],
      counts: "3|2|10|1",
      slowPython: true,
    });
    r.exits(0, /clips left\s+2\s+\(10 s;/);
  });

  it("warns loudly when no daily cap is set", () => {
    const r = run({ args: ["--athlete", ME, "--dry-run"], cap: null });
    expect(r.out).toMatch(/STUDIO_ENRICH_DAILY_CAP_USD IS NOT SET/);
  });

  it("answering anything but y sends nothing", () => {
    const r = run({ args: ["--athlete", ME], input: "n\n" });
    expect(r.out).toMatch(/nothing sent/);
    expect(r.calls).toEqual([]);
  });
});

describe("the loop", () => {
  it("every request carries her athleteId and maxTicks 1, and it runs until nothing remains", () => {
    const r = run({
      args: ["--athlete", ME],
      input: "y\n",
      replies: [
        reply({ tagged: 5, embedded: 5, remaining: 4 }),
        reply({ tagged: 4, embedded: 4, remaining: 0 }),
      ],
    });
    r.exits(0);
    expect(r.calls).toHaveLength(2);
    for (const c of r.calls) {
      expect(c).toContain(`{"athleteId":"${ME}","maxTicks":1}`);
      expect(c).toContain(
        "http://localhost:8080/api/internal/media-enrich-cron",
      );
    }
    expect(r.out).toMatch(
      /pass 1: tagged 5, embedded 5, failed 0, remaining 4/,
    );
    expect(r.out).toMatch(/done — nothing left for this athlete/);
  });

  it("the secret never reaches argv or stdout — only the 0600 header file curl reads", () => {
    const r = run({
      args: ["--athlete", ME],
      input: "y\n",
      replies: [reply({ remaining: 0 })],
    });
    expect(r.headers).toContain(`x-cron-secret: ${SECRET}`);
    expect(r.calls.join("\n")).not.toContain(SECRET);
    expect(r.out).not.toContain(SECRET);
    expect(r.out).not.toContain(DB_PASSWORD);
  });

  it("a .env saved with CRLF line endings: the header carries the secret without its \\r (ADI-S20-SCHED)", () => {
    const r = run({
      args: ["--athlete", ME],
      input: "y\n",
      replies: [reply({ remaining: 0 })],
      crlf: true,
    });
    r.exits(0);
    expect(r.headers).toContain(`x-cron-secret: ${SECRET}\n`);
    expect(r.headers).not.toContain("\r");
  });

  it("stops on a pass that makes no progress while rows remain — the cap, seen from outside", () => {
    const r = run({
      args: ["--athlete", ME],
      input: "y\n",
      replies: [
        reply({ remaining: 3 }),
        reply({ remaining: 3 }),
        reply({ remaining: 3 }),
      ],
    });
    r.exits(1, /no progress with 3 left/);
    expect(r.calls).toHaveLength(2);
  });

  it("stops on an HTTP error and on a failed row", () => {
    const http = run({
      args: ["--athlete", ME],
      input: "y\n",
      replies: [reply({}, 500)],
    });
    http.exits(1, /HTTP 500 — stopping/);
    const failed = run({
      args: ["--athlete", ME],
      input: "y\n",
      replies: [
        reply({ tagged: 1, failed: 1, remaining: 2 }),
        reply({ remaining: 0 }),
      ],
    });
    failed.exits(1, /1 failed — stopping/);
    expect(failed.calls).toHaveLength(1);
  });
});

describe("the quote uses the code's own figures", () => {
  const constant = (name: string) => {
    const m = readFileSync(SCRIPT, "utf8").match(
      new RegExp(`^${name}="([0-9.]+)"`, "m"),
    );
    return m ? Number(m[1]) : NaN;
  };

  it("a photo: one tag (retag.ts) plus one embed ($0.0001, qa/cost.ts's default)", () => {
    expect(constant("PHOTO_USD")).toBeCloseTo(RETAG_USD_PER_ROW + 0.0001, 10);
  });

  it("a clip: enrich/config.ts's token counts at its rates, and 60 s for an unmeasured clip", () => {
    const inRate = videoEnrichUsdPerInputToken();
    const outRate = videoEnrichUsdPerOutputToken();
    expect(constant("CLIP_FIXED_USD")).toBeCloseTo(
      VIDEO_PROMPT_TOKENS * inRate + VIDEO_OUTPUT_TOKENS_FLAT * outRate,
      10,
    );
    expect(constant("CLIP_PER_SEC_USD")).toBeCloseTo(
      VIDEO_TOKENS_PER_SECOND * inRate +
        VIDEO_OUTPUT_TOKENS_PER_SECOND * outRate,
      10,
    );
    expect(readFileSync(SCRIPT, "utf8")).toMatch(
      new RegExp(`^UNKNOWN_CLIP_SECONDS=${VIDEO_ASSUMED_SECONDS}$`, "m"),
    );
  });
});
