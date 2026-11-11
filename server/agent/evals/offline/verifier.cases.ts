/**
 * agent/evals/offline/verifier.cases.ts — check before deliver (services/verify) on good and bad artifacts, one set per
 * kind, as the deliverables arrive at their delivery points. The video facts are RECORDED ffprobe output (trimmed to the
 * fields the check reads; ffprobe 9.0.2 on lavfi test clips, 3 Nov 2026), parsed by the same function the live probe
 * uses, so the eval needs no ffmpeg. Every name, brand and id is made up.
 */
import type { ArtifactOf, CtxOf, DeliverableKind } from "../../../services/verify/deliverable";
import { durationAround } from "../../../services/verify/deliverable";
import { videoFactsFromFfprobe } from "../../../services/verify/media";
import { documentFromDeckHtml } from "../../../services/verify/adapters";
import { herLinksFrom } from "../../../services/verify/herLinks";
import { DECK_HTML } from "../../../services/verify/fixtures";

export type VerifierCase = {
  [K in DeliverableKind]: { id: string; kind: K; artifact: ArtifactOf[K]; ctx: CtxOf[K]; expect: { ok: boolean; checks: string[] } };
}[DeliverableKind];

/** `ffprobe -show_streams -show_format -of json`, recorded. */
export const FFPROBE = {
  reel6sWithSound: { streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, duration: "6.000000" }, { codec_type: "audio", codec_name: "aac", duration: "6.000000" }], format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "6.000000", size: "74015" } },
  reel6sSilent: { streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, duration: "6.000000" }], format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "6.000000", size: "16814" } },
  /** "moov atom not found": ffprobe printed `{}` and exited 1. */
  truncated: {},
} as const;

const REEL = { durationSec: durationAround(6), width: 1080, height: 1920, bytes: { min: 1, max: 200 * 1024 * 1024 } };
const OURS = ["nomila.co", "nomila-v2-iau7alh5qq-uc.a.run.app"];
/** Her rows (made up): the accounts and the official roster page the realistic deck links to. */
const HER = herLinksFrom({
  connected: [{ platform: "instagram", platform_username: "alex.rivera" }, { platform: "tiktok", platform_username: "alexruns" }],
  identities: [{ platform: "youtube", handle: "AlexRiveraRuns", canonical_url: null }],
  socials: { twitter: "alexrivera_" },
  facts: [{ source_url: "https://gostatesports.example/sports/track/roster/alex-rivera/1234", also_seen_at: [], source_type: "official", subject_kind: "athlete" }],
});
const OTHERS = [{ id: "a7e0c1d2-0000-4000-8000-0000000000aa", name: "Riley Okafor", emails: ["riley.okafor@mail.example"], amounts: [2500] }];


export const VERIFIER_CASES: readonly VerifierCase[] = [
  // ── video ──
  { id: "reel-good", kind: "video", artifact: { facts: videoFactsFromFfprobe(FFPROBE.reel6sWithSound, null) }, ctx: { ...REEL, audio: true }, expect: { ok: true, checks: [] } },
  { id: "reel-lost-its-music", kind: "video", artifact: { facts: videoFactsFromFfprobe(FFPROBE.reel6sSilent, null) }, ctx: { ...REEL, audio: true }, expect: { ok: false, checks: ["audio"] } },
  { id: "reel-silent-no-bed", kind: "video", artifact: { facts: videoFactsFromFfprobe(FFPROBE.reel6sSilent, null) }, ctx: { ...REEL, audio: false }, expect: { ok: true, checks: [] } },
  { id: "reel-wrong-length", kind: "video", artifact: { facts: videoFactsFromFfprobe(FFPROBE.reel6sWithSound, null) }, ctx: { ...REEL, durationSec: durationAround(15) }, expect: { ok: false, checks: ["duration"] } },
  { id: "reel-wrong-frame", kind: "video", artifact: { facts: videoFactsFromFfprobe(FFPROBE.reel6sWithSound, null) }, ctx: { ...REEL, width: 1080, height: 1350 }, expect: { ok: false, checks: ["resolution"] } },
  { id: "reel-truncated", kind: "video", artifact: { facts: videoFactsFromFfprobe(FFPROBE.truncated, 5) }, ctx: REEL, expect: { ok: false, checks: ["readable"] } },
  { id: "reel-too-big", kind: "video", artifact: { facts: videoFactsFromFfprobe(FFPROBE.reel6sWithSound, 300 * 1024 * 1024) }, ctx: REEL, expect: { ok: false, checks: ["size"] } },
  // ── image ──
  { id: "feed-picture-good", kind: "image", artifact: { facts: { decoded: true, width: 1080, height: 1350, sizeBytes: 412_000 } }, ctx: { width: 1080, height: 1350, bytes: { min: 1, max: 25 * 1024 * 1024 } }, expect: { ok: true, checks: [] } },
  { id: "feed-picture-square", kind: "image", artifact: { facts: { decoded: true, width: 1080, height: 1080, sizeBytes: 412_000 } }, ctx: { width: 1080, height: 1350 }, expect: { ok: false, checks: ["dimensions"] } },
  { id: "picture-corrupt", kind: "image", artifact: { facts: { decoded: false, error: "VipsJpeg: premature end of JPEG image", width: null, height: null, sizeBytes: 9_000 } }, ctx: { width: 1080, height: 1350 }, expect: { ok: false, checks: ["decodes"] } },
  // ── document ──
  {
    id: "pitch-good", kind: "document",
    artifact: documentFromDeckHtml(DECK_HTML.pitchGood),
    ctx: { requiredSections: ["cover"], allowedHosts: OURS }, expect: { ok: true, checks: [] },
  },
  {
    id: "pitch-links-to-her-socials-and-roster", kind: "document",
    artifact: documentFromDeckHtml(DECK_HTML.pitchWithHerLinks),
    ctx: { requiredSections: ["cover"], allowedHosts: OURS, her: HER }, expect: { ok: true, checks: [] },
  },
  {
    id: "pitch-links-to-a-shortener", kind: "document",
    artifact: documentFromDeckHtml(DECK_HTML.pitchWithForeignLinks),
    ctx: { requiredSections: ["cover"], allowedHosts: OURS, her: HER }, expect: { ok: false, checks: ["links"] },
  },
  {
    id: "pitch-template-residue", kind: "document",
    artifact: documentFromDeckHtml(DECK_HTML.pitchTemplateResidue),
    ctx: { requiredSections: ["cover"], allowedHosts: OURS }, expect: { ok: false, checks: ["placeholders"] },
  },
  {
    id: "public-page-no-cover-foreign-link", kind: "document",
    artifact: documentFromDeckHtml(DECK_HTML.publicPageNoCoverForeignLink),
    ctx: { requiredSections: ["cover"], allowedHosts: OURS }, expect: { ok: false, checks: ["sections", "links"] },
  },
  {
    id: "brand-book-missing-plan", kind: "document",
    artifact: { sections: [{ id: "cover", text: "Alex Rivera" }, { id: "found", text: "What we found" }], links: [] },
    ctx: { requiredSections: ["cover", "plan"], allowedHosts: OURS }, expect: { ok: false, checks: ["sections"] },
  },
  // ── draft reply ──
  { id: "reply-good", kind: "draft_reply", artifact: { body: "Hi Sam,\n\nThanks for reaching out — I'd love to hear more. What would the posts involve?\n\nBest,\nAlex", to: "sam@northpeak.example" }, ctx: { maxChars: 3000, otherAthletes: OTHERS }, expect: { ok: true, checks: [] } },
  { id: "reply-no-recipient", kind: "draft_reply", artifact: { body: "Hi there,\n\nThanks!\n\nAlex", to: null }, ctx: { maxChars: 3000, otherAthletes: OTHERS }, expect: { ok: false, checks: ["recipient"] } },
  { id: "reply-residue", kind: "draft_reply", artifact: { body: "Hi Sam, my rate is [amount] per post. TODO: add usage.", to: "Sam" }, ctx: { maxChars: 3000, otherAthletes: OTHERS }, expect: { ok: false, checks: ["placeholders"] } },
  { id: "reply-dm-too-long", kind: "draft_reply", artifact: { body: "Thanks so much! ".repeat(70), to: "@northpeak" }, ctx: { maxChars: 1000, otherAthletes: OTHERS }, expect: { ok: false, checks: ["length"] } },
  // A teammate on a joint campaign is named freely; their private data is not.
  { id: "reply-names-a-teammate", kind: "draft_reply", artifact: { body: "Hi Sam, Riley Okafor and I would both be glad to.", to: "Sam" }, ctx: { maxChars: 3000, otherAthletes: OTHERS }, expect: { ok: true, checks: [] } },
  { id: "reply-another-athletes-deal", kind: "draft_reply", artifact: { body: "Hi Sam, Riley Okafor got $2,500 for this, so I'd ask the same.", to: "Sam" }, ctx: { maxChars: 3000, otherAthletes: OTHERS }, expect: { ok: false, checks: ["other_athlete"] } },
  { id: "reply-another-athletes-email", kind: "draft_reply", artifact: { body: "Hi Sam, you can loop in riley.okafor@mail.example too.", to: "Sam" }, ctx: { maxChars: 3000, otherAthletes: OTHERS }, expect: { ok: false, checks: ["other_athlete"] } },
  // ── answer with sources ──
  {
    id: "answer-good", kind: "answer",
    artifact: { statements: [{ text: "Cobaltwave looks legit.", sourceIx: [0] }, { text: "They sponsored two college volleyball players this year.", sourceIx: [0, 1] }], sources: [{ url: "https://cobaltwave.example/press" }, { url: "https://collegesportsdaily.example/refill" }] },
    ctx: {}, expect: { ok: true, checks: [] },
  },
  {
    id: "answer-unsourced-claim", kind: "answer",
    artifact: { statements: [{ text: "Cobaltwave looks legit.", sourceIx: [0] }, { text: "They pay $2,000 a post.", sourceIx: [] }], sources: [{ url: "https://cobaltwave.example/press" }] },
    ctx: {}, expect: { ok: false, checks: ["claim_sources"] },
  },
  {
    id: "answer-bad-source", kind: "answer",
    artifact: { statements: [{ text: "Cobaltwave looks legit.", sourceIx: [0, 3] }], sources: [{ url: "cobaltwave.example/press" }] },
    ctx: {}, expect: { ok: false, checks: ["source_index", "source_urls"] },
  },
];
