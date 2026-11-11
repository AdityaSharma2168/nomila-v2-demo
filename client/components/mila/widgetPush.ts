/**
 * widgetPush.ts — validating a widget that arrived over the room's data channel.
 *
 * ── A data packet is UNTRUSTED INPUT ─────────────────────────────────────────
 * Everything else the chat renders came from our own authenticated API. This did
 * not: it arrived over a WebRTC data channel, and the only reason to believe the
 * sender is the transport-level check the caller makes before parsing (topic,
 * sender present, sender is not us). That check establishes WHO sent it. This
 * file establishes WHAT it is, and assumes nothing.
 *
 * So the discipline here is the one server/voice/voiceContext.ts uses for the
 * worker's writes, for the same reason: every field is read and re-emitted BY
 * NAME. Nothing is spread, nothing is passed through, nothing survives that
 * wasn't explicitly asked for. An unexpected key cannot reach the renderer
 * because no code path copies unexpected keys.
 *
 * Anything malformed returns null and the packet is dropped in silence. There is
 * no partial parse and no repair: a card assembled from half-valid input is a
 * card nobody can reason about, and the durable copy is on the server anyway.
 *
 * ── Prose does not cross this channel ────────────────────────────────────────
 * The wire carries ids, closed enums, booleans and numbers. `brandName` is the
 * single exception — a card is unreadable without it — so it is sanitised here
 * exactly as spoken names are: collapsed to one line, stripped of markup, length
 * capped, and rejected outright if nothing survives. The DISPLAY SENTENCE is
 * composed on this side from the enums; it is never sent.
 */

import type {
  DealCardWidgetData,
  MilaWidget,
  OnboardingUpdateWidgetData,
  ReplyActionWidgetData,
} from "../../hooks/use-mila-chat";

/** Must match WIDGET_TOPIC in the worker's widgetBridge.ts. */
export const WIDGET_TOPIC = "mila.widget";

/** Must match WIDGET_SCHEMA_VERSION in the worker. Anything else is rejected. */
const WIDGET_SCHEMA_VERSION = 1;

/** Longest brand name rendered. A card, not an essay. */
const BRAND_NAME_MAX = 80;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CATEGORIES = ["PAID", "MEDIA", "EDITORIAL", "GIFTING"] as const;
const VERDICTS = ["poor", "fair", "good", "great"] as const;
/** Mirrors the deal statuses DealCard renders; anything else is not a status. */
const STATUSES = [
  "detected",
  "pending",
  "negotiating",
  "accepted",
  "completed",
  "rejected",
] as const;
const REPLY_INTENTS = [
  "accept",
  "negotiate",
  "request_terms",
  "decline",
] as const;
/**
 * Platforms a card may claim. Outlook is present because a deal really can be on
 * it — the card then renders its no-in-app-send state rather than a Send button
 * the send route would reject.
 */
const PLATFORMS = ["gmail", "instagram", "outlook"] as const;

/** What the caller gets: the widget to render plus the line to render it under. */
export interface ParsedWidgetPush {
  widget: MilaWidget;
  /**
   * Composed HERE from validated fields, never taken from the wire. It also has
   * to be non-empty: a message with a widget but no content is dropped by the
   * conversation reload filter, so an empty line would render live and then
   * vanish on reopen.
   */
  line: string;
}

/**
 * Reports why a payload was refused and returns null, so every rejection site
 * stays a one-liner.
 *
 * A callback rather than a second "explain" function on purpose: a parallel
 * diagnostic would be a second copy of these checks, free to drift from the
 * real ones — and a diagnostic that disagrees with the validator is worse than
 * none. This way there is exactly one set of checks and the reason falls out of
 * whichever one fired. Callers that don't care pass nothing and it costs an
 * optional-call.
 */
type RejectReason = (reason: string) => null;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const oneOf = <T extends readonly string[]>(
  v: unknown,
  allowed: T,
): T[number] | null =>
  typeof v === "string" && allowed.some((a) => a === v)
    ? (v as T[number])
    : null;

/**
 * A brand name fit to put on screen, or null.
 *
 * Brand names are extracted from email and are not ours. Newlines and markup are
 * removed rather than escaped because this value is rendered into a Text node
 * and used to build a sentence — a name that needs escaping to be safe is a name
 * we would rather drop.
 */
function safeBrandName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const cleaned = v
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, BRAND_NAME_MAX)
    .trim();
  return cleaned.length ? cleaned : null;
}

/** A finite number, or null. Rejects NaN/Infinity, which JSON.parse can produce. */
const finiteOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** A short display string, or null. Same one-line treatment as a brand name. */
function shortText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const cleaned = v
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return cleaned.length ? cleaned : null;
}

/**
 * Builds a deal_card key by key. Every field is required to be present and of
 * the right shape EXCEPT the three the card itself treats as optional
 * (offerAmount, verdict, scoreNumeric) — the renderer already handles those as
 * null, so an absent one is data we don't have, not a malformed packet.
 */
function parseDealCard(
  raw: Record<string, unknown>,
  onReject: RejectReason,
): ParsedWidgetPush | null {
  const dealId = typeof raw.dealId === "string" ? raw.dealId : "";
  if (!UUID_RE.test(dealId)) return onReject("dealId is not a uuid");

  const brandName = safeBrandName(raw.brandName);
  if (!brandName) return onReject("brandName empty after sanitising");

  const category = oneOf(raw.category, CATEGORIES);
  if (!category) return onReject("category not in the allowed set");

  const status = oneOf(raw.status, STATUSES);
  if (!status) return onReject("status not in the allowed set");

  const timeAgo = shortText(raw.timeAgo, 32) ?? "";

  // Built by name — the object below is the ONLY thing that reaches the
  // renderer, and every key in it was checked above.
  const data: DealCardWidgetData = {
    id: dealId,
    brandName,
    brandDomain: null,
    category,
    status,
    offerAmount: shortText(raw.offerAmount, 24),
    timeAgo,
    verdict: oneOf(raw.verdict, VERDICTS),
    scoreNumeric: finiteOrNull(raw.scoreNumeric),
  };

  return {
    widget: { type: "deal_card", data },
    // Composed from validated fields. The wire never carries a sentence.
    line: `Here's the ${brandName} deal.`,
  };
}

/**
 * Builds a reply_action key by key — the interactive card, and so the one where
 * this discipline matters most.
 *
 * Note what is NOT read from the wire: `draft` and `refusal`. They are pinned to
 * null here regardless of what arrived, because a pushed card is by definition a
 * card whose body does not exist yet — the client generates it. That means no
 * draft copy can be injected over this channel even if a payload carries a
 * `draft` field, and no attacker-chosen prose can reach the editable input the
 * athlete is about to review and send.
 *
 * `needsDraft` is likewise not taken from the wire: a pushed reply_action ALWAYS
 * needs a draft. Reading it would let a payload flip the card into "already
 * drafted" with a null body, which renders as nothing.
 */
function parseReplyAction(
  raw: Record<string, unknown>,
  onReject: RejectReason,
): ParsedWidgetPush | null {
  const dealId = typeof raw.dealId === "string" ? raw.dealId : "";
  if (!UUID_RE.test(dealId)) return onReject("dealId is not a uuid");

  // null is legitimate — a deal with no thread has nothing to reply into, and
  // the card renders its no-in-app-send state.
  let threadId: string | null = null;
  if (raw.threadId !== null && raw.threadId !== undefined) {
    if (typeof raw.threadId !== "string" || !UUID_RE.test(raw.threadId)) {
      return onReject("threadId is neither null nor a uuid");
    }
    threadId = raw.threadId;
  }

  const brandName = safeBrandName(raw.brandName);
  if (!brandName) return onReject("brandName empty after sanitising");

  const platform = oneOf(raw.platform, PLATFORMS);
  if (!platform) return onReject("platform not in the allowed set");

  const replyIntent = oneOf(raw.replyIntent, REPLY_INTENTS);
  if (!replyIntent) return onReject("replyIntent not in the allowed set");

  // Explicit boolean only. A truthy string must not become a Send button.
  if (typeof raw.sendable !== "boolean") {
    return onReject("sendable is not a boolean");
  }
  // The structural gate from the server AND a real reply path. Belt and braces:
  // the send route re-derives all of this authoritatively at tap time anyway.
  const sendable = raw.sendable && threadId !== null;

  const data: ReplyActionWidgetData = {
    dealId,
    threadId,
    platform,
    sendable,
    brandName,
    // Pinned, never read from the wire — see the header above.
    draft: null,
    refusal: null,
    needsDraft: true,
    // Set HERE and nowhere else. Reaching this function means the card arrived
    // over the data channel in this session, which is the only situation where
    // generating a body unprompted is what the athlete just asked for. Cards
    // rebuilt by openConversation never pass through here, so they render a
    // manual affordance instead of silently spending.
    autoDraft: true,
    params: {
      replyIntent,
      // Defaults, not wire values: the spoken flow offers no way to choose them,
      // so accepting them would widen the payload for no behaviour.
      style: "friendly",
      voice: "athlete",
      selectedTerms: [],
      includeMediaKit: false,
    },
  };

  return {
    widget: { type: "reply_action", data },
    line: `Draft reply to ${brandName}`,
  };
}

// ─── onboarding_update ────────────────────────────────────────────────────────

/** The first-entry fields the server may save. Labels are OURS, never from the wire. */
const ONBOARDING_FIELD_LABELS: Record<string, string> = {
  position: "Position",
  class_year: "Class year",
  hometown: "Hometown",
  sport: "Sport",
  school: "Team / school",
  nickname: "Goes by",
  note: "Note",
};
const ONBOARDING_STEPS = ["greet", "doors"] as const;
const ONBOARDING_NEXT = ["doors", "done"] as const;
const ONBOARDING_DOORS = ["profile", "deals"] as const;
/** The server caps a saved value at 120 characters; anything longer did not come from it. */
const ONBOARDING_VALUE_MAX = 120;

/**
 * Builds the first-entry receipt card key by key. `value` is the one free-text field
 * read here: the athlete's own words about themself, saved by the server after its
 * vocabulary and length checks. Same treatment as a brand name — one line, no markup,
 * capped, dropped if nothing survives. An unknown field is dropped, not rendered.
 */
function parseOnboardingUpdate(
  raw: Record<string, unknown>,
  onReject: RejectReason,
): ParsedWidgetPush | null {
  const runId = typeof raw.runId === "string" ? raw.runId : "";
  if (!UUID_RE.test(runId)) return onReject("runId is not a uuid");
  const step = oneOf(raw.step, ONBOARDING_STEPS);
  if (!step) return onReject("step not in the allowed set");
  const next = oneOf(raw.next, ONBOARDING_NEXT);
  if (!next) return onReject("next not in the allowed set");
  let door: OnboardingUpdateWidgetData["door"] = null;
  if (raw.door !== null && raw.door !== undefined) {
    door = oneOf(raw.door, ONBOARDING_DOORS);
    if (!door) return onReject("door not in the allowed set");
  }
  const saved: OnboardingUpdateWidgetData["saved"] = [];
  for (const item of Array.isArray(raw.saved) ? raw.saved : []) {
    if (!isRecord(item)) continue;
    const field = typeof item.field === "string" ? item.field : "";
    const label = ONBOARDING_FIELD_LABELS[field];
    if (!label) continue;
    const value =
      typeof item.value === "string"
        ? item.value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, ONBOARDING_VALUE_MAX)
        : "";
    if (!value) continue;
    const agentActionId =
      typeof item.agentActionId === "string" && UUID_RE.test(item.agentActionId)
        ? item.agentActionId
        : null;
    saved.push({ field, label, value, agentActionId });
  }
  const data: OnboardingUpdateWidgetData = { runId, step, saved, next, door };
  return {
    widget: { type: "onboarding_update", data },
    line: saved.length
      ? "Saved to your profile."
      : next === "doors"
        ? "Where do you want to start?"
        : "You're all set.",
  };
}

/**
 * The entry point. Returns null for anything that is not a widget push this
 * client understands — wrong version, unknown kind, malformed field.
 */
export function parseWidgetPush(
  raw: unknown,
  onReject?: (reason: string) => void,
): ParsedWidgetPush | null {
  const reject: RejectReason = (reason) => {
    onReject?.(reason);
    return null;
  };
  if (!isRecord(raw)) return reject("payload is not an object");
  if (raw.v !== WIDGET_SCHEMA_VERSION) {
    return reject(`unsupported schema version (want ${WIDGET_SCHEMA_VERSION})`);
  }
  if (raw.kind === "deal_card") return parseDealCard(raw, reject);
  if (raw.kind === "reply_action") return parseReplyAction(raw, reject);
  if (raw.kind === "onboarding_update") return parseOnboardingUpdate(raw, reject);
  return reject(
    `unsupported kind: ${typeof raw.kind === "string" ? raw.kind : "absent"}`,
  );
}
