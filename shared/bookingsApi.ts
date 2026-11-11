/**
 * shared/bookingsApi.ts — the wire types of the Bookings v2 API, shared by the server (which builds them in
 * server/services/bookings/views.ts) and the app (which renders them). One definition, so a screen always renders the
 * real typed response.
 *
 * Money is INTEGER CENTS. Times are ISO strings (the app formats them in her time zone; buyer pages in the buyer's).
 * Her side never carries the buyer's email or phone: the buyer is a first name + initial.
 */

export type BookingStatusWire =
  | "unverified" | "requested" | "accepted" | "confirmed" | "in_review" | "issue_reported" | "disputed"
  | "released" | "declined" | "withdrawn" | "expired" | "canceled" | "refunded";

export type OfferFormat = "video_call" | "appearance" | "clinic" | "custom";
export type LocationMode = "virtual" | "in_person";
export type OfferStatus = "draft" | "published" | "paused" | "archived";
export type PausedReason = "athlete" | "no_show_review" | "support";
/**
 * Who a session is for (0153). one = 1:1 (the default). private_group = ONE fan books the whole time for themselves +
 * friends (party size 1..maxPeople). open_group = strangers each book and pay for their own spot until maxPeople.
 * Her price is PER PERSON: a booking's total is price × party size (+ the one Nomila service fee on that total).
 */
export type Audience = "one" | "private_group" | "open_group";

/**
 * Her weekly hours for a session (0155, offers.availability): the hours fans can book, per day of HER week, that the
 * app turns into open times (back-to-back starts by the session's length inside each block). Kept so the editor can
 * reopen them; the open times themselves are still offer_slots.
 *   day    0 = Sunday … 6 = Saturday, in the offer's time zone (offers.time_zone, her phone's)
 *   start  minutes after midnight, a multiple of 15 (0..1425); end the same, after start (≤ 1440 = midnight)
 *   preset the quick start she began from, if the hours still match it (null when she shaped them herself)
 */
export type HoursPreset = "weekday_evenings" | "weekends" | "after_practice";
export interface HoursBlockView { day: number; start: number; end: number }
export interface WeeklyAvailability {
  version: 1;
  preset:  HoursPreset | null;
  blocks:  HoursBlockView[];
}

export interface QuoteView {
  priceCents:           number; // her price — what she receives
  serviceFeeCents:      number; // the ONE "Nomila service fee" line buyers see
  buyerTotalCents:      number; // all-in, the same for every payment method
  athleteReceivesCents: number;
  currency:             string;
  /** Group sessions: her per-person price and the people this quote covers (priceCents = unit × partySize). */
  unitPriceCents?:      number;
  partySize?:           number;
}

export interface PayoutStatusView {
  hasAccount:      boolean;
  /** Stripe can send money to her bank (payouts on + transfers active). Publish is gated on this. */
  ready:           boolean;
  /** Stripe's own missing items, as Stripe names them (the app turns them into plain words). */
  requirementsDue: string[];
}

export interface OfferView {
  id:                    string;
  publicId:              string;
  format:                OfferFormat;
  title:                 string;
  description:           string | null;
  priceCents:            number;
  durationMinutes:       number;
  locationMode:          LocationMode;
  videoMode:             "livekit" | "link" | null;
  venue:                 string | null;
  venueConfirmed:        boolean;
  requireIdVerification: boolean;
  allowMinorAttendees:   boolean;
  returningBuyersOnly:   boolean;
  schedulingMode:        "slots" | "request";
  availableFrom:         string | null;
  availableUntil:        string | null;
  freeCancelHours:       number;
  status:                OfferStatus;
  pausedReason:          PausedReason | null;
  adultAttested:         boolean;
  /** Who it's for (0153). priceCents is per person; quote is for ONE person. */
  audience:              Audience;
  /** 1 for one; 2..20 for a group (private: the most people one booking can bring; open: the spots per time). */
  maxPeople:             number;
  /** Open groups only (0154): each spot waits for her Accept instead of confirming itself. False for anything else. */
  approveEachSpot:       boolean;
  /** Her weekly hours (0155), or null (request mode, or an offer from before flexible hours). */
  availability:          WeeklyAvailability | null;
  quote:                 QuoteView;
  openSlots:             number;
  liveBookings:          number;
  updatedAt:             string;
}

export interface SlotView {
  id:        string;
  startsAt:  string;
  endsAt:    string;
  /** A live booking (a request in progress, or a booked session) holds it. Open group: every spot is held (full). */
  taken:     boolean;
  /** People this time holds (1 for one / private_group; maxPeople for open_group), how many are held, how many are left. */
  capacity:   number;
  spotsTaken: number;
  spotsLeft:  number;
}

export interface BookingsSummaryView {
  payouts:            PayoutStatusView;
  offers:             { published: number; draft: number; paused: number };
  /** Her offers are paused by Nomila (2 missed sessions) until support reviews them. */
  pausedByNomila:     boolean;
  /** Requests waiting on her answer, and the soonest deadline among them. */
  requests:           number;
  nextRespondBy:      string | null;
  upcoming:           number;
  /** The section in Opportunities shows only once she has a published offer (app layout B). */
  showSection:        boolean;
  limits:             { minPriceCents: number; maxPriceCents: number; durationOptions: number[]; freeCancelHoursOptions: number[]; freeCancelHoursDefault: number; maxProposedTimes: number };
  respondHours:       number;
  supportEmail:       string;
}

/** Where a booking stands, in her words. The app maps each to its plain line ("Waiting for your answer" …). */
export type BookingPhase =
  | "request"          // waiting on her yes or no
  | "waiting_buyer"    // she proposed other times; the buyer picks one
  | "waiting_payment"  // she accepted; the hold had lapsed, the buyer has a pay link
  | "booked"           // paid, before the start
  | "happening"        // between the start and the end
  | "finished"         // ended; she's paid when the buyer confirms or the clock runs
  | "on_hold"          // a report or a chargeback is open
  | "paid"             // her money was sent
  | "declined" | "withdrawn" | "expired" | "canceled" | "refunded";

export interface BookingChecksView {
  email:        boolean;
  phone:        boolean;
  idChecked:    boolean;
  adult:        boolean;
  /** A parent booking for a child (her offer allows it), who attests they'll be there. */
  parent:       boolean;
}

export interface ProposedTimeView { start: string; tz: string | null }

export interface BookingListItemView {
  id:           string;
  status:       BookingStatusWire;
  phase:        BookingPhase;
  buyerLabel:   string;          // "Jordan P." — never contact details
  title:        string;
  format:       OfferFormat;
  locationMode: LocationMode;
  startsAt:     string | null;
  endsAt:       string | null;
  proposedTimes: ProposedTimeView[];
  respondBy:    string | null;
  receiveCents: number;          // her price × party size: what she receives
  /** 0153: who it was for, how many people this booking covers, her per-person price, and the time it holds. An open
   *  group's bookings share one slotId: the app shows them as ONE item from GET /bookings/groups. */
  audience:     Audience;
  partySize:    number;
  unitPriceCents: number;
  slotId:       string | null;
  checks:       BookingChecksView;
  createdAt:    string;
  unreadMessages: number;
}

export interface BookingTimelineEntry { at: string; kind: "requested" | "accepted" | "paid" | "proposed" | "picked" | "session_done" | "no_show" | "reported" | "paid_out" | "declined" | "withdrawn" | "expired" | "canceled" | "refunded"; by: "you" | "buyer" | "nomila" }

export interface BookingActionsView {
  accept:      boolean;
  decline:     boolean;
  propose:     boolean;
  cancel:      boolean;
  /** "Buyer didn't show": true once open; else when it opens (null when it never will). */
  noShow:      boolean;
  noShowAt:    string | null;
  sessionDone: boolean;
  message:     boolean;
  /** 0154: "Block <name>" on the booking (the booker isn't blocked yet). */
  block:       boolean;
}

export interface BookingPayoutView {
  receiveCents:   number;
  /** none (not paid yet), held (Nomila holds it), on_hold (a report is open), paid, refunded, unpaid_cancel (no refund: paid on the clock). */
  state:          "none" | "held" | "on_hold" | "paid" | "refunded";
  releaseDueAt:   string | null;
  paidAt:         string | null;
  cardFeeCents:   number;        // a card fee taken from this payout for a cancellation she caused (0 if none)
}

export interface BookingDetailView extends BookingListItemView {
  buyerMessage:         string | null;
  minorFirstName:       string | null;
  proposedNote:         string | null;
  athleteProposedTimes: ProposedTimeView[];
  meetingMode:          "livekit" | "link" | "in_person" | null;
  meetingLink:          string | null;
  venue:                string | null;
  freeCancelHours:      number;
  buyerTotalCents:      number;
  payBy:                string | null;
  athleteDoneAt:        string | null;
  noShowBy:             "buyer" | "athlete" | null;
  canceledBy:           "buyer" | "athlete" | "system" | "admin" | null;
  /** Her first cancellation is on Nomila (no card fee). */
  firstCancelFree:      boolean;
  actions:              BookingActionsView;
  payout:               BookingPayoutView;
  timeline:             BookingTimelineEntry[];
  /** Private group: the friends the booker invited (first names only; never their email). */
  guests:               Array<{ name: string | null }>;
  /** 0154: she blocked this booker (her Blocked fans list). */
  fanBlocked:           boolean;
  supportEmail:         string;
}

export interface CancelPreviewView {
  buyerRefundCents:     number;   // what the buyer gets back (everything, when she cancels)
  firstCancelFree:      boolean;
  /** An ESTIMATE of the card fee she covers (the actual Stripe fee is used when it happens); 0 when free. */
  estCardFeeCents:      number;
}

export interface BookingMessageView {
  id:        string;
  from:      "you" | "them" | "nomila";
  /** Null when the message was held and you are not its sender (it never reached you). */
  body:      string | null;
  /** Your own message that was held: "Not delivered. It included contact details." */
  held:      boolean;
  heldReason: "contact_details" | "link" | "off_platform_payment" | "review" | null;
  at:        string;
}

export interface BookingPayoutsView {
  payouts:      PayoutStatusView;
  comingCents:  number;
  paidCents:    number;
  items: Array<{
    bookingId:  string;
    title:      string;
    buyerLabel: string;
    state:      "held" | "on_hold" | "paid" | "refunded";
    amountCents: number;          // what reached / will reach her (her price − any card fee taken)
    cardFeeCents: number;
    dueAt:      string | null;    // when it pays out on the clock (held), or when it was paid
  }>;
  cardFees: Array<{ bookingId: string; title: string; amountCents: number; status: "owed" | "waived" | "recovered" | "written_off"; at: string }>;
}

// ── The buyer side (public, account-less) ──────────────────────────────────────────────────────────────────────

export interface PublicOfferView {
  publicId:         string;
  athleteFirstName: string;
  format:           OfferFormat;
  title:            string;
  description:      string | null;
  durationMinutes:  number;
  locationMode:     LocationMode;
  /** In person: never the venue before payment. */
  schedulingMode:   "slots" | "request";
  freeCancelHours:  number;
  allowMinorAttendees: boolean;
  idCheckRequired:  boolean;
  /** 0153: who it's for and how many people. The quote is for ONE person ("$X per person"); a private-group booker
   *  picks 1..maxPeople and GET /offers/:publicId/quote?party_size=N prices it. */
  audience:         Audience;
  maxPeople:        number;
  quote:            QuoteView;
  /** "$177.96 — includes [First]'s $150 + $27.96 Nomila service fee" */
  allInLine:        string;
  /** Bookable times. Open group: spotsLeft (≥ 1) and capacity on each. */
  slots:            Array<{ id: string; startsAt: string; endsAt: string; spotsLeft?: number; capacity?: number }>;
  /** Open group: times that are full (shown as "Full", not bookable). Empty otherwise. */
  fullSlots:        Array<{ id: string; startsAt: string; endsAt: string }>;
  maxProposedTimes: number;
  available:        boolean;
  supportEmail:     string;
}

/** "contact": a request that started in Ask Mila still needs the visitor's name, email, phone and 18+ answer. */
export type BuyerStep = "contact" | "email" | "phone" | "identity" | "card" | "done";

export interface BuyerBookingView {
  ref:              string;          // a short reference for support ("NB-4821")
  status:           BookingStatusWire;
  phase:            "verifying" | "waiting" | "pick_time" | "pay" | "booked" | "after" | "closed" | "on_hold";
  nextStep:         BuyerStep;
  athleteFirstName: string;
  title:            string;
  format:           OfferFormat;
  locationMode:     LocationMode;
  startsAt:         string | null;
  endsAt:           string | null;
  proposedTimes:    ProposedTimeView[];
  athleteProposedTimes: ProposedTimeView[];
  respondBy:        string | null;
  payBy:            string | null;
  quote:            QuoteView;
  freeCancelHours:  number;
  freeCancelUntil:  string | null;
  /** Revealed only once the card is charged (confirmed or later). */
  venue:            string | null;
  meetingLink:      string | null;
  holdPlaced:       boolean;
  charged:          boolean;
  canceledBy:       "buyer" | "athlete" | "system" | "admin" | null;
  refundOutcome:    "full" | "price_only" | "none" | null;
  noShowBy:         "buyer" | "athlete" | null;
  athleteDoneAt:    string | null;
  releaseDueAt:     string | null;
  /** The call and "How did it go?" page (/s/…), once the booking is paid for a video call; null otherwise. */
  sessionUrl:       string | null;
  /** The buyer's taps on this page. The session and after it ("It happened", "Report a problem") are #868's /s/:token page. */
  actions:          { withdraw: boolean; cancel: boolean; pickTime: boolean; message: boolean; guests: boolean };
  /** 0153: who it's for, the people this booking covers, her per-person price; open group: the spots in the session. */
  audience:         Audience;
  partySize:        number;
  unitPriceCents:   number;
  groupSpots:       number | null;
  /** 0154: an open-group spot that waits for her Accept (her "Approve each spot"); false otherwise. */
  approveEachSpot:  boolean;
  /** Private group: the friends invited so far (the booker's own list) and how many more can be added. */
  guests:           GuestView[];
  guestsLeft:       number;
  supportEmail:     string;
}

/** A friend invited to a private group (the booker's own view; each gets their own call link by email). */
export interface GuestView { id: string; name: string | null; email: string; invitedAt: string | null }

export interface BuyerCancelPreviewView { refundCents: number; keptCents: number; inWindow: boolean; freeUntil: string | null }

/** POST /bookings/:id/accept: charged at once (confirmed), or the hold had lapsed and the buyer has a pay link. */
export interface AcceptResultView { result: "confirmed" | "waiting_payment"; booking: BookingDetailView }

// ── Group sessions, her side (0153) ────────────────────────────────────────────────────────────────────────────────

/** One person (or party) in a group time, as she sees them: first name only, never contact details. */
export interface GroupAttendeeView {
  bookingId:  string;
  /** "Jordan" — first name only. */
  firstName:  string;
  status:     BookingStatusWire;
  partySize:  number;
  /** Their LiveKit identity in the group room (a keyed pseudonym), so her app can put a first name on a tile and
   *  remove that participant. Fans see each other as "Fan"; only her app maps identity → first name. */
  identity:   string;
  joined:     boolean;
  inRoom:     boolean;
  /** 0154: she blocked this fan. */
  blocked:    boolean;
}

/** One open-group time with its people: what her app shows as ONE item. */
export interface GroupSessionListItemView {
  slotId:       string;
  offerId:      string;
  title:        string;
  format:       OfferFormat;
  locationMode: LocationMode;
  startsAt:     string;
  endsAt:       string;
  capacity:     number;
  spotsTaken:   number;
  spotsLeft:    number;
  /** "booked" (before the start) | "happening" | "finished" | "canceled" (every booking in it was cancelled). */
  phase:        "booked" | "happening" | "finished" | "canceled";
  /** What she receives from this time (her per-person price × every live, paid spot). */
  receiveCents: number;
  unitPriceCents: number;
  /** First names of the people booked (confirmed or later), in booking order. */
  firstNames:   string[];
}

export interface GroupSessionView extends GroupSessionListItemView {
  attendees:    GroupAttendeeView[];
  video:        { mode: "livekit" | "link" | "none"; joinOpensAt: string | null; joinClosesAt: string | null; joinState: "not_yet_open" | "open" | "closed" | "unavailable"; fallbackLink: string | null };
  actions:      { join: boolean; cancel: boolean; sessionDone: boolean; removeParticipant: boolean };
  freeCancelHours: number;
  firstCancelFree: boolean;
  supportEmail: string;
  serverNow:    string;
}

// ─── Blocking (0154) ────────────────────────────────────────────────────────────────────────────────────────────

/** One fan she blocked (her Blocked fans list). Never a hash or contact detail. */
export interface FanBlockView {
  id:        string;
  /** "Jordan"; "A fan" when we never had a name. */
  firstName: string;
  /** Where she blocked them: a booking (the booker), a friend in a group call, or (later) a Live. */
  source:    "booking" | "guest" | "live";
  bookingId: string | null;
  reason:    string | null;
  blockedAt: string;
}

/** What blocking this person will do (the confirm sheet says it before she taps). */
export interface BlockPreviewView {
  firstName:       string;
  role:            "buyer" | "guest";
  alreadyBlocked:  boolean;
  /** Their upcoming paid bookings with her: each is cancelled with a full refund to them. */
  cancels:         Array<{ bookingId: string; title: string; startsAt: string; refundCents: number }>;
  /** Their requests still waiting on her (or on a payment): each is declined, the card hold released. */
  pendingRequests: number;
}

export interface BlockResultView {
  block:           FanBlockView;
  canceled:        number;
  refundedCents:   number;
  requestsEnded:   number;
  /** LiveKit confirmed they're out of the call (or they weren't in it). */
  removedFromCall: boolean;
}

export interface GroupCancelPreviewView {
  bookings:          number;  // paid spots that will be cancelled and refunded in full
  /** The PEOPLE those paid spots cover (the sum of their party sizes): what "N people get a full refund" counts. */
  people:            number;
  pending:           number;  // spots still mid-checkout: their card holds are released
  buyerRefundCents:  number;  // everything the fans get back, together
  firstCancelFree:   boolean;
  /** ESTIMATE of the card fees she covers (Stripe's actual fee is used when it happens; her first one is free). */
  estCardFeeCents:   number;
}

export interface GroupCancelResultView { canceled: number; released: number; refundedCents: number; group: GroupSessionView }
