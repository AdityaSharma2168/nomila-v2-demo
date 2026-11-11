/**
 * snapshotAdapter.ts — the thin adapter from a PUBLISHED snapshot (read through publicCardReader, nothing else) to
 * PublicCardView, the renderer's one input (view.ts). Wired as createPublicPageRouter({ loadView }) in server/index.ts.
 *
 *   loadView(handle)   the published card as a view, or null (unknown, unpublished, removed, an old handle, flag off —
 *                      the same 404). Old handles answer null here; the JSON read (/api/public/cards) redirects them.
 *   toView(page)       pure mapping. Copies the four tiles exactly as resolved at publish (never recomputed), rewrites
 *                      every media key to the same-origin proxy /p/:handle/m/:key, carries offers' quoted all-in totals
 *                      and picks' opaque /go codes and her words verbatim. Only what the snapshot holds can appear.
 *
 * A PUBLIC SURFACE: no schema, no db (publicCard.boundary.test.ts B3). Copy is pronoun-neutral, her first name the only
 * variable. Third-party images (brand logos, merchant product photos) are left out: the page's CSP allows images only
 * from this origin and the signed-URL bucket.
 */
import { read, type PublicCardRead } from "./publicCardReader";
import type { PublicCardContent, PublicItem } from "./types";
import type { PublicAskChip, PublicCardView, PublicChapter, PublicChapterItem, PublicOffer, PublicPick } from "./view";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 12400 → "12.4K", 2_300_000 → "2.3M", 950 → "950". */
export function compactNumber(n: number): string {
  const f = (x: number, unit: string) => `${(Math.round(x * 10) / 10).toString()}${unit}`;
  if (Math.abs(n) >= 1_000_000) return f(n / 1_000_000, "M");
  if (Math.abs(n) >= 1_000) return f(n / 1_000, "K");
  return String(Math.round(n));
}
/** "2026-10-01" → "as of 1 Oct". */
const asOfLine = (iso: string | null | undefined) => {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `as of ${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : undefined;
};
/** "2026-03" → "since Mar 2026". */
const sinceLine = (ym: string | null | undefined) => {
  const m = ym?.match(/^(\d{4})-(\d{2})/);
  return m ? `since ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : undefined;
};
const publishedLine = (iso: string) => {
  const d = new Date(iso);
  return `Published ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function itemOf(it: PublicItem, handle: string): PublicChapterItem | null {
  switch (it.kind) {
    case "stat":
      return it.value == null ? null : { type: "stat", label: it.label ?? "", value: compactNumber(it.value), ...(asOfLine(it.asOf) ? { asOf: asOfLine(it.asOf) } : {}) };
    case "beat":
      return it.text ? { type: "beat", label: cap(it.label ?? ""), text: it.text } : null;
    case "partner":
      return it.text ? { type: "partner", name: it.text, ...(sinceLine(it.since) ? { since: sinceLine(it.since) } : {}) } : null;
    case "media":
      return it.mediaKey ? { type: "media", media: { kind: it.mediaType === "video" ? "video" : "image", src: `/p/${handle}/m/${it.mediaKey}`, alt: "" } } : null;
    case "affiliation": case "proof_point": case "cause": case "value": case "venture":
      return it.text ? { type: "fact", text: it.text, ...(it.label ? { detail: it.label } : {}) } : null;
    default:
      // identity_line and quote are drawn on the athlete header; offers and picks are not chapter items.
      return null;
  }
}

const EYEBROW: Partial<Record<PublicChapter["kind"], (first: string) => string>> = {
  partnerships: () => "Signed partnerships",
  competition: () => "Career highlights",
  impact: (first) => `What ${first} stands for`,
  media: () => "Photos & videos",
};

/** Fixed question templates for chapters she published (never generated). Only while the Ask Mila door is on. */
const ASK_TEMPLATES: Partial<Record<PublicChapter["kind"], (first: string) => string>> = {
  story: (f) => `How did ${f} get started?`,
  partnerships: (f) => `Who has ${f} worked with?`,
  competition: (f) => `What has ${f} achieved?`,
  impact: (f) => `What does ${f} care about?`,
};

/** Her first published image (Highlights first, then her other chapters in her order), or null. */
export function heroOf(chapters: PublicChapter[]): PublicCardView["hero"] {
  const ordered = [...chapters.filter((c) => c.kind === "highlights"), ...chapters.filter((c) => c.kind !== "highlights")];
  for (const ch of ordered) {
    for (const it of ch.items) if (it.type === "media" && it.media.kind === "image") return { ...it.media, alt: it.media.alt ?? "" };
  }
  return null;
}

export function toView(page: Extract<PublicCardRead, { status: "ok" }>): PublicCardView {
  const c: PublicCardContent = page.content;
  const first = c.firstName;
  const highlights = c.chapters.find((ch) => ch.key === "highlights");
  const identityLine = highlights?.items.find((i) => i.kind === "identity_line")?.text ?? undefined;
  const quote = highlights?.items.find((i) => i.kind === "quote")?.text ?? undefined;
  const source = publishedLine(page.publishedAt);

  const chapters: PublicChapter[] = c.chapters.map((ch) => ({
    id: ch.key,
    kind: ch.key,
    title: ch.title,
    headline: ch.key === "highlights" ? c.displayName : ch.title,
    ...(EYEBROW[ch.key] ? { eyebrow: EYEBROW[ch.key]!(first) } : {}),
    items: ch.items.map((i) => itemOf(i, page.handle)).filter((x): x is PublicChapterItem => !!x),
    media: null,
    source,
  }));

  const offers: PublicOffer[] = c.offers.filter((o) => o.totalCents != null).map((o) => ({
    id: o.key,
    title: o.text ?? "",
    durationMin: o.durationMinutes ?? 0,
    format: o.locationMode === "in_person" ? "in_person" : "virtual",
    allInMinor: o.totalCents!,
    currency: (o.currency ?? "usd").toUpperCase(),
    note: "Includes the Nomila service fee",
  }));

  const picks: PublicPick[] = c.picks.map((p) => {
    const goCode = (p.href ?? "").split("/").pop() ?? "";
    return {
      id: p.key, title: p.text ?? "", merchant: p.merchant ?? "",
      ...(p.priceCents != null ? { priceMinor: p.priceCents } : {}),
      ...(p.currency ? { currency: p.currency.toUpperCase() } : {}),
      ...(p.blurb ? { herWords: p.blurb } : {}),
      goCode,
      ...(p.amazon ? { amazon: true } : {}),
    };
  }).filter((p) => !!p.goCode);

  const askChips: PublicAskChip[] = c.doors.ask_mila
    ? chapters.filter((ch) => ASK_TEMPLATES[ch.kind]).map((ch) => ({ label: ASK_TEMPLATES[ch.kind]!(first), chapterId: ch.id }))
    : [];

  return {
    handle: page.handle,
    version: page.version,
    publishedAt: page.publishedAt,
    indexable: page.indexable,
    athlete: {
      firstName: first,
      lastName: c.lastName,
      ...(identityLine ? { identityLine } : {}),
      ...(quote ? { quote } : {}),
      verified: c.verified,
    },
    // The Highlights card is about her, so it opens on her own published photo (DESIGN.md §9): the first image she put
    // on her page. None published → the card's own ground.
    hero: heroOf(chapters),
    chapters,
    // Exactly as resolved at publish (resolveTileSlots); never recomputed here.
    tiles: c.tiles,
    offers,
    picks,
    socials: c.socials,
    askChips,
    askMila: !!c.doors.ask_mila,
  };
}

/** createPublicPageRouter's loader: her published view, or null for everything else. */
export async function loadView(handle: string): Promise<PublicCardView | null> {
  const r = await read(handle);
  return r.status === "ok" ? toView(r) : null;
}
