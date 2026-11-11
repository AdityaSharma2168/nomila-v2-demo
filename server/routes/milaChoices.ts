/**
 * routes/milaChoices.ts — Me › What Mila does for you, server side (design "Mila welcome flow" §4, §12; MILA_WELCOME):
 *
 *   GET  /api/v1/me/mila/capabilities          every optional capability that is a switch, with the athlete's state
 *                                              (unset when never answered), its consent words, its Turn-on sheet
 *                                              (milaCards/capabilities.ts presentation) and, for a per-account one, the
 *                                              connected accounts it can be switched on for. Me › What Mila can do
 *                                              reads this list.
 *   POST /api/v1/me/mila/capabilities/:key     { to, accountRef?, expectedVersion?, consentVersion? } — the athlete's
 *                                              own tap in Me (turning on needs the consent version Me showed):
 *                                              turn on, pause, turn off, not now, never. Recorded via "me" in
 *                                              mila_choices with history (choices.ts setChoice); turning one off stops
 *                                              its jobs and its tools from the next check on.
 *
 * The athlete is the session's (requireAuth); no route takes an athlete id. With MILA_WELCOME off both answer 404.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { createLogger } from "../logger";
import { milaWelcomeEnabled } from "../agent/welcome/config";
import { availableNow, CAPABILITIES, capability } from "../agent/welcome/registry";
import { consentWords, openToAthlete, turnOnKeys } from "../agent/welcome/turnOn";
import { presentation } from "../agent/milaCards/capabilities";

const logger = createLogger("routes/milaChoices");

const body = z.object({
  to: z.enum(["enabled", "paused", "revoked", "not_now", "never"]),
  accountRef: z.string().uuid().nullable().optional(),
  expectedVersion: z.number().int().min(0).optional(),
  /** Required to turn on: the consent version Me showed (GET's consent.version), so a yes is to the words seen. */
  consentVersion: z.string().max(80).optional(),
});

const STATUS: Record<string, number> = {
  unknown_capability: 404, core_capability: 400, not_available: 409, scope: 400, account_not_found: 404,
  account_does_not_fit: 400, invalid_transition: 409, needs_tap: 400, version_conflict: 409, disabled: 404,
};

const router = Router();

router.get("/mila/capabilities", requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!milaWelcomeEnabled()) { res.status(404).json({ error: "Not found" }); return; }
  try {
    const { accountsFor, listChoices } = await import("../agent/welcome/choices");
    const choices = await listChoices(req.athleteId!);
    const keys = new Set(turnOnKeys(CAPABILITIES));
    const listed = CAPABILITIES.filter((c) => keys.has(c.key) && availableNow(c) && openToAthlete(c.key, req.athleteId!));
    const capabilities = [];
    for (const c of listed) {
      const p = presentation(c.key);
      capabilities.push({
        key: c.key, name: c.name, scope: c.scope, consent: consentWords(c),
        // On until they turn it off (registry defaultOn): with no choice yet, the switch shows on.
        defaultOn: !!c.defaultOn,
        presentation: p ? { headline: p.headline, line: p.line, glyph: p.glyph, platform: p.platform, sheet: p.sheet } : null,
        accounts: c.scope === "per_account" ? await accountsFor(req.athleteId!, c.key) : [],
        choices: choices.filter((x) => x.capability === c.key).map((x) => ({ accountRef: x.accountRef, state: x.state, version: x.version, consentVersion: x.consentVersion, decidedAt: x.decidedAt })),
      });
    }
    res.json({ capabilities });
  } catch (err) {
    logger.error({ err }, "mila capabilities read failed");
    res.status(500).json({ error: "Could not load that" });
  }
});

router.post("/mila/capabilities/:key", requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!milaWelcomeEnabled()) { res.status(404).json({ error: "Not found" }); return; }
  const b = body.safeParse(req.body ?? {});
  if (!b.success) { res.status(400).json({ error: "Invalid choice" }); return; }
  const entry = capability(String(req.params.key));
  if (b.data.to === "enabled" && entry && !entry.core && b.data.consentVersion !== entry.consent.version) {
    res.status(409).json({ error: "consent_changed", message: "the consent changed; show it again" });
    return;
  }
  try {
    const { setChoice } = await import("../agent/welcome/choices");
    const r = await setChoice({
      athleteId: req.athleteId!, capability: String(req.params.key), accountRef: b.data.accountRef ?? null, to: b.data.to, via: "me",
      ...(b.data.expectedVersion !== undefined ? { expectedVersion: b.data.expectedVersion } : {}),
    });
    if (!r.ok) { res.status(STATUS[r.error] ?? 400).json({ error: r.error, message: r.message }); return; }
    res.json({ changed: r.changed, choice: { capability: r.choice.capability, accountRef: r.choice.accountRef, state: r.choice.state, version: r.choice.version, consentVersion: r.choice.consentVersion } });
  } catch (err) {
    logger.error({ err }, "mila capability choice failed");
    res.status(500).json({ error: "Could not save that" });
  }
});

export default router;
