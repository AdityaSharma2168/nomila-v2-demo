/**
 * lifecycleHooks.test.ts — EXHAUSTIVENESS GUARDS for PR E2b (design record pr-e-identity-resolution-design.md §1.2
 * T1/T9, §5.4, D14). Static, like the acquisition registry guard: they read the source, so a NEW path that is not wired
 * fails CI before it can ship.
 *
 *   (a) entry points  every request handler that creates an athletes row or links a user to one (an insert, the
 *                     identity module's create / grandfather / claim-confirm / operator-decide helpers, or a
 *                     resolveIdentity "linked" branch) converges on enterLifecycleResearch — the one path to
 *                     startLifecycleResearch. Pinned per handler with its exact number of calls, so dropping one
 *                     branch's call fails too.
 *   (b) anchor writers every production UPDATE of athletes that can write an identity-anchor field (full_name,
 *                     first_name, last_name, sport — named, a computed key, or an opaque object) snapshots the anchor
 *                     (anchorFieldsBefore) right before and re-enters (reenterOnAnchorEdit → reenterIdentityResolution,
 *                     T9 / T7) right after.
 *
 * Each has an explicit SHRINK-ONLY allow-list of known exceptions with the reason. Adding an entry needs a reason a
 * reviewer accepts; the tests fail on a stale entry, so the list can only shrink silently, never grow.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const REPO = resolve(__dirname, "../../../..");
const posix = (p: string) => p.split(sep).join("/");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(posix(relative(REPO, p)));
  }
  return out;
}
/** Production server source: no tests, no one-off scripts, no test utilities / fixtures. */
const SERVER = walk(join(REPO, "server")).filter((f) => !/^server\/scripts\//.test(f) && !/testUtils|testFixtures/.test(f));
/** Source with comments blanked out (line numbers kept). */
function codeLines(f: string): string[] {
  const src = readFileSync(join(REPO, f), "utf8").replace(/\r\n/g, "\n")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1")                       // line comments first: a "/*" inside one opens nothing
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return src.split("\n");
}

// ── (a) entry points ──────────────────────────────────────────────────────────

/** A site that creates an athletes row or links a user to one. */
const ENTRY_MARKER = /\.insert\((?:schema\.)?athletes\)|\bcreateAthleteForUser\(|\bgrandfatherMembership\(|\.action === "linked"|\b(?:confirmClaim|decideClaim)\(/;
const ENTRY_CALL = /\benterLifecycleResearch\(/g;
const HANDLER = /^router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/;

/** Every request handler with an entry marker → the exact number of enterLifecycleResearch calls it must make. */
const ENTRY_POINTS: Record<string, { calls: number; what: string }> = {
  "server/routes/auth.ts POST /signup": { calls: 4, what: "index claim-link, index create, legacy e-mail claim, legacy create (the legacy name claim is gone: a name match only queues a proposed claim)" },
  "server/routes/auth.ts POST /microsoft": { calls: 3, what: "Microsoft claim-link, index create, legacy create (live: routed at /api/v1/auth, client button, secrets in both yamls)" },
  "server/routes/waitlist.ts POST /": { calls: 1, what: "the landing page's create / claim-link branches converge at the onboarding start (same guard: the sport is known)" },
  "server/routes/identityClaims.ts POST /claims/:id/confirm": { calls: 1, what: "\"Is this you?\" claim confirmation (linked)" },
  "server/routes/admin.ts POST /identity/claims/:id/decide": { calls: 1, what: "operator-approved claim (linked)" },
};
/** SHRINK-ONLY: markers that are deliberately NOT lifecycle entry points. */
const ENTRY_EXCEPTIONS: Record<string, string> = {
  "server/services/intelligence/identity/claims.ts (module)": "identity-module internal: createAthleteForUser's own insert; its callers are the route handlers pinned above",
};

/** handler key → { markers, calls } over the production server tree. */
function entrySites(): Map<string, { markers: number; calls: number }> {
  const out = new Map<string, { markers: number; calls: number }>();
  for (const f of SERVER) {
    let key = `${f} (module)`;
    for (const line of codeLines(f)) {
      const h = HANDLER.exec(line);
      if (h) key = `${f} ${h[1].toUpperCase()} ${h[2]}`;
      const isDef = /\b(?:async\s+)?function\s+(?:createAthleteForUser|grandfatherMembership|confirmClaim|decideClaim)\b/.test(line);
      const markers = !isDef && ENTRY_MARKER.test(line) && !/^\s*import\s/.test(line) ? 1 : 0;
      const calls = (line.match(ENTRY_CALL) ?? []).length;
      if (!markers && !calls) continue;
      const e = out.get(key) ?? { markers: 0, calls: 0 };
      e.markers += markers; e.calls += calls;
      out.set(key, e);
    }
  }
  return out;
}

describe("(a) every signup / claim entry point converges on enterLifecycleResearch", () => {
  const sites = entrySites();
  const withMarkers = [...sites].filter(([, v]) => v.markers > 0).map(([k]) => k);

  test("the scan sees the tree and the known entry points", () => {
    expect(SERVER.length).toBeGreaterThan(200);
    for (const k of Object.keys(ENTRY_POINTS)) expect(withMarkers).toContain(k);
  });

  test("no handler creates or links an athlete without being registered (a new path must be wired, or excepted with a reason)", () => {
    const unknown = withMarkers.filter((k) => !(k in ENTRY_POINTS) && !(k in ENTRY_EXCEPTIONS));
    expect(unknown).toEqual([]);
  });

  test("each registered entry point makes exactly its enterLifecycleResearch calls (one per branch)", () => {
    for (const [k, v] of Object.entries(ENTRY_POINTS)) expect({ k, calls: sites.get(k)?.calls ?? 0 }).toEqual({ k, calls: v.calls });
  });

  test("enterLifecycleResearch is called from nowhere else (excepted sites never call it); the allow-list has no stale entry", () => {
    const callers = [...sites].filter(([k, v]) => v.calls > 0 && !k.endsWith("lifecycleHooks.ts (module)")).map(([k]) => k).sort();
    expect(callers).toEqual(Object.keys(ENTRY_POINTS).sort());
    for (const k of Object.keys(ENTRY_EXCEPTIONS)) expect({ k, hasMarkers: (sites.get(k)?.markers ?? 0) > 0 }).toEqual({ k, hasMarkers: true });
  });

  test("the only path to startLifecycleResearch from production code is the hooks module", () => {
    const users = SERVER.filter((f) => !/research\/lifecycle(Hooks)?\.ts$/.test(f) && codeLines(f).some((l) => /\bstartLifecycleResearch\b/.test(l)));
    expect(users).toEqual([]);
  });
});

// ── (b) anchor writers ────────────────────────────────────────────────────────

const ANCHOR_FIELD = /\b(?:full_name|first_name|last_name|sport)\b/;
const OPAQUE_SET = /\.set\(\s*[A-Za-z_$][\w$]*\s*(?:as\s+any\s*)?\)/;
const COMPUTED_KEY = /\.set\(\s*\{\s*\[/;
const UPDATE_SITE = /\.update\((?:schema\.)?athletes\)|\bUPDATE\s+athletes\b(?!_)/;

interface AnchorSite { key: string; wired: boolean }
/** Every UPDATE of athletes whose SET clause can carry an anchor field, with whether it is wired before + after. */
function anchorSites(): AnchorSite[] {
  const out: AnchorSite[] = [];
  for (const f of SERVER) {
    const lines = codeLines(f);
    const seen = new Map<string, number>();
    lines.forEach((line, i) => {
      if (!UPDATE_SITE.test(line)) return;
      let end = i;
      while (end < lines.length - 1 && end < i + 20 && !/\.where\(/.test(lines[end])) end++;
      const clause = lines.slice(i, end + 1).join("\n");
      if (!(ANCHOR_FIELD.test(clause) || OPAQUE_SET.test(clause) || COMPUTED_KEY.test(clause))) return;
      const before = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
      const after = lines.slice(end, end + 3).join("\n");
      const wired = /\banchorFieldsBefore\(/.test(before) && /\breenterOnAnchorEdit\(/.test(after);
      const n = (seen.get(f) ?? 0) + 1; seen.set(f, n);
      out.push({ key: `${f} #${n}`, wired });
    });
  }
  return out;
}

/** Wired anchor writers, per file: the count is exact. */
const ANCHOR_WRITERS: Record<string, { sites: number; what: string }> = {
  "server/mila/onboarding.ts": { sites: 3, what: "recordAssertions (a sport correction), undoProfileWrite (put the sport back), clearAssertion (clear it)" },
  "server/routes/waitlist.ts": { sites: 1, what: "the landing page's COALESCE update of full_name / first_name / last_name / sport" },
};
/** SHRINK-ONLY: anchor-capable UPDATE sites deliberately not wired, with the reason. */
const ANCHOR_EXCEPTIONS: Record<string, string> = {
  "server/skills/researchAthlete.ts #1": "legacy research pipeline: fills sport ONLY when it is null, from its own findings — research must never re-open the identity it researched (circular); not an athlete or operator edit",
  "server/agent/onboarding/service.ts #1": "agent onboarding owns research for this athlete; legacy reenterOnAnchorEdit is retiring per the 9 Oct rebuild (startOnboarding fills an empty sport from what the athlete typed, then runs the new Research skill itself — it must not re-enter the legacy research lifecycle)",
  "server/services/affiliations.ts #1": "projectPrimary: `next` is only school / division / conference (the primary-team projection) — no anchor field; team changes reach the anchor through the affiliation ledger, which the planner's anchorHash check covers (T7)",
};

describe("(b) every production writer of an anchor field re-enters through reenterOnAnchorEdit (T9 / T7)", () => {
  const sites = anchorSites();

  test("the scan finds the known writers", () => {
    for (const f of Object.keys(ANCHOR_WRITERS)) expect(sites.some((s) => s.key.startsWith(`${f} #`))).toBe(true);
  });

  test("every anchor-capable UPDATE is wired (snapshot right before, re-entry right after) or excepted with a reason", () => {
    const unwired = sites.filter((s) => !s.wired && !(s.key in ANCHOR_EXCEPTIONS)).map((s) => s.key);
    expect(unwired).toEqual([]);
  });

  test("wired writers per file are exact, and no excepted site exists that is not anchor-capable (no stale exception)", () => {
    for (const [f, v] of Object.entries(ANCHOR_WRITERS)) expect({ f, wired: sites.filter((s) => s.key.startsWith(`${f} #`) && s.wired).length }).toEqual({ f, wired: v.sites });
    const wiredFiles = new Set(sites.filter((s) => s.wired).map((s) => s.key.replace(/ #\d+$/, "")));
    expect([...wiredFiles].sort()).toEqual(Object.keys(ANCHOR_WRITERS).sort());
    for (const k of Object.keys(ANCHOR_EXCEPTIONS)) expect({ k, present: sites.some((s) => s.key === k && !s.wired) }).toEqual({ k, present: true });
  });

  test("reenterIdentityResolution is reached from production code only through the hooks module and the planner", () => {
    const users = SERVER.filter((f) => !/research\/(lifecycle|lifecycleHooks|planner)\.ts$/.test(f) && codeLines(f).some((l) => /\breenterIdentityResolution\b/.test(l)));
    expect(users).toEqual([]);
  });
});
