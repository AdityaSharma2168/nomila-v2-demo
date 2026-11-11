/**
 * brandName.ts — the brand-name keys, pure and import-free so any module (and any test that
 * mocks brandResolver) can use them. brandResolver re-exports normalizeBrand from here.
 */

/**
 * Identity-grade brand normalization (dedup + advertiser matching key).
 * lowercase → strip "(via …)" parentheticals → strip legal-entity suffixes
 * (inc/llc/ltd/corp/co/gmbh/plc/group) → punctuation → collapse whitespace.
 * Deliberately does NOT strip product tokens like "tech"/"golf" — those
 * distinguish real brands (Nike vs Nike Tech), per the dedup-key review.
 */
export function normalizeBrand(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(inc|llc|ltd|corp|co|gmbh|plc|group)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The key two rows must share to be the same brand: normalizeBrand with spacing ignored too. */
export function sameNameKey(name: string | null | undefined): string {
  return normalizeBrand(name).replace(/ /g, "");
}

// A legal-entity name's regional tail ("adidas America Inc.", "Nike USA, LLC"): the regional arm of the same company.
// Stripped ONLY when the raw name carries a legal suffix — "Air Canada" and "Hockey Canada" are names, not arms — and
// never after "of" ("Bank of America, N.A." stays).
const LEGAL_SUFFIX = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|gmbh|ag|plc|bv|nv|pty)\.?\s*$/i;
const REGION_TAIL = /\s+(north america|america|usa|us|europe|emea|uk|canada)$/;

/** sameNameKey with a legal-entity name's regional tail dropped: "adidas America Inc." and "adidas" share "adidas". */
export function brandIdentityKey(name: string | null | undefined): string {
  const raw = String(name ?? "").replace(/[\s,.]+$/, "").trim();
  let n = normalizeBrand(raw);
  if (LEGAL_SUFFIX.test(raw) && !/\bof( the)? \S+$/.test(n)) {
    const stripped = n.replace(REGION_TAIL, "").trim();
    if (stripped) n = stripped;
  }
  return n.replace(/ /g, "");
}

/** True when two brand names are the same company: the same name key, or the same identity key. */
export function sameBrandName(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = sameNameKey(a);
  if (!ka) return false;
  return ka === sameNameKey(b) || brandIdentityKey(a) === brandIdentityKey(b);
}

/**
 * A brand row whose name is a DESCRIPTION, not a name ("Home Improvement Brand", "a leading
 * skincare company"). Review heuristic for the read-only report only — it never gates ingest.
 */
export function looksGenericBrandName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return false;
  if (/^(a|an)\s/.test(n)) return true;
  if (/^unknown\b/.test(n)) return true;
  return /\b(brand|brands|company|companies|client|startup|business|retailer)\b/.test(n);
}
