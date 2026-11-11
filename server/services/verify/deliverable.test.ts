/**
 * deliverable.test.ts — check before deliver (A4), per kind. Pure checks over facts; the image reader on real sharp
 * files made here; the video reader on a file that is not a video. No model, no network, no database.
 */
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import {
  durationAround, linkIsOurs, linkVerdict, otherAthletesIn, placeholderIn, verifyDeliverable, VERIFY_CHECKS, VERIFIER_ERROR_MODE,
  type ImageFacts, type VideoFacts,
} from "./deliverable";
import { readImageFacts, readVideoFacts, videoFactsFromFfprobe } from "./media";
import { anchorHrefs, answerFromCard, documentFromBrandBook, documentFromDeckHtml, ourHosts } from "./adapters";
import { herLinksFrom } from "./herLinks";
import { DECK_HTML } from "./fixtures";

const video = (o: Partial<VideoFacts> = {}): VideoFacts => ({ valid: true, durationSec: 12, hasAudio: true, width: 1080, height: 1920, sizeBytes: 4_000_000, ...o });
const image = (o: Partial<ImageFacts> = {}): ImageFacts => ({ decoded: true, width: 1080, height: 1350, sizeBytes: 300_000, ...o });
const checksOf = (r: Awaited<ReturnType<typeof verifyDeliverable>>) => (r.ok ? [] : r.failures.map((f) => f.check));

describe("video", () => {
  const ctx = { durationSec: durationAround(12), audio: true, width: 1080, height: 1920, bytes: { min: 1, max: 200e6 } };
  it("passes a clip of the planned shape", async () => {
    expect(await verifyDeliverable("video", { facts: video() }, ctx)).toEqual({ ok: true, kind: "video", checked: [...VERIFY_CHECKS.video] });
  });
  it("an unreadable file fails as readable, and nothing else is judged", async () => {
    expect(checksOf(await verifyDeliverable("video", { facts: video({ valid: false, error: "moov atom not found" }) }, ctx))).toEqual(["readable"]);
  });
  it.each([
    ["duration", { durationSec: 6 }],
    ["duration", { durationSec: null }],
    ["audio", { hasAudio: false }],
    ["resolution", { width: 720, height: 1280 }],
    ["size", { sizeBytes: 0 }],
  ])("fails %s", async (check, o) => {
    expect(checksOf(await verifyDeliverable("video", { facts: video(o as Partial<VideoFacts>) }, ctx))).toEqual([check]);
  });
  it("silence is not a finding when no sound was expected", async () => {
    expect((await verifyDeliverable("video", { facts: video({ hasAudio: false }) }, { ...ctx, audio: false })).ok).toBe(true);
  });
  it("the duration slack is the structure check's: max(0.3 s, 5%)", () => {
    expect(durationAround(2)).toEqual({ min: 1.7, max: 2.3 });
    expect(durationAround(20)).toEqual({ min: 19, max: 21 });
  });
  it("parses recorded ffprobe output; no video stream is not valid", () => {
    const json = { streams: [{ codec_type: "video", width: 1080, height: 1920, duration: "12.01" }, { codec_type: "audio" }], format: { duration: "12.05", size: "4000000" } };
    expect(videoFactsFromFfprobe(json, null)).toEqual({ valid: true, durationSec: 12.01, hasAudio: true, width: 1080, height: 1920, sizeBytes: 4000000 });
    expect(videoFactsFromFfprobe({ streams: [{ codec_type: "audio" }] }, 10).valid).toBe(false);
  });
  it("a file that is not a video reads as not valid, never a throw, and never names the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-video-"));
    try {
      const p = join(dir, "not-a-video.mp4");
      await writeFile(p, "hello");
      const f = await readVideoFacts(p);
      expect(f.valid).toBe(false);
      expect(f.error ?? "").not.toContain(p);
      expect(checksOf(await verifyDeliverable("video", { path: p }, ctx))).toEqual(["readable"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("uses an injected reader", async () => {
    const read = jest.fn(async () => video({ durationSec: 30 }));
    expect(checksOf(await verifyDeliverable("video", { path: "/x.mp4" }, { ...ctx, read }))).toEqual(["duration"]);
    expect(read).toHaveBeenCalledWith("/x.mp4");
  });
});

describe("image", () => {
  it("passes the exact frame; fails another size, a minimum, a non-decode", async () => {
    expect((await verifyDeliverable("image", { facts: image() }, { width: 1080, height: 1350 })).ok).toBe(true);
    expect(checksOf(await verifyDeliverable("image", { facts: image({ width: 1080, height: 1080 }) }, { width: 1080, height: 1350 }))).toEqual(["dimensions"]);
    expect(checksOf(await verifyDeliverable("image", { facts: image({ width: 200, height: 200 }) }, { minWidth: 512, minHeight: 512 }))).toEqual(["dimensions"]);
    expect(checksOf(await verifyDeliverable("image", { facts: image({ decoded: false }) }, {}))).toEqual(["decodes"]);
    expect(checksOf(await verifyDeliverable("image", { facts: image({ sizeBytes: 30e6 }) }, { bytes: { max: 25e6 } }))).toEqual(["size"]);
  });
  it("reads real files: a JPEG decodes with its size; a truncated one does not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "verify-image-"));
    try {
      const good = join(dir, "good.jpg");
      const buf = await sharp({ create: { width: 64, height: 80, channels: 3, background: { r: 10, g: 120, b: 200 } } }).jpeg().toBuffer();
      await writeFile(good, buf);
      expect(await readImageFacts(good)).toMatchObject({ decoded: true, width: 64, height: 80, sizeBytes: buf.length });
      const bad = join(dir, "bad.jpg");
      await writeFile(bad, buf.subarray(0, Math.floor(buf.length / 3)));
      expect((await readImageFacts(bad)).decoded).toBe(false);
      expect((await readImageFacts(join(dir, "missing.jpg"))).decoded).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("document", () => {
  const hosts = ["nomila.co", "nomila-v2-iau7alh5qq-uc.a.run.app"];
  it("passes required sections with clean text and our links", async () => {
    const doc = { sections: [{ id: "cover", text: "Alex Rivera · Track" }, { id: "plan", text: "Three posts a week." }], links: ["/p/alex/partner", "#top", "https://nomila.co", "co.nomila.app://opportunities"] };
    expect((await verifyDeliverable("document", doc, { requiredSections: ["cover", "plan"], allowedHosts: hosts })).ok).toBe(true);
  });
  it("fails a missing section, a placeholder, and a foreign link — each named", async () => {
    const doc = { sections: [{ id: "cover", text: "Hi [Brand Name], my rate is [amount]." }], links: ["https://evil.example/x"] };
    const r = await verifyDeliverable("document", doc, { requiredSections: ["cover", "plan"], allowedHosts: hosts });
    expect(checksOf(r)).toEqual(["sections", "placeholders", "links"]);
  });
  it.each([
    ["[Name]", true], ["[amount]", true], ["[Brand Name]", true], ["[your rate]", true], ["[Insert date]", true], ["[BRAND_NAME]", true],
    ["[FIRST NAME]", true], ["{{first}}", true], ["{{ brand.name }}", true], ["<insert date>", true], ["TODO: fix", true], ["TODO", true],
    ["(FIXME)", true], ["lorem ipsum dolor", true], ["$XXX per post", true], ["call XXX-XXXX", true], ["rate: XXXX", true],
    // Real copy the old check refused: a stream tag, a citation, an editor's [sic], a Spanish word, a jersey size, a roman numeral.
    ["See [our page](https://nomila.co)", false], ["Training at 6 a.m.", false], ["todo list", false], ["Dates TBC", false], ["Date TBD", false],
    ["Game day [Live] on IG", false], ["As reported [1]", false], ["\"best season [sic] yet\"", false], ["TODOS juntos", false], ["Watch [Official Video]", false],
    ["Sizes S to XXL", false], ["Super Bowl XXX", false], ["XXXL hoodie", false], ["Mastodon {{", false], ["[Day 1] recap", false],
  ])("placeholder %s → %s", (text, hit) => {
    expect(placeholderIn(text) !== null).toBe(hit);
  });
  it.each([
    ["https://nomila.co/p/x", true], ["https://app.nomila.co/x", true], ["https://nomila.co.evil.example", false],
    ["javascript:alert(1)", false], ["//evil.example", false], ["mailto:a@b.co", true], ["https://instagram.com/x", false], ["ftp://nomila.co", false],
  ])("link %s ours → %s", (href, ours) => {
    expect(linkIsOurs(href, ["nomila.co"])).toBe(ours);
  });
  it("reads a rendered deck: card kinds by class (nested sections too), visible text, anchors only", () => {
    const html = `<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/x"></head><body>
      <section class="pc-hero"><div><section class="scr g-ink k-cover v-A"><h1>Alex</h1></section><section class="scr k-statement">Fast</section></div></section>
      <a class="btn" href="/p/alex/partner">Partner</a><script>var x = "[Name]";</script></body></html>`;
    const d = documentFromDeckHtml(html);
    expect(d.sections.map((s) => s.id)).toEqual(["cover", "statement", "page"]);
    expect(d.sections.find((s) => s.id === "page")!.text).toBe("Alex Fast Partner");
    expect(d.links).toEqual(["/p/alex/partner"]);
    expect(anchorHrefs(`<a href='https://x.example'>x</a>`)).toEqual(["https://x.example"]);
  });
  it("reads a brand book: chapters by id, lines and facts as text", () => {
    const d = documentFromBrandBook({ pages: [{ id: "cover", title: "Cover", lines: { line: { text: "Alex", options: [] } }, facts: ["12K followers"], images: [] }] as never });
    expect(d).toEqual({ sections: [{ id: "cover", text: "Cover\nAlex\n12K followers" }], links: [] });
  });
  it("our hosts include nomila.co and the configured base URLs", () => {
    const saved = process.env.API_BASE_URL;
    process.env.API_BASE_URL = "https://nomila-v2-iau7alh5qq-uc.a.run.app";
    try { expect(ourHosts()).toEqual(expect.arrayContaining(["nomila.co", "nomila-v2-iau7alh5qq-uc.a.run.app"])); }
    finally { if (saved === undefined) delete process.env.API_BASE_URL; else process.env.API_BASE_URL = saved; }
  });
});

describe("document links: ours, hers, her facts', a profile platform — nothing else", () => {
  const OURS = ["nomila.co", "nomila-v2-iau7alh5qq-uc.a.run.app"];
  // Her rows as the loader reads them (made up): two connected accounts, a researched YouTube, a sign-up X handle, and
  // facts from her school's roster (official) and a news story.
  const her = herLinksFrom({
    connected: [{ platform: "instagram", platform_username: "alex.rivera" }, { platform: "tiktok", platform_username: "alexruns" }, { platform: "gmail", platform_username: null }],
    identities: [{ platform: "youtube", handle: null, canonical_url: "https://www.youtube.com/@AlexRiveraRuns" }],
    socials: { twitter: "@alexrivera_" },
    facts: [
      { source_url: "https://gostatesports.example/sports/track/roster/alex-rivera/1234", also_seen_at: [{ url: "https://news.example/2026/10/alex-rivera-wins-state" }], source_type: "official", subject_kind: "athlete" },
      { source_url: "https://localpaper.example/sports/alex-rivera-profile/", also_seen_at: [], source_type: "local", subject_kind: "athlete" },
    ],
  });
  const ctx = { requiredSections: ["cover"], allowedHosts: OURS, her };
  it.each([
    ["/p/alex/partner", "ours"], ["co.nomila.app://opportunities", "ours"], ["https://nomila.co/p/alex", "ours"],
    ["https://instagram.com/alex.rivera", "her_account"], ["https://www.instagram.com/alex.rivera/", "her_account"], ["https://instagram.com/alex.rivera/reel/C9xyz", "her_account"],
    ["https://www.tiktok.com/@alexruns", "her_account"], ["https://youtube.com/@alexriveraruns", "her_account"], ["https://twitter.com/alexrivera_", "her_account"], ["https://x.com/alexrivera_", "her_account"],
    ["https://gostatesports.example/sports/track/roster/alex-rivera/1234", "her_fact"], ["https://gostatesports.example/sports/track", "her_fact"],
    ["https://news.example/2026/10/alex-rivera-wins-state?utm_source=x", "her_fact"], ["https://localpaper.example/sports/alex-rivera-profile", "her_fact"],
    ["https://instagram.com/teammate.jo", "profile_platform"], ["https://www.linkedin.com/in/alex-rivera", "profile_platform"], ["https://linktr.ee/alexrivera", "profile_platform"],
    ["https://bit.ly/x", "refused"], ["https://evil.example/alex.rivera", "refused"], ["https://localpaper.example/other-story", "refused"], ["https://instagram.com", "refused"],
    ["http://instagram.com/teammate.jo", "refused"], ["javascript:alert(1)", "refused"], ["https://user:pw@instagram.com/alex.rivera", "refused"], ["https://instagram.com.evil.example/alex.rivera", "refused"],
  ])("%s → %s", (href, want) => {
    expect(linkVerdict(href, ctx)).toBe(want);
  });
  it("a realistic pitch deck with her socials, her school roster and our doors passes", async () => {
    const d = documentFromDeckHtml(DECK_HTML.pitchWithHerLinks);
    expect(d.links.length).toBeGreaterThanOrEqual(6);
    expect(await verifyDeliverable("document", d, ctx)).toMatchObject({ ok: true });
  });
  it("the same deck fails on a shortener and a stranger's site, and the reason says what a link must be", async () => {
    const r = await verifyDeliverable("document", documentFromDeckHtml(DECK_HTML.pitchWithForeignLinks), ctx);
    expect(checksOf(r)).toEqual(["links"]);
    expect(r.ok ? "" : r.failures[0].reason).toMatch(/not ours, not her account, not from her facts, not a known profile platform: https:\/\/bit\.ly/);
  });
  it("without her rows, her own handles still pass as profile links; her school site does not", () => {
    expect(linkVerdict("https://instagram.com/alex.rivera", { allowedHosts: OURS })).toBe("profile_platform");
    expect(linkVerdict("https://gostatesports.example/sports/track", { allowedHosts: OURS })).toBe("refused");
  });
  it("a brand book with her socials passes", async () => {
    const book = { sections: [{ id: "cover", text: "Alex Rivera" }, { id: "plan", text: "Three posts a week." }], links: ["https://instagram.com/alex.rivera", "https://www.tiktok.com/@alexruns"] };
    expect((await verifyDeliverable("document", book, { requiredSections: ["cover", "plan"], allowedHosts: OURS, her })).ok).toBe(true);
  });
});

describe("draft_reply", () => {
  const casey = { id: "7d3c1d2e-0000-4000-8000-000000000001", name: "Casey Morgan", emails: ["casey.morgan@mail.example"], phones: ["+1 (555) 201-7788"],
    amounts: [4000], snippets: ["Northwind offered Casey a three-post package with a 60-day usage window and product seeding."] };
  const others = [casey, { id: "7d3c1d2e-0000-4000-8000-000000000002", name: "Sam" }];
  const ctx = { maxChars: 3000, otherAthletes: others };
  it("passes a clean, addressed reply", async () => {
    expect((await verifyDeliverable("draft_reply", { body: "Hi Jo,\n\nThanks — happy to talk.\n\nBest,\nAlex", to: "Jo Park" }, ctx)).ok).toBe(true);
  });
  it.each([
    ["recipient", { body: "Hi there, thanks.", to: null }],
    ["recipient", { body: "Hi there, thanks.", to: "  " }],
    ["placeholders", { body: "Hi [Name], my rate is [amount].", to: "Jo" }],
    ["length", { body: "x".repeat(3001), to: "Jo" }],
    ["other_athlete", { body: "ref 7d3c1d2e-0000-4000-8000-000000000001", to: "Jo" }],
    ["other_athlete", { body: "You can also reach casey.morgan@mail.example.", to: "Jo" }],
    ["other_athlete", { body: "Call 555-201-7788 to set it up.", to: "Jo" }],
    ["other_athlete", { body: "Casey Morgan got $4,000 for the same thing, so I'd want that too.", to: "Jo" }],
    ["other_athlete", { body: "Like before: Northwind offered Casey a three-post package with a 60-day usage window and product seeding.", to: "Jo" }],
  ])("fails %s", async (check, a) => {
    expect(checksOf(await verifyDeliverable("draft_reply", a, ctx))).toEqual([check]);
  });
  it.each([
    "Casey Morgan and I would love to do the joint campaign together.",
    "Happy to post alongside Casey Morgan — two reels each works for us.",
    "My rate for this is $4,000.",
    "Sam said hi. Casey Morganson too.",
  ])("a teammate's name, or a figure without their name, is not a leak: %s", async (body) => {
    expect((await verifyDeliverable("draft_reply", { body, to: "Jo" }, ctx)).ok).toBe(true);
  });
  it("what the thread itself carries is theirs to quote", async () => {
    const body = "Thanks — I'll cc casey.morgan@mail.example as you suggested, and Casey Morgan's $4,000 sounds right for me too.";
    expect((await verifyDeliverable("draft_reply", { body, to: "Jo" }, { ...ctx, quoted: "Please cc casey.morgan@mail.example. We paid Casey Morgan $4,000." })).ok).toBe(true);
  });
  it("the failure names the kind of match, never the other athlete or the value", async () => {
    const r = await verifyDeliverable("draft_reply", { body: "Casey Morgan got $4,000; write to casey.morgan@mail.example", to: "Jo" }, ctx);
    expect(checksOf(r)).toEqual(["other_athlete"]);
    expect(JSON.stringify(r)).not.toMatch(/Casey|casey|4,000|7d3c1d2e/);
    expect(otherAthletesIn("Casey Morgan got $4,000; write to casey.morgan@mail.example", others).sort()).toEqual([`deal_amount ${casey.id}`, `email ${casey.id}`]);
  });
});

describe("answer", () => {
  const sources = [{ url: "https://cobaltwave.example/press" }, { url: "https://collegesportsdaily.example/refill" }];
  it("passes when every claim has a chip and every source is http(s); framing and questions need none", async () => {
    const a = { statements: [{ text: "Here's what I found.", sourceIx: [], claim: false }, { text: "Cobaltwave sponsored two volleyball players in 2025.", sourceIx: [0, 1] }, { text: "Want me to look for more?", sourceIx: [] }], sources };
    expect((await verifyDeliverable("answer", a, {})).ok).toBe(true);
  });
  it.each([
    ["claim_sources", { statements: [{ text: "They are legit.", sourceIx: [] }], sources }],
    ["source_index", { statements: [{ text: "They are legit.", sourceIx: [5] }], sources }],
    ["source_urls", { statements: [{ text: "They are legit.", sourceIx: [0] }], sources: [{ url: "javascript:alert(1)" }] }],
    ["has_claims", { statements: [{ text: "Want me to look?", sourceIx: [] }], sources }],
  ])("fails %s", async (check, a) => {
    expect(checksOf(await verifyDeliverable("answer", a, {}))).toEqual([check]);
  });
});

describe("answer card adapter", () => {
  it("headline + line is one claim with every chip; a list row cites its own source, or the card's", async () => {
    const a = answerFromCard({ headline: "Cobaltwave looks legit.", line: "Two college deals this year.", list: [{ text: "Sponsored a setter", sourceIx: 1 }, { text: "Press page lists both", sourceIx: null }],
      sources: [{ url: "https://cobaltwave.example/press" }, { url: "https://collegesportsdaily.example/refill" }] });
    expect(a.statements.map((s) => s.sourceIx)).toEqual([[0, 1], [1], [0, 1]]);
    expect((await verifyDeliverable("answer", a, {})).ok).toBe(true);
  });
});

describe("a verifier bug (the check itself throws)", () => {
  const boom = async (): Promise<never> => { throw new Error("probe exploded"); };
  it("fails CLOSED for renders, documents and drafts: needs a look, never a throw", async () => {
    expect(VERIFIER_ERROR_MODE).toEqual({ video: "closed", image: "closed", document: "closed", draft_reply: "closed", answer: "open" });
    expect(checksOf(await verifyDeliverable("video", { path: "/x.mp4" }, { read: boom }))).toEqual(["verifier_error"]);
    expect(checksOf(await verifyDeliverable("image", { path: "/x.jpg" }, { read: boom }))).toEqual(["verifier_error"]);
    expect(checksOf(await verifyDeliverable("document", { sections: null as never, links: [] }, { requiredSections: ["cover"], allowedHosts: [] }))).toEqual(["verifier_error"]);
    expect(checksOf(await verifyDeliverable("draft_reply", { body: null as never, to: "Jo" }, { maxChars: 10, otherAthletes: [] }))).toEqual(["verifier_error"]);
  });
  it("fails OPEN for an answer card, and says so in `checked`", async () => {
    expect(await verifyDeliverable("answer", { statements: null as never, sources: [] }, {})).toEqual({ ok: true, kind: "answer", checked: ["verifier_error"] });
  });
});

describe("the model review hook (off)", () => {
  it("runs only when passed, and only after every deterministic check passed", async () => {
    const modelReview = jest.fn(async () => [{ check: "model_review", reason: "tone" }]);
    const bad = await verifyDeliverable("draft_reply", { body: "[Name]", to: "Jo" }, { maxChars: 10, otherAthletes: [], modelReview });
    expect(modelReview).not.toHaveBeenCalled();
    expect(checksOf(bad)).toEqual(["placeholders"]);
    const reviewed = await verifyDeliverable("draft_reply", { body: "Hi Jo", to: "Jo" }, { maxChars: 10, otherAthletes: [], modelReview });
    expect(checksOf(reviewed)).toEqual(["model_review"]);
  });
  it("a review that throws leaves the deterministic result standing", async () => {
    const r = await verifyDeliverable("answer", { statements: [{ text: "A.", sourceIx: [0] }], sources: [{ url: "https://a.example" }] }, { modelReview: async () => { throw new Error("down"); } });
    expect(r.ok).toBe(true);
  });
});
