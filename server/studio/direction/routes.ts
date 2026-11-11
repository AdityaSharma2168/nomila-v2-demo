/**
 * studio/direction/routes — the direction tools' doors, mounted on the Studio router behind its gate.
 *
 *   POST /studio/direction/echo   { brand, productLine } → a BriefProposal (the spike tool, commit 1)
 *
 * They live here and not in routes/studio.ts for the reason studio/publish/routes.ts gives: the whole
 * capability reads — and reverts — in one folder, and that file gains one import and one call. The
 * gate is passed in, so no door here can be mounted behind a different one by accident.
 *
 * ─── ⚠️  THE HARD GATE: A TOOL RETURNS A BRIEF. IT NEVER SPENDS. ────────────────────────────────────
 *
 * No route in this file, and nothing it imports, may ask the planner, derive concepts, quote a
 * preview, open a generation job or queue a stitch. A tool's whole answer is a proposal she confirms;
 * the planner runs only from the Studio flow, after that confirm, through POST /studio/agent/plan.
 * Two tests hold it: tripwire.test walks this folder's imports; routes.test mounts the real router
 * with every spending entry point spied and asserts none was called and no preview, plan or job row
 * exists after each request. ⚠️ MUTATION: make a route here call deriveConcepts or the planner —
 * "no direction route asks the planner, generates, stitches or quotes — the hard gate" reds by name.
 *
 * ─── TENANCY ────────────────────────────────────────────────────────────────────────────────────────
 *
 * `req.athleteId`, from the gate, is the only identity. echo_brief reads nothing of hers and so has no
 * tenancy surface; the tools that do (a brief under her prefix, her asset, her library) resolve every
 * handle under that id, and an id in a body is never read.
 *
 * ─── THE SWITCH ─────────────────────────────────────────────────────────────────────────────────────
 *
 * STUDIO_BRAND_PROFILES, the flag the campaign brief and its upload already sit behind: off, every
 * door here is a 404 — the surface does not exist — before the body is read.
 */
import { randomUUID } from "node:crypto";
import {
  raw as rawBody,
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from "express";
import { createLogger } from "../../logger";
import { brandProfilesEnabled, momentSearchEnabled } from "../config";
import { echoBrief, ECHO_MAX_BRAND, ECHO_MAX_LINE } from "./echo";
import { validateBriefProposal } from "./envelope";
import { decomposeToProposal, type DecomposeToolResult } from "./decompose";
import { researchMoment, type MomentResult } from "./moment";
import { proposeCampaign, type ProposeResult } from "./propose";
import { trendSignal } from "./trend";
import { isPdf, summarizeBrief, type SummarizeResult } from "./summarize";

const logger = createLogger("studio/direction/routes");

const NOT_FOUND = { error: "Not found" };
/** The direct-upload door's ceiling (decision, 23 Sep 2026); the signed-url door's is 20 MB (routes/studio.ts). */
export const UPLOAD_LIMIT = "10mb";
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** A required short line of hers, or the field that is wrong. */
function shortLine(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
}

/** The switch, as a middleware, for a route that must refuse BEFORE its body is parsed. */
const requireBrandProfiles: RequestHandler = (_req, res, next) => {
  if (!brandProfilesEnabled()) {
    res.status(404).json(NOT_FOUND);
    return;
  }
  next();
};

/** Only a PDF body is read at all — checked before the body parser so nothing else is buffered. */
const requirePdfBody: RequestHandler = (req, res, next) => {
  if (!req.is("application/pdf")) {
    res.status(415).json({ error: "A brief is a PDF" });
    return;
  }
  next();
};

/** body-parser's over-limit error, answered in this router's own words. */
const tooLarge: ErrorRequestHandler = (err, _req, res, next: NextFunction) => {
  if (
    err &&
    typeof err === "object" &&
    (err as { type?: string }).type === "entity.too.large"
  ) {
    res
      .status(413)
      .json({ error: `Too large — max ${MAX_UPLOAD_BYTES / 1048576}MB` });
    return;
  }
  next(err);
};

/**
 * A tool's answer as the wire: the proposal (plus what the door adds), the cost as a header for the
 * eval runner — never in the body, which stays the strict envelope — or the refusal's status.
 */
function answerSummary(
  res: Response,
  athleteId: string,
  r: SummarizeResult,
  extra?: Record<string, unknown>,
): void {
  if (!r.ok) {
    if (r.reason === "disabled") {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (r.reason === "unreadable_pdf") {
      res.status(415).json({ error: "That file isn't a PDF I can read." });
      return;
    }
    logger.warn(
      {
        athleteId,
        reason: r.reason,
        issues: r.issues?.length ?? 0,
        model: r.model,
      },
      "summarize_brief refused",
    );
    res.status(502).json({
      error: "Couldn't read that brief just now. Nothing was planned.",
    });
    return;
  }
  if (r.cost.usd !== null)
    res.setHeader("X-Studio-Cost-Usd", String(r.cost.usd));
  res.setHeader("X-Studio-Model", r.model);
  res.status(200).json(extra ? { proposal: r.proposal, ...extra } : r.proposal);
}

/** decompose_reference's answer as the wire: the proposal, or the refusal's status in the engine's own terms. */
function answerDecomposition(
  res: Response,
  athleteId: string,
  r: DecomposeToolResult,
): void {
  if (!r.ok) {
    switch (r.reason) {
      case "disabled":
        res.status(404).json(NOT_FOUND);
        return;
      case "invalid_input":
        res.status(400).json({
          error: "that reference isn't one I can read",
          issues: r.issues ?? [],
        });
        return;
      case "url_refused":
        res.status(400).json({
          error: `That link can't be fetched: ${r.issues?.[0] ?? "not a public https address"}.`,
          field: "source.url",
        });
        return;
      case "not_an_image":
        res.status(415).json({
          error:
            "That link isn't a direct image (jpeg, png or webp). A page can't be read yet — save the picture and upload it, or paste the words.",
          field: "source.url",
        });
        return;
      case "too_large":
        res.status(413).json({
          error: "That image is over 10 MB. Nothing was stored.",
          field: "source.url",
        });
        return;
      case "fetch_failed":
      case "store_failed":
        logger.warn(
          { athleteId, reason: r.reason, detail: r.issues?.[0] ?? null },
          "decompose_reference could not take the link",
        );
        res.status(502).json({
          error:
            "Couldn't fetch that link just now. Nothing was stored, nothing was planned.",
          field: "source.url",
        });
        return;
      case "not_found":
        res.status(404).json({ error: "No such photo" });
        return;
      case "unreadable_image":
        res
          .status(422)
          .json({ error: "That photo couldn't be read as an image." });
        return;
      default:
        logger.warn(
          {
            athleteId,
            reason: r.reason,
            issues: r.issues?.length ?? 0,
            model: r.model,
          },
          "decompose_reference refused",
        );
        res.status(502).json({
          error: "Couldn't read that reference just now. Nothing was planned.",
        });
        return;
    }
  }
  if (r.cost.usd !== null)
    res.setHeader("X-Studio-Cost-Usd", String(r.cost.usd));
  res.setHeader("X-Studio-Model", r.model);
  // A link she gave is now one of her rows (origin 'reference'); the flow keeps the id to name it.
  if (r.storedAssetId)
    res.setHeader("X-Studio-Reference-Asset-Id", r.storedAssetId);
  res.status(200).json(r.proposal);
}

const MOMENT_BODY_KEYS = ["ask", "brand", "date"];

/** research_moment's answer as the wire. */
function answerMoment(res: Response, athleteId: string, r: MomentResult): void {
  if (!r.ok) {
    switch (r.reason) {
      case "disabled":
        res.status(404).json(NOT_FOUND);
        return;
      case "invalid_input":
        res.status(400).json({
          error: "that ask isn't one I can search",
          issues: r.issues ?? [],
        });
        return;
      case "rate_limited":
        res.status(429).json({
          error:
            "You've searched a lot just now — try again in a few minutes. Nothing was spent.",
        });
        return;
      case "day_cap":
        res.status(429).json({
          error:
            "You've reached today's search limit. Try again tomorrow. Nothing was spent.",
        });
        return;
      case "nothing_found":
        res.status(422).json({
          error:
            "Nothing current turned up for that. Try naming the event, the opponent or the week.",
        });
        return;
      default:
        logger.warn(
          {
            athleteId,
            reason: r.reason,
            issues: r.issues?.length ?? 0,
            model: r.model,
          },
          "research_moment refused",
        );
        res.status(502).json({
          error: "Couldn't read what the search found. Nothing was planned.",
        });
        return;
    }
  }
  if (r.cost.usd !== null)
    res.setHeader("X-Studio-Cost-Usd", String(r.cost.usd));
  res.setHeader("X-Studio-Model", r.model);
  res.status(200).json(r.proposal);
}

const PROPOSE_BODY_KEYS = ["objective", "brand", "occasion", "priorContext"];

/** propose_campaign's answer as the wire: the proposals and the tool's notes, or the refusal's status. */
function answerProposals(
  res: Response,
  athleteId: string,
  r: ProposeResult,
): void {
  if (!r.ok) {
    if (r.reason === "disabled") {
      res.status(404).json(NOT_FOUND);
      return;
    }
    if (r.reason === "invalid_input") {
      res.status(400).json({
        error: "that ask isn't one I can propose for",
        issues: r.issues ?? [],
      });
      return;
    }
    logger.warn(
      {
        athleteId,
        reason: r.reason,
        issues: r.issues?.length ?? 0,
        model: r.model,
      },
      "propose_campaign refused",
    );
    res.status(502).json({
      error:
        r.reason === "too_few"
          ? "Couldn't find two distinct ideas for that. Nothing was planned."
          : "Couldn't propose just now. Nothing was planned.",
    });
    return;
  }
  if (r.cost.usd !== null)
    res.setHeader("X-Studio-Cost-Usd", String(r.cost.usd));
  res.setHeader("X-Studio-Model", r.model);
  res.status(200).json({ proposals: r.proposals, notes: r.notes });
}

export function registerDirectionRoutes(
  router: Router,
  gate: readonly RequestHandler[],
): void {
  // ─── POST /studio/direction/propose-campaign ────────────────────────────────────────────────
  // { objective, brand?, occasion?, priorContext? } → { proposals: BriefProposal[], notes }. The one
  // door that reads her LIBRARY (the planner's own assembly, read only, ≤ 4 embeddings) — and still
  // never plans, generates, stitches or quotes.
  router.post(
    "/studio/direction/propose-campaign",
    ...gate,
    async (req: Request, res: Response): Promise<void> => {
      if (!brandProfilesEnabled()) {
        res.status(404).json(NOT_FOUND);
        return;
      }
      const athleteId = req.athleteId as string;
      const b = req.body;
      if (!b || typeof b !== "object" || Array.isArray(b)) {
        res
          .status(400)
          .json({ error: "the body must be an object", field: "body" });
        return;
      }
      const extra = Object.keys(b).find((k) => !PROPOSE_BODY_KEYS.includes(k));
      if (extra) {
        res.status(400).json({ error: "unknown field", field: extra });
        return;
      }
      answerProposals(
        res,
        athleteId,
        await proposeCampaign(athleteId, {
          objective: b.objective,
          brand: b.brand,
          occasion: b.occasion,
          priorContext: b.priorContext,
        }),
      );
    },
  );

  // ─── POST /studio/direction/research-moment ─────────────────────────────────────────────────
  // { ask, brand?, date? } → ONE live grounded search (Lane D, behind STUDIO_DIRECTION_MOMENTS as well as
  // the profiles flag) → a BriefProposal: the moment as `story`, its feel as tone, a concept the plan
  // call can ride — all inferred, cited from the provider's own chunks. The date is HERS or nobody's.
  router.post(
    "/studio/direction/research-moment",
    ...gate,
    async (req: Request, res: Response): Promise<void> => {
      if (!brandProfilesEnabled() || !momentSearchEnabled()) {
        res.status(404).json(NOT_FOUND);
        return;
      }
      const athleteId = req.athleteId as string;
      const b = req.body;
      if (!b || typeof b !== "object" || Array.isArray(b)) {
        res
          .status(400)
          .json({ error: "the body must be an object", field: "body" });
        return;
      }
      const extra = Object.keys(b).find((k) => !MOMENT_BODY_KEYS.includes(k));
      if (extra) {
        res.status(400).json({ error: "unknown field", field: extra });
        return;
      }
      answerMoment(
        res,
        athleteId,
        await researchMoment(athleteId, {
          ask: b.ask,
          brand: b.brand,
          date: b.date,
        }),
      );
    },
  );

  // ─── GET /studio/direction/trend ────────────────────────────────────────────────────────────
  // The trend pillar's honest answer (Lane D2): not available, and nothing simulated in its place.
  router.get(
    "/studio/direction/trend",
    ...gate,
    (_req: Request, res: Response): void => {
      if (!brandProfilesEnabled()) {
        res.status(404).json(NOT_FOUND);
        return;
      }
      res.status(200).json(trendSignal());
    },
  );

  // ─── POST /studio/direction/decompose-reference ─────────────────────────────────────────────
  // { source: {kind:"image", assetId} | {kind:"text", text} | {kind:"url", url}, role? } → a
  // BriefProposal, every line inferred, the §7 decomposition riding as references[0].intent. PR 3's
  // engine does the reading, untouched, under her id. A url is fetched through safeFetch and stored as her
  // reference asset (origin 'reference', 0062) before it is read; a page is a 415.
  router.post(
    "/studio/direction/decompose-reference",
    ...gate,
    async (req: Request, res: Response): Promise<void> => {
      if (!brandProfilesEnabled()) {
        res.status(404).json(NOT_FOUND);
        return;
      }
      const athleteId = req.athleteId as string;
      const b = req.body;
      if (!b || typeof b !== "object" || Array.isArray(b)) {
        res
          .status(400)
          .json({ error: "the body must be an object", field: "body" });
        return;
      }
      const extra = Object.keys(b).find((k) => k !== "source" && k !== "role");
      if (extra) {
        res.status(400).json({ error: "unknown field", field: extra });
        return;
      }
      answerDecomposition(
        res,
        athleteId,
        await decomposeToProposal(athleteId, {
          source: b.source,
          role: b.role,
        }),
      );
    },
  );

  // ─── POST /studio/direction/summarize-brief ─────────────────────────────────────────────────
  // { briefFilePath } — a brief she uploaded through the signed-url door (6d), under HER prefix.
  router.post(
    "/studio/direction/summarize-brief",
    ...gate,
    async (req: Request, res: Response): Promise<void> => {
      if (!brandProfilesEnabled()) {
        res.status(404).json(NOT_FOUND);
        return;
      }
      const athleteId = req.athleteId as string;
      const b = req.body;
      if (!b || typeof b !== "object" || Array.isArray(b)) {
        res
          .status(400)
          .json({ error: "the body must be an object", field: "body" });
        return;
      }
      // Hers, by prefix and shape, before anything is read — the same rule the plan row applies.
      const { isHerBriefPath } = await import("../agent/plans.js");
      if (!isHerBriefPath(athleteId, b.briefFilePath)) {
        res.status(404).json({ error: "No such brief" });
        return;
      }
      const { getAttachment } = await import(
        "../../lib/inboxAttachmentStore.js"
      );
      const bytes = await getAttachment(b.briefFilePath);
      if (!bytes) {
        res.status(404).json({ error: "No such brief" });
        return;
      }
      answerSummary(res, athleteId, await summarizeBrief(bytes));
    },
  );

  // ─── POST /studio/direction/summarize-brief/upload ──────────────────────────────────────────
  // The PDF itself, raw, ≤ 10 MB: stored under her prefix (so the plan row can name it, and the 6d
  // door's signing is not needed on a laptop), then read. Answers { proposal, briefFilePath }.
  router.post(
    "/studio/direction/summarize-brief/upload",
    ...gate,
    requireBrandProfiles,
    requirePdfBody,
    rawBody({ type: "application/pdf", limit: UPLOAD_LIMIT }),
    tooLarge,
    async (req: Request, res: Response): Promise<void> => {
      const athleteId = req.athleteId as string;
      const bytes = req.body as unknown;
      if (!Buffer.isBuffer(bytes) || !isPdf(bytes)) {
        res.status(415).json({ error: "That file isn't a PDF I can read." });
        return;
      }
      const { briefPrefix } = await import("../agent/plans.js");
      const { putAttachment } = await import(
        "../../lib/inboxAttachmentStore.js"
      );
      const briefFilePath = `${briefPrefix(athleteId)}${randomUUID()}.pdf`;
      // One greppable line per upload path (Lane E): here the raw route served — the fallback when the
      // runtime cannot sign, or a caller that never asked for a signed url.
      logger.info(
        { athleteId, path: "raw-fallback" },
        "brief upload path: raw-fallback",
      );
      // Best effort: a store that fails costs her the path on the plan row, never the reading.
      const stored = await putAttachment(
        briefFilePath,
        bytes,
        "application/pdf",
      );
      if (!stored)
        logger.warn(
          { athleteId },
          "brief upload could not be stored; reading it anyway",
        );
      answerSummary(res, athleteId, await summarizeBrief(bytes), {
        briefFilePath: stored ? briefFilePath : null,
      });
    },
  );

  // ─── POST /studio/direction/echo ────────────────────────────────────────────────────────────
  router.post(
    "/studio/direction/echo",
    ...gate,
    async (req: Request, res: Response): Promise<void> => {
      // ⚠️ FIRST, before the body is read. Off is a 404, and nothing has run.
      if (!brandProfilesEnabled()) {
        res.status(404).json(NOT_FOUND);
        return;
      }
      const athleteId = req.athleteId as string;
      const b = req.body;
      if (!b || typeof b !== "object" || Array.isArray(b)) {
        res
          .status(400)
          .json({ error: "the body must be an object", field: "body" });
        return;
      }
      const brand = shortLine(b.brand, ECHO_MAX_BRAND);
      if (!brand) {
        res.status(400).json({
          error: `brand is a line of up to ${ECHO_MAX_BRAND} characters`,
          field: "brand",
        });
        return;
      }
      const productLine = shortLine(b.productLine, ECHO_MAX_LINE);
      if (!productLine) {
        res.status(400).json({
          error: `productLine is a line of up to ${ECHO_MAX_LINE} characters`,
          field: "productLine",
        });
        return;
      }
      // The route validates what it is about to send: a tool that could emit an invalid proposal
      // would be a tool the client has to distrust, and the whole point is that it need not.
      const v = validateBriefProposal(echoBrief({ brand, productLine }));
      if (!v.ok) {
        logger.error(
          { athleteId, issues: v.issues },
          "echo_brief produced an invalid proposal",
        );
        res.status(500).json({ error: "Couldn't shape that brief" });
        return;
      }
      logger.info(
        {
          athleteId,
          tool: v.proposal.sourceTool,
          flags: v.proposal.flags.length,
        },
        "direction tool answered",
      );
      res.status(200).json(v.proposal);
    },
  );
}
