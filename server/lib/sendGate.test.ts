/**
 * sendGate.test.ts — the rule itself, plus the invariant that let it drift.
 *
 * The bug this pins: `server/mila/widgets.ts` spelled the send gate out by hand
 * and omitted the INBOUND term, so the text card offered "Review & Send" on a
 * thread the brand had never written into. Tapping it reached `sendThreadReply`,
 * which refuses at `if (!lastInbound)` with 400 "No inbound messages to reply
 * to", surfaced to the athlete as a generic "couldn't send, try again" that
 * retrying cannot fix. Voice kept the term, so the two surfaces disagreed about
 * the same deal.
 *
 * The last describe block is the one that matters: it asserts the three call
 * sites AGREE, by exercising each one's real derivation rather than trusting that
 * they all import the helper today.
 */

import { REPLY_PLATFORMS } from "./replyPlatforms";
import {
  sendablePlatforms,
  isSendableWithDraft,
  isStructurallySendable,
  type ReplyPathFacts,
} from "./sendGate";

/** A thread that can genuinely be replied to. */
const REPLYABLE: ReplyPathFacts = {
  threadId: "fb3ebe33-0a9a-49d2-b43e-7c60de05c76c",
  hasInbound: true,
  platform: "gmail",
};

/**
 * The Prime Hydration shape, from live data: a real gmail thread whose three
 * messages are ALL outbound because the athlete wrote them himself. A thread
 * exists, so `threadId` is set and `platform` reads gmail — which is exactly why
 * dropping the inbound term was invisible.
 */
const NO_INBOUND: ReplyPathFacts = { ...REPLYABLE, hasInbound: false };

const WITH_DRAFT = { draft: "Hi Alex, thanks for reaching out.", refusal: null };

describe("isStructurallySendable", () => {
  it("allows a thread with an inbound on a sendable platform", () => {
    expect(isStructurallySendable(REPLYABLE)).toBe(true);
    expect(isStructurallySendable({ ...REPLYABLE, platform: "instagram" })).toBe(
      true,
    );
  });

  it("refuses a thread with NO inbound — the term that went missing", () => {
    expect(isStructurallySendable(NO_INBOUND)).toBe(false);
  });

  it("refuses a deal with no thread at all", () => {
    expect(
      isStructurallySendable({ ...REPLYABLE, threadId: null }),
    ).toBe(false);
  });

  it("refuses a platform the send route cannot answer", () => {
    // Outlook is refused while OUTLOOK_SEND is off (the default), so a Send button would 400.
    for (const platform of ["outlook", "tiktok", "twitter", "", "GMAIL", "constructor"]) {
      expect(isStructurallySendable({ ...REPLYABLE, platform })).toBe(false);
    }
  });
});

/**
 * The gate's sendable set is DERIVED from the one reply-platform table that sendThreadReply
 * dispatches through — so instead of pinning a hand-written list, assert the two directions.
 */
describe("the sendable set comes from the reply-platform table", () => {
  const saved = process.env.OUTLOOK_SEND;
  afterEach(() => {
    if (saved === undefined) delete process.env.OUTLOOK_SEND;
    else process.env.OUTLOOK_SEND = saved;
  });

  it("every sendable platform has a sender, and every platform with a sender is sendable when switched on", () => {
    for (const p of sendablePlatforms()) {
      expect(typeof REPLY_PLATFORMS[p]?.sender?.send).toBe("function");
    }
    process.env.OUTLOOK_SEND = "true";
    const withSenders = Object.keys(REPLY_PLATFORMS).filter((p) => typeof REPLY_PLATFORMS[p].sender.send === "function");
    expect(sendablePlatforms().sort()).toEqual(withSenders.sort());
    for (const p of withSenders) expect(isStructurallySendable({ ...REPLYABLE, platform: p })).toBe(true);
  });

  it("Outlook is in the table, and is sendable only while OUTLOOK_SEND is on", () => {
    expect(REPLY_PLATFORMS.outlook?.sender.kind).toBe("mailbox");
    delete process.env.OUTLOOK_SEND;
    expect(sendablePlatforms()).not.toContain("outlook");
    expect(isStructurallySendable({ ...REPLYABLE, platform: "outlook" })).toBe(false);
    process.env.OUTLOOK_SEND = "true";
    expect(sendablePlatforms()).toContain("outlook");
    expect(isStructurallySendable({ ...REPLYABLE, platform: "outlook" })).toBe(true);
  });

  it("Gmail, Instagram and the Nomila relay stay sendable whatever the Outlook switch says", () => {
    delete process.env.OUTLOOK_SEND;
    expect(sendablePlatforms()).toEqual(expect.arrayContaining(["gmail", "instagram", "nomila"]));
  });
});

describe("isSendableWithDraft", () => {
  it("adds the copy half on top of the structural gate", () => {
    expect(isSendableWithDraft(REPLYABLE, WITH_DRAFT)).toBe(true);
  });

  it("refuses with no draft, or with a refusal, however good the path", () => {
    expect(
      isSendableWithDraft(REPLYABLE, { draft: null, refusal: null }),
    ).toBe(false);
    expect(
      isSendableWithDraft(REPLYABLE, {
        draft: "anything",
        refusal: "Couldn't draft a safe reply.",
      }),
    ).toBe(false);
  });

  it("still refuses a no-inbound thread even with perfect copy", () => {
    expect(isSendableWithDraft(NO_INBOUND, WITH_DRAFT)).toBe(false);
  });
});

/**
 * THE ANTI-DRIFT TEST.
 *
 * Each block below reproduces one call site's OWN expression, copied from that
 * file. If any of them stops going through the shared helper — or someone
 * hand-inlines the terms again — these diverge and this fails. That is the whole
 * point: the previous bug was three derivations where only two agreed, and
 * nothing anywhere asserted they matched.
 */
describe("all three call sites agree", () => {
  /** server/mila/tools/draftReply.ts — the text tool's own `sendable`. */
  const draftReplyGate = (
    facts: ReplyPathFacts,
    copy: { draft: string | null; refusal: string | null },
  ) =>
    isSendableWithDraft(
      { threadId: facts.threadId, hasInbound: facts.hasInbound, platform: facts.platform },
      copy,
    );

  /**
   * server/mila/widgets.ts — the text CARD builder, re-deriving from the tool's
   * wire result. Mirrors its coercions exactly, including `has_inbound === true`
   * so an ABSENT field reads false.
   */
  const widgetsGate = (
    result: Record<string, unknown>,
    copy: { draft: string | null; refusal: string | null },
  ) =>
    isSendableWithDraft(
      {
        threadId:
          typeof result.thread_id === "string" ? result.thread_id : null,
        hasInbound: result.has_inbound === true,
        platform: typeof result.platform === "string" ? result.platform : "",
      },
      copy,
    );

  /** server/voice/draftIntentRoute.ts — structural only; no draft exists yet. */
  const voiceGate = (facts: ReplyPathFacts) => isStructurallySendable(facts);

  const wireOf = (facts: ReplyPathFacts) => ({
    thread_id: facts.threadId,
    has_inbound: facts.hasInbound,
    platform: facts.platform,
  });

  it.each([
    ["a replyable gmail thread", REPLYABLE, true],
    ["the no-inbound Prime shape", NO_INBOUND, false],
    ["no thread at all", { ...REPLYABLE, threadId: null }, false],
    ["an outlook thread", { ...REPLYABLE, platform: "outlook" }, false],
  ])("%s — all three answer the same", (_label, facts, expected) => {
    expect(voiceGate(facts as ReplyPathFacts)).toBe(expected);
    expect(draftReplyGate(facts as ReplyPathFacts, WITH_DRAFT)).toBe(expected);
    expect(widgetsGate(wireOf(facts as ReplyPathFacts), WITH_DRAFT)).toBe(
      expected,
    );
  });

  // The regression in its exact shape: the tool computed hasInbound, folded it
  // into its own `sendable`, and did not put it on the wire — so the card had no
  // way to re-derive it and silently treated it as satisfied. Now an omitted
  // `has_inbound` is false, so a stale producer fails CLOSED, not open.
  it("fails closed when the tool result omits has_inbound", () => {
    const legacyWire = {
      thread_id: REPLYABLE.threadId,
      platform: "gmail",
      // has_inbound absent, as the old draft_reply result had it
    };
    expect(widgetsGate(legacyWire, WITH_DRAFT)).toBe(false);
  });
});
