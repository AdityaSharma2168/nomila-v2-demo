/**
 * publicPage.ts — the PUBLIC athlete page, /p/:handle (design: public profile v2 "Mila at the centre"; public card
 * v3.2 §11 "Public read path"). Behind PUBLIC_CARD (default off): with the flag off every route here falls through to
 * the app's 404, as if it did not exist.
 *
 *   GET  /p/:handle                     the page (swipe chapters + the notched 2×2 grid + Mila at the centre)
 *   GET  /p/:handle/:door               the no-script page for a door: partner | book | shop | create | ask | follow
 *   POST /p/:handle/partner             the no-script Partner form's target: with PARTNER_INTAKE on, the Partner door's
 *                                       own draft → email confirm path (partner/doorForm.ts); off, "opens soon".
 *   GET  /p/_a/:file, /p/_a/mila/:file  the first-party bundle and Mila's avatar loops (long-cached, versioned)
 *   GET  /p/_dev/fixtures[/:name[/:door]]  the same renderer over made-up fixtures. Dev only: never in production (flag.ts).
 *
 * The page renders a PublicCardView and nothing else. The real loader (server/index.ts) wires `loadView` to
 * publicCard/snapshotAdapter.ts, a thin adapter over the published snapshot (publicCardReader). Unknown, unpublished
 * and deleted handles all answer the same 404.
 *
 * Headers: a strict per-response CSP (setPublicPageCsp: no inline script or style), noindex unless she turned search
 * on (meta + X-Robots-Tag), Cache-Control max-age=60 with the snapshot version as the ETag. Pages reuse the per-IP
 * publicCardLimiter of /c/:shareId.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { publicCardLimiter } from "../lib/rateLimit";
import { htmlEscape, setPublicPageCsp } from "../lib/securityHeaders";
import { publicCardEnabled, publicCardFixturesEnabled } from "../services/publicCard/flag";
import { askMilaPublicEnabled } from "../services/askMila/config";
import { PUBLIC_CARD_FIXTURES } from "../services/publicCard/fixtures";
import { isDoorPage, renderDoorPage, renderPartnerResult, renderPublicCardHtml, type PartnerFormState, type RenderOptions } from "../services/publicCard/render";
import { partnerIntakeEnabled } from "../services/partner/config";
import type { DoorFormResult } from "../services/partner/doorForm";
import type { PublicCardView } from "../services/publicCard/view";
import { BOOKINGS } from "../services/bookings/config";

/** Resolves a handle to its published view, or null (unknown, unpublished, deleted — all the same). */
export type PublicCardLoader = (handle: string) => Promise<PublicCardView | null>;

/** Lowercase letters, digits and inner hyphens, 2–40 long. App words starting with "_" can never be handles. */
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/;

const BUNDLE_DIR = () => path.join(process.cwd(), "server/public/p");
const MILA_DIR = () => path.join(process.cwd(), "assets/mila");
/** The bundle files this router serves, and nothing else from that folder. */
const BUNDLE_FILES = new Set(["front.css", "front.js", "mila.js", "mila.css", "ask.js", "sheets.js", "book.js"]);
const MILA_FILES = new Set(["mila-idle.mp4", "mila-searching.mp4", "mila-generating.mp4", "mila-writing.mp4", "mila-still.png"]);

const hashCache = new Map<string, string>();
/** A short content hash for cache-busting (?v=). Cached in production; recomputed in dev so edits show at once. */
function fileVersion(full: string): string {
  if (process.env.NODE_ENV === "production" && hashCache.has(full)) return hashCache.get(full)!;
  let v = "0";
  try {
    v = crypto.createHash("sha1").update(fs.readFileSync(full)).digest("hex").slice(0, 10);
  } catch {
    /* missing file: the asset route will 404; the page still renders */
  }
  hashCache.set(full, v);
  return v;
}

/** Which visitor taps public Mila can offer: each needs its track's port wired (askMilaPublic.ts). */
export interface AskTaps { booking: boolean; partner: boolean }

/**
 * Public Mila mode for this page, or null. On only with ASK_MILA_PUBLIC (read per request), the widget bundle, and a
 * real handle's page (never the dev fixtures: they have no published snapshot for the chat to read).
 */
function askFor(handlePath: string | null, withMila: boolean, taps: AskTaps): RenderOptions["ask"] {
  return handlePath && withMila && askMilaPublicEnabled() ? { endpoint: `${handlePath}/ask`, booking: taps.booking, partner: taps.partner } : null;
}

function renderOptions(basePath: string, withMila: boolean, ask: RenderOptions["ask"] = null): RenderOptions {
  const b = (f: string) => `/p/_a/${f}?v=${fileVersion(path.join(BUNDLE_DIR(), f))}`;
  const m = (f: string) => `/p/_a/mila/${f}?v=${fileVersion(path.join(MILA_DIR(), f))}`;
  return {
    basePath,
    ask,
    publicOrigin: (process.env.PUBLIC_CARD_BASE_URL ?? "https://nomila.co").replace(/\/+$/, ""),
    assets: {
      css: b("front.css"),
      js: b("front.js"),
      milaJs: withMila ? b("mila.js") : undefined,
      milaCss: withMila ? b("mila.css") : undefined,
      askJs: ask ? b("ask.js") : undefined,
      bookJs: BOOKINGS.enabled ? b("book.js") : undefined,
      mila: {
        poster: m("mila-still.png"),
        idle: m("mila-idle.mp4"),
        searching: m("mila-searching.mp4"),
        generating: m("mila-generating.mp4"),
        writing: m("mila-writing.mp4"),
      },
    },
  };
}

/** A one-line message page. Styled by the bundle stylesheet, because the strict CSP allows no inline style. */
const msgPage = (text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
  `<meta name="robots" content="noindex, nofollow"><title>Nomila</title>` +
  `<link rel="stylesheet" href="/p/_a/front.css?v=${fileVersion(path.join(BUNDLE_DIR(), "front.css"))}"></head>` +
  `<body class="pc-body pc-body--msg"><main class="pc-msg"><p>${htmlEscape(text)}</p></main></body></html>`;

const notFound = (res: Response) => {
  setPublicPageCsp(res);
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store");
  res.status(404).type("html").send(msgPage("Page not found."));
};

/** Common page headers. `etag` null = no caching (dev fixtures). Answers 304 when the ETag matches. */
function sendPage(req: Request, res: Response, view: PublicCardView, html: string, etag: string | null): void {
  setPublicPageCsp(res);
  res.setHeader("X-Robots-Tag", view.indexable ? "all" : "noindex, nofollow");
  if (etag) {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.setHeader("ETag", etag);
    if (req.headers["if-none-match"] === etag) {
      res.status(304).end();
      return;
    }
  } else {
    res.setHeader("Cache-Control", "no-store");
  }
  res.status(200).type("html").send(html);
}

// "cf1": pages are rendered through the contact-detail filter (publicCard/contactFilter.ts); bumping it means no copy
// cached before the filter can revalidate. "bk1": the Book door reads her offers live and Ask Mila's Book panel links
// to it. With bookings on, book.js's own version is in the tag too, so a page never keeps a stale booking flow.
const pageEtag = (v: PublicCardView, door: string, ask: RenderOptions["ask"] = null) =>
  `W/"pc-${v.version}-${door}-cf1-bk1-${fileVersion(path.join(BUNDLE_DIR(), "front.css"))}${fileVersion(path.join(BUNDLE_DIR(), "front.js"))}${fileVersion(path.join(BUNDLE_DIR(), "mila.js"))}${fileVersion(path.join(BUNDLE_DIR(), "mila.css"))}` +
  (BOOKINGS.enabled ? `-k${fileVersion(path.join(BUNDLE_DIR(), "book.js"))}` : "") +
  (ask ? `-a${fileVersion(path.join(BUNDLE_DIR(), "ask.js"))}${ask.booking ? "b" : ""}${ask.partner ? "p" : ""}` : "") + `"`;

const gate = (req: Request, _res: Response, next: NextFunction) => (publicCardEnabled() ? next() : next("router"));

export interface PublicPageRouterOptions {
  /** The published-view loader. Default: none wired (every handle is a 404); server/index.ts wires snapshotAdapter's loadView. */
  loadView?: PublicCardLoader;
  /** Serve the Mila widget bundle (PR 4a). Default true; false keeps the doors as plain links. */
  mila?: boolean;
  /** Public Mila mode's wired taps (PR 5). Default none: typed questions only, while ASK_MILA_PUBLIC is on. */
  askTaps?: AskTaps;
  /** The no-script Partner form's submit (default: the Partner door's own path, partner/doorForm.ts). Tests inject. */
  submitPartnerForm?: (handle: string, body: unknown, ip: string | undefined) => Promise<DoorFormResult>;
  /**
   * Counts one view of a real page (her metrics rail; services/publicPage/stats.ts recordView, wired in index.ts so this
   * module never reaches the database). Called after the page is answered, never for a prefetch, a door page or a
   * fixture; a failure is swallowed and never reaches the visitor.
   */
  onView?: (handle: string) => Promise<unknown> | void;
  /**
   * The page drawn by the brand book's engine (services/nomiDeck front door). Returns null to fall back to the
   * published-snapshot renderer (no cached card). Wired in index.ts.
   */
  renderEngine?: (view: PublicCardView, paths: { base: string; css: string; js: string; like: string; sheets?: string; book?: string }) => Promise<string | null>;
  /** The engine page's stylesheet (served as /p/_a/nomi.css only when renderEngine is wired). */
  engineCss?: () => string;
}

/** A browser prefetch or prerender is not a view. */
const isPrefetch = (req: Request) => /prefetch|prerender/i.test(`${req.get("sec-purpose") ?? ""} ${req.get("purpose") ?? ""} ${req.get("x-moz") ?? ""}`);

/** The Partner door takes requests on this card: PARTNER_INTAKE on and her Partner tile live in this version. */
const partnerOpen = (v: PublicCardView): boolean => partnerIntakeEnabled() && v.tiles.some((t) => t.intent === "partner");

export function createPublicPageRouter(opts: PublicPageRouterOptions = {}): Router {
  // Default (no loadView passed): every handle is a 404. server/index.ts passes loadView: loadPublicCardView
  // (publicCard/snapshotAdapter.ts), the thin adapter from publicCardReader's published snapshot to PublicCardView.
  const loadView: PublicCardLoader = opts.loadView ?? (async () => null);
  const withMila = opts.mila ?? true;
  const taps: AskTaps = opts.askTaps ?? { booking: false, partner: false };
  // Loaded on first use: the form's backend reaches the database, and this public page module must not (until a form is sent).
  const submitPartnerForm = opts.submitPartnerForm
    ?? (async (handle: string, body: unknown, ip: string | undefined) => (await import("../services/partner/doorForm")).submitDoorForm(handle, body, ip));
  const router = Router();
  const inner = Router();
  router.use("/p", gate, inner);

  // ── static bundle + avatar loops ──
  inner.get("/_a/mila/:file", (req, res, next) => {
    if (!MILA_FILES.has(req.params.file)) return next();
    res.sendFile(req.params.file, {
      root: MILA_DIR(),
      maxAge: req.query.v ? "365d" : "1h",
      immutable: !!req.query.v,
      dotfiles: "deny",
    });
  });
  inner.get("/_a/:file", (req, res, next) => {
    if (!BUNDLE_FILES.has(req.params.file) || (req.params.file.startsWith("mila.") && !withMila)) return next();
    if (req.params.file === "ask.js" && !(withMila && askMilaPublicEnabled())) return next();
    res.sendFile(req.params.file, {
      root: BUNDLE_DIR(),
      maxAge: req.query.v && process.env.NODE_ENV === "production" ? "365d" : 0,
      immutable: !!req.query.v && process.env.NODE_ENV === "production",
      dotfiles: "deny",
    });
  });

  // The engine page's stylesheet (a file, so the page keeps its strict CSP: no inline style).
  if (opts.renderEngine && opts.engineCss) {
    const css = opts.engineCss;
    inner.get("/_a/nomi.css", (_req, res) => {
      res.setHeader("Cache-Control", process.env.NODE_ENV === "production" ? "public, max-age=300" : "no-store");
      res.type("text/css").send(css());
    });
  }

  // ── dev fixtures (same renderer, made-up athletes) ──
  inner.use("/_dev", (req, res, next) => (publicCardFixturesEnabled() ? next() : notFound(res)));
  inner.get("/_dev/fixtures", publicCardLimiter, (_req, res) => {
    setPublicPageCsp(res);
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "no-store");
    const links = Object.keys(PUBLIC_CARD_FIXTURES)
      .map((h) => `<li><a href="/p/_dev/fixtures/${h}">${h}</a></li>`)
      .join("");
    res.type("html").send(`<!doctype html><meta charset=utf-8><meta name=robots content="noindex"><title>Public card fixtures</title><h1>Fixtures</h1><ul>${links}</ul>`);
  });
  inner.get("/_dev/fixtures/:name", publicCardLimiter, (req, res) => {
    const view = PUBLIC_CARD_FIXTURES[req.params.name];
    if (!view) return notFound(res);
    // The heart draws on fixtures too, but nothing is sent (no endpoint): a made-up page has no likes to keep.
    const html = renderPublicCardHtml(view, { ...renderOptions(`/p/_dev/fixtures/${view.handle}`, withMila), like: { endpoint: null } });
    sendPage(req, res, view, html, null);
  });
  inner.get("/_dev/fixtures/:name/:door", publicCardLimiter, (req, res) => {
    const view = PUBLIC_CARD_FIXTURES[req.params.name];
    if (!view || !isDoorPage(req.params.door)) return notFound(res);
    const html = renderDoorPage(view, req.params.door, renderOptions(`/p/_dev/fixtures/${view.handle}`, withMila));
    sendPage(req, res, view, html, null);
  });
  inner.post("/_dev/fixtures/:name/partner", publicCardLimiter, (_req, res) => partnerNotOpen(res));

  // ── the public page ──
  const load = async (req: Request): Promise<PublicCardView | null> => {
    const handle = req.params.handle;
    if (!HANDLE_RE.test(handle)) return null;
    try {
      const v = await loadView(handle);
      return v && v.handle === handle ? v : null;
    } catch {
      return null;
    }
  };

  inner.get("/:handle", publicCardLimiter, async (req, res) => {
    const view = await load(req);
    if (!view) return notFound(res);
    let engineHtml: string | null = null;
    if (opts.renderEngine) {
      const base = `/p/${view.handle}`;
      try {
        engineHtml = await opts.renderEngine(view, { base, css: "/p/_a/nomi.css", js: `/p/_a/front.js?v=${fileVersion(path.join(BUNDLE_DIR(), "front.js"))}`, sheets: `/p/_a/sheets.js?v=${fileVersion(path.join(BUNDLE_DIR(), "sheets.js"))}`, book: BOOKINGS.enabled ? `/p/_a/book.js?v=${fileVersion(path.join(BUNDLE_DIR(), "book.js"))}` : undefined, like: `${base}/like` });
      } catch {
        engineHtml = null; // the classic page is always the fallback
      }
    }
    if (engineHtml) {
      sendPage(req, res, view, engineHtml, null);
    } else {
      const ask = askFor(`/p/${view.handle}`, withMila, taps);
      sendPage(req, res, view, renderPublicCardHtml(view, { ...renderOptions(`/p/${view.handle}`, withMila, ask), like: { endpoint: `/p/${view.handle}/like` } }), pageEtag(view, "page", ask));
    }
    if (opts.onView && !isPrefetch(req)) {
      try { Promise.resolve(opts.onView(view.handle)).catch(() => {}); } catch { /* a count never breaks the page */ }
    }
  });
  inner.get("/:handle/:door", publicCardLimiter, async (req, res) => {
    if (!isDoorPage(req.params.door)) return notFound(res);
    const view = await load(req);
    if (!view) return notFound(res);
    const o = renderOptions(`/p/${view.handle}`, withMila);
    if (req.params.door === "partner" && partnerOpen(view)) {
      // The working form: never cached (it carries the time it was drawn, for the minimum fill time).
      const kind = typeof req.query.kind === "string" ? req.query.kind : null;
      const partner: PartnerFormState = { open: true, kind, openedAt: Date.now() };
      return sendPage(req, res, view, renderDoorPage(view, "partner", { ...o, partner }), null);
    }
    sendPage(req, res, view, renderDoorPage(view, req.params.door, o), pageEtag(view, req.params.door));
  });
  // The no-script Partner form. With PARTNER_INTAKE off nothing is read or stored and the visitor is told so plainly.
  inner.post("/:handle/partner", publicCardLimiter, express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
    const view = await load(req);
    if (!view) return notFound(res);
    if (!partnerOpen(view)) return partnerNotOpen(res);
    const r = await submitPartnerForm(view.handle, req.body, req.ip);
    const o = renderOptions(`/p/${view.handle}`, withMila);
    setPublicPageCsp(res);
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "no-store");
    switch (r.status) {
      case "not_found":
        return notFound(res);
      case "sent":
        return void res.status(200).type("html").send(renderPartnerResult(view, o, { sent: true, email: r.email }));
      case "limited":
        return void res.status(429).type("html").send(renderPartnerResult(view, o, { sent: false, text: r.text }));
      case "invalid": {
        const partner: PartnerFormState = { open: true, kind: r.kind, openedAt: Number(r.values.opened_at) || Date.now(), error: { text: r.error, field: r.field }, values: r.values };
        return void res.status(400).type("html").send(renderDoorPage(view, "partner", { ...o, partner }));
      }
    }
  });

  return router;
}

function partnerNotOpen(res: Response): void {
  setPublicPageCsp(res);
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store");
  res.status(503).type("html").send(msgPage("Requests through this page open soon. Nothing was sent."));
}

export default createPublicPageRouter();
