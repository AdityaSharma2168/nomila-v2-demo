/**
 * adminBookings.ts — the human review queue for bookings (requireAdmin). Mounted at /api/v1/admin/bookings.
 * Reached only by a person at Nomila — never by Mila, a pending action or a sweep (bookingsTapOnly.test.ts).
 *
 *   GET  /reports?status=open|in_review|resolved   the queue (no buyer contact details)
 *   POST /:bookingId/resolve  { resolution: release|no_action|refund_athlete_no_show|refund_full, note? }
 */
import { Router, type Request, type Response } from "express";
import { desc, eq } from "drizzle-orm";
import { requireAdmin } from "../lib/auth";
import { createLogger } from "../logger";
import { db } from "../db";
import { bookingReports, bookings } from "../../shared/schema";
import { BOOKINGS } from "../services/bookings/config";
import { RESOLUTIONS, resolveBookingIssue, type Resolution } from "../services/bookings/resolve";
import { bookingRef } from "../services/bookings/tokens";

const router = Router();
const logger = createLogger("routes/adminBookings");
router.use(requireAdmin);
router.use((_req, res, next) => { if (!BOOKINGS.enabled) { res.status(404).json({ error: "not found" }); return; } next(); });

router.get("/reports", async (req: Request, res: Response): Promise<void> => {
  const status = ["open", "in_review", "resolved"].includes(req.query.status as string) ? (req.query.status as string) : "open";
  const rows = await db.select({ r: bookingReports, title: bookings.title, bstatus: bookings.status }).from(bookingReports)
    .innerJoin(bookings, eq(bookings.id, bookingReports.booking_id))
    .where(eq(bookingReports.status, status)).orderBy(desc(bookingReports.opened_at)).limit(200);
  res.json({
    reports: rows.map(({ r, title, bstatus }) => ({
      id: r.id, bookingId: r.booking_id, ref: bookingRef(r.booking_id), title, bookingStatus: bstatus, reportedBy: r.reported_by,
      category: r.category, details: r.details, status: r.status, resolution: r.resolution, openedAt: r.opened_at.toISOString(),
    })),
  });
});

router.post("/:bookingId/resolve", async (req: Request, res: Response): Promise<void> => {
  const resolution = req.body?.resolution as Resolution;
  if (!RESOLUTIONS.includes(resolution)) { res.status(400).json({ error: "resolution must be one of " + RESOLUTIONS.join(", ") }); return; }
  const note = typeof req.body?.note === "string" ? req.body.note : null;
  try {
    res.json(await resolveBookingIssue(req.params.bookingId, resolution, note));
  } catch (err: any) {
    if (err.code === "NOT_FOUND") { res.status(404).json({ error: "not found" }); return; }
    if (["WRONG_STATE", "NO_PAYMENT", "NOT_REFUNDABLE", "CHARGEBACK_OPEN"].includes(err.code)) { res.status(409).json({ error: err.code, detail: err.detail ?? null }); return; }
    logger.error({ bookingId: req.params.bookingId, error: err.message }, "resolve failed");
    res.status(502).json({ error: "resolve failed" });
  }
});

export default router;
