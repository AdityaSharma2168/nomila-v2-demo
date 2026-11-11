/**
 * senderMemory — the pipeline remembering who has already wasted the athlete's time.
 *
 * Layer 1 of the learning loop, and deliberately the dumbest one: no model, no embedding,
 * no training. If the same sender has been set aside as not-a-deal more than once, the
 * next message from that sender is filed without asking an LLM. It is a SQL lookup on
 * rows that already exist.
 *
 * It slots in after structuralNonDeal and before classifyMessage, keeping the cost order
 * intact: free filters, then an indexed query, then the paid call.
 *
 * WHY THIS IS SAFE TO ACT ON, when the classifier is not.
 * The harvested fixture put recall at 100% and precision at 63.6% — the classifier misses
 * nothing and over-surfaces. There is no recall to trade away, so filtering is the correct
 * direction. What a filter must never do is hide a conversation the athlete is IN, hence
 * the guards below.
 *
 * GUARDS. A wrong mute hides real money, so every one of these must hold:
 *
 *   · The athlete has a LIVE conversation with this sender — an outbound reply on a
 *     thread that was not later archived or demoted. That outranks any count.
 *
 *     Engagement is measured by REPLIES, never by deals.status. Status is not evidence
 *     about the athlete: the thread summarizer advances it from its own deal_stage read,
 *     so 11 of 23 "advanced" deals had no human involvement. A status guard blocked the
 *     mute on marriottbonvoy@email-marriott.com — 2 demotes, 0 replies, and a
 *     machine-advanced deal standing in for consent. Same lesson as the eval fixture:
 *     behaviour counts, inference does not.
 *
 *     A reply on a thread that was subsequently demoted does not count either. Declining
 *     politely is not engagement, and the outbound bodies in prod are exactly that —
 *     "Thanks so much for reaching out ... As a competitive athlete ...".
 *   · Domain rules need a higher bar than address rules AND cannot fire on a domain the
 *     athlete has engaged with. This matters: `us-news.comms.adidas.com` has 4 demotes in
 *     prod — a real brand's marketing subdomain. Muting the domain on count alone would
 *     drop a genuine adidas approach arriving from a neighbouring host.
 *   · Free-mail domains (gmail.com and friends) are never muted by DOMAIN. One junk sender
 *     on gmail would otherwise mute every individual who mails from gmail.
 *
 * Everything it does is reversible and receipted, like every other automatic action.
 */

import { sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../logger";
import { senderProfile } from "./senderProfile";
import { pseudonymousSender } from "./mailbox/retention";

const logger = createLogger("lib/senderMemory");

/**
 * Thresholds are EVIDENCE POINTS, not row counts — not every demote is worth the same,
 * and rows are not independent observations. See WEIGHT_* below.
 */
/** Same address twice is a pattern; once is an accident. */
export const SENDER_MUTE_THRESHOLD = 2;
/** A domain covers many senders, so it needs more evidence than one address does. */
export const DOMAIN_MUTE_THRESHOLD = 3;

/**
 * What a demote is WORTH, and why the two differ.
 *
 * A human demote is the athlete asserting "this is not a deal" — ground truth, and the
 * only signal in the system the pipeline cannot manufacture for itself.
 *
 * A machine demote is our own classifier's output, at 63.6% measured precision. Counting
 * it equally is how the loop starts confirming itself: the classifier sets a sender
 * aside, memory learns from that, and every later message from that sender is filed
 * WITHOUT an LLM — so the original misjudgement can never be revisited, not even by a
 * better model. A one-way ratchet built on a 2-in-3 call.
 *
 * Machine evidence is not worthless, so it is halved rather than discarded: four separate
 * machine occasions still mute, but a single sweep never can.
 */
const WEIGHT_HUMAN   = 1.0;
const WEIGHT_MACHINE = 0.5;

/** The shape of a mute. Absent (null) whenever anything at all is uncertain. */
export type SenderVerdict = {
  muted: true;
  scope: "explicit" | "sender" | "domain";
  reason: string;
};

/**
 * Should this message be filed without an LLM call?
 *
 * Returns null whenever anything is uncertain — an unknown sender, an engaged sender, or
 * a query that fails. Never throws: a memory lookup must not be able to break ingestion.
 */
export async function senderVerdict(
  athleteId: string,
  fromEmail: string | null | undefined,
): Promise<SenderVerdict | null> {
  const email = (fromEmail ?? "").toLowerCase().trim();
  if (!email || !email.includes("@")) return null;
  // The structural facts — free mail, workflow provider — come from senderProfile, so
  // this module owns only what it alone can know: what the athlete has DONE about them.
  const sender = senderProfile(email);
  const domain = sender.domain || null;
  // Under MAILBOX_ZERO_RETENTION a sender who is not a counterparty is stored as
  // `sha256-<hex>@<domain>` (lib/mailbox/retention.ts). The same address always hashes to the
  // same value and keeps its domain, so every count below matches EITHER form: the plain
  // address (legacy rows, counterparties) or its pseudonym. split_part(…, '@', 2) is the
  // domain for both. Computed whatever the flag, so rows written under it are still
  // recognised if the flag is later turned off.
  const pseudo = pseudonymousSender(email) ?? email;

  try {
    // One round trip. Counts are DISTINCT over threads so a thread demoted twice (undo,
    // redo) cannot inflate its way past a threshold on its own.
    //
    // Three things this query has to keep straight, each of which was wrong before:
    //
    //   1. not_interested is NOT a demote. The dispose route writes action='reclassify'
    //      for both dispositions, but they mean opposite things about the classifier:
    //      not_a_deal says we should never have surfaced it, not_interested says we were
    //      RIGHT and the answer is simply no. Counting it would mute a brand for the crime
    //      of making a real offer she declined — two polite declines to gorjana and the
    //      next gorjana contract never reaches the classifier. The same holds for
    //      'expired', which says the offer was real and we were merely too late. Both
    //      count as engagement instead, being proof the sender sends real deals.
    //   2. Human and machine demotes are tallied apart, so they can be weighted apart.
    //   3. Machine demotes count as OCCASIONS (distinct minutes), not rows. A bulk
    //      re-scan is ONE decision applied to many threads, not many observations: in
    //      prod a single sweep on 2026-08-16 demoted 9 AEGISLAB threads at once and
    //      minted every sender mute in the system. Human labels stay per-thread, because
    //      each tap really is its own act.
    const { rows } = await db.execute(sql`
      with dispositions as (
        select a.thread_id,
               lower(m.sender_email) as sender,
               a.payload ->> 'athlete_label' as athlete_label,
               date_trunc('minute', a.created_at) as occasion,
               a.action
          from agent_actions a
          join lateral (
                 select sender_email from inbox_messages
                  where thread_id = a.thread_id and direction = 'inbound'
                  order by received_at asc nulls last limit 1
               ) m on true
         where a.athlete_id = ${athleteId}
           and a.action in ('reclassify', 'mute_sender')
      )
      select
        (select count(*) from dispositions
          where action = 'mute_sender' and sender in (${email}, ${pseudo}))         as explicit_mutes,
        -- Ground truth: the athlete herself said "not a deal". One point per thread.
        (select count(distinct thread_id) from dispositions
          where sender in (${email}, ${pseudo}) and action = 'reclassify'
            and athlete_label = 'not_a_deal')                                       as sender_human,
        -- Our own inference: half a point per OCCASION, so one sweep counts once.
        (select count(distinct occasion) from dispositions
          where sender in (${email}, ${pseudo}) and action = 'reclassify'
            and athlete_label is null)                                              as sender_machine,
        -- A confirmed real offer she declined. Evidence FOR this sender, never against.
        (select count(*) from dispositions
          where sender in (${email}, ${pseudo})
            and athlete_label in ('not_interested', 'expired'))                     as sender_real_offers,
        (select count(distinct thread_id) from dispositions
          where action = 'reclassify' and athlete_label = 'not_a_deal'
            and ${domain ?? ""} <> ''
            and split_part(sender, '@', 2) = ${domain ?? ""})                       as domain_human,
        (select count(distinct occasion) from dispositions
          where action = 'reclassify' and athlete_label is null
            and ${domain ?? ""} <> ''
            and split_part(sender, '@', 2) = ${domain ?? ""})                       as domain_machine,
        (select count(*) from dispositions
          where athlete_label in ('not_interested', 'expired')
            and ${domain ?? ""} <> ''
            and split_part(sender, '@', 2) = ${domain ?? ""})                       as domain_real_offers,
        -- A LIVE conversation: replied to, and the thread was not later set aside.
        (select count(*) from inbox_messages om
           join inbox_threads t on t.id = om.thread_id
           join lateral (
                  select sender_email from inbox_messages
                   where thread_id = t.id and direction = 'inbound'
                   order by received_at asc nulls last limit 1
                ) im on true
          where t.athlete_id = ${athleteId}
            and om.direction = 'outbound'
            and t.status is distinct from 'archived'
            and lower(im.sender_email) in (${email}, ${pseudo}))                    as sender_replies,
        (select count(*) from inbox_messages om
           join inbox_threads t on t.id = om.thread_id
           join lateral (
                  select sender_email from inbox_messages
                   where thread_id = t.id and direction = 'inbound'
                   order by received_at asc nulls last limit 1
                ) im on true
          where t.athlete_id = ${athleteId}
            and om.direction = 'outbound'
            and ${domain ?? ""} <> ''
            and split_part(lower(im.sender_email), '@', 2) = ${domain ?? ""})       as domain_replies
    `);

    const r: any = rows?.[0] ?? {};
    const n = (v: unknown) => Number(v ?? 0);

    // An explicit mute is the athlete's own instruction and outranks every guard.
    if (n(r.explicit_mutes) > 0) {
      return { muted: true, scope: "explicit", reason: `Muted sender ${email}` };
    }

    // Engagement beats any count — but only a LIVE reply, never a status the
    // summarizer may have advanced on its own.
    if (n(r.sender_replies) > 0) return null;

    // A declined-or-lapsed but REAL offer is the athlete confirming this sender sends
    // actual deals. That outranks any pile of machine demotes sitting on the address.
    if (n(r.sender_real_offers) > 0) return null;

    const senderPoints = n(r.sender_human) * WEIGHT_HUMAN + n(r.sender_machine) * WEIGHT_MACHINE;
    if (senderPoints >= SENDER_MUTE_THRESHOLD) {
      return {
        muted: true,
        scope: "sender",
        reason: n(r.sender_human) > 0
          ? `the athlete marked ${n(r.sender_human)} message(s) from ${email} as not a deal`
          : `messages from ${email} were set aside as not a deal on ${n(r.sender_machine)} separate occasions`,
      };
    }

    // Domain rule last, with the extra bar and its own engagement guard.
    const domainPoints = n(r.domain_human) * WEIGHT_HUMAN + n(r.domain_machine) * WEIGHT_MACHINE;
    if (
      domain &&
      !sender.freeMail &&
      !sender.workflow &&
      n(r.domain_replies) === 0 &&
      n(r.domain_real_offers) === 0 &&
      domainPoints >= DOMAIN_MUTE_THRESHOLD
    ) {
      return {
        muted: true,
        scope: "domain",
        reason: n(r.domain_human) > 0
          ? `the athlete marked ${n(r.domain_human)} message(s) from ${domain} as not a deal`
          : `messages from ${domain} were set aside as not a deal on ${n(r.domain_machine)} separate occasions`,
      };
    }

    return null;
  } catch (err: any) {
    // A memory lookup is an optimisation. If it fails the message simply goes to the
    // classifier, which is exactly what happened before this existed.
    logger.warn({ athleteId, email, err: err?.message }, "senderVerdict failed — falling through");
    return null;
  }
}
