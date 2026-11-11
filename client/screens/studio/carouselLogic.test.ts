/**
 * carouselLogic.test.ts — the Carousel Create screen's pure rules and its two structural riders (PR 9, Lane 4).
 *   "a 4th reference accepted" (client)                 — addRef takes a fourth
 *   "candidate or stage count exceeds the quote" (client) — setVariations passes a total over three
 *   "download-all names its count"                      — downloadAllLabel drops the count (Adi's rider 3)
 *   "carousel entry renders in the edit popover"      — the popover has no carousel door (the format chip is the only entry)
 *   "the interim chooser path survives" (Adi's rider 2)   — BrandPlanStep still knows the old next-screen path
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addRef,
  batchBody,
  canCreate,
  allSettled,
  candidatesOf,
  downloadAllLabel,
  readyBatches,
  removeRef,
  setVariations,
  totalVariations,
  type CarouselRef,
} from "./carouselLogic";
import { brandFormatsFor } from "./brandLogic";
import { MANUAL_OPS } from "./editPopoverLogic";
import type { EditPresented } from "./editTypes";

const P = (n: number) =>
  `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-00000000000${n}`;
const ref = (n: number, variations = 1): CarouselRef => ({
  assetId: P(n),
  thumbUrl: null,
  variations,
  cleanup: null,
  refusal: null,
});

describe("references: one to three, never the same twice", () => {
  /** ⚠️ MUTATION "a 4th reference accepted": drop the MAX_REFS check in addRef. */
  it("takes three, refuses a fourth in copy, refuses a repeat", () => {
    let refs: CarouselRef[] = [];
    for (const n of [1, 2, 3]) {
      const out = addRef(refs, { assetId: P(n), thumbUrl: null });
      expect(out.ok).toBe(true);
      if (out.ok) refs = out.refs;
    }
    expect(refs).toHaveLength(3);
    expect(addRef(refs, { assetId: P(4), thumbUrl: null })).toEqual({
      ok: false,
      reason: expect.stringContaining("Up to 3 photos"),
    });
    expect(addRef(refs, { assetId: P(1), thumbUrl: null })).toEqual({
      ok: false,
      reason: expect.stringContaining("already in"),
    });
    expect(removeRef(refs, P(2)).map((r) => r.assetId)).toEqual([P(1), P(3)]);
  });

  /** ⚠️ MUTATION "candidate or stage count exceeds the quote": drop the total check in setVariations. */
  it("her distribution: any split that keeps the total at three; a total over three is refused", () => {
    const three = [ref(1), ref(2), ref(3)];
    expect(totalVariations(three)).toBe(3);
    expect(setVariations(three, P(1), 2)).toEqual({
      ok: false,
      reason: expect.stringContaining("Up to 3 ads"),
    });
    const one = [ref(1)];
    const out = setVariations(one, P(1), 3);
    expect(out.ok && out.refs[0].variations).toBe(3);
    expect(setVariations(one, P(1), 4)).toEqual({
      ok: false,
      reason: expect.stringContaining("One to three"),
    });
    const two = [ref(1, 2), ref(2, 1)];
    expect(setVariations(two, P(2), 2)).toMatchObject({ ok: false });
    expect(canCreate([])).toBe(false);
    expect(canCreate([{ ...ref(1), refusal: "still checking" }])).toBe(false);
    expect(canCreate(two)).toBe(true);
  });

  it("the batch body carries a cleanup ONLY where the pass grounded one, and the brief lines verbatim", () => {
    const rec = {
      op: "recolour" as const,
      params: { target: "logos", colour: "black" },
      because: "No Nike marks on kit or ball.",
      what: "w",
    };
    const body = batchBody(
      [{ ...ref(1, 2), cleanup: rec }, ref(2)],
      "Jane Street",
      { story: "s" },
      ["No Nike marks on kit or ball."],
      "Without theatrics",
      "stadium pitch at dusk",
    );
    expect(body).toEqual({
      refs: [
        { assetId: P(1), variations: 2, cleanup: rec },
        { assetId: P(2), variations: 1, cleanup: null },
      ],
      brand: "Jane Street",
      campaign: { story: "s" },
      headline: "Without theatrics",
      setting: "stadium pitch at dusk",
      briefLines: ["No Nike marks on kit or ball."],
    });
  });
});

describe("results", () => {
  /** ⚠️ MUTATION "download-all names its count": return "Download all" with no number. */
  it("Download-all names how many it will save", () => {
    expect(downloadAllLabel(3)).toBe("Download all · 3 frames");
    expect(downloadAllLabel(1)).toBe("Download all · 1 frame");
    expect(downloadAllLabel(3)).toMatch(/\b3\b/);
  });

  const row = (over: Partial<EditPresented>): EditPresented => ({
    id: "r",
    sourceAssetId: P(1),
    op: "ad",
    status: "ready",
    batchId: "b",
    url: "u",
    width: 1,
    height: 1,
    costQuotedUsd: 0.2,
    costUsd: 0.13,
    acceptedAssetId: null,
    intermediate: false,
    error: null,
    createdAt: "2026-09-23T00:00:00.000Z",
    expiresAt: "2026-09-24T00:00:00.000Z",
    ...over,
  });

  it("results show only once every candidate has settled — three windows hold the place until then", () => {
    expect(allSettled([])).toBe(false);
    expect(
      allSettled([row({ id: "b1" }), row({ id: "b2", status: "running" })]),
    ).toBe(false);
    expect(
      allSettled([row({ id: "b1" }), row({ id: "b2", status: "quoted" })]),
    ).toBe(false);
    expect(
      allSettled([
        row({ id: "b1" }),
        row({ id: "b2", status: "failed" }),
        row({ id: "b3", status: "discarded" }),
      ]),
    ).toBe(true);
  });

  // A fixed clock (PR 10, R-7): the fixture expires 2026-09-24T00:00Z, and a test that read Date.now() would
  // start failing the moment the calendar passed it — as it did on the evening of 23 Sep 2026.
  const NOW = Date.parse("2026-09-23T12:00:00.000Z");

  it("the grid never shows an intermediate; the Now feed row appears once every candidate settled, none decided", () => {
    const rows = [
      row({ id: "a", intermediate: true, op: "recolour" }),
      row({ id: "b1" }),
      row({ id: "b2", createdAt: "2026-09-23T00:00:01.000Z" }),
    ];
    expect(candidatesOf(rows).map((r) => r.id)).toEqual(["b1", "b2"]);
    expect(readyBatches(rows, NOW)).toEqual([{ batchId: "b", ready: 2, total: 2 }]);
    expect(
      readyBatches([...rows, row({ id: "b3", status: "running" })], NOW),
    ).toEqual([]);
    expect(
      readyBatches([row({ id: "b1", status: "accepted" }), row({ id: "b2" })], NOW),
    ).toEqual([]);
    expect(readyBatches([row({ id: "x", batchId: null })], NOW)).toEqual([]);
  });

  /** ⚠️ MUTATION "an expired ready row shows under Now" (PR 10, R-7): drop the expiry line in readyBatches. */
  it("an expired ready row shows under Now: never — by the server's flag, or by its expiresAt against the clock", () => {
    const rows = [row({ id: "b1" }), row({ id: "b2" })];
    const past = Date.parse("2026-09-25T00:00:00.000Z");
    expect(readyBatches(rows, past)).toEqual([]);
    expect(readyBatches([row({ id: "b1", expired: true }), row({ id: "b2", expired: true })], NOW)).toEqual([]);
    // One expired, one standing: the batch still shows, counting only what stands.
    expect(readyBatches([row({ id: "b1", expired: true }), row({ id: "b2" })], NOW)).toEqual([
      { batchId: "b", ready: 1, total: 1 },
    ]);
  });
});

describe("the two doors and the dead path — structural", () => {
  const src = (p: string) => readFileSync(join(__dirname, p), "utf8");

  /** ⚠️ MUTATION "carousel entry renders in the edit popover": add a StudioCarouselCreate navigation or an ad door to the popover. */
  it("the popover has no carousel entry — no StudioCarouselCreate navigation, no ad door, no ad chip; the manual entry alone; the ad op is not a manual op", () => {
    const popover = src("../../components/studio/EditPopover.tsx");
    expect(popover).not.toMatch(
      /StudioCarouselCreate|onAd|Make it an ad|use-studio-edits|fetch\(/,
    );
    expect(popover.match(/testID="edit-popover-manual"/g)).toHaveLength(1);
    expect(popover).toMatch(/r\.op !== "ad"/);
    const agent = src("AgentScreen.tsx");
    expect(agent).not.toMatch(/StudioCarouselCreate|onAd=|campaignFrom/);
    expect(MANUAL_OPS.map((m) => m.op)).not.toContain("ad");
    const sheet = src("../../components/studio/EditSheet.tsx");
    expect(sheet).not.toMatch(/op:\s*"ad"/);
  });

  /** ⚠️ MUTATION "the interim chooser path survives" (Adi's rider 2): restore onOtherFormat / SetupScreen to the chooser. */
  it("the chooser's Carousel chip opens the Carousel Create screen, and the old next-screen path is unreachable from it", () => {
    const step = src("BrandPlanStep.tsx");
    expect(step).toMatch(/nav\.navigate\("StudioCarouselCreate"/);
    expect(step).not.toMatch(/onOtherFormat|SetupScreen|StudioMakeIt/);
    // She picks the photo on THIS screen, before the door (Adi, 23 Sep 2026): the card holds a picker,
    // the door carries the pick as ref 1 with its thumbnail, and it is shut until she has picked.
    expect(step).toMatch(/refs: \[carouselPhoto\.assetId\]/);
    expect(step).toMatch(/thumbs: \{\s*\[carouselPhoto\.assetId\]/);
    expect(step).toMatch(/disabled=\{!carouselPhoto\}/);
    expect(step).not.toMatch(/refs: \[productPhotoId\]/);
    // The setting is not optional (Adi, 23 Sep 2026): no such label, and the quote CTA is shut without one.
    const screen = src("CarouselCreateScreen.tsx");
    expect(screen).not.toMatch(/SETTING · OPTIONAL/);
    expect(screen).toMatch(/!setting\.trim\(\) \|\| busy/);
    const post = src("BrandPostScreen.tsx");
    expect(post).not.toMatch(/otherFormat/);
    // And the plain brand post's Set-it-up screen — the one she sees with the brand-profile flags off —
    // sends its Carousel chip to the same screen, never to Make it (Adi, 23 Sep 2026).
    const setup = src("SetupScreen.tsx");
    expect(setup).toMatch(/format === "carousel" \? toCarousel : toPlan/);
    expect(setup).toMatch(/nav\.navigate\("StudioCarouselCreate"/);
  });

  /** ⚠️ MUTATION "Carousel chip renders with STUDIO_IMAGE_EDIT off": return BRAND_FORMATS from brandFormatsFor whatever the flag, or read BRAND_FORMATS directly in BrandPlanStep. */
  it("with STUDIO_IMAGE_EDIT off the chooser is Video only, the chooser reads the flag, and the Create screen is a closed door before any hook (PR 10, R-1)", () => {
    expect(brandFormatsFor(false).map((f) => f.key)).toEqual(["video"]);
    expect(brandFormatsFor(true).map((f) => f.key)).toEqual(["video", "carousel"]);
    const step = src("BrandPlanStep.tsx");
    expect(step).toMatch(/brandFormatsFor\(STUDIO_IMAGE_EDIT\)\.map/);
    expect(step).not.toMatch(/BRAND_FORMATS\.map/);
    const setup = src("SetupScreen.tsx");
    expect(setup).toMatch(/if \(!STUDIO_IMAGE_EDIT\) \{\s*toPlan\(\);/);
    const screen = src("CarouselCreateScreen.tsx");
    expect(screen).toMatch(/if \(STUDIO_IMAGE_EDIT\) return <CarouselCreateOpen \/>;/);
    // The closed door comes first in the file: the open screen's hooks live in a component that is never mounted.
    expect(screen.indexOf('testID="carousel-closed"')).toBeLessThan(screen.indexOf("function CarouselCreateOpen"));
  });
});
