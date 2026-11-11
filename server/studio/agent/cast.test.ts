/**
 * cast.test.ts — which of her photographs each planned item is made from, against real Postgres.
 *
 * The real `searchMedia` runs here, over PGlite, because the hazards this module exists for are
 * properties of searchMedia's own filters and scoring: an untagged row passing every filter and
 * scoring zero, a video with a poster coming back looking like a still, a soft-deleted row coming
 * back at all. A stubbed search would test a description of them.
 *
 * Mocked at the network boundaries only: `embedText` (one fixed query vector — ranking is then set
 * by each row's own embedding) and `signedUrl`.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));
jest.mock("../../lib/mediaEmbed", () => ({
  embedText: jest.fn(async () => [1, 0, 0]),
  // The module's own arithmetic, restated — the real module builds cloud clients at load.
  cosine: (a: number[], b: number[]) => {
    let dot = 0,
      na = 0,
      nb = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  },
}));
jest.mock("../../lib/mediaStore", () => ({
  signedUrl: jest.fn(async (p: string) => `https://signed.example/${p}`),
  // The stitch publisher's upload — stood in so the REAL publisher can write its row here.
  uploadLocalFile: jest.fn(async () => undefined),
}));

import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, isNotNull } from "drizzle-orm";
import { mediaAssets } from "../../../shared/schema";
import {
  closeTestDb,
  db,
  initTestDb,
  seedAthlete,
} from "../../testUtils/pgliteDb";
import { searchMedia } from "../../services/mediaSearch";
import { brandsToAvoid } from "./brands";
import { embedText } from "../../lib/mediaEmbed";
import {
  asPick,
  castPlan,
  DEMOTED_LINE,
  fitsKind,
  isMetaImage,
  loadCastable,
  NO_PRODUCT_LEFT_LINE,
  rankWithoutHer,
  SWAPPED_LINE,
  UNCAST_CLIP_LINE,
  UNCAST_LINE,
  type CastableRow,
  type CastSearch,
} from "./cast";
import type { AgentPlan, PlanItem } from "./types";

let her: string;
let someoneElse: string;

beforeAll(async () => {
  await initTestDb();
  her = await seedAthlete("Cast Test Athlete");
  someoneElse = await seedAthlete("Another Athlete");
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(async () => {
  await db.delete(mediaAssets);
});

/** Tags as lib/visionTag.ts writes them — only the fields ranking and casting read. */
const tags = (athletePresent: boolean, brands: string[] = []) => ({
  athlete_present: athletePresent,
  athlete_prominence: 0.8,
  shot_type: "action",
  description: "a photograph",
  brands_visible: brands,
  aesthetic_quality: 0.8,
  brand_safe: true,
  hero_suitability: 0.8,
  content_flags: {},
});

/** One of her photographs. `sim` sets how closely it matches every query (cosine to [1,0,0]). */
async function photo(
  over: {
    owner?: string;
    athletePresent?: boolean | null;
    sim?: number;
    /** vision.brands_visible, as the tagger would write it. */
    brands?: string[];
    [k: string]: unknown;
  } = {},
): Promise<string> {
  const {
    owner = her,
    athletePresent = true,
    sim = 1,
    brands = [],
    ...rest
  } = over;
  const tagged = athletePresent !== null;
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: owner,
      platform: "studio",
      origin: "upload",
      media_type: "IMAGE",
      status: "stored",
      gcs_path: `athletes/${owner}/${Math.random().toString(36).slice(2)}.jpg`,
      content_type: "image/jpeg",
      ingested_at: new Date(),
      metadata: tagged
        ? {
            vision: tags(athletePresent as boolean, brands),
            embedding: [sim, Math.sqrt(Math.max(0, 1 - sim * sim)), 0],
          }
        : null,
      ...rest,
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  kind: "i2v",
  beat: "open on her",
  direction: "she turns toward the camera",
  // No named photo: these tests exercise the SWAP path — what an item falls back to when the photo
  // it named cannot be used. Tests that name a photo build a library with `libraryOf`.
  ref: null,
  segment: null,
  window: null,
  motion: null,
  searchQuery: "her, on the track",
  sound: false,
  ...over,
});
const plan = (...items: PlanItem[]): AgentPlan => ({
  items,
  nulled: [],
  gaps: [],
});
/** No products, no picks — the plan cast from her library alone. */
const NO_LIBRARY: ReadonlyMap<string, CastableRow> = new Map();
const NOTHING_GIVEN = {
  products: [],
  library: NO_LIBRARY,
  picks: [],
  avoid: [],
};
/** The library the planner was shown, as the route builds it: `a1`, `a2`… in this order. */
async function libraryOf(...ids: string[]): Promise<Map<string, CastableRow>> {
  const rows = await loadCastable(her, ids);
  return new Map(ids.map((id, i) => [`a${i + 1}`, rows.get(id)!]));
}
/** A photo she picked (as a photo or as a product), as the route hands it over. */
const given = (
  assetId: string,
  athletePresent: boolean | null = false,
  brandsVisible: string[] = [],
) => ({
  assetId,
  thumbUrl: null,
  athletePresent,
  brandsVisible,
  mediaType: "photo" as const,
  durationSeconds: null,
  beats: [],
});

describe("provenance — a label on the row, folded exactly as the picker folds it", () => {
  it("loads the row's origin as camera / made-here / synced, and the fold is MEDIA_ORIGINS' own", async () => {
    const { MEDIA_ORIGINS } = await import("../mediaList");
    const { PROVENANCE_OF_ORIGIN } = await import("./provenance");
    // The same three names, the same members — pinned, because this module may not import mediaList.
    for (const [name, origins] of Object.entries(MEDIA_ORIGINS)) {
      const label =
        name === "upload"
          ? "camera"
          : name === "generated"
            ? "made-here"
            : "synced";
      for (const o of origins) expect(PROVENANCE_OF_ORIGIN[o]).toBe(label);
    }
    expect(Object.keys(PROVENANCE_OF_ORIGIN).sort()).toEqual(
      Object.values(MEDIA_ORIGINS).flat().sort(),
    );

    const up = await photo({ origin: "upload", platform: "upload" });
    const made = await photo({ origin: "generated", platform: "studio" });
    const synced = await photo({ origin: "connected", platform: "instagram" });
    const rows = await loadCastable(her, [up, made, synced]);
    expect(rows.get(up)?.provenance).toBe("camera");
    expect(rows.get(made)?.provenance).toBe("made-here");
    expect(rows.get(synced)?.provenance).toBe("synced");
  });

  /**
   * ⚠️ THE PIN ON AN INFERRED LABEL (Adi, 22 Sep 2026). `stitched-here` is read off an ABSENT field
   * (no generation job) or the publisher's path — so this runs the REAL publisher
   * (video/materialize.ts `publishStitchOutput`, upload stood in) and reads its row back through
   * the caster. A publisher that starts writing job ids, or moves its path, reds here rather than
   * silently re-admitting compilations as "your clip".
   *
   * MUTATIONS, each red here: fold on origin alone (the row reads made-here) · require BOTH
   * witnesses (set a job id on the published row: still stitched by path, but the fold says
   * made-here) · drop `notStitchedHere` from listClips (the compilation is offered).
   */
  it("reads the stitch publisher's own row as stitched-here, and never offers it as a clip", async () => {
    const { publishStitchOutput } = await import("../video/materialize");
    const dir = await mkdtemp(join(tmpdir(), "stitch-row-"));
    const localPath = join(dir, "output.mp4");
    await writeFile(localPath, Buffer.from("not really an mp4"));
    const { assetId } = await publishStitchOutput({
      athleteId: her,
      stitchJobId: randomUUID(),
      localPath,
      width: 1080,
      height: 1920,
      durationSeconds: 12.5,
    });
    // Enrichment would tag it later; the offer needs a vision object to describe it with.
    await db
      .update(mediaAssets)
      .set({ metadata: { vision: { ...tags(true), beats: [] } } } as never)
      .where(eq(mediaAssets.id, assetId));
    const generated = await clip();

    const rows = await loadCastable(her, [assetId, generated]);
    expect(rows.get(assetId)?.provenance).toBe("stitched-here");
    expect(rows.get(assetId)?.mediaType).toBe("clip");
    expect(rows.get(generated)?.provenance).toBe("made-here");

    // Enforcement: the compilation is not OFFERED. Her pick of it still loads (above) — labelled.
    const { listClips } = await import("./cast");
    expect((await listClips(her, 8)).map((r) => r.id)).toEqual([generated]);

    // EITHER witness: a job id on a row under the stitch path is still a compilation…
    await db
      .update(mediaAssets)
      .set({ generation_job_id: randomUUID() } as never)
      .where(eq(mediaAssets.id, assetId));
    expect((await loadCastable(her, [assetId])).get(assetId)?.provenance).toBe(
      "stitched-here",
    );
    expect((await listClips(her, 8)).map((r) => r.id)).toEqual([generated]);
    // …and a made-here video with no job is one wherever it lives.
    const noJob = await clip({
      generation_job_id: null,
      gcs_path: `athletes/${her}/studio/${randomUUID()}/clip.mp4`,
    });
    expect((await loadCastable(her, [noJob])).get(noJob)?.provenance).toBe(
      "stitched-here",
    );
    expect((await listClips(her, 8)).map((r) => r.id)).toEqual([generated]);
  });

  it("the SQL exclusion and the row fold agree on every shape of generated video — and touch no photo and no upload", async () => {
    const { listClips } = await import("./cast");
    const { provenanceOfRow } = await import("./provenance");
    const shapes = [
      {
        generation_job_id: randomUUID(),
        gcs_path: `athletes/${her}/studio/a/x.mp4`,
      },
      { generation_job_id: null, gcs_path: `athletes/${her}/studio/b/x.mp4` },
      {
        generation_job_id: randomUUID(),
        gcs_path: `athletes/${her}/studio/stitch/c/output.mp4`,
      },
      {
        generation_job_id: null,
        gcs_path: `athletes/${her}/studio/stitch/d/output.mp4`,
      },
      {
        origin: "upload",
        generation_job_id: null,
        gcs_path: `athletes/${her}/studio/stitch/e/output.mp4`,
      },
    ];
    const ids: string[] = [];
    for (const shape of shapes) ids.push(await clip(shape));
    const rows = await loadCastable(her, ids);
    const offered = new Set((await listClips(her, 8)).map((r) => r.id));
    for (const id of ids) {
      const row = rows.get(id)!;
      const fold = provenanceOfRow({
        origin: shapes[ids.indexOf(id)].origin ?? "generated",
        isVideo: true,
        generationJobId: shapes[ids.indexOf(id)].generation_job_id,
        gcsPath: shapes[ids.indexOf(id)].gcs_path,
      });
      expect(row.provenance).toBe(fold);
      expect(offered.has(id)).toBe(fold !== "stitched-here");
    }
    expect([...offered]).toHaveLength(2); // the generated-with-job clip and the upload
    // A PHOTOGRAPH is never stitched, whatever its columns say.
    const p = await photo({
      origin: "generated",
      platform: "studio",
      generation_job_id: null,
    });
    expect((await loadCastable(her, [p])).get(p)?.provenance).toBe("made-here");
  });
});

describe("castPlan", () => {
  /**
   * ⚠️ MUTATION: judge i2v as "not known to be absent" (`athletePresent !== false`) — which is what
   * trusting searchMedia's truthy-only filter amounts to. This reds, and nothing else does.
   *
   * The thin shelf: the only row that comes back is one enrichment has not reached — no tags, no
   * embedding, a score of exactly 0.000. searchMedia returns it anyway. Nothing has established
   * that she is in it, so it is not cast into an identity shot — the item is dropped and shown.
   */
  it("does not cast the untagged row a thin shelf hands back as filler", async () => {
    await photo({ athletePresent: null });

    const out = await castPlan(her, plan(item()), NOTHING_GIVEN);

    expect(out.items[0]).toMatchObject({ assetId: null, uncast: UNCAST_LINE });
    expect(out.castCount).toBe(0);
  });

  /**
   * ⚠️ MUTATION: drop `media_type IN ('IMAGE','CAROUSEL_ALBUM')` from the caster's predicate. This
   * reds, and nothing else does.
   *
   * searchMedia has no media_type filter: a video with a poster comes back looking like a still —
   * tagged, embedded, a perfect match. The planner casts photographs; a video passes through as a
   * placed clip and is never cast.
   */
  it("does not cast a video that comes back looking like a still", async () => {
    await photo({
      media_type: "VIDEO",
      content_type: "video/mp4",
      gcs_path: `athletes/${her}/clip.mp4`,
      gcs_thumb_path: `athletes/${her}/clip-poster.jpg`,
    });

    const out = await castPlan(her, plan(item()), NOTHING_GIVEN);

    expect(out.items[0].assetId).toBeNull();
  });

  it("does not cast a soft-deleted photograph — searchMedia has no deleted_at filter", async () => {
    await photo({ deleted_at: new Date() });

    const out = await castPlan(her, plan(item()), NOTHING_GIVEN);

    expect(out.items[0].assetId).toBeNull();
  });

  it("does not cast a photograph without her into an identity shot", async () => {
    const empty = await photo({ athletePresent: false, sim: 1 });
    const mine = await photo({ athletePresent: true, sim: 0.5 });

    const out = await castPlan(her, plan(item({ kind: "i2v" })), NOTHING_GIVEN);

    // The empty frame ranks higher on the query and is still not hers to be in.
    expect(out.items[0].assetId).toBe(mine);
    expect(out.items[0].assetId).not.toBe(empty);
  });

  /**
   * ⚠️ MUTATION: let b-roll fall through to `uncast()` again (drop the b-roll branch). The item is then
   * LEFT OUT with a line, and this reds.
   *
   * B-roll is made from words (docs/studio-broll-t2v-decision.md). With a scene and a photo of her both
   * on the shelf, a b-roll item still gets NO photo — and it is not left out: the Board makes it from
   * its direction alone. Nothing is searched and nothing is embedded for it.
   */
  it("b-roll is made from words: never cast, never searched, never swapped — and not left out", async () => {
    await photo({ athletePresent: true, sim: 1 });
    await photo({ athletePresent: false, sim: 1 });
    const scene = await photo({ athletePresent: false, sim: 0.9 });
    const searched: string[] = [];
    const search: CastSearch = async (athleteId, opts) => {
      searched.push(opts?.brief ?? "");
      return searchMedia(athleteId, opts);
    };
    (embedText as jest.Mock).mockClear();

    const out = await castPlan(
      her,
      plan(item({ kind: "broll", searchQuery: "the empty track at dusk" })),
      { ...NOTHING_GIVEN, picks: [given(scene, false)] },
      search,
    );

    expect(out.items[0]).toMatchObject({
      kind: "broll",
      assetId: null,
      thumbUrl: null,
      swapped: null,
      uncast: null,
    });
    expect(out.castCount).toBe(1);
    expect(searched).toEqual([]);
    expect(embedText).not.toHaveBeenCalled();
  });

  /**
   * TENANCY. searchMedia is athlete-scoped, so it never returns another athlete's row — which is why
   * this test injects one: the caster's OWN predicate must refuse it anyway, not merely never meet it.
   */
  it("never casts another athlete's photograph, even if a search handed one back", async () => {
    const theirs = await photo({ owner: someoneElse });
    const search: CastSearch = async () =>
      [{ id: theirs, url: "https://signed.example/theirs" }] as never;

    const out = await castPlan(her, plan(item()), NOTHING_GIVEN, search);

    expect(out.items[0].assetId).toBeNull();
  });

  it("searches under HER athlete id, and only hers", async () => {
    const calls: string[] = [];
    const search: CastSearch = async (athleteId, opts) => {
      calls.push(athleteId);
      return searchMedia(athleteId, opts);
    };
    await photo();
    await photo();

    // Two identity shots: b-roll is not searched at all (its own tenancy test is below).
    await castPlan(her, plan(item(), item()), NOTHING_GIVEN, search);

    expect(calls).toEqual([her, her]);
  });

  it("does not cast the same photograph twice across items", async () => {
    const best = await photo({ sim: 1 });
    const next = await photo({ sim: 0.9 });

    const out = await castPlan(her, plan(item(), item()), NOTHING_GIVEN);

    expect(out.items.map((i) => i.assetId)).toEqual([best, next]);
  });

  it("drops an item nothing fits, keeps the rest, and says so where the item was", async () => {
    const mine = await photo({ athletePresent: true });

    // Two identity shots and one photo of her: the second has nothing left to be made from.
    const out = await castPlan(
      her,
      plan(item({ kind: "i2v" }), item({ kind: "i2v", beat: "close on her" })),
      NOTHING_GIVEN,
    );

    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({ assetId: mine, uncast: null });
    expect(out.items[1]).toMatchObject({
      kind: "i2v",
      beat: "close on her",
      assetId: null,
      uncast: UNCAST_LINE,
    });
    expect(out.castCount).toBe(1);
  });

  it("casts a product item as HER pick, never searched — and the b-roll beside it is made from words", async () => {
    const product = await photo({ athletePresent: false, sim: 1 });
    await photo({ athletePresent: false, sim: 0.5 });
    const searched: string[] = [];
    const search: CastSearch = async (athleteId, opts) => {
      searched.push(opts?.brief ?? "");
      return searchMedia(athleteId, opts);
    };

    const out = await castPlan(
      her,
      plan(
        item({
          kind: "product",
          searchQuery: null,
          direction: "the product, turning",
        }),
        item({ kind: "broll", searchQuery: "the bottle on a bench" }),
      ),
      { products: [given(product)], picks: [], library: NO_LIBRARY, avoid: [] },
      search,
    );

    // Her ACTUAL product, from her photo — the product stays image-to-video on purpose.
    expect(out.items[0]).toMatchObject({ kind: "product", assetId: product });
    // The b-roll gets no photo, not even the scene on the shelf.
    expect(out.items[1]).toMatchObject({ assetId: null, uncast: null });
    // Never searched: a search for the product would carry its direction as the brief.
    expect(searched).not.toContain("the product, turning");
  });

  /**
   * ⚠️ MUTATION: skip the first pass — no preference for her picks. This reds, and nothing else does.
   *
   * She chose this photograph. A library photo that matches the planner's query more closely does
   * not get to replace it.
   */
  it("casts her picked photo over a library photo that matches the query better", async () => {
    await photo({ sim: 1 }); // the library's best match for every query
    const pick = await photo({ sim: 0.2 });

    const out = await castPlan(her, plan(item()), {
      products: [],
      picks: [given(pick, true)],
      library: NO_LIBRARY,
      avoid: [],
    });

    expect(out.items[0].assetId).toBe(pick);
  });

  /**
   * The soccer-ball case. She picked a photo with nobody in it as a regular pick (not a product). No
   * kind takes it now: i2v needs her in frame, b-roll is made from words, and only the products tray
   * is ever a product. So it is never cast — the route names it in `picksWithoutHer` and the Agent
   * screen says why it was left out.
   */
  it("never casts a pick without her into anything — the identity shot takes a photo of her, b-roll takes none", async () => {
    const ball = await photo({ athletePresent: false, sim: 1 });
    const mine = await photo({ athletePresent: true, sim: 0.4 });

    const out = await castPlan(
      her,
      plan(item({ kind: "i2v" }), item({ kind: "broll" })),
      {
        products: [],
        picks: [given(ball, false)],
        library: NO_LIBRARY,
        avoid: [],
      },
    );

    expect(out.items.map((i) => i.assetId)).toEqual([mine, null]);
    expect(out.items.some((i) => i.assetId === ball)).toBe(false);
  });

  /**
   * ⚠️ MUTATION: give every product item her FIRST product (`products[0]`). This reds, and nothing
   * else does.
   *
   * She picked two products for one ad; each product item is the next one she picked. A plan that
   * shows the first product twice has quietly dropped the second.
   */
  it("gives each product item the next product she picked — and drops one past the last, with its line", async () => {
    const shoe = await photo({ athletePresent: false });
    const bottle = await photo({ athletePresent: false });
    const product = item({ kind: "product", searchQuery: null });

    const out = await castPlan(her, plan(product, product, product), {
      products: [given(shoe), given(bottle)],
      picks: [],
      library: NO_LIBRARY,
      avoid: [],
    });

    expect(out.items.map((i) => i.assetId)).toEqual([shoe, bottle, null]);
    expect(out.items[2]).toMatchObject({
      kind: "product",
      uncast: NO_PRODUCT_LEFT_LINE,
    });
    expect(out.castCount).toBe(2);
  });

  it("reserves every product before anything else — a later product is never cast into an identity shot", async () => {
    // Her SECOND product has her hand in it and is the library's best match for the identity shot,
    // and no product item comes first.
    const shoe = await photo({ athletePresent: false, sim: 0.1 });
    const bottleInHand = await photo({ athletePresent: true, sim: 1 });
    const mine = await photo({ athletePresent: true, sim: 0.5 });

    const out = await castPlan(
      her,
      plan(item({ kind: "i2v" }), item({ kind: "product", searchQuery: null })),
      {
        products: [given(shoe), given(bottleInHand, true)],
        picks: [],
        library: NO_LIBRARY,
        avoid: [],
      },
    );

    expect(out.items.map((i) => i.assetId)).toEqual([mine, shoe]);
  });

  /**
   * ⚠️ MUTATION: carry `athletePresent: null` on a cast product. This reds, and nothing else does.
   *
   * A product photo with her hand in it is an identity frame. The client decides the engine from
   * this fact (agentLogic `seedRowsFrom`), so it must arrive exactly as the tagger wrote it.
   */
  it("carries the tagger's fact about her product — a product photo with her in it says so", async () => {
    const bottle = await photo({ athletePresent: true });
    await photo({ athletePresent: false });

    const out = await castPlan(
      her,
      plan(
        item({ kind: "product", searchQuery: null }),
        item({ kind: "broll" }),
      ),
      {
        products: [given(bottle, true)],
        picks: [],
        library: NO_LIBRARY,
        avoid: [],
      },
    );

    // The product carries the tagger's fact; the b-roll, made from words, carries none.
    expect(out.items.map((i) => [i.assetId, i.athletePresent])).toEqual([
      [bottle, true],
      [null, null],
    ]);
  });

  /**
   * `rankWithoutHer` casts nothing now — b-roll is made from words — but the ROUTE still shows the
   * planner her scenes through it, as context a sentence-made shot can stay true to.
   *
   * searchMedia gives every photo of her up to 0.18 of heroScore a scene can never earn. On a library
   * that is mostly her — device check, 21 Sep 2026: 358 of her, 7 without — a scene would never reach
   * the planner. Ranked among themselves, the best scene for the query comes first.
   */
  it("ranks her scenes among themselves — the best scene first, and no photo of her at all", async () => {
    for (let i = 0; i < 30; i++) await photo({ athletePresent: true, sim: 1 });
    const worse = await photo({ athletePresent: false, sim: 0.1 });
    const best = await photo({ athletePresent: false, sim: 0.3 });

    const ranked = await rankWithoutHer(her, "the empty track");

    expect(ranked.map((r) => r.id)).toEqual([best, worse]);
  });

  /**
   * TENANCY, for the path that does not go through searchMedia. ⚠️ MUTATION: rank scenes with only
   * the `athlete_present = false` condition, not THE PREDICATE. This reds, and nothing else does.
   */
  it("ranks only HER scenes — another athlete's closer match never reaches her planner", async () => {
    await photo({ owner: someoneElse, athletePresent: false, sim: 1 });
    const mine = await photo({ athletePresent: false, sim: 0.2 });

    const ranked = await rankWithoutHer(her, "the empty track");

    expect(ranked.map((r) => r.id)).toEqual([mine]);
  });

  /**
   * ⚠️ MUTATION: take the first photograph that fits, ignoring the brands on it (`fitting[0]`, on both
   * paths). This reds, and nothing else does.
   *
   * An Adidas ad. The best match for the identity shot shows Nike; a slightly worse one shows
   * nothing. The clean one is cast. (B-roll is made from words, so no photo of it can show a brand.)
   */
  it("prefers a photograph that shows no other brand when one fits as well", async () => {
    await photo({ athletePresent: true, sim: 1, brands: ["Nike"] });
    const mine = await photo({ athletePresent: true, sim: 0.6 });

    const out = await castPlan(
      her,
      plan(item({ kind: "i2v" }), item({ kind: "broll" })),
      {
        products: [],
        picks: [],
        library: NO_LIBRARY,
        avoid: brandsToAvoid("an Adidas ad for the drop"),
      },
    );

    expect(out.items.map((i) => i.assetId)).toEqual([mine, null]);
  });

  it("still casts a branded photograph when nothing clean fits — the plan is hers to judge", async () => {
    const only = await photo({ athletePresent: true, brands: ["Nike"] });

    const out = await castPlan(her, plan(item()), {
      products: [],
      picks: [],
      library: NO_LIBRARY,
      avoid: brandsToAvoid("an Adidas ad"),
    });

    expect(out.items[0].assetId).toBe(only);
  });

  /**
   * ⚠️ MUTATION: pass over a pick that shows another brand in the first pass. This reds, and nothing
   * else does.
   *
   * She chose it. The Agent says what it shows; it does not overrule her with a cleaner photograph.
   */
  it("never passes over her pick for a cleaner photograph", async () => {
    await photo({ athletePresent: true, sim: 1 });
    const pick = await photo({
      athletePresent: true,
      sim: 0.2,
      brands: ["Nike"],
    });

    const out = await castPlan(her, plan(item()), {
      products: [],
      picks: [given(pick, true, ["Nike"])],
      library: NO_LIBRARY,
      avoid: brandsToAvoid("an Adidas ad"),
    });

    expect(out.items[0].assetId).toBe(pick);
  });
});

describe("castPlan — capabilities ride the item (C2 Half B)", () => {
  it("puts slotted asks on `shot`, and the unslotted ones as prose on the direction — the plan's words are otherwise untouched", async () => {
    const a1 = await photo();
    const library = new Map([["a1", (await loadCastable(her, [a1])).get(a1)!]]);
    const cast = await castPlan(
      her,
      plan(
        item({
          ref: "a1",
          direction: "she turns toward the camera",
          capabilities: {
            camera: "low_angle",
            movement: "push_in",
            lighting: "rim_light",
            composition: "rule_of_thirds",
            motion: "turning",
          },
        }),
        item({ kind: "broll", ref: null, direction: "a ball on the grass" }),
      ),
      { ...NOTHING_GIVEN, library },
    );
    expect(cast.items[0].shot).toEqual({ movement: "push-in" });
    expect(cast.items[0].capabilities).toEqual({
      camera: "low_angle",
      movement: "push_in",
      lighting: "rim_light",
      composition: "rule_of_thirds",
      motion: "turning",
    });
    expect(cast.items[0].direction).toBe(
      "she turns toward the camera Camera: low angle. Light: rim light. Composition: rule of thirds. Motion: turning.",
    );
    expect(cast.items[1].direction).toBe("a ball on the grass");
    expect(cast.items[1].shot).toBeUndefined();
    expect(cast.items[1].capabilities).toBeUndefined();
  });
});

/** One of her clips, read as a clip (Half A's shape): `beats` as the tagger writes them. */
async function clip(
  over: {
    owner?: string;
    beats?: {
      start_s: number;
      end_s: number;
      description?: string;
      camera?: string;
      motion?: string;
    }[];
    duration?: number | null;
    [k: string]: unknown;
  } = {},
): Promise<string> {
  const {
    owner = her,
    beats = [
      { start_s: 0, end_s: 3, camera: "static wide", motion: "she sprints" },
      { start_s: 3, end_s: 6.5, camera: "handheld close-up", motion: "still" },
    ],
    duration = 6.5,
    ...rest
  } = over;
  const [row] = await db
    .insert(mediaAssets)
    .values({
      athlete_id: owner,
      platform: "studio",
      origin: "generated",
      media_type: "VIDEO",
      status: "stored",
      // A GENERATED clip carries the job that made it (studio/jobs.ts `recordGeneratedAsset`). One
      // without a job — or under the stitch path — is a stitched compilation (provenance.ts).
      generation_job_id: randomUUID(),
      gcs_path: `athletes/${owner}/${Math.random().toString(36).slice(2)}.mp4`,
      gcs_thumb_path: `athletes/${owner}/poster.jpg`,
      content_type: "video/mp4",
      duration_seconds_precise: duration,
      ingested_at: new Date(),
      metadata: {
        vision: {
          ...tags(true),
          beats: beats.map((b) => ({ description: "a beat", ...b })),
          video: { source: "clip" },
        },
        embedding: [1, 0, 0],
      },
      ...rest,
    } as never)
    .returning({ id: mediaAssets.id });
  return row.id;
}

describe("castPlan — a clip item is her footage, whole or cut to a beat (C2 Half B)", () => {
  it("loads a clip through the one door with its beats and length, and a poster-only video is not a clip", async () => {
    const c = await clip();
    const posterOnly = await photo({
      media_type: "VIDEO",
      content_type: "image/jpeg",
    });
    const rows = await loadCastable(her, [c, posterOnly]);
    expect(rows.get(c)).toMatchObject({
      mediaType: "clip",
      durationSeconds: 6.5,
    });
    expect(rows.get(c)!.beats).toEqual([
      {
        startSec: 0,
        endSec: 3,
        description: "a beat",
        camera: "static wide",
        motion: "she sprints",
      },
      {
        startSec: 3,
        endSec: 6.5,
        description: "a beat",
        camera: "handheld close-up",
        motion: "still",
      },
    ]);
    expect(rows.has(posterOnly)).toBe(false);
  });

  it("casts a clip item to the clip it named, trimmed to the beat its segment names — $0, no search", async () => {
    const c = await clip();
    const library = new Map([["a1", (await loadCastable(her, [c])).get(c)!]]);
    (embedText as jest.Mock).mockClear();
    const out = await castPlan(
      her,
      plan(
        item({
          kind: "clip",
          ref: "a1",
          segment: 1,
          searchQuery: null,
          sound: true,
        }),
      ),
      { ...NOTHING_GIVEN, library },
    );
    expect(out.items[0]).toMatchObject({
      kind: "clip",
      assetId: c,
      mediaType: "clip",
      trim: { startSec: 3, endSec: 6.5 },
      durationSeconds: 6.5,
      sound: true,
      swapped: null,
      uncast: null,
      // The mp4 signed, so the Board row can play its window (enrichment fixes, 22 Sep 2026).
      videoUrl: expect.stringMatching(
        new RegExp(`^https://signed\\.example/athletes/${her}/.+\\.mp4$`),
      ),
    });
    expect(embedText).not.toHaveBeenCalled();
    expect(out.castCount).toBe(1);
  });

  /**
   * ⚠️ MUTATION, red here by name: keep `thumbUrl: pick.thumbUrl` in `castTo` (ignore the poster)
   * — "a cut clip item shows a frame from inside its window" reds; the whole-clip case stays green.
   */
  it("a cut clip item shows a frame from inside its window — the beat poster — and a whole clip its own poster; a photo has no videoUrl", async () => {
    const c = await clip();
    const p = await photo();
    const library = new Map([
      ["a1", (await loadCastable(her, [c])).get(c)!],
      ["a2", (await loadCastable(her, [p])).get(p)!],
    ]);
    const poster = jest.fn(
      async (g: {
        assetId: string;
        window: { startSec: number; endSec: number };
      }) =>
        `https://signed.example/beats/${g.assetId}/${g.window.startSec}-${g.window.endSec}.jpg`,
    );
    const out = await castPlan(
      her,
      plan(
        item({ kind: "clip", ref: "a1", segment: 1, searchQuery: null }),
        item({ kind: "image", ref: "a2", searchQuery: null }),
      ),
      { ...NOTHING_GIVEN, library },
      undefined,
      poster,
    );
    expect(out.items[0].thumbUrl).toBe(
      `https://signed.example/beats/${c}/3-6.5.jpg`,
    );
    expect(poster).toHaveBeenCalledWith({
      athleteId: her,
      assetId: c,
      videoPath: expect.stringMatching(
        new RegExp(`^athletes/${her}/.+\\.mp4$`),
      ),
      window: { startSec: 3, endSec: 6.5 },
    });
    expect(out.items[1]).toMatchObject({ assetId: p, videoUrl: null });
    expect(poster).toHaveBeenCalledTimes(1);

    // Whole clip: the clip's own poster, no frame asked for. A poster that fails keeps it too.
    const whole = await castPlan(
      her,
      plan(item({ kind: "clip", ref: "a1", segment: null, searchQuery: null })),
      { ...NOTHING_GIVEN, library },
      undefined,
      poster,
    );
    expect(whole.items[0].thumbUrl).toBe(
      `https://signed.example/athletes/${her}/poster.jpg`,
    );
    expect(poster).toHaveBeenCalledTimes(1);
    const failing = await castPlan(
      her,
      plan(item({ kind: "clip", ref: "a1", segment: 0, searchQuery: null })),
      { ...NOTHING_GIVEN, library },
      undefined,
      async () => null,
    );
    expect(failing.items[0].thumbUrl).toBe(
      `https://signed.example/athletes/${her}/poster.jpg`,
    );
  });

  it("a clip item with no segment is the whole clip — trim null", async () => {
    const c = await clip();
    const library = new Map([["a1", (await loadCastable(her, [c])).get(c)!]]);
    const out = await castPlan(
      her,
      plan(item({ kind: "clip", ref: "a1", segment: null, searchQuery: null })),
      { ...NOTHING_GIVEN, library },
    );
    expect(out.items[0]).toMatchObject({ assetId: c, trim: null });
  });

  it("never casts a clip into a photo kind, nor a photo into a clip — the kind fits one media type", async () => {
    const c = await clip();
    const p = await photo();
    const rows = await loadCastable(her, [c, p]);
    const library = new Map([
      ["a1", rows.get(c)!],
      ["a2", rows.get(p)!],
    ]);
    // i2v naming a clip: the named row does not fit, and the search fallback finds only the photo.
    const out = await castPlan(
      her,
      plan(
        item({ kind: "i2v", ref: "a1" }),
        item({ kind: "clip", ref: "a2", segment: null, searchQuery: null }),
      ),
      { ...NOTHING_GIVEN, library },
    );
    expect(out.items[0].assetId).not.toBe(c);
    // clip naming a photo: nothing fits — a clip is never searched for — so it is left out and says so,
    // even though a search would have found the clip above.
    expect(out.items[1]).toMatchObject({
      assetId: null,
      uncast: UNCAST_CLIP_LINE,
    });
    // And the log knows WHY — the kind mismatch, then where the fallback stopped (22 Sep 2026: a
    // live plan reported `dropped: 3` with no reason on the line).
    expect(out.leftOut).toEqual([
      {
        index: 1,
        kind: "clip",
        ref: "a2",
        segment: null,
        reason: expect.stringMatching(
          /^ref_kind_mismatch\(a2 is a photo.*\); no_pick_fits; clip_never_searched$/,
        ),
      },
    ]);
  });

  it("a swapped clip goes in whole — the segment indexed the clip the planner named, not this one", async () => {
    const named = await clip();
    const other = await clip({ beats: [{ start_s: 0, end_s: 2 }] });
    const rows = await loadCastable(her, [named, other]);
    const library = new Map([["a1", rows.get(named)!]]);
    // Two items name the same clip AND THE SAME BEAT — a reuse; the second is swapped to her pick
    // (another clip) — whole. (Two different beats of one clip are not a reuse: next test.)
    const out = await castPlan(
      her,
      plan(
        item({ kind: "clip", ref: "a1", segment: 0, searchQuery: null }),
        item({ kind: "clip", ref: "a1", segment: 0, searchQuery: null }),
      ),
      {
        ...NOTHING_GIVEN,
        library,
        picks: [
          {
            ...given(other),
            mediaType: "clip" as const,
            durationSeconds: 2,
            beats: rows.get(other)!.beats,
          },
        ],
      },
    );
    expect(out.items[0]).toMatchObject({
      assetId: named,
      trim: { startSec: 0, endSec: 3 },
    });
    expect(out.items[1]).toMatchObject({
      assetId: other,
      trim: null,
      swapped: SWAPPED_LINE,
    });
    // Swapped is not left out: nothing on the reasons list.
    expect(out.leftOut).toEqual([]);
  });

  /**
   * ⚠️ MUTATION: key `used` on the asset id alone (drop the `#segment` from `cutKey`). Items 2 and
   * 3 here red as `ref_already_used`, and nothing else in this file does.
   *
   * Found on device, 22 Sep 2026, on the first plan after the doctrine merge: "recap using my real
   * footage" named d076a790's beats [0]–[3] on four items; beat [0] cast, the other three came back
   * "Couldn't use that clip here." A beat is a window of the file, not the file — the plan eval
   * already counts it so (eval/metrics.ts `refsReused`), and the caster now agrees.
   */
  it("casts each beat of one clip to that clip — a beat is a window, not a reuse; the same beat twice, or the whole beside a beat, is", async () => {
    const c = await clip({
      beats: [
        { start_s: 0, end_s: 2 },
        { start_s: 2, end_s: 4 },
        { start_s: 4, end_s: 6.5 },
      ],
    });
    const library = new Map([["a1", (await loadCastable(her, [c])).get(c)!]]);
    const out = await castPlan(
      her,
      plan(
        item({ kind: "clip", ref: "a1", segment: 0, searchQuery: null }),
        item({ kind: "clip", ref: "a1", segment: 1, searchQuery: null }),
        item({ kind: "clip", ref: "a1", segment: 2, searchQuery: null }),
        item({ kind: "clip", ref: "a1", segment: 1, searchQuery: null }), // beat [1] again: a reuse
        item({ kind: "clip", ref: "a1", segment: null, searchQuery: null }), // the whole, beside its beats: a reuse
      ),
      { ...NOTHING_GIVEN, library },
    );
    expect(out.items.map((i) => [i.assetId, i.trim, i.uncast])).toEqual([
      [c, { startSec: 0, endSec: 2 }, null],
      [c, { startSec: 2, endSec: 4 }, null],
      [c, { startSec: 4, endSec: 6.5 }, null],
      [null, null, UNCAST_CLIP_LINE],
      [null, null, UNCAST_CLIP_LINE],
    ]);
    expect(out.castCount).toBe(3);
    expect(out.leftOut.map((l) => [l.index, l.reason])).toEqual([
      [
        3,
        "ref_already_used(a1#1 by item 1); no_pick_fits; clip_never_searched",
      ],
      [
        4,
        "ref_already_used(a1#whole by item 0); no_pick_fits; clip_never_searched",
      ],
    ]);
  });

  it("the whole clip, cast first, blocks every beat of it after", async () => {
    const c = await clip();
    const library = new Map([["a1", (await loadCastable(her, [c])).get(c)!]]);
    const out = await castPlan(
      her,
      plan(
        item({ kind: "clip", ref: "a1", segment: null, searchQuery: null }),
        item({ kind: "clip", ref: "a1", segment: 1, searchQuery: null }),
      ),
      { ...NOTHING_GIVEN, library },
    );
    expect(out.items.map((i) => [i.assetId, i.trim])).toEqual([
      [c, null],
      [null, null],
    ]);
    expect(out.leftOut[0].reason).toMatch(
      /^ref_already_used\(a1#1 by item 0\)/,
    );
  });

  it("lists her clips newest first, tagged only, hers only, capped — and never a photograph", async () => {
    const old = await clip({ ingested_at: new Date("2026-01-01") });
    const newer = await clip({ ingested_at: new Date("2026-06-01") });
    await clip({ metadata: null });
    await clip({ owner: someoneElse });
    await photo();
    const { listClips } = await import("./cast");
    const rows = await listClips(her, 8);
    expect(rows.map((r) => r.id)).toEqual([newer, old]);
    expect((await listClips(her, 1)).map((r) => r.id)).toEqual([newer]);
    expect(await listClips(her, 0)).toEqual([]);
  });

  /**
   * MUTATION: drop `clipProvenanceRank` from the ORDER BY — the oldest camera clip falls to the
   * bottom and this reds. The baseline measured why: newest-first buried her three camera clips
   * under eighty-five generated ones.
   */
  it("lists her camera clips before synced, before made-here — newest within each (doctrine)", async () => {
    const madeNew = await clip({ ingested_at: new Date("2026-06-01") });
    const madeOld = await clip({ ingested_at: new Date("2026-05-01") });
    const cameraOld = await clip({
      origin: "upload",
      platform: "upload",
      ingested_at: new Date("2025-01-01"),
    });
    const cameraNewer = await clip({
      origin: "upload",
      platform: "upload",
      ingested_at: new Date("2025-06-01"),
    });
    const synced = await clip({
      origin: "connected",
      platform: "instagram",
      ingested_at: new Date("2026-07-01"),
    });
    const { listClips } = await import("./cast");
    expect((await listClips(her, 8)).map((r) => r.id)).toEqual([
      cameraNewer,
      cameraOld,
      synced,
      madeNew,
      madeOld,
    ]);
    // The cap takes from the top: two slots are her two camera clips, not the two newest rows.
    expect((await listClips(her, 2)).map((r) => r.id)).toEqual([
      cameraNewer,
      cameraOld,
    ]);
  });
});

describe("fitsKind — a reject-disposition row is never AUTO-cast (PR 12, ruling 3)", () => {
  const base = {
    athletePresent: true as const,
    mediaType: "photo" as const,
    provenance: "camera" as const,
  };
  const reject = { ...base, vision: { disposition: "reject" } };
  afterEach(() => {
    delete process.env.STUDIO_LIBRARY_FIELDS;
  });

  /** ⚠️ MUTATION "planner sees a reject-disposition photo": drop the reject line in fitsKind — reds by name. */
  it("with the flag on: not by the planner's ref, not by the search fallback — only her own pick casts it", () => {
    process.env.STUDIO_LIBRARY_FIELDS = "true";
    expect(fitsKind("i2v", reject)).toBe(false);
    expect(fitsKind("image", reject)).toBe(false);
    expect(fitsKind("clip", { ...reject, mediaType: "clip" })).toBe(false);
    expect(fitsKind("i2v", reject, { picked: true })).toBe(true);
    expect(fitsKind("image", reject, { picked: true })).toBe(true);
    // Any other disposition, an absent vision (an older caller's pick shape): as before.
    expect(fitsKind("i2v", { ...base, vision: { disposition: "crop" } })).toBe(
      true,
    );
    expect(fitsKind("i2v", base)).toBe(true);
  });

  it("with the flag off, a reject fits exactly as it did", () => {
    expect(fitsKind("i2v", reject)).toBe(true);
    expect(fitsKind("image", reject)).toBe(true);
  });
});

describe("castPlan — an image item is the photo, held (C1b)", () => {
  /**
   * ⚠️ RC-C1b-14 — MUTATION: make `fitsKind` demand her in the frame for `image` too. The held
   * product close-up (nobody in it) is then swapped or dropped, and this reds.
   */
  it("casts an image item to the photo it named, with or without her in it — and that photo is then used", async () => {
    const closeUp = await photo({ athletePresent: false });
    const ofHer = await photo({ athletePresent: true });
    const library = await libraryOf(closeUp, ofHer);
    const out = await castPlan(
      her,
      plan(
        item({ kind: "image", ref: "a1", searchQuery: "the bottle" }),
        item({ kind: "i2v", ref: "a1" }),
      ),
      { ...NOTHING_GIVEN, library },
    );
    expect(out.items[0]).toMatchObject({
      kind: "image",
      assetId: closeUp,
      swapped: null,
      uncast: null,
    });
    // The i2v named the same photo: it is taken, and would not fit anyway — swapped to one of her.
    expect(out.items[1]).toMatchObject({
      kind: "i2v",
      assetId: ofHer,
      swapped: SWAPPED_LINE,
    });
    expect(out.castCount).toBe(2);
  });
});

describe("castPlan — the photo the planner named (device check finding 6)", () => {
  /**
   * ⚠️ MUTATION: ignore the ref (cast every item by its query, as before finding 6). This reds —
   * and so does "reserves every named photo" below, which cannot hold if refs are not honoured at
   * all. Nothing else does.
   *
   * The finding: a direction written about one photo was cast onto another by query — a basketball
   * direction on a soccer photo. The named photo is cast even when the query matches another better.
   */
  it("casts the photo the planner named, even when its query matches another photo better", async () => {
    const named = await photo({ sim: 0.2 });
    await photo({ sim: 1 }); // the query's best match
    const library = await libraryOf(named);

    const out = await castPlan(her, plan(item({ ref: "a1" })), {
      ...NOTHING_GIVEN,
      library,
    });

    expect(out.items[0]).toMatchObject({ assetId: named, swapped: null });
  });

  /**
   * ⚠️ MUTATION: cast a swap without its line (`swapped: null` on every item). This reds, and nothing
   * else does.
   *
   * The direction was written about the named photo. When that photo cannot be used, the item is
   * cast from her library instead — and she is told, because the direction may no longer fit.
   */
  /**
   * The hazard the planner's new rule guards (a photo without her is never a ref): if a model names
   * one for an identity shot anyway, it does not fit, and the item is swapped to a photo of her — and
   * SAYS so, because the direction was written about the other photo.
   */
  it("swaps a named photo that does not fit its kind for the closest fit — and says so", async () => {
    const scene = await photo({ athletePresent: false, sim: 1 });
    const withHer = await photo({ athletePresent: true, sim: 0.5 });
    const library = await libraryOf(scene, withHer);

    const out = await castPlan(her, plan(item({ kind: "i2v", ref: "a1" })), {
      ...NOTHING_GIVEN,
      library,
    });

    expect(out.items[0]).toMatchObject({
      assetId: withHer,
      swapped: SWAPPED_LINE,
    });
  });

  /**
   * ⚠️ MUTATION: let a named photo be cast again (drop `!used.has` in the first pass). This reds, and
   * nothing else does.
   */
  it("casts a photo named twice only once — the second item is swapped", async () => {
    const first = await photo({ sim: 1 });
    const other = await photo({ sim: 0.5 });
    const library = await libraryOf(first);

    const out = await castPlan(
      her,
      plan(item({ ref: "a1" }), item({ ref: "a1" })),
      { ...NOTHING_GIVEN, library },
    );

    expect(out.items.map((i) => i.assetId)).toEqual([first, other]);
  });

  /**
   * ⚠️ MUTATION: resolve each item's named photo in item order instead of all of them first. This
   * reds, and nothing else does.
   *
   * An earlier item that has to fall back must not take the photo a LATER item was written about —
   * that would push the later one onto a photo its direction does not describe.
   */
  it("reserves every named photo before any fallback runs", async () => {
    const wanted = await photo({ sim: 1 }); // the fallback's best match, and item 2's named photo
    const next = await photo({ sim: 0.5 });
    const library = await libraryOf(wanted);

    const out = await castPlan(
      her,
      plan(item({ ref: null }), item({ ref: "a1" })),
      { ...NOTHING_GIVEN, library },
    );

    expect(out.items.map((i) => i.assetId)).toEqual([next, wanted]);
    expect(out.items[1].swapped).toBeNull();
  });
});

/**
 * ─── A WINDOW INSIDE A BEAT, AND WHERE THE ROW CAME FROM (22 Sep 2026) ────────────────────────
 * ⚠️ MUTATION, red here by name: in `trimFor` ignore `item.window` (always the beat) — "a clip
 * item's window inside its beat is the trim" reds.
 */
describe("castPlan — a clip item's window, and provenance on every cast item", () => {
  it("a clip item's window inside its beat is the trim; one outside it falls back to the beat; provenance rides on the item", async () => {
    const c = await clip();
    const library = new Map([["a1", (await loadCastable(her, [c])).get(c)!]]);
    const given = { ...NOTHING_GIVEN, library };
    const inside = await castPlan(
      her,
      plan(
        item({
          kind: "clip",
          ref: "a1",
          segment: 1,
          searchQuery: null,
          window: { startSec: 4, endSec: 6 },
        }),
      ),
      given,
      undefined,
      async () => null,
    );
    expect(inside.items[0]).toMatchObject({
      trim: { startSec: 4, endSec: 6 },
      provenance: "made-here",
    });
    const outside = await castPlan(
      her,
      plan(
        item({
          kind: "clip",
          ref: "a1",
          segment: 1,
          searchQuery: null,
          window: { startSec: 1, endSec: 6 },
        }),
      ),
      given,
      undefined,
      async () => null,
    );
    expect(outside.items[0].trim).toEqual({ startSec: 3, endSec: 6.5 });
    const p = await photo();
    const onPhoto = await castPlan(
      her,
      plan(item({ kind: "i2v", ref: "a2", searchQuery: null })),
      {
        ...NOTHING_GIVEN,
        library: new Map([["a2", (await loadCastable(her, [p])).get(p)!]]),
      },
    );
    expect(onPhoto.items[0].provenance).toBe("camera");
  });
});

describe("castPlan — a made-here still is never an i2v ref unless she picked it (S1, the lookalike gap)", () => {
  /**
   * The live case (22 Sep 2026): a generated still of "a female soccer player… teammates frame the
   * foreground" cast as an i2v of her — visually not her. It passes athlete_present and the subject
   * guard; what the row DOES say is origin = 'generated'. Her camera and her accounts are hers by
   * construction; a pick is her own decision; a made-here still is an `image` at most.
   *
   * ⚠️ MUTATION: drop the provenance clause from `fitsKind` — the first two cases red by name (the
   * lookalike is cast as the i2v); "she picked it" and "held as an image" stay green, which is why
   * they are here: the gate is on i2v-by-provenance and nothing wider.
   */
  const madeHere = (over: Record<string, unknown> = {}) =>
    photo({
      origin: "generated",
      // A generated still carries its job (studio/jobs.ts); the fold reads made-here from it.
      generation_job_id: randomUUID(),
      ...over,
    });

  it("a made-here still named as an i2v ref is swapped to her camera photo by query — and says so", async () => {
    const lookalike = await madeHere({ sim: 1 });
    const hers = await photo({ sim: 0.5 }); // an upload of her, a worse query match
    const library = await libraryOf(lookalike, hers);
    const out = await castPlan(her, plan(item({ ref: "a1" })), {
      ...NOTHING_GIVEN,
      library,
    });
    expect(out.items[0]).toMatchObject({
      kind: "i2v",
      assetId: hers,
      provenance: "camera",
      swapped: SWAPPED_LINE,
      uncast: null,
    });
    expect(out.leftOut).toEqual([]);
  });

  it("with no photo of hers to swap to, the item is left out — and the reason names the provenance", async () => {
    const lookalike = await madeHere();
    await madeHere(); // another generated still: not a swap target either
    const library = await libraryOf(lookalike);
    const out = await castPlan(her, plan(item({ ref: "a1" })), {
      ...NOTHING_GIVEN,
      library,
    });
    expect(out.items[0]).toMatchObject({
      kind: "i2v",
      assetId: null,
      uncast: UNCAST_LINE,
    });
    expect(out.leftOut[0].reason).toContain("provenance made-here");
    expect(out.castCount).toBe(0);
  });

  it("she picked it: a made-here still she chose herself is cast as the i2v she named", async () => {
    const chosen = await madeHere();
    const library = await libraryOf(chosen);
    const rows = await loadCastable(her, [chosen]);
    const out = await castPlan(her, plan(item({ ref: "a1" })), {
      ...NOTHING_GIVEN,
      library,
      picks: [
        { ...given(chosen, true), provenance: rows.get(chosen)!.provenance },
      ],
    });
    expect(out.items[0]).toMatchObject({
      kind: "i2v",
      assetId: chosen,
      provenance: "made-here",
      swapped: null,
      uncast: null,
    });
  });

  it("a synced photo of her fits i2v unpicked — her accounts are hers by construction", async () => {
    const synced = await photo({ origin: "connected", platform: "instagram" });
    const library = await libraryOf(synced);
    const out = await castPlan(her, plan(item({ ref: "a1" })), {
      ...NOTHING_GIVEN,
      library,
    });
    expect(out.items[0]).toMatchObject({
      assetId: synced,
      provenance: "synced",
      swapped: null,
    });
  });

  it("held as an image, a made-here still is still the photo — S1 gates i2v and nothing wider", async () => {
    const still = await madeHere();
    const library = await libraryOf(still);
    const out = await castPlan(
      her,
      plan(item({ kind: "image", ref: "a1", searchQuery: "the still" })),
      { ...NOTHING_GIVEN, library },
    );
    expect(out.items[0]).toMatchObject({
      kind: "image",
      assetId: still,
      provenance: "made-here",
      swapped: null,
    });
  });
});

describe("editNoteOf — a clip's stored AI edit, read off the tagger's disposition (C3, D1)", () => {
  /**
   * ⚠️ MUTATION: return the note whatever the disposition says — "as_is carries no edit" reds by
   * name; return null always — "crop carries its note" reds.
   */
  it("crop and enhance carry their note, capped and squashed; as_is and reject carry none; a photo never does", async () => {
    const { editNoteOf } = await import("./cast");
    expect(
      editNoteOf(
        {
          disposition: "crop",
          edit_note: "  tighten  to her\n from the waist up ",
        },
        true,
      ),
    ).toBe("tighten to her from the waist up");
    expect(
      editNoteOf(
        { disposition: "enhance", edit_note: "relight the shadows" },
        true,
      ),
    ).toBe("relight the shadows");
    expect(
      editNoteOf({ disposition: "as_is", edit_note: "none" }, true),
    ).toBeNull();
    expect(
      editNoteOf({ disposition: "reject", edit_note: "unusable" }, true),
    ).toBeNull();
    expect(editNoteOf({ disposition: "crop", edit_note: "" }, true)).toBeNull();
    expect(editNoteOf({ disposition: "crop" }, true)).toBeNull();
    expect(
      editNoteOf({ disposition: "crop", edit_note: "tighten" }, false),
    ).toBeNull();
    expect(editNoteOf(null, true)).toBeNull();
    expect(
      editNoteOf({ disposition: "crop", edit_note: "x".repeat(300) }, true),
    ).toHaveLength(200);
  });

  it("rides the row through loadCastable — a clip with a crop note carries it, a photo does not", async () => {
    const [clip] = await db
      .insert(mediaAssets)
      .values({
        athlete_id: her,
        platform: "upload",
        origin: "upload",
        media_type: "VIDEO",
        status: "stored",
        gcs_path: `athletes/${her}/edit.mp4`,
        gcs_thumb_path: `athletes/${her}/edit.jpg`,
        content_type: "video/mp4",
        ingested_at: new Date(),
        metadata: {
          vision: {
            ...tags(true),
            disposition: "crop",
            edit_note: "crop to portrait around her",
            beats: [],
            video: { source: "clip" },
          },
        },
      } as never)
      .returning({ id: mediaAssets.id });
    const p = await photo();
    const rows = await loadCastable(her, [clip.id, p]);
    expect(rows.get(clip.id)?.editNote).toBe("crop to portrait around her");
    expect(rows.get(p)?.editNote).toBeNull();
  });
});

describe("castPlan — a made-here still whose job carried her reference is hers by construction (S2)", () => {
  const { generationJobs } = jest.requireActual(
    "../../../shared/schema",
  ) as typeof import("../../../shared/schema");
  /** A generate job of `owner`'s whose frozen brief carried these references. */
  async function job(
    owner: string,
    references: { role: string }[],
  ): Promise<string> {
    const [row] = await db
      .insert(generationJobs)
      .values({
        athlete_id: owner,
        origin: "system",
        mode: "generate",
        objective: "grow-following",
        deliverable: "post",
        brief: { job: { references } },
        status: "succeeded",
      } as never)
      .returning({ id: generationJobs.id });
    return row.id;
  }
  const madeFrom = (jobId: string, over: Record<string, unknown> = {}) =>
    photo({ origin: "generated", generation_job_id: jobId, ...over });

  /**
   * ⚠️ MUTATIONS: drop the identity-bound arm of `fitsKind` — the first case reds by name. Drop the
   * athlete from `castableFrom`'s join — "a job that is not hers binds nothing" reds by name.
   */
  it("a made-here still whose job carried her reference fits i2v unpicked — labelled made here", async () => {
    const bound = await madeFrom(
      await job(her, [{ role: "product" }, { role: "person" }]),
    );
    await photo({ sim: 0.5 }); // an upload of her the swap would otherwise take
    const library = await libraryOf(bound);
    const out = await castPlan(her, plan(item({ ref: "a1" })), {
      ...NOTHING_GIVEN,
      library,
    });
    expect(out.items[0]).toMatchObject({
      kind: "i2v",
      assetId: bound,
      provenance: "made-here",
      swapped: null,
    });
    expect((await loadCastable(her, [bound])).get(bound)?.identityBound).toBe(
      true,
    );
  });

  it("a job of hers with no person reference binds nothing — S1 still swaps it", async () => {
    const unbound = await madeFrom(await job(her, [{ role: "object" }]));
    const hers = await photo({ sim: 0.5 });
    const library = await libraryOf(unbound);
    const out = await castPlan(her, plan(item({ ref: "a1" })), {
      ...NOTHING_GIVEN,
      library,
    });
    expect(out.items[0]).toMatchObject({
      assetId: hers,
      swapped: SWAPPED_LINE,
    });
    expect(
      (await loadCastable(her, [unbound])).get(unbound)?.identityBound,
    ).toBe(false);
  });

  it("a job that is not hers binds nothing — the athlete is on the join, so a foreign pack is never borrowed", async () => {
    const foreign = await madeFrom(
      await job(someoneElse, [{ role: "person" }]),
    );
    const hers = await photo({ sim: 0.5 });
    const library = await libraryOf(foreign);
    const out = await castPlan(her, plan(item({ ref: "a1" })), {
      ...NOTHING_GIVEN,
      library,
    });
    expect(out.items[0]).toMatchObject({
      assetId: hers,
      swapped: SWAPPED_LINE,
    });
    expect(
      (await loadCastable(her, [foreign])).get(foreign)?.identityBound,
    ).toBeNull();
  });

  it("an upload has no job: identityBound is null and it fits i2v on its provenance alone", async () => {
    const upload = await photo();
    expect(
      (await loadCastable(her, [upload])).get(upload)?.identityBound,
    ).toBeNull();
    const out = await castPlan(her, plan(item({ ref: "a1" })), {
      ...NOTHING_GIVEN,
      library: await libraryOf(upload),
    });
    expect(out.items[0]).toMatchObject({ assetId: upload, swapped: null });
  });
});

describe("castPlan — on an own-footage brief a made-here still is refused in every motion unless she picked it (S1b)", () => {
  const { generationJobs } = jest.requireActual(
    "../../../shared/schema",
  ) as typeof import("../../../shared/schema");
  async function boundJob(): Promise<string> {
    const [row] = await db
      .insert(generationJobs)
      .values({
        athlete_id: her,
        origin: "system",
        mode: "generate",
        objective: "recap",
        deliverable: "post",
        brief: { job: { references: [{ role: "person" }] } },
        status: "succeeded",
      } as never)
      .returning({ id: generationJobs.id });
    return row.id;
  }
  const OWN = { ...NOTHING_GIVEN, ownFootage: true };

  /** ⚠️ MUTATION: exempt held stills from the own-footage gate — the first case reds by name. */
  it("a made-here still named as an image item on an own-footage brief is swapped to her camera photo", async () => {
    const made = await photo({
      origin: "generated",
      generation_job_id: randomUUID(),
      sim: 1,
    });
    const hers = await photo({ sim: 0.5 });
    const library = await libraryOf(made, hers);
    const out = await castPlan(
      her,
      plan(item({ kind: "image", ref: "a1", searchQuery: "the still" })),
      { ...OWN, library },
    );
    expect(out.items[0]).toMatchObject({
      kind: "image",
      assetId: hers,
      provenance: "camera",
      swapped: SWAPPED_LINE,
    });
    expect(out.leftOut).toEqual([]);
  });

  it("a pushed-in made-here still is the same still — refused; with no camera photo it is left out and the reason says own_footage", async () => {
    const made = await photo({
      origin: "generated",
      generation_job_id: randomUUID(),
    });
    const library = await libraryOf(made);
    const out = await castPlan(
      her,
      plan(
        item({
          kind: "image",
          ref: "a1",
          motion: "dolly",
          searchQuery: "the still",
        }),
      ),
      { ...OWN, library },
    );
    expect(out.items[0]).toMatchObject({
      kind: "image",
      assetId: null,
      uncast: UNCAST_LINE,
    });
    expect(out.leftOut[0].reason).toContain("own_footage");
  });

  it("an identity-bound made-here still loses i2v on an own-footage brief — generated FROM her is still not what she filmed", async () => {
    const bound = await photo({
      origin: "generated",
      generation_job_id: await boundJob(),
      sim: 1,
    });
    const hers = await photo({ sim: 0.5 });
    const library = await libraryOf(bound, hers);
    const out = await castPlan(her, plan(item({ ref: "a1" })), {
      ...OWN,
      library,
    });
    // Swapped to her upload by S1b — and, since PR 4's A1b, held pushed-in rather than animated:
    // an own-footage brief makes no i2v at all (the demotion's own cases are below).
    expect(out.items[0]).toMatchObject({
      kind: "image",
      motion: "dolly",
      assetId: hers,
      swapped: SWAPPED_LINE,
      demoted: DEMOTED_LINE,
    });
    // Off an own-footage brief the same still is the S2 case, cast as named.
    const off = await castPlan(her, plan(item({ ref: "a1" })), {
      ...NOTHING_GIVEN,
      library,
    });
    expect(off.items[0]).toMatchObject({
      kind: "i2v",
      assetId: bound,
      swapped: null,
      demoted: null,
    });
  });

  it("she picked it: a made-here still she chose is held as an image on an own-footage brief", async () => {
    const chosen = await photo({
      origin: "generated",
      generation_job_id: randomUUID(),
    });
    const rows = await loadCastable(her, [chosen]);
    const out = await castPlan(
      her,
      plan(item({ kind: "image", ref: "a1", searchQuery: "the still" })),
      {
        ...OWN,
        library: await libraryOf(chosen),
        picks: [
          { ...given(chosen, true), provenance: rows.get(chosen)!.provenance },
        ],
      },
    );
    expect(out.items[0]).toMatchObject({
      kind: "image",
      assetId: chosen,
      provenance: "made-here",
      swapped: null,
    });
  });

  it("off an own-footage brief a made-here still is still the photo, held — S1's line, unchanged", async () => {
    const made = await photo({
      origin: "generated",
      generation_job_id: randomUUID(),
    });
    const out = await castPlan(
      her,
      plan(item({ kind: "image", ref: "a1", searchQuery: "the still" })),
      { ...NOTHING_GIVEN, library: await libraryOf(made) },
    );
    expect(out.items[0]).toMatchObject({
      kind: "image",
      assetId: made,
      provenance: "made-here",
      swapped: null,
    });
  });
});

describe("castPlan — on an own-footage brief a made-here CLIP is refused unless she picked it (S1c, PR 6)", () => {
  const OWN = { ...NOTHING_GIVEN, ownFootage: true };
  const namedClip = () =>
    plan(item({ kind: "clip", ref: "a1", segment: 0, searchQuery: null }));
  const cameraClip = () =>
    clip({ origin: "upload", platform: "upload", generation_job_id: null });

  /** ⚠️ MUTATION: drop S1c's `(!ownFootage || hers)` in fitsKind — this case reds by name. */
  it("made-here clip castable on own footage: never — a named made-here clip is left out, shown, and the reason says own_footage", async () => {
    const made = await clip();
    const library = await libraryOf(made);
    const out = await castPlan(her, namedClip(), { ...OWN, library });
    expect(out.items[0]).toMatchObject({
      kind: "clip",
      assetId: null,
      uncast: UNCAST_CLIP_LINE,
    });
    expect(out.leftOut[0].reason).toContain(
      "is a clip, provenance made-here, own_footage",
    );
  });

  it("her camera clip and her synced clip are hers — cast on an own-footage brief as named", async () => {
    const cam = await cameraClip();
    const synced = await clip({
      origin: "connected",
      platform: "instagram",
      generation_job_id: null,
    });
    for (const id of [cam, synced]) {
      const library = await libraryOf(id);
      const out = await castPlan(her, namedClip(), { ...OWN, library });
      expect(out.items[0]).toMatchObject({ kind: "clip", assetId: id });
      expect(out.leftOut).toEqual([]);
    }
  });

  it("a made-here clip she picked is her decision — cast on an own-footage brief", async () => {
    const made = await clip();
    const library = await libraryOf(made);
    const out = await castPlan(her, namedClip(), {
      ...OWN,
      library,
      picks: [{ ...given(made, true), mediaType: "clip" as const }],
    });
    expect(out.items[0]).toMatchObject({
      kind: "clip",
      assetId: made,
      provenance: "made-here",
    });
  });

  it("off an own-footage brief the same made-here clip is cast as before", async () => {
    const made = await clip();
    const library = await libraryOf(made);
    const out = await castPlan(her, namedClip(), {
      ...NOTHING_GIVEN,
      library,
    });
    expect(out.items[0]).toMatchObject({ kind: "clip", assetId: made });
  });
});

describe("castPlan — a swapped or dropped i2v's direction is scrubbed of other people (S1b, the leaked direction)", () => {
  const { mentionsOtherPeople, REWRITTEN_LINE } = jest.requireActual(
    "./cast",
  ) as typeof import("./cast");
  const TEAMMATES =
    "She smiles joyfully while dribbling, framed by the shoulders of her teammates in the foreground";

  it("names the nouns B2 refuses, with a unicode-aware boundary, and nothing else", () => {
    for (const t of [
      "her teammates in the foreground",
      "past two opponents",
      "the coach watches",
      "fans behind the goal",
      "a crowd roars",
      "other players blur past",
      "Teammates.",
    ])
      expect(mentionsOtherPeople(t)).toBe(true);
    for (const t of [
      "she turns toward the camera",
      "a fanfare of light",
      "the crowded shelf",
      "her red kit",
      "a coaching manual",
    ])
      expect(mentionsOtherPeople(t)).toBe(false);
  });

  /** ⚠️ MUTATION: keep the direction on swap — this reds by name. */
  it("an i2v swapped off a photo of other people takes the swapped photo's own description, and says so", async () => {
    const lookalike = await photo({
      origin: "generated",
      generation_job_id: randomUUID(),
      sim: 1,
    });
    const hers = await photo({ sim: 0.5 });
    await db
      .update(mediaAssets)
      .set({
        metadata: {
          vision: {
            ...tags(true),
            description: "she stands on the track in the sun",
          },
          embedding: [0.5, Math.sqrt(0.75), 0],
        } as never,
      })
      .where(eq(mediaAssets.id, hers));
    const library = await libraryOf(lookalike, hers);
    const out = await castPlan(
      her,
      plan(item({ ref: "a1", direction: TEAMMATES })),
      { ...NOTHING_GIVEN, library },
    );
    expect(out.items[0]).toMatchObject({
      assetId: hers,
      swapped: SWAPPED_LINE,
      rewritten: REWRITTEN_LINE,
      direction: "she stands on the track in the sun",
    });
  });

  it("a direction naming nobody else keeps its words on a drop, and the planned photo is never rewritten whatever its direction says", async () => {
    const lookalike = await photo({
      origin: "generated",
      generation_job_id: randomUUID(),
      sim: 1,
    });
    const hers = await photo({ sim: 0.5 });
    const library = await libraryOf(lookalike, hers);
    const out = await castPlan(
      her,
      plan(
        item({ ref: "a1", direction: "she looks up and smiles" }),
        item({ ref: "a2", direction: "her teammates cheer" }),
      ),
      { ...NOTHING_GIVEN, library },
    );
    // Pass 1 reserves a2 for item 1 before any swap runs, so item 0 has nothing left: dropped, its
    // words untouched — the scrub is for a direction about OTHER people, and this one is not.
    expect(out.items[0]).toMatchObject({
      assetId: null,
      uncast: UNCAST_LINE,
      rewritten: null,
      direction: "she looks up and smiles",
    });
    // The planned photo, cast as named: never rewritten, even though its direction names
    // teammates — the planner wrote those words about THIS photo; B2 is the prompt's job there.
    expect(out.items[1]).toMatchObject({
      assetId: hers,
      swapped: null,
      rewritten: null,
      direction: "her teammates cheer",
    });
  });

  it("a dropped i2v written about other people reads as its beat where the direction was", async () => {
    const lookalike = await photo({
      origin: "generated",
      generation_job_id: randomUUID(),
    });
    const library = await libraryOf(lookalike);
    const out = await castPlan(
      her,
      plan(item({ ref: "a1", direction: TEAMMATES, beat: "warming up" })),
      { ...NOTHING_GIVEN, library },
    );
    expect(out.items[0]).toMatchObject({
      assetId: null,
      uncast: UNCAST_LINE,
      rewritten: REWRITTEN_LINE,
      direction: "warming up",
    });
  });
});

describe("castPlan — on an own-footage brief an i2v is held, pushed in, never animated (PR 4 A1b, doctrine rule 1)", () => {
  const OWN = { ...NOTHING_GIVEN, ownFootage: true };

  /** ⚠️ MUTATION: the i2v stays an i2v on an own-footage brief — this case reds by name. */
  it("held, not animated: the i2v's own camera photo comes back as a pushed-in image, the same asset, and the card says why", async () => {
    const hers = await photo();
    const library = await libraryOf(hers);
    const out = await castPlan(her, plan(item({ ref: "a1" })), {
      ...OWN,
      library,
    });
    expect(out.items[0]).toMatchObject({
      kind: "image",
      motion: "dolly",
      assetId: hers,
      provenance: "camera",
      swapped: null,
      demoted: DEMOTED_LINE,
    });
    expect(out.leftOut).toEqual([]);
  });

  it("off an own-footage brief the same i2v is animated as before — the demotion is the brief's, not the photo's", async () => {
    const hers = await photo();
    const out = await castPlan(her, plan(item({ ref: "a1" })), {
      ...NOTHING_GIVEN,
      library: await libraryOf(hers),
    });
    expect(out.items[0]).toMatchObject({
      kind: "i2v",
      motion: null,
      assetId: hers,
      demoted: null,
    });
  });

  it("the gates still choose the photo: a made-here still named for the i2v is not held in its place — it is swapped to her camera photo, then held", async () => {
    const made = await photo({
      origin: "generated",
      generation_job_id: randomUUID(),
      sim: 1,
    });
    const hers = await photo({ sim: 0.5 });
    const out = await castPlan(her, plan(item({ ref: "a1" })), {
      ...OWN,
      library: await libraryOf(made, hers),
    });
    expect(out.items[0]).toMatchObject({
      kind: "image",
      motion: "dolly",
      assetId: hers,
      swapped: SWAPPED_LINE,
      demoted: DEMOTED_LINE,
    });
  });

  it("nothing fits: an i2v with no photo of hers to hold is left out as an i2v, never held empty", async () => {
    const made = await photo({
      origin: "generated",
      generation_job_id: randomUUID(),
    });
    const out = await castPlan(
      her,
      plan(item({ ref: "a1", searchQuery: "the still" })),
      { ...OWN, library: await libraryOf(made) },
    );
    expect(out.items[0]).toMatchObject({
      kind: "i2v",
      assetId: null,
      uncast: UNCAST_LINE,
      demoted: null,
    });
  });

  it("only an i2v is demoted: an image the planner held dead still keeps motion null", async () => {
    const hers = await photo();
    const out = await castPlan(
      her,
      plan(item({ kind: "image", ref: "a1", motion: null })),
      { ...OWN, library: await libraryOf(hers) },
    );
    expect(out.items[0]).toMatchObject({
      kind: "image",
      motion: null,
      assetId: hers,
      demoted: null,
    });
  });
});

describe("castPlan — her own footage in doctrine rule 3's order: her camera, then her instagram, then made here (PR 4 B2b)", () => {
  const OWN = { ...NOTHING_GIVEN, ownFootage: true };

  /** ⚠️ MUTATION: drop the provenance grouping from the swap — "camera before her instagram" reds by name. */
  it("camera before her instagram: on an own-footage brief the swap takes her camera photo over a higher-ranked reel still", async () => {
    const reel = await photo({
      origin: "connected",
      platform: "instagram",
      sim: 1,
    });
    const hers = await photo({ sim: 0.5 });
    const out = await castPlan(her, plan(item()), OWN);
    expect(out.items[0]).toMatchObject({
      assetId: hers,
      provenance: "camera",
    });
    expect(out.items[0].assetId).not.toBe(reel);
  });

  it("with no camera photo, her instagram is next — cast, carrying its platform for the card", async () => {
    const reel = await photo({
      origin: "connected",
      platform: "instagram",
      sim: 1,
    });
    const out = await castPlan(her, plan(item()), OWN);
    expect(out.items[0]).toMatchObject({
      assetId: reel,
      provenance: "synced",
      platform: "instagram",
    });
  });

  it("off an own-footage brief the search's order stands — the reel still ranks first, as an i2v", async () => {
    const reel = await photo({
      origin: "connected",
      platform: "instagram",
      sim: 1,
    });
    await photo({ sim: 0.5 });
    const out = await castPlan(her, plan(item()), NOTHING_GIVEN);
    expect(out.items[0]).toMatchObject({
      kind: "i2v",
      assetId: reel,
      provenance: "synced",
      platform: "instagram",
    });
  });
});

describe("castPlan — a meta image is never held or animated unless she picked it (PR 4 A2)", () => {
  /** A photograph whose tags read as `vision` says — the rest of the tags as the tagger writes them. */
  const tagged = (vision: Record<string, unknown>, sim = 1) =>
    photo({
      sim,
      metadata: {
        vision: { ...tags(vision.athlete_present !== false), ...vision },
        embedding: [sim, Math.sqrt(Math.max(0, 1 - sim * sim)), 0],
      },
    });

  it("reads a text graphic by shot_type, and a screenshot, a mockup or a colour block by its words — not a graphic backdrop, not a text overlay", () => {
    expect(isMetaImage({ shot_type: "text_graphic", description: "x" })).toBe(
      true,
    );
    for (const description of [
      "A screenshot of a social post showing a player after training.",
      "A player on a bench, framed within a smartphone mockup with text.",
      "Abstract graphic of a red half and a blue half.",
      "A simple horizontal split color block of red and blue.",
    ])
      expect(isMetaImage({ shot_type: "other", description })).toBe(true);
    expect(
      isMetaImage({
        shot_type: "other",
        description: "a court",
        setting: "inside a phone frame",
      }),
    ).toBe(true);
    for (const description of [
      "A studio portrait of a player holding a ball against a graphic background.",
      "A player posing on a pitch at sunset with a slogan text overlay.",
      "A soccer ball with a sporting goods logo on a white background.",
    ])
      expect(isMetaImage({ shot_type: "portrait", description })).toBe(false);
    // A clip is footage, whatever its words say.
    expect(isMetaImage({ shot_type: "text_graphic" }, true)).toBe(false);
  });

  /** ⚠️ MUTATION "meta images castable": drop the meta line in fitsKind — this reds by name. */
  it("meta images castable: never — a named screenshot is swapped for a real photo as a held image, and a named text graphic never becomes an i2v", async () => {
    const shot = await tagged({
      shot_type: "other",
      description: "A screenshot of a social post showing her after training.",
    });
    const hers = await tagged(
      { shot_type: "portrait", description: "her, smiling" },
      0.5,
    );
    const held = await castPlan(
      her,
      plan(
        item({ kind: "image", ref: "a1", searchQuery: "her after training" }),
      ),
      { ...NOTHING_GIVEN, library: await libraryOf(shot, hers) },
    );
    expect(held.items[0]).toMatchObject({
      kind: "image",
      assetId: hers,
      swapped: SWAPPED_LINE,
    });

    const graphic = await tagged({
      shot_type: "text_graphic",
      description: "her name over a photo",
    });
    const animated = await castPlan(her, plan(item({ ref: "a1" })), {
      ...NOTHING_GIVEN,
      library: await libraryOf(graphic),
    });
    // The graphic is refused by name; her own photo (seeded above, still in the table) is the swap.
    expect(animated.items[0]).toMatchObject({
      kind: "i2v",
      assetId: hers,
      swapped: SWAPPED_LINE,
    });
  });

  it("the search never lands on one either: a screenshot of her that ranks first is passed over for her photo", async () => {
    // Her IN it, like the made-here screenshot round 2 pushed in on a live brief — so the search's
    // athlete-present hint returns it, first, and only the meta gate keeps it out.
    const shot = await tagged({
      shot_type: "other",
      description:
        "A screenshot of a social post of her, muddy and smiling after training.",
    });
    const hers = await tagged(
      { shot_type: "portrait", description: "her on the pitch" },
      0.5,
    );
    const out = await castPlan(
      her,
      plan(item({ kind: "image", searchQuery: "her after training" })),
      NOTHING_GIVEN,
    );
    expect(out.items[0]).toMatchObject({ kind: "image", assetId: hers });
    expect(out.items[0].assetId).not.toBe(shot);
  });

  it("with nothing else to hold, a named meta image is left out and the reason says meta_image", async () => {
    const block = await tagged({
      shot_type: "text_graphic",
      description: "Abstract colour block, red over blue.",
    });
    const out = await castPlan(
      her,
      plan(item({ kind: "image", ref: "a1", searchQuery: "red and blue" })),
      { ...NOTHING_GIVEN, library: await libraryOf(block) },
    );
    expect(out.items[0]).toMatchObject({
      kind: "image",
      assetId: null,
      uncast: UNCAST_LINE,
    });
    expect(out.leftOut[0].reason).toContain("meta_image");
  });

  it("she picked it: a meta image she chose herself is held as it is", async () => {
    const shot = await tagged({
      shot_type: "text_graphic",
      description: "A screenshot of her announcement post.",
    });
    const rows = await loadCastable(her, [shot]);
    const out = await castPlan(
      her,
      plan(item({ kind: "image", ref: "a1", searchQuery: "the post" })),
      {
        ...NOTHING_GIVEN,
        library: await libraryOf(shot),
        picks: [
          { ...given(shot, true), provenance: rows.get(shot)!.provenance },
        ],
      },
    );
    expect(out.items[0]).toMatchObject({
      kind: "image",
      assetId: shot,
      swapped: null,
    });
  });
});

describe("castPlan — what she set runs as she set it; made-here is a label, never a hold (PR 19, ADI-R19-BOARD3)", () => {
  const { generationJobs } = jest.requireActual(
    "../../../shared/schema",
  ) as typeof import("../../../shared/schema");
  /** A job of hers: a from-scratch generate with these references, or an edit of `from`. */
  async function jobOf(
    references: { role: string }[],
    from?: string,
  ): Promise<string> {
    const [row] = await db
      .insert(generationJobs)
      .values({
        athlete_id: her,
        origin: "system",
        mode: from ? "edit" : "generate",
        ...(from ? { source_asset_id: from } : {}),
        objective: "grow-following",
        deliverable: "post",
        brief: { job: { references } },
        status: "succeeded",
      } as never)
      .returning({ id: generationJobs.id });
    return row.id;
  }
  /** Loaded as the plan route loads her picks and products (routes/studio.ts `given`): the chain rule's standing. */
  const pickOf = async (id: string) =>
    asPick((await loadCastable(her, [id])).get(id)!);
  const madeWithoutHer = async () =>
    photo({
      origin: "generated",
      generation_job_id: await jobOf([{ role: "object" }]),
    });

  beforeEach(() => {
    process.env.STUDIO_LIBRARY_FIELDS = "true";
  });
  afterEach(async () => {
    delete process.env.STUDIO_LIBRARY_FIELDS;
    // An edit job points at its source photo; the suite's beforeEach deletes every photo, so these go first.
    await db
      .delete(generationJobs)
      .where(isNotNull(generationJobs.source_asset_id));
  });

  it("a made-here photo not from her, with her in it, runs as the product she set — no hold, no refusal", async () => {
    const notHer = await madeWithoutHer(); // tagged athlete_present, as a generated stranger is
    const out = await castPlan(her, plan(item({ kind: "product" })), {
      ...NOTHING_GIVEN,
      products: [await pickOf(notHer)],
    });
    expect(out.items[0]).toMatchObject({
      kind: "product",
      assetId: notHer,
      demoted: null,
      uncast: null,
    });
  });

  it("her pick: a made-here photo not from her, picked as the i2v, is animated as she set it — never held, never refused", async () => {
    const chosen = await madeWithoutHer();
    const out = await castPlan(her, plan(item({ ref: "a1" })), {
      ...NOTHING_GIVEN,
      library: await libraryOf(chosen),
      picks: [await pickOf(chosen)],
    });
    expect(out.items[0]).toMatchObject({
      kind: "i2v",
      assetId: chosen,
      demoted: null,
      uncast: null,
    });
    expect(out.leftOut).toEqual([]);
  });

  /**
   * The walk's board (25 Sep 2026): shot 3 was an edit of shot 4's photo, and both were animated. A photo and every edit
   * in its derived_from chain are ONE photo — cast once, twice only when she picked it twice. ⚠️ MUTATION M-oneChain:
   * `rootBlocks` answers false (cast.ts) — this reds by name.
   */
  it("a photo and its edit are one photo: the caster casts it once — twice only when she picked both", async () => {
    const hers = await photo();
    const edit = await photo({
      origin: "generated",
      generation_job_id: await jobOf([], hers),
      derived_from_asset_id: hers,
    });
    // The walk's shape: an edit of an edit, named first, and the photo it came from named second.
    const editOfEdit = await photo({
      origin: "generated",
      generation_job_id: await jobOf([], edit),
      derived_from_asset_id: edit,
    });
    const nothingFound = async () => [];
    const twoShots = plan(item({ ref: "a1" }), item({ ref: "a2" }));
    const once = await castPlan(
      her,
      twoShots,
      { ...NOTHING_GIVEN, library: await libraryOf(editOfEdit, hers) },
      nothingFound,
    );
    expect(once.items.map((i) => i.assetId)).toEqual([editOfEdit, null]);
    // She picked both: her decision, twice — both are cast.
    const picked = await castPlan(
      her,
      twoShots,
      {
        ...NOTHING_GIVEN,
        library: await libraryOf(editOfEdit, hers),
        picks: [await pickOf(editOfEdit), await pickOf(hers)],
      },
      nothingFound,
    );
    expect(picked.items.map((i) => i.assetId)).toEqual([editOfEdit, hers]);
  });

  it("an edit of her upload is her: the chain rule reaches the caster, and the product stays a product", async () => {
    const hers = await photo();
    const edit = await photo({
      origin: "generated",
      generation_job_id: await jobOf([], hers),
      derived_from_asset_id: hers,
    });
    expect((await loadCastable(her, [edit])).get(edit)?.identityBound).toBe(
      true,
    );
    const out = await castPlan(her, plan(item({ kind: "product" })), {
      ...NOTHING_GIVEN,
      products: [await pickOf(edit)],
    });
    expect(out.items[0]).toMatchObject({
      kind: "product",
      assetId: edit,
      demoted: null,
    });
  });

  it("with STUDIO_LIBRARY_FIELDS off, today's cast, and the edit reads today's rule", async () => {
    delete process.env.STUDIO_LIBRARY_FIELDS;
    const notHer = await madeWithoutHer();
    const out = await castPlan(her, plan(item({ kind: "product" })), {
      ...NOTHING_GIVEN,
      products: [await pickOf(notHer)],
    });
    expect(out.items[0]).toMatchObject({ kind: "product", demoted: null });
    const hers = await photo();
    const edit = await photo({
      origin: "generated",
      generation_job_id: await jobOf([], hers),
      derived_from_asset_id: hers,
    });
    expect((await loadCastable(her, [edit])).get(edit)?.identityBound).toBe(
      false,
    );
  });
});
