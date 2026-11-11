/**
 * verifier.test.ts — the check-before-deliver eval, offline (CI): good artifacts pass and bad ones fail with exactly
 * the checks expected, every kind and every check covered. Recorded ffprobe output, no binary, no model, no database.
 */
import { verifyDeliverable, VERIFY_CHECKS, type DeliverableKind } from "../../../services/verify/deliverable";
import { VERIFIER_CASES } from "./verifier.cases";

test("cases: unique ids; every kind has a good and a bad artifact", () => {
  expect(new Set(VERIFIER_CASES.map((c) => c.id)).size).toBe(VERIFIER_CASES.length);
  for (const kind of Object.keys(VERIFY_CHECKS) as DeliverableKind[]) {
    const mine = VERIFIER_CASES.filter((c) => c.kind === kind);
    expect([kind, mine.some((c) => c.expect.ok), mine.some((c) => !c.expect.ok)]).toEqual([kind, true, true]);
  }
});

test("every check but the rare ones has a failing case", () => {
  const failing = new Set(VERIFIER_CASES.flatMap((c) => c.expect.checks.map((x) => `${c.kind}.${x}`)));
  // image.size is covered by the unit tests (services/verify/deliverable.test.ts); answer.has_claims likewise.
  const skip = new Set(["image.size", "answer.has_claims"]);
  for (const [kind, checks] of Object.entries(VERIFY_CHECKS)) for (const check of checks) {
    if (!skip.has(`${kind}.${check}`)) expect([`${kind}.${check}`, failing.has(`${kind}.${check}`)]).toEqual([`${kind}.${check}`, true]);
  }
});

test.each(VERIFIER_CASES.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
  const r = await verifyDeliverable(c.kind, c.artifact as never, c.ctx as never);
  expect({ ok: r.ok, checks: r.ok ? [] : r.failures.map((f) => f.check) }).toEqual(c.expect);
  if (!r.ok) expect(r.status).toBe("needs_a_look");
});
