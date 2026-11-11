/**
 * studioSessions.ts — the Create Anything thread's surface (session persistence plan v2 §3;
 * docs/plans/studio-sessions-plan-v2.md). Keep a thread, read it back, archive it.
 *
 *   GET   /api/v1/me/studio/sessions?archived=true&limit=30   her threads, most recently touched first
 *   GET   /api/v1/me/studio/sessions/:id?before=<seq>&limit=50 one thread: a page of entries, hydrated, and one
 *                                                              asset map for the page
 *   POST  /api/v1/me/studio/sessions/:id/entries               append one entry; the first append claims the thread.
 *                                                              Idempotent by entry id. Answers the EFFECTIVE sessionId
 *   PATCH /api/v1/me/studio/sessions/:id                       { archived: boolean } — archive only, nothing deletes
 *
 * ─── ITS OWN GATE, SO routes/studio.ts HAS NO DIFF ────────────────────────────────────────────────────────
 *
 * `requireSessions` 404s unless STUDIO_ENABLED and STUDIO_SESSIONS are both on — 404, not 403, for the reason
 * routes/studio.ts gives: an unreleased surface should not be discoverable by the shape of its refusal. Then
 * requireAuth, then a local requireAthlete (the same two lines studio.ts keeps, for the same reason).
 *
 * ─── NO SPEND SURFACE ─────────────────────────────────────────────────────────────────────────────────────
 *
 * Nothing here, or in studio/sessions.ts, imports generate, the provider router, an adapter, the interpreter or
 * the compiler, and nothing calls a model (asserted by walking the import graph in the route suite). Re-attaching
 * to a run in flight adds no route: a thread's plan carries `run.jobId`, and the client watches the EXISTING
 * GET /studio/jobs/:jobId.
 *
 * ─── TENANCY ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The athlete is `req.athleteId`, always; no request type here has an athlete field. Not-yours and not-found are
 * the same answer on every route, byte for byte — see studio/sessions.ts for how each query carries it.
 */
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { rateLimit } from "express-rate-limit";
import { requireAuth } from "../lib/auth";
import { studioEnabled, studioSessionsEnabled } from "../studio/config";
import {
  appendEntry,
  isUuid,
  listSessions,
  parseEntry,
  readSession,
  setArchived,
} from "../studio/sessions";
import { createLogger } from "../logger";

const logger = createLogger("routes/studioSessions");
const router = Router();

// ─── Gates ────────────────────────────────────────────────────────────────────────────────────────────────

function requireSessions(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!studioEnabled() || !studioSessionsEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}

/** Belt and braces, as in routes/studio.ts: `Request.athleteId` is optional in the type, so it is checked. */
function requireAthlete(req: Request, res: Response, next: NextFunction): void {
  if (!req.athleteId) {
    logger.warn(
      { path: req.path },
      "authenticated principal reached studio sessions with no athleteId",
    );
    res.status(403).json({ error: "This account is not an athlete account" });
    return;
  }
  next();
}

const gate = [requireSessions, requireAuth, requireAthlete] as const;

/**
 * Appends only, per athlete — after requireAuth, so the key is her athlete id rather than an IP behind Cloud Run's
 * load balancer (the shape of server/lib/rateLimit.ts, local to this router). A thread appends a few entries per
 * send; 60 a minute absorbs retries and a busy thread, and stops a loop.
 */
const appendLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  keyGenerator: (req: Request) => req.athleteId ?? "unknown",
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "That's a lot of saving at once — give it a moment and try again.",
  },
});

const NO_SUCH_THREAD = { error: "No such thread" };

/** A client-named page size is clamped by the store; an unparseable one falls back rather than becoming NaN. */
function limitFrom(v: unknown): number | undefined {
  const n = Number(v);
  return v === undefined || !Number.isFinite(n) ? undefined : n;
}

// ─── GET /studio/sessions ─────────────────────────────────────────────────────────────────────────────────

router.get(
  "/studio/sessions",
  ...gate,
  async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId as string;
    try {
      const sessions = await listSessions(athleteId, {
        archived: req.query.archived === "true",
        limit: limitFrom(req.query.limit),
      });
      res.json({ sessions });
    } catch (err) {
      logger.error({ err, athleteId }, "studio sessions list failed");
      res.status(500).json({ error: "Couldn't load your threads" });
    }
  },
);

// ─── GET /studio/sessions/:id ─────────────────────────────────────────────────────────────────────────────

router.get(
  "/studio/sessions/:id",
  ...gate,
  async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId as string;
    const sessionId = req.params.id;
    if (!isUuid(sessionId)) {
      res.status(404).json(NO_SUCH_THREAD);
      return;
    }
    // `before` is a seq. An unreadable one is refused rather than ignored: ignoring it would answer the NEWEST page
    // to a "load earlier", and a client paging back would loop on it.
    const rawBefore = req.query.before;
    const before = rawBefore === undefined ? undefined : Number(rawBefore);
    if (before !== undefined && !(Number.isSafeInteger(before) && before > 0)) {
      res
        .status(400)
        .json({ error: "before must be an entry's seq", field: "before" });
      return;
    }

    try {
      const page = await readSession(athleteId, sessionId.toLowerCase(), {
        before,
        limit: limitFrom(req.query.limit),
      });
      if (!page) {
        res.status(404).json(NO_SUCH_THREAD);
        return;
      }
      res.json(page);
    } catch (err) {
      logger.error({ err, athleteId, sessionId }, "studio session read failed");
      res.status(500).json({ error: "Couldn't load this thread" });
    }
  },
);

// ─── POST /studio/sessions/:id/entries ────────────────────────────────────────────────────────────────────

router.post(
  "/studio/sessions/:id/entries",
  ...gate,
  appendLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId as string;
    const sessionId = req.params.id;
    if (!isUuid(sessionId)) {
      res.status(404).json(NO_SUCH_THREAD);
      return;
    }
    const parsed = parseEntry(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error, field: parsed.field });
      return;
    }

    try {
      const out = await appendEntry(
        athleteId,
        sessionId.toLowerCase(),
        parsed.value,
      );
      switch (out.kind) {
        case "appended":
        case "replayed":
          res.status(out.kind === "appended" ? 201 : 200).json({
            sessionId: out.sessionId,
            entryId: out.entryId,
            seq: out.seq,
          });
          return;
        case "full":
          res.status(409).json({
            error: "This thread is full. Start a new one to keep going.",
            field: "sessionId",
          });
          return;
        case "not_found":
          // Hers or nobody's: another athlete's preview or photo answers exactly as a nonexistent one.
          res
            .status(404)
            .json({ error: "That isn't in your Studio", field: out.field });
          return;
        case "id_taken":
          res
            .status(409)
            .json({ error: "That entry id is already in use", field: "id" });
          return;
      }
    } catch (err) {
      logger.error(
        { err, athleteId, sessionId, kind: parsed.value.kind },
        "studio session append failed",
      );
      res.status(500).json({ error: "Couldn't save that right now" });
    }
  },
);

// ─── PATCH /studio/sessions/:id ───────────────────────────────────────────────────────────────────────────

router.patch(
  "/studio/sessions/:id",
  ...gate,
  async (req: Request, res: Response): Promise<void> => {
    const athleteId = req.athleteId as string;
    const sessionId = req.params.id;
    if (!isUuid(sessionId)) {
      res.status(404).json(NO_SUCH_THREAD);
      return;
    }
    const body: unknown = req.body;
    const keys =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? Object.keys(body)
        : null;
    const archived = keys
      ? (body as { archived?: unknown }).archived
      : undefined;
    if (
      !keys ||
      keys.length !== 1 ||
      keys[0] !== "archived" ||
      typeof archived !== "boolean"
    ) {
      res.status(400).json({
        error: "the body is { archived: true | false }",
        field: "archived",
      });
      return;
    }

    try {
      const session = await setArchived(
        athleteId,
        sessionId.toLowerCase(),
        archived,
      );
      if (!session) {
        res.status(404).json(NO_SUCH_THREAD);
        return;
      }
      res.json({ session });
    } catch (err) {
      logger.error(
        { err, athleteId, sessionId },
        "studio session archive failed",
      );
      res.status(500).json({ error: "Couldn't update this thread" });
    }
  },
);

export default router;
