// shopLogic — the words and small rules My Picks and Mila's pick card share (Her picks,
// docs/design/shop-her-picks.md). Pure, so it is tested without React.

/** The disclosure on every pick. PickCard draws it and has no way to hide it. */
export const DISCLOSURE = "Paid link";

export const SOURCE_LABEL: Record<string, string> = {
  amazon: "Amazon",
  shopify: "Shopify store",
  ltk: "LTK",
  shopmy: "ShopMy",
  link: "Shop link",
};

export const CATEGORY_LABEL: Record<string, string> = {
  apparel: "Apparel",
  footwear: "Footwear",
  equipment: "Equipment",
  nutrition: "Food & drink",
  supplements: "Supplements",
  beauty: "Beauty",
  tech: "Tech",
  home: "Home",
  other: "Other",
};

export const categoryLabel = (c: string | null | undefined): string | null => (c ? CATEGORY_LABEL[c] ?? c : null);

/** "$129.00" when the currency is known; "129.00" when it isn't; null without a price. */
export function formatPrice(cents: number | null | undefined, currency: string | null | undefined): string | null {
  if (cents == null || !Number.isFinite(cents) || cents < 0) return null;
  const amount = cents / 100;
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
    } catch {
      /* an unknown code falls through */
    }
  }
  return amount.toFixed(2);
}

/** What Nomila detected about her link, in one line: "Amazon · your tag her-20", "Shopify store", "Shop link". */
export function detectedLine(source: string, networkTag: string | null | undefined): string {
  const label = SOURCE_LABEL[source] ?? SOURCE_LABEL.link;
  return source === "amazon" && networkTag ? `${label} · your tag ${networkTag}` : label;
}

/** "12 clicks this week" · "1 click this week" · "No clicks yet". */
export function clicksLine(clicks7d: number, clicks30d: number): string {
  if (clicks7d > 0) return `${clicks7d} ${clicks7d === 1 ? "click" : "clicks"} this week`;
  if (clicks30d > 0) return `${clicks30d} ${clicks30d === 1 ? "click" : "clicks"} this month`;
  return "No clicks yet";
}

export const STATUS_LABEL: Record<string, string> = { draft: "Draft", live: "Live", hidden: "Hidden" };

export const AMAZON_NO_TAG = "This Amazon link has no Associates tag, so you won't earn on it. Paste the link from your Associates account.";

// ─── My Picks (PR 3) ─────────────────────────────────────────────────────────────────────────────────────────────

export const PICKS_COPY = {
  parent: "Me",
  title: "My Picks",
  lede: "Products you use, with your own links. When a fan buys through your link, the store pays you. Nomila takes nothing.",
  minor: "My Picks is for athletes 18 and older.",
  gateTitle: "Before your picks go live",
  adult: "I'm 18 or older",
  adultDone: "You confirmed you're 18 or older.",
  intlQuestion: "Are you an international student on a visa (like F-1)?",
  yes: "Yes",
  no: "No",
  intlWarning: "Earning from promotion in the US can affect your visa status. Check with your school's international student office before you publish anything.",
  intlAck: "I understand",
  addTitle: "Add a pick",
  addPlaceholder: "Paste your link",
  paste: "Paste",
  add: "Add",
  addNote: "Use your own link: your Amazon Associates link, LTK, ShopMy, or the link or code a brand gave you. Nomila never changes it.",
  added: "Added as a draft. Open it to add your words and publish.",
  existing: "That link is already on your picks.",
  listTitle: "Your picks",
  empty: "No picks yet. Paste a link above.",
  nilGoReport: "Report to NIL Go",
  nilGoUnder: "Under $600",
  settingsTitle: "Settings",
  supplements: "Supplements",
  supplementsOn: "On",
  supplementsOff: "Off",
  supplementsTurnOn: "Turn on",
  supplementsTurnOff: "Turn off",
  supplementsWarning: "You're responsible for anything you endorse under NCAA drug-testing rules, and your school may not allow supplement endorsements. Prefer products certified for sport. Turn supplements on?",
  supplementsConfirm: "Turn supplements on",
  sponsor: "Your school's apparel sponsor",
  sponsorPlaceholder: "Optional — the brand your team wears",
  sponsorNote: "Nomila warns you before you add competing apparel or footwear.",
  save: "Save",
  international: "International student",
  change: "Change",
  error: "Couldn't save that. Try again.",
} as const;

export const EDIT_COPY = {
  title: "Your pick",
  name: "Title",
  words: "In your words",
  wordsPlaceholder: "Why you use it (optional). Only your words are shown.",
  suggestion: "Suggested by Mila",
  useThis: "Use this",
  code: "Discount code",
  codePlaceholder: "Optional",
  category: "Category",
  preview: "How fans see it",
  save: "Save",
  publish: "Publish",
  publishAnyway: "I've checked — publish",
  hide: "Hide",
  delete: "Delete",
  deleteConfirm: "Tap again to delete",
  needsCategory: "Pick a category first.",
  notEligible: "Finish the questions on My Picks before you publish.",
} as const;

/** Move one id up (-1) or down (+1) in her order; the ends stay put. */
export function moveId(ids: string[], id: string, dir: -1 | 1): string[] {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const out = ids.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** "Live · 12 clicks this week" · "Draft" · "Hidden". */
export function pickMeta(status: string, clicks7d: number, clicks30d: number): string {
  const s = STATUS_LABEL[status] ?? status;
  return status === "live" ? `${s} · ${clicksLine(clicks7d, clicks30d)}` : s;
}

/** "$650" for whole dollars, else cents. */
export function dollars(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}

// ─── Server refusals ─────────────────────────────────────────────────────────────────────────────────────────────

/** A refusal the server explains: { status, code, error, warnings?, needs? }. */
export interface ShopRefusal { status: number; code: string | null; error: string; warnings?: Array<{ code: string; text: string }>; needs?: string[] }

/** apiRequest throws "<status>: <body>"; read the body back when it is the server's JSON. */
export function shopRefusal(err: unknown): ShopRefusal | null {
  const m = /^(\d{3}): ([\s\S]*)$/.exec(err instanceof Error ? err.message : "");
  if (!m) return null;
  try {
    const b = JSON.parse(m[2]);
    return { status: Number(m[1]), code: typeof b.code === "string" ? b.code : null, error: String(b.error ?? ""), warnings: b.warnings, needs: b.needs };
  } catch {
    return { status: Number(m[1]), code: null, error: m[2] };
  }
}


// ─── From your brands (PR 4) ─────────────────────────────────────────────────────────────────────────────────────

export const BRANDS_COPY = {
  title: "From your brands",
  lede: "Brands you work with that have the Nomila app on their store. Once a brand approves you, pick their products here — no link to paste.",
  ask: "Ask to feature",
  pending: "Waiting for the brand",
  declined: "Not approved",
  browse: "Browse products",
  code: (c: string) => `Your code ${c}`,
  sheetTitle: "Products",
  search: "Search products",
  add: "Add",
  added: "Added",
  none: "No products match.",
  unavailable: "Sold out",
} as const;
