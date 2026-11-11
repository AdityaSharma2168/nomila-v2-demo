/**
 * campaignGovernance.ts — the athlete's narrow Campaign governance surface (#570 Amendment 3, the second act): see a
 * campaign's purpose, period and end eligibility, its current scope (deliverables, constraints, progress), approve the
 * current draft version (which materialises creative intents and nothing else), confirm an external obligation, and end
 * the campaign with a reason. Behind STUDIO_CAMPAIGN_GOVERNANCE (off ⇒ 404). Decline / request-revision is not a
 * #570 governance act: a draft stays draft and a revision is a new version — no route pretends otherwise.
 * CampaignSpec approval ≠ spend, publish or external-execution authorization; nothing here reaches Studio's gates.
 */
import type { RequestHandler, Router, Request, Response } from "express";
import { db } from "../db";
import { campaignGovernanceEnabled } from "../studio/config";
import { deriveIntentState } from "../services/intelligence/creative/intents";
import { downstreamOf } from "../services/intelligence/creative/store";
import { campaignWorkItem } from "../services/intelligence/campaign/existingWork";
import { deliverableProgress } from "../services/intelligence/campaign/fulfilment";
import { endCampaign, endEligibility } from "../services/intelligence/campaign/lifecycle";
import { campaignIntents, materializeCreativeIntents } from "../services/intelligence/campaign/materialize";
import { CampaignRefused, approveSpec, confirmExternally, deliverablesInScope, getCampaign, getSpec, listCampaigns, listSpecs } from "../services/intelligence/campaign/store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerCampaignGovernanceRoutes(router: Router, gate: readonly RequestHandler[]): void {
  const on = (_req: Request, res: Response, next: () => void) => { if (!campaignGovernanceEnabled()) { res.status(404).json({ error: "Not found" }); return; } next(); };
  const id = (v: unknown, res: Response, field: string): string | null => { if (typeof v !== "string" || !UUID_RE.test(v)) { res.status(400).json({ error: `not a ${field}`, field }); return null; } return v; };
  const refused = (res: Response, err: unknown) => { if (err instanceof CampaignRefused) res.status(409).json({ error: err.message }); else throw err; };

  router.get("/campaigns", ...gate, on, async (req, res) => {
    const list = await listCampaigns(db, req.athleteId as string);
    res.status(200).json({ campaigns: list.map((c) => ({ id: c.id, purpose: c.purpose, status: c.status, originDoor: c.originDoor, currentSpecVersion: c.currentSpecVersion, period: c.period, endedBecause: c.endedBecause })) });
  });

  router.get("/campaigns/:id", ...gate, on, async (req, res) => {
    const cid = id(req.params.id, res, "campaign id"); if (!cid) return;
    const athleteId = req.athleteId as string;
    const c = await getCampaign(db, athleteId, cid); if (!c) { res.status(404).json({ error: "That campaign isn't one of yours." }); return; }
    const specs = await listSpecs(db, athleteId, cid); const latest = specs[specs.length - 1] ?? null;
    const approved = specs.filter((s) => s.approval !== "draft").pop() ?? null;
    const scope = await deliverablesInScope(db, athleteId, cid, latest?.version ?? c.currentSpecVersion);
    const intents = await campaignIntents(db, athleteId, cid);
    const progress = await Promise.all(scope.map((d) => deliverableProgress(db, athleteId, d, intents)));
    const states = await Promise.all(intents.map(async (i) => ({ intent: i, state: deriveIntentState(i, await downstreamOf(db, athleteId, i.id)) })));
    const work = campaignWorkItem({ campaign: c, spec: approved, inScope: approved ? await deliverablesInScope(db, athleteId, cid, approved.version) : [], intents: states });
    res.status(200).json({
      campaign: c, eligibility: await endEligibility(db, athleteId, c),
      currentScope: latest ? { version: latest.version, approval: latest.approval, purpose: latest.purpose, period: latest.period, constraints: latest.constraints, supersedes: latest.supersedes, deliverables: scope.map((d, i) => ({ ...d, progress: progress[i] })) } : null,
      approvedVersion: approved?.version ?? null,
      /** exactly what the Brain sees in Existing Work — null once ended */
      existingWork: work,
    });
  });

  // THE SECOND ACT: approve the current draft version. Materialises creative intents; authorizes nothing downstream.
  router.post("/campaigns/:id/specs/:version/approve", ...gate, on, async (req, res) => {
    const cid = id(req.params.id, res, "campaign id"); if (!cid) return;
    const version = Number(req.params.version); if (!Number.isInteger(version) || version < 1) { res.status(400).json({ error: "not a version", field: "version" }); return; }
    const athleteId = req.athleteId as string;
    try {
      const a = await approveSpec(db, athleteId, cid, version, "athlete");
      const m = a.alreadyApproved ? { created: [], kept: 0, withdrawn: [] } : await materializeCreativeIntents(db, athleteId, cid, version);
      res.status(200).json({ campaign: a.campaign, spec: a.spec, alreadyApproved: a.alreadyApproved, dropped: a.dropped.map((d) => d.id), creativeIntents: { created: m.created.map((i) => i.id), kept: m.kept, withdrawn: m.withdrawn.map((i) => i.id) } });
    } catch (err) { refused(res, err); }
  });

  router.post("/campaigns/:id/deliverables/:did/confirm", ...gate, on, async (req, res) => {
    const cid = id(req.params.id, res, "campaign id"); if (!cid) return;
    const did = id(req.params.did, res, "deliverable id"); if (!did) return;
    const ref = typeof (req.body ?? {}).reference === "string" ? String((req.body as any).reference) : null;
    try { const d = await confirmExternally(db, req.athleteId as string, did, "athlete", new Date(), ref); if (d.campaignId !== cid) { res.status(404).json({ error: "not this campaign's" }); return; } res.status(200).json({ deliverable: d }); }
    catch (err) { refused(res, err); }
  });

  router.post("/campaigns/:id/end", ...gate, on, async (req, res) => {
    const cid = id(req.params.id, res, "campaign id"); if (!cid) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!["fulfilled", "expired", "cancelled"].includes(String(b.because))) { res.status(400).json({ error: "because must be fulfilled | expired | cancelled", field: "because" }); return; }
    if (b.remaining !== undefined && !["waive", "cancel"].includes(String(b.remaining))) { res.status(400).json({ error: "remaining must be waive | cancel", field: "remaining" }); return; }
    try {
      const r = await endCampaign(db, req.athleteId as string, cid, { because: b.because as any, actor: "athlete", remaining: b.remaining as any, override: typeof b.overrideReason === "string" && b.overrideReason.trim() ? { reason: b.overrideReason.trim() } : undefined });
      res.status(200).json({ campaign: r.campaign, eligibility: r.eligibility, obligations: r.obligations, withdrawnIntents: r.withdrawnIntents, recommendationOutcome: r.recommendationOutcome });
    } catch (err) { refused(res, err); }
  });
}
