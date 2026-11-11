/**
 * nomiDeck — the Nomi Card (pitch + public page) on the brand book's engine (21 Oct 2026). Always on since NOMI_ENGINE_V1
 * was retired (2 Nov 2026); a look the engine does not draw still falls back to the legacy kitRenderer.
 *
 *   renderNomiForWeb(kit, opts)  path-form kit → treated photos (lib/photoTreat, $0, cached) → signed → HTML
 */
import { signedUrl } from "../../lib/mediaStore";
import { signKit, withoutRetiredCards } from "../kitCache";
import type { MediaKitData } from "../mediaKitService";
import { deckLookOf, frontDoors, type DeckLook, type FrontDoorOffer } from "./layout";
import { frontDoorCss, nomiDeckCss, renderFrontDoorHtml, renderNomiDeckHtml, type DeckDoor } from "./render";
import { treatKitImages } from "./treat";
import { fillKitAtmosphere } from "./atmosphere";
import { treatedPath, type PhotoLook } from "../../lib/photoTreat";

export { planDeck, deckLookOf, editionOf, DECK_LOOKS, frontDoors, bookLine } from "./layout";
export { renderNomiDeckHtml, nomiDeckCss, renderFrontDoorHtml, frontDoorCss } from "./render";

/** Is this card look one the engine draws? (Luxe and Campaign; any other theme stays on its legacy renderer.) */
export function engineDrawsTheme(theme: string | null | undefined): boolean {
  return !theme || theme === "luxe" || theme === "campaign";
}

export interface RenderForWebOpts {
  theme?: string | null;
  mode?: "deck" | "page";
  doors?: DeckDoor[];
  partnerHref?: string | null;
  /** Page mode on a surface whose CSP allows inline style (the owner preview); the public route serves the CSS file. */
  inlineCss?: boolean;
  cssHref?: string;
}

export interface FrontDoorForWebOpts {
  theme?: string | null;
  first: string;
  /** The athlete's door switches as published (Partner defaults on). */
  partnerOn: boolean;
  bookOn: boolean;
  shopOn: boolean;
  offers?: FrontDoorOffer[];
  /** Where the doors go: `${basePath}/partner` etc. */
  basePath: string;
  handle?: string | null;
  likeEndpoint?: string | null;
  cssHref?: string;
  inlineCss?: boolean;
  jsHref?: string;
  claimHref?: string;
  /** sheets.js URL (public route): each door opens in a slide-up sheet. */
  sheetsJsHref?: string;
  /** book.js URL: the Book door runs the request flow inside its sheet (Bookings PR2). */
  bookJsHref?: string;
  /** OWNER VIEW ONLY: the metrics rail. Never set on the public route. */
  metrics?: import("./render").OwnerRailItem[] | null;
}

/** The public page (front door v2.1, simplified) from a path-form kit. Treatments are $0 and cached. */
export async function renderFrontDoorForWeb(kit: MediaKitData, o: FrontDoorForWebOpts): Promise<string> {
  const look: DeckLook = deckLookOf(o.theme ?? kit.tokens?.theme);
  const clean = withoutRetiredCards(kit);
  const { kit: treated, backdrops, coverFit } = await treatKitWithAtmosphere(clean, look);
  const signed = await signKit(treated);
  const sign = (p: string) => (/^https?:/i.test(p) ? Promise.resolve(p) : signedUrl(p));
  const pool = await Promise.all((treated.imagePool ?? []).slice(0, 12).map(async (p) => ({ ...p, gcsPath: (await sign(p.gcsPath)) ?? p.gcsPath })));
  const signedBackdrops = Object.fromEntries(await Promise.all(Object.entries(backdrops).map(async ([k, p]) => [k, (await sign(p)) ?? p] as const)));
  const { doors, arrangement } = frontDoors({ first: o.first, partnerOn: o.partnerOn, bookOn: o.bookOn, shopOn: o.shopOn, offers: o.offers });
  return renderFrontDoorHtml({ ...signed, imagePool: pool }, {
    look, backdrops: signedBackdrops, coverFit, arrangement,
    doors: doors.map((d) => ({ ...d, href: `${o.basePath}/${d.key}` })),
    handle: o.handle ?? null, likeEndpoint: o.likeEndpoint, cssHref: o.cssHref, inlineCss: o.inlineCss, jsHref: o.jsHref, sheetsJsHref: o.sheetsJsHref, bookJsHref: o.bookJsHref, claimHref: o.claimHref, metrics: o.metrics ?? null,
  });
}

/** The front door's stylesheet as one file (served at /p/_a/nomi.css under the strict public CSP). */
export function frontDoorStylesheet(): string {
  return nomiDeckCss() + frontDoorCss();
}

/** A path-form kit (as cached) → the engine's HTML. Treatments are $0 and cached; signing is the only per-view work. */
export async function renderNomiForWeb(kit: MediaKitData, o: RenderForWebOpts = {}): Promise<string> {
  const look: DeckLook = deckLookOf(o.theme ?? kit.tokens?.theme);
  const clean = withoutRetiredCards(kit);
  const { kit: treated, backdrops, coverFit } = await treatKitWithAtmosphere(clean, look);
  const signed = await signKit(treated);
  const sign = (p: string) => (/^https?:/i.test(p) ? Promise.resolve(p) : signedUrl(p));
  const pool = await Promise.all((treated.imagePool ?? []).slice(0, 12).map(async (p) => ({ ...p, gcsPath: (await sign(p.gcsPath)) ?? p.gcsPath })));
  const signedBackdrops = Object.fromEntries(await Promise.all(Object.entries(backdrops).map(async ([k, p]) => [k, (await sign(p)) ?? p] as const)));
  const html = renderNomiDeckHtml({ ...signed, imagePool: pool }, {
    look, mode: o.mode ?? "deck", backdrops: signedBackdrops, coverFit, doors: o.doors, partnerHref: o.partnerHref ?? null, cssHref: o.cssHref,
  });
  if (o.mode === "page" && o.inlineCss) {
    const { nomiDeckCss } = await import("./render");
    return html.replace(/<link rel="stylesheet" href="[^"]*"><\/head>/, `<style>${nomiDeckCss()}</style></head>`);
  }
  return html;
}

/** The kit with places filled and treated, ready to sign: treatKitImages plus the cover's toned place backdrop. */
async function treatKitWithAtmosphere(kit: MediaKitData, look: PhotoLook): ReturnType<typeof treatKitImages> {
  const { kit: withPlaces, coverBackdrop } = await fillKitAtmosphere(kit);
  const res = await treatKitImages(withPlaces, look);
  const coverId = withPlaces.cards.find((c) => c.type === "cover")?.id;
  if (coverBackdrop && coverId && !res.backdrops[coverId]) {
    res.backdrops[coverId] = await treatedPath(coverBackdrop, { shape: "statement", treatment: "tonal", look, face: null }).catch(() => coverBackdrop);
  }
  return res;
}
