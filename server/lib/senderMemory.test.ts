/**
 * senderMemory.test.ts — the guards, because a wrong mute hides real money.
 *
 * senderVerdict is one SQL round trip plus a decision. The SQL is exercised against a
 * mocked db.execute so these tests pin the DECISION, which is where the danger is: every
 * bug this feature could plausibly have is a case where it mutes something it shouldn't.
 *
 * Two of these cases are regressions from live data, not hypotheticals:
 *   · marriottbonvoy@email-marriott.com — 2 demotes, 0 replies, and one deal the thread
 *     SUMMARIZER had advanced. An earlier draft treated status as engagement and refused
 *     to mute. Status is not consent; the summarizer sets it from its own deal_stage read.
 *   · us-news.comms.adidas.com — 4 demotes on a REAL brand's marketing subdomain. The
 *     domain rule must not be able to drop a genuine adidas approach from a sibling host.
 *
 * Evidence is now WEIGHTED, and the tests below pin the three distinctions that carry it:
 * a human label outweighs our own inference, a bulk sweep is one observation rather than
 * many, and "not interested" is evidence FOR a sender rather than against it.
 */

import { senderVerdict, SENDER_MUTE_THRESHOLD, DOMAIN_MUTE_THRESHOLD } from "./senderMemory";
import { domainOf } from "./senderProfile";

jest.mock("../db", () => ({ db: { execute: jest.fn() } }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { db } = require("../db");

const ATHLETE = "11111111-1111-1111-1111-111111111111";

/**
 * Shape one row of counts the way the query returns it.
 *
 * `*_human` are threads the athlete labelled not_a_deal. `*_machine` are OCCASIONS of
 * our own pipeline setting mail aside — distinct minutes, not rows, so a sweep that
 * touched nine threads arrives here as 1. `*_real_offers` are not_interested labels:
 * offers she confirmed were real and declined.
 */
function counts(over: Partial<Record<string, number>> = {}) {
  (db.execute as jest.Mock).mockResolvedValueOnce({
    rows: [{
      explicit_mutes: 0,
      sender_human: 0,
      sender_machine: 0,
      sender_real_offers: 0,
      domain_human: 0,
      domain_machine: 0,
      domain_real_offers: 0,
      sender_replies: 0,
      domain_replies: 0,
      ...over,
    }],
  });
}

beforeEach(() => jest.clearAllMocks());

describe("senderVerdict — mutes when the evidence is there", () => {
  it("mutes an address at the threshold", async () => {
    counts({ sender_human: SENDER_MUTE_THRESHOLD });
    const v = await senderVerdict(ATHLETE, "influencer@usa.temu.com");
    expect(v?.muted).toBe(true);
    expect(v?.scope).toBe("sender");
  });

  it("mutes a domain only at its higher threshold", async () => {
    counts({ domain_human: DOMAIN_MUTE_THRESHOLD });
    expect((await senderVerdict(ATHLETE, "a@spammy-agency.com"))?.scope).toBe("domain");
  });

  it("an explicit mute outranks every guard, including a live reply", async () => {
    counts({ explicit_mutes: 1, sender_replies: 5 });
    const v = await senderVerdict(ATHLETE, "muted@example.com");
    expect(v?.scope).toBe("explicit");
  });

  it("states WHY in the reason, so the receipt is explainable", async () => {
    counts({ sender_human: 4 });
    const v = await senderVerdict(ATHLETE, "casey@herbalco.test");
    expect(v?.reason).toContain("4");
    expect(v?.reason).toContain("casey@herbalco.test");
  });
});

describe("senderVerdict — refuses to mute (the half that protects money)", () => {
  it("one below the threshold is not a pattern", async () => {
    counts({ sender_human: SENDER_MUTE_THRESHOLD - 1 });
    expect(await senderVerdict(ATHLETE, "once@example.com")).toBeNull();
  });

  it("a live reply beats any number of demotes", async () => {
    counts({ sender_human: 9, sender_replies: 1 });
    expect(await senderVerdict(ATHLETE, "campaigns@crevasse.ai")).toBeNull();
  });

  it("a replied-to DOMAIN is never muted, even over the threshold", async () => {
    // The adidas case: a real brand's marketing subdomain accrues demotes while the
    // athlete is in conversation with the brand elsewhere on that domain.
    counts({ domain_human: 9, domain_replies: 1 });
    expect(await senderVerdict(ATHLETE, "adidas@us-news.comms.adidas.com")).toBeNull();
  });

  it("never mutes an e-signature DOMAIN — it carries contracts forward", async () => {
    // The regression this pins: adobesign.com sends "Completed: GORJANA_Athlete_
    // Endorsement_Release" in prod. Such a domain carries mail for EVERY brand, so junk
    // demotes pile up on it far faster than on a real brand's domain — and muting it
    // would silently stop deals ever reaching `signed`.
    counts({ domain_human: 25 });
    expect(await senderVerdict(ATHLETE, "echosign@adobesign.com")).toBeNull();
  });

  it("protects a SUBDOMAIN of a workflow provider too", async () => {
    counts({ domain_human: 25 });
    expect(await senderVerdict(ATHLETE, "noreply@na4.docusign.net")).toBeNull();
  });

  it("still mutes one noisy ADDRESS at a workflow provider", async () => {
    // The domain is protected; a specific spammer using it is not.
    counts({ sender_human: SENDER_MUTE_THRESHOLD, domain_human: 25 });
    expect((await senderVerdict(ATHLETE, "spam@docusign.net"))?.scope).toBe("sender");
  });

  it("never mutes a free-mail DOMAIN — one junk gmail would mute every person", async () => {
    counts({ domain_human: 50 });
    expect(await senderVerdict(ATHLETE, "someone@gmail.com")).toBeNull();
  });

  it("still mutes a free-mail ADDRESS, which is specific to one sender", async () => {
    counts({ sender_human: SENDER_MUTE_THRESHOLD, domain_human: 50 });
    expect((await senderVerdict(ATHLETE, "spammer@gmail.com"))?.scope).toBe("sender");
  });

  it("an unknown sender is never muted", async () => {
    counts();
    expect(await senderVerdict(ATHLETE, "new@brandnewbrand.com")).toBeNull();
  });
});

describe("senderVerdict — cannot break ingestion", () => {
  it("returns null on a malformed address without querying", async () => {
    expect(await senderVerdict(ATHLETE, "not-an-email")).toBeNull();
    expect(await senderVerdict(ATHLETE, "")).toBeNull();
    expect(await senderVerdict(ATHLETE, null)).toBeNull();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("swallows a query failure and falls through to the classifier", async () => {
    (db.execute as jest.Mock).mockRejectedValueOnce(new Error("connection reset"));
    await expect(senderVerdict(ATHLETE, "a@b.com")).resolves.toBeNull();
  });

  it("tolerates an empty result set", async () => {
    (db.execute as jest.Mock).mockResolvedValueOnce({ rows: [] });
    await expect(senderVerdict(ATHLETE, "a@b.com")).resolves.toBeNull();
  });
});

describe("senderVerdict — whose judgement is this, and how many times", () => {
  // ── not_interested is not a demote ──────────────────────────────────────────
  // The dispose route writes action='reclassify' for BOTH dispositions, so the only
  // thing separating them is athlete_label. Counting not_interested would mute a brand
  // for making a real offer she declined: two polite passes on gorjana and the next
  // gorjana contract never reaches the classifier.
  it("a declined REAL offer never mutes the sender, whatever else has piled up", async () => {
    counts({ sender_human: 9, sender_real_offers: 1 });
    expect(await senderVerdict(ATHLETE, "partnerships@gorjana.com")).toBeNull();
  });

  // "Expired" says the offer was real and we were merely too late. That is the same kind
  // of evidence as a decline — proof this sender sends actual deals — and the opposite of
  // a reason to silence them.
  it("an EXPIRED offer also protects the sender", async () => {
    counts({ sender_human: 9, sender_real_offers: 1 });
    expect(await senderVerdict(ATHLETE, "colleen@wildgrain.test")).toBeNull();
  });

  it("a declined REAL offer protects the whole domain too", async () => {
    counts({ domain_human: 25, domain_real_offers: 1 });
    expect(await senderVerdict(ATHLETE, "someone-else@gorjana.com")).toBeNull();
  });

  // ── a sweep is one observation ──────────────────────────────────────────────
  // The AEGISLAB case: a single bulk re-scan on 2026-08-16 demoted 9 threads at once.
  // Nine rows, one decision — it arrives here as one occasion and must not mute.
  it("one bulk sweep cannot mute, no matter how many threads it touched", async () => {
    counts({ sender_machine: 1 });
    expect(await senderVerdict(ATHLETE, "campaigns@crevasse.ai")).toBeNull();
  });

  // ── machine inference is worth half ─────────────────────────────────────────
  it("two machine occasions are not enough on their own", async () => {
    counts({ sender_machine: 2 });   // 1.0 point
    expect(await senderVerdict(ATHLETE, "casey@herbalco.test")).toBeNull();
  });

  it("four separate machine occasions do reach the bar", async () => {
    counts({ sender_machine: 4 });   // 2.0 points
    expect((await senderVerdict(ATHLETE, "blaster@example.com"))?.scope).toBe("sender");
  });

  it("one human label plus two machine occasions reaches it faster", async () => {
    counts({ sender_human: 1, sender_machine: 2 });   // 1.0 + 1.0
    expect((await senderVerdict(ATHLETE, "blaster@example.com"))?.scope).toBe("sender");
  });

  it("the domain bar needs six machine occasions but only three human labels", async () => {
    counts({ domain_machine: 5 });   // 2.5 points — short
    expect(await senderVerdict(ATHLETE, "a@spammy-agency.com")).toBeNull();
    counts({ domain_machine: 6 });   // 3.0 points
    expect((await senderVerdict(ATHLETE, "a@spammy-agency.com"))?.scope).toBe("domain");
  });

  // ── the receipt has to say who decided ──────────────────────────────────────
  it("names the athlete as the source when she labelled it", async () => {
    counts({ sender_human: 2 });
    expect((await senderVerdict(ATHLETE, "x@y.com"))?.reason).toContain("the athlete marked");
  });

  it("says 'separate occasions' when only the pipeline decided", async () => {
    counts({ sender_machine: 4 });
    expect((await senderVerdict(ATHLETE, "x@y.com"))?.reason).toContain("separate occasions");
  });
});

describe("domainOf", () => {
  it("extracts and lowercases", () => {
    expect(domainOf("A@Example.COM")).toBe("example.com");
  });
  it("returns null for anything that is not one address", () => {
    expect(domainOf("nope")).toBeNull();
    expect(domainOf("a@")).toBeNull();
    expect(domainOf(null)).toBeNull();
  });
});
