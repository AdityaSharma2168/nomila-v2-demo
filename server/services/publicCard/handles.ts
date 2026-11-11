/**
 * publicCard/handles.ts — the handle rules (design-public-card-v3 §16 Q1).
 *
 *   • a handle is 3–30 of a-z 0-9 with single inner hyphens, compared lower-case;
 *   • reserved words (the app's own root routes and product words, config.ts) are never a handle;
 *   • her first pick is free; after that she may change it once per 30 days;
 *   • her old handle redirects to the new one for 90 days and nobody else can take it until then;
 *   • she can take back one of her own old handles at any time (that redirect simply ends).
 *
 * proposeHandle() suggests one from her name (accents folded, spaces → hyphens, a number appended when taken).
 * Nothing here names an athlete; names come from the data.
 */
import { and, eq, gt, lte, ne } from "drizzle-orm";
import { db as defaultDb } from "../../db";
import { publicCardHandleRedirects, publicCards } from "../../../shared/schema";
import { PUBLIC_CARD, RESERVED_HANDLES } from "./config";

type Db = typeof defaultDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Client = Db | Tx;

const DAY = 86_400_000;
const SHAPE = /^[a-z0-9](-?[a-z0-9])+$/;

export type HandleProblem = "invalid" | "reserved" | "taken" | "too_soon";

export class HandleError extends Error {
  constructor(public readonly code: HandleProblem, message: string, public readonly nextChangeAt: Date | null = null) {
    super(message);
    this.name = "HandleError";
  }
}

/** Lower-case and trim. Does not repair; validateHandle says what is wrong. */
export function normalizeHandle(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** The shape and reserved-word rules (no database). */
export function validateHandle(raw: unknown): { ok: true; handle: string } | { ok: false; code: "invalid" | "reserved" } {
  const h = normalizeHandle(raw);
  if (h.length < PUBLIC_CARD.handleMin || h.length > PUBLIC_CARD.handleMax || !SHAPE.test(h)) return { ok: false, code: "invalid" };
  if (RESERVED_HANDLES.has(h)) return { ok: false, code: "reserved" };
  return { ok: true, handle: h };
}

/** A handle-shaped slug from a name: accents folded, anything else becomes a single hyphen. */
export function slugFromName(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, PUBLIC_CARD.handleMax).replace(/-+$/g, "");
}

/** Whether `handle` is free for `athleteId`: not another athlete's current handle, not inside another's 90 days. */
export async function handleAvailable(handle: string, athleteId: string, opts: { db?: Client; now?: Date } = {}): Promise<boolean> {
  const db = opts.db ?? defaultDb;
  const now = opts.now ?? new Date();
  const [current] = await db.select({ athlete_id: publicCards.athlete_id }).from(publicCards)
    .where(and(eq(publicCards.handle, handle), ne(publicCards.athlete_id, athleteId))).limit(1);
  if (current) return false;
  const [held] = await db.select({ athlete_id: publicCardHandleRedirects.athlete_id }).from(publicCardHandleRedirects)
    .where(and(eq(publicCardHandleRedirects.handle, handle), ne(publicCardHandleRedirects.athlete_id, athleteId), gt(publicCardHandleRedirects.expires_at, now))).limit(1);
  return !held;
}

/** A free, valid handle from her name ("first-last", then "first-last-2" …). Null when the name gives nothing usable. */
export async function proposeHandle(athleteId: string, name: string, opts: { db?: Client; now?: Date } = {}): Promise<string | null> {
  let base = slugFromName(name);
  if (base.length < PUBLIC_CARD.handleMin) return null;
  if (!validateHandle(base).ok) base = `${base.slice(0, PUBLIC_CARD.handleMax - 5)}-card`.replace(/-+/g, "-");
  for (let n = 1; n <= 50; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const candidate = `${base.slice(0, PUBLIC_CARD.handleMax - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (validateHandle(candidate).ok && await handleAvailable(candidate, athleteId, opts)) return candidate;
  }
  return null;
}

/**
 * Set her handle, inside the caller's transaction. Her card row must exist. Returns the handle. Throws HandleError.
 * Changing an existing handle writes the 90-day redirect for the old one and stamps handle_changed_at.
 */
export async function setHandle(tx: Client, athleteId: string, raw: unknown, now: Date = new Date()): Promise<string> {
  const v = validateHandle(raw);
  if (!v.ok) throw new HandleError(v.code, v.code === "reserved" ? "That handle is reserved." : "A handle is 3–30 letters, numbers and single hyphens.");
  const handle = v.handle;
  const [card] = await tx.select({ handle: publicCards.handle, handle_changed_at: publicCards.handle_changed_at })
    .from(publicCards).where(eq(publicCards.athlete_id, athleteId)).for("update");
  if (!card) throw new Error("public card row missing");
  if (card.handle === handle) return handle;

  if (card.handle && card.handle_changed_at) {
    const next = new Date(card.handle_changed_at.getTime() + PUBLIC_CARD.handleChangeDays * DAY);
    if (now < next) throw new HandleError("too_soon", "A handle can change once a month.", next);
  }
  // Expired holds on this handle are released here (lazily) so they never block anyone.
  await tx.delete(publicCardHandleRedirects).where(and(eq(publicCardHandleRedirects.handle, handle), lte(publicCardHandleRedirects.expires_at, now)));
  if (!(await handleAvailable(handle, athleteId, { db: tx, now }))) throw new HandleError("taken", "That handle is taken.");

  // Taking back one of her own old handles ends that redirect.
  await tx.delete(publicCardHandleRedirects).where(and(eq(publicCardHandleRedirects.handle, handle), eq(publicCardHandleRedirects.athlete_id, athleteId)));
  if (card.handle) {
    const expires = new Date(now.getTime() + PUBLIC_CARD.handleRedirectDays * DAY);
    await tx.insert(publicCardHandleRedirects).values({ handle: card.handle, athlete_id: athleteId, expires_at: expires, created_at: now })
      .onConflictDoUpdate({ target: publicCardHandleRedirects.handle, set: { athlete_id: athleteId, expires_at: expires, created_at: now } });
  }
  try {
    await tx.update(publicCards).set({
      handle,
      // The first pick is free: only a CHANGE starts the 30-day clock.
      handle_changed_at: card.handle ? now : null,
      updated_at: now,
    }).where(eq(publicCards.athlete_id, athleteId));
  } catch (err: any) {
    if (String(err?.code ?? err?.cause?.code) === "23505" || /public_cards_handle_unique/.test(String(err?.message))) throw new HandleError("taken", "That handle is taken.");
    throw err;
  }
  return handle;
}
