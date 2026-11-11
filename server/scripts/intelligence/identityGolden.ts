/**
 * identityGolden.ts — the Identity Intelligence golden-set harness (Concept 0.4 Part B, "Golden set"); reports the 0.2
 * brand platform (essence, positioning, pillars, narrative, the other synthesised concepts, and a summary of the rules
 * parts) for human rubric scoring.
 *
 * For each athlete id it calls the ADMIN recompute seam of a running service
 * (POST /api/v1/admin/intelligence/athletes/:id/identity-intelligence/recompute), so the provider call happens on that
 * service, where the flags and credentials live; this process opens no database connection and calls no provider.
 * It writes a JSON report for HUMAN rubric scoring: grounded · distinctive · her direction respected · tiers honoured ·
 * nothing excluded. It scores nothing itself.
 *
 *   NOMILA_ADMIN_TOKEN=<admin Firebase ID token> \
 *   npx tsx server/scripts/intelligence/identityGolden.ts --base-url https://<service> --ids <id>,<id>,… [options]
 *
 *   --ids a,b,c | --ids-file <path>   athlete ids (one per line in the file; # comments allowed)
 *   --force                           recompute even when the inputVersion is unchanged
 *   --out <path>                      report path (default ./identity-golden-<timestamp>.json)
 *
 * The token is read from the environment and never printed.
 */

import { readFileSync, writeFileSync } from "node:fs";

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
const flag = (name: string) => process.argv.includes(name);

function idsFrom(): string[] {
  const inline = arg("--ids");
  const file = arg("--ids-file");
  const raw = [...(inline ? inline.split(",") : []), ...(file ? readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.replace(/#.*/, "")) : [])];
  return [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
}

type Form = { short: string; long: string; strength: string; basis: number } | null;
type Text = { text: string; strength: string; basis: number } | null;

export interface GoldenRow {
  athleteId: string;
  status: number;
  outcome: string | null;
  contract: string | null;
  // (c) synthesis — what the model wrote
  essence: Form;
  positioning: { current: Form; desired: string | null };
  standsFor: Form;
  pillars: Array<{ label: string; definition: string; proof: number; strength: string; basis: number }>;
  differentiators: Array<NonNullable<Text>>;
  throughline: Form;
  chapters: { origin: Text; rise: Text; defining: Text; now: Text; next: string | null };
  athleticStyle: Text;
  origin: Text;
  values: string[];
  personality: string[];
  motivation: Text;
  communities: string[];
  mediaFraming: Text;
  imageGap: Text;
  // (a)/(b) rules parts, summarised
  rules: { proofPoints: string[]; signatureMoments: string[]; interests: string[]; causes: string[]; guardrails: number; voiceTone: string[] };
  direction: Array<{ value: string; athleteAuthored: boolean }>;
  unresolved: string[];
  tiers: Record<string, number>;
  sections: Record<string, number>;
  claimTiers: Record<string, number>;
  sufficiency: unknown;
  validation: unknown;
  reason: string | null;
  /** Filled in by the reviewer (1–5): grounded, distinctive, direction respected, tiers honoured, nothing excluded,
   *  her words used for motivation, perspective-neutral. */
  rubric: { grounded: null; distinctive: null; directionRespected: null; tiersHonoured: null; nothingExcluded: null; herWords: null; perspectiveNeutral: null; notes: "" };
}

/** Pure: the report row for one seam response (a 0.2 record). Exported for tests. */
export function goldenRow(athleteId: string, status: number, body: any): GoldenRow {
  const v = body?.value ?? null;
  const count = (xs: Array<Record<string, unknown>> | undefined, k: string) => (xs ?? []).reduce<Record<string, number>>((m, x) => { const key = String(x?.[k] ?? "?"); m[key] = (m[key] ?? 0) + 1; return m; }, {});
  const form = (f: any): Form => (f ? { short: f.short, long: f.long, strength: f.strength, basis: (f.basis ?? []).length } : null);
  const text = (t: any): Text => (t ? { text: t.text, strength: t.strength, basis: (t.basis ?? []).length } : null);
  const texts = (xs: any[] | undefined) => (xs ?? []).map((x: any) => x.text);
  const ch = v?.chapters ?? {};
  return {
    athleteId, status,
    outcome: body?.outcome ?? null,
    contract: v?.contract ?? null,
    essence: form(v?.essence),
    positioning: { current: form(v?.positioning?.current), desired: v?.positioning?.desired?.value ?? null },
    standsFor: form(v?.standsFor),
    pillars: (v?.pillars ?? []).map((p: any) => ({ label: p.label, definition: p.definition, proof: (p.proof ?? []).length, strength: p.strength, basis: (p.basis ?? []).length })),
    differentiators: (v?.differentiators ?? []).map((d: any) => text(d)!),
    throughline: form(v?.throughline),
    chapters: { origin: text(ch.origin), rise: text(ch.rise), defining: text(ch.defining), now: text(ch.now), next: ch.next?.text ?? null },
    athleticStyle: text(v?.athletic?.style),
    origin: text(v?.origin),
    values: texts(v?.values),
    personality: texts(v?.personality),
    motivation: text(v?.motivation),
    communities: texts(v?.communities),
    mediaFraming: text(v?.mediaFraming),
    imageGap: text(v?.imageGap),
    rules: {
      proofPoints: (v?.proofPoints ?? []).map((p: any) => `${p.kind}: ${p.text}`),
      signatureMoments: (v?.signatureMoments ?? []).map((p: any) => p.text),
      interests: texts(v?.interests), causes: texts(v?.causes),
      guardrails: (v?.guardrails ?? []).length, voiceTone: v?.voice?.observed?.tone ?? [],
    },
    direction: (v?.direction ?? []).map((d: any) => ({ value: d.value, athleteAuthored: !!d.athleteAuthored })),
    unresolved: (v?.unresolved ?? []).map((u: any) => u.question),
    tiers: count(v?.envelope, "tier"),
    sections: count(v?.envelope, "section"),
    claimTiers: count(v?.claims, "tier"),
    sufficiency: body?.sufficiency ?? null,
    validation: body?.validation ?? null,
    reason: body?.reason ?? body?.error ?? null,
    rubric: { grounded: null, distinctive: null, directionRespected: null, tiersHonoured: null, nothingExcluded: null, herWords: null, perspectiveNeutral: null, notes: "" },
  };
}

async function main() {
  const base = arg("--base-url");
  const token = process.env.NOMILA_ADMIN_TOKEN;
  const ids = idsFrom();
  if (!base || !token || !ids.length) {
    console.error("usage: NOMILA_ADMIN_TOKEN=… npx tsx server/scripts/intelligence/identityGolden.ts --base-url <url> --ids a,b | --ids-file f [--force] [--out f]");
    process.exit(2);
  }
  const root = `${base.replace(/\/+$/, "")}/api/v1/admin/intelligence/athletes`;
  const rows: GoldenRow[] = [];
  for (const id of ids) {
    const r = await fetch(`${root}/${id}/identity-intelligence/recompute`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ force: flag("--force") }),
    });
    const body = await r.json().catch(() => ({}));
    const row = goldenRow(id, r.status, body);
    rows.push(row);
    console.log(`${id}  ${r.status}  ${row.outcome ?? "-"}  ${row.essence?.long ?? row.essence?.short ?? "(no essence)"}`);
  }
  const out = arg("--out") ?? `identity-golden-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl: base, rows }, null, 2));
  console.log(`\nreport: ${out}`);
}

if (require.main === module) main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
