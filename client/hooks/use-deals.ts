import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";
import { domainFromLogoUrl } from "../lib/brand-logo";
import type { DealItem, DealCategory, DealStatus, DealSource } from "../components/deals/DealCard";

type BrandSource = NonNullable<DealItem["brandSources"]>[number];
import { invalidateDealQueries } from "../lib/dealQueryKeys";

// ─── API shape (GET /api/v1/me/deals) ────────────────────────────────────────

interface ApiDealRawData {
  category?:     string;
  summary?:      string;
  deliverables?: string[];
  thread_id?:    string;
}


/**
 * A deal's money when it has a SCHEDULE — a contract running over periods, rather than one
 * figure. Cents on the wire; the client formats. Absent for ordinary single-figure deals,
 * and absence means exactly that, never "worth nothing".
 */
export interface DealMoney {
  basis:                "schedule" | "none";
  currency:             string;
  tcvCents:             number | null;   // whole term, guaranteed
  acvCents:             number | null;   // this contract year
  aavCents:             number | null;   // average per year
  remainingCents:       number | null;
  scheduledToDateCents: number | null;   // DUE by now — not "earned"; see dealValue.ts
  directedCents:        number | null;   // charitable; shown, never counted
  conditionalCents:     number | null;
  /** Periods whose cash we could not establish. NULL IS NOT ZERO — see dealValue. */
  unknownCashPeriods:   number[];
  acvUnknown:           boolean;
  currentPeriod:        {
    seq: number; label: string | null;
    starts_on: string | null; ends_on: string | null;
    cash_cents: number | null; product_cents: number | null;
    guaranteed: boolean; condition: string | null;
  } | null;
  periodCount:          number;
  guaranteedCount:      number;
  reconciled:           boolean;
  /** Economics-only read for a scheduled deal nothing has scored. Fit is absent by design. */
  economics:            { band: string; detail: string } | null;
  termMonths:           number | null;
}

export interface ApiDeal {
  id:                 string;
  brand_name:         string;
  deal_type:          string;
  amount:             string | null;
  money:              DealMoney | null;
  /** Contract term. Already crossed the wire before this; nothing mapped it. */
  term_start:         string | null;
  term_end:           string | null;
  /** The opportunity this deal belongs to (Opportunities PR 3): the one detail screen opens by it. */
  opportunity_id?:    string | null;
  status:             string;
  saved:              boolean | null;
  detected_at:        string;
  raw_data:           ApiDealRawData | null;
  classification:     Record<string, any> | null;
  conversation_state: Record<string, any> | null;
  latest_draft:       { body: string; tone: string; generated_at: string } | null;
  thread_id:          string | null;
  thread_status:      string | null;
  brand_id:           number | null;
  subject:            string | null;
  summary:            string | null;
  source:             string | null;
  /** Always null: the deal score is gone (inbox_threads.score dropped in 0088). Kept on the wire for older builds. */
  score:              null;
  last_message_at:    string | null;
  brand_logo:                 string | null;
  brand_image:                string | null;
  brand_images:               string[] | null;
  brand_category:             string | null;
  brand_description?:         string | null;
  brand_audience_summary?:    string | null;
  brand_sources?:             unknown;
  brand_sport_categories?:    string[] | null;
  brand_known_partnerships?:  string[] | null;
  message_count?:             number;
  // Number of deals (email threads) collapsed into this one via cross-thread grouping. 1 = solo.
  group_size?:                number;
  // WS2/WS3: Mila's agent voice, composed server-side (single source of truth).
  voice?: { line: string; factLine: string | null; primaryActionLabel: string } | null;
}

/** Mila's composed agent voice for a deal (from `composeDealVoice`, server-side). */
export interface DealVoice {
  line: string;
  factLine: string | null;
  primaryActionLabel: string;
}

// ─── Stats for MoneyHero ──────────────────────────────────────────────────────

export interface MoneyStats {
  totalAmount:      number;
  newCount:         number;
  negotiatingCount: number;
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

const VALID_CATEGORIES = new Set<DealCategory>(["PAID", "MEDIA", "EDITORIAL", "GIFTING"]);
const VALID_STATUSES   = new Set<DealStatus>(["detected","pending","negotiating","accepted","completed","rejected"]);

function mapCategory(classification: Record<string, any> | null | undefined, raw: string | undefined): DealCategory {
  const cat = (classification?.category ?? raw)?.toUpperCase() as DealCategory;
  return VALID_CATEGORIES.has(cat) ? cat : "PAID";
}

function mapStatus(raw: string): DealStatus {
  return VALID_STATUSES.has(raw as DealStatus) ? (raw as DealStatus) : "detected";
}

// Map the thread's source platform → deal card source + label. Falls back to
// gmail/Email for legacy rows where platform wasn't recorded.
function mapSource(platform: string | null | undefined): { source: DealSource; sourceType: "Email" | "DM" } {
  switch (platform) {
    case "instagram": return { source: "instagram", sourceType: "DM" };
    case "outlook":   return { source: "outlook",   sourceType: "Email" };
    default:          return { source: "gmail",     sourceType: "Email" };
  }
}

function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return "";
  const diff  = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60_000);
  if (mins < 60)  return `${mins}m ago`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days  = Math.floor(diff / 86_400_000);
  if (days < 7)   return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatOfferAmount(amount: string | null): string | undefined {
  if (!amount) return undefined;
  const n = Number(amount);
  if (!isFinite(n) || n <= 0) return undefined;
  return `$${n.toLocaleString("en-US")}`;
}

function mapToDealItem(d: ApiDeal): DealItem {
  const rawData = d.raw_data ?? {};
  const { source, sourceType } = mapSource(d.source);
  return {
    id:           d.id,
    brandName:    d.brand_name,
    // inbox_brands.id (via inbox_threads.brand_id) — the numeric id the pitch flow needs.
    brandId:      d.brand_id ?? null,
    opportunityId: d.opportunity_id ?? null,
    // Resolved brand identity (display-only) — from the classification re-attribution.
    advertiser:   (d.classification?.advertiser as string | null) ?? null,
    agencyName:   (d.classification?.agency_name as string | null) ?? null,
    viaAgency:    d.classification?.via_agency === true,
    qualification: typeof d.classification?.qualification === "string" ? d.classification.qualification : null,
    channel: typeof d.classification?.channel === "string" ? d.classification.channel : null,
    // The classifier's own category, unmapped (SCHOOL_NIL has no card category and maps to PAID above).
    sourceCategory: typeof d.classification?.category === "string" ? d.classification.category : null,
    // Any stored logo form (Yoku, favicon, old Clearbit) yields the domain; Clearbit-only parsing lost upgraded rows.
    brandDomain:  domainFromLogoUrl(d.brand_logo),
    category:     mapCategory(d.classification, rawData.category),
    status:       mapStatus(d.status),
    saved:        d.saved ?? false,
    verdict:      null, // the deal score is gone (0088)
    source,
    sourceType,
    score:        null, // the deal score is gone (0088)
    timeAgo:      formatTimeAgo(d.last_message_at ?? d.detected_at),
    aiSummary:    d.summary ?? rawData.summary ?? d.subject ?? "",
    deliverables: rawData.deliverables,
    offerAmount:   formatOfferAmount(d.amount),
    money:         d.money ?? null,
    termStart:     d.term_start ?? null,
    termEnd:       d.term_end ?? null,
    deadline:              (d.classification?.deadline as string | null) ?? null,
    detectedAt:            d.detected_at,
    lastMessageAt:         d.last_message_at ?? null,
    latestComms:           (d.conversation_state as any)?.conversation_state as string | undefined,
    convAsk:               (d.conversation_state as any)?.key_details?.ask as string | undefined,
    offerDisplay:          (d.conversation_state as any)?.offer_display as string | undefined,
    // Ordered stated $ figures (negotiation progression) — surfaced for the In-Flight
    // timeline; monthlyEstimate below is a derived summary of the same array.
    offerHistory:          (() => {
      const amounts = (d.conversation_state as any)?.key_details?.amounts as number[] | undefined;
      if (!Array.isArray(amounts)) return undefined;
      const clean = amounts.filter((a): a is number => typeof a === "number" && isFinite(a) && a > 0);
      return clean.length > 0 ? clean : undefined;
    })(),
    // No "Est. monthly": the old guess took the largest stated figure as a monthly rate, but key_details.amounts is
    // cash first, then product — "$2,000 cash + $6,500 product" read "~$6,500/mo" (audit E §1.4). A real monthly fee
    // reads from the term sheet's fee unit, on the deal letter.
    monthlyEstimate:       undefined,
    messageCount:          (d as any).message_count as number | undefined,
    lastContact:           (d.conversation_state as any)?.key_details?.last_contact as string | undefined,
    awaitingResponseFrom:  (d.conversation_state as any)?.key_details?.awaiting_response_from as string | undefined,
    hasDraft:              !!d.latest_draft,
    draftTone:             (d.latest_draft as any)?.tone as string | undefined,
    // The saved draft text itself, so reopening a deal restores what you were writing
    // instead of an empty editor. Already on the list payload — no extra fetch.
    draftBody:             (d.latest_draft as any)?.body as string | undefined,
    // What the saved draft was written to DO. A draft written to accept must not be
    // restored into a sheet the athlete opened to negotiate — Send is live on mount,
    // so that would be one tap from mailing an acceptance as a counter.
    draftIntent:           (d.latest_draft as any)?.reply_intent as string | undefined,
    // The researched brand category (inbox_brands).
    brandCategory:         d.brand_category ?? undefined,
    // Real brand imagery (inbox_brands.image_url / images) — cover for the card, ranked set
    // for the deal-detail brand-deck hero. Absent until brand research/backfill has run.
    brandCover:            d.brand_image ?? undefined,
    brandImages:           d.brand_images ?? undefined,
    groupSize:             d.group_size ?? undefined,
    brandDescription:        d.brand_description ?? undefined,
    brandAudienceSummary:    d.brand_audience_summary ?? undefined,
    brandSources:            Array.isArray(d.brand_sources) ? (d.brand_sources as BrandSource[]) : undefined,
    brandSportCategories:    d.brand_sport_categories ?? undefined,
    brandKnownPartnerships:  d.brand_known_partnerships ?? undefined,
    threadId:                d.thread_id ?? null,
    threadStatus:            d.thread_status ?? null,
    voice:                   d.voice ?? undefined,
  };
}

function computeMoneyStats(rawDeals: ApiDeal[]): MoneyStats {
  const active = rawDeals.filter((d) =>
    d.status === "detected" || d.status === "pending" || d.status === "negotiating"
  );
  return {
    totalAmount:      active.reduce((sum, d) => sum + (Number(d.amount) || 0), 0),
    newCount:         rawDeals.filter((d) => d.status === "detected").length,
    negotiatingCount: rawDeals.filter((d) => d.status === "negotiating").length,
  };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export type DealView = "active" | "archived" | "all";

/**
 * The deal list, for ONE view.
 *
 * Defaults to "active" — filed deals are not fetched at all. For the athlete with 204 deals
 * that is 35 rows instead of 100, because 169 archived ones used to be shipped and discarded
 * by the client on arrival. Ordering archived last stopped them HIDING live deals; asking for
 * a view stops them being fetched.
 *
 * Archived is loaded lazily by whoever shows that tab, so those rows only cross the wire when
 * somebody actually looks at them.
 */
export function useDeals(view: DealView = "active", enabled: boolean = true) {
  const query = useQuery<ApiDeal[]>({
    queryKey: [`/api/v1/me/deals?view=${view}`],
    // Lazy on purpose: the Archived view passes false until the athlete opens that tab, so
    // 169 filed rows are never fetched for a screen showing 35 live ones.
    enabled,
  });

  const rawDeals  = query.data ?? [];
  // The server's order IS the order (GET /me/deals follows the opportunity board; the deal score is retired),
  // so the client never re-sorts. It used to sort by the score, which now would only reorder by recency.
  const sortedRaw = rawDeals;
  const deals     = sortedRaw.map(mapToDealItem);
  const moneyStats = computeMoneyStats(rawDeals);

  return {
    deals,
    moneyStats,
    isLoading: query.isLoading,
    error:     query.error as Error | null,
    refetch:   query.refetch,
  };
}

// ─── useDealPreferences / useUpdatePreferences ────────────────────────────────

/** Deal-type keys for per-type floors — mirror `DealTypeRates` / the server's MINIMUM_RATE_KEYS. */
export type RateFloorKey = "socialPost" | "appearance" | "ambassador" | "autograph" | "licensing";

export interface DealPreferences {
  minimum_rate?:  number;                          // legacy single floor (negotiate-draft path)
  minimum_rates?: Partial<Record<RateFloorKey, number>>;  // per-type floors (WS2 rate settings)
  agent_name?:    string;
  agency_name?:   string;
  /** The team member's role ("Manager"): signed under their name when she sends as her team (D2). */
  agent_role?:    string;
}

export function useDealPreferences() {
  return useQuery<{ deal_preferences: DealPreferences | null }>({
    queryKey: ["/api/v1/me/preferences"],
    queryFn: () => apiRequest("GET", "/api/v1/me/preferences").then((r) => r.json()),
  });
}

export function useUpdatePreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (prefs: Partial<DealPreferences>) =>
      apiRequest("PATCH", "/api/v1/me/preferences", prefs).then((r) => r.json()),
    onSuccess: () => {
      invalidateDealQueries(qc);
      qc.invalidateQueries({ queryKey: ["/api/v1/me/preferences"] });
    },
  });
}

/**
 * One deal, in the same shape the list produces.
 *
 * Deal Detail used to resolve its deal with `deals.find()` over the full list, which is what
 * made the list a client-side store — and why the list cannot be paged or filtered
 * server-side without the detail screen breaking for anything outside the page.
 *
 * This fetches `?id=` from the SAME endpoint and runs the SAME `mapToDealItem`, so the shape
 * is identical by construction. The alternative — pointing the screen at GET /deals/:id —
 * returns a different, nested payload and would need a second mapper across ~25 fields, where
 * every field it got subtly wrong is a silent rendering bug rather than a crash.
 *
 * `enabled` is false without an id so the hook is safe to call before navigation params land.
 */
export function useDeal(dealId: string | undefined) {
  const query = useQuery<ApiDeal[]>({
    queryKey: [`/api/v1/me/deals?id=${dealId}`],
    enabled:  !!dealId,
  });

  const raw = query.data?.[0];
  return {
    deal:      raw ? mapToDealItem(raw) : null,
    isLoading: query.isLoading,
    error:     query.error as Error | null,
    refetch:   query.refetch,
  };
}

/**
 * How many deals are live and how many are filed — two integers from the server.
 *
 * The archived count used to be derived by counting archived rows the client already held.
 * It no longer holds them, so the server counts instead: cheaper than shipping 169 rows to
 * produce one number.
 *
 * NOTE this count is GLOBAL, not scoped to the search box, because the rows behind it are not
 * loaded until the Archived tab is opened. Every other stage count stays client-side and
 * search-accurate; only this one is a total.
 */
export function useDealCounts() {
  const query = useQuery<{ active: number; archived: number }>({
    queryKey: ["/api/v1/me/deals/counts"],
  });
  return {
    active:    query.data?.active ?? 0,
    archived:  query.data?.archived ?? 0,
    isLoading: query.isLoading,
  };
}
