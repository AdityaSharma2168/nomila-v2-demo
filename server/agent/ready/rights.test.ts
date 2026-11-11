/**
 * rights.test.ts — "Post it" and the athlete's rights words (agent/ready/rights.ts), on the in-memory store, an
 * in-memory rights store with the table's rules and a fake media port; no database, no provider. Made-up athletes and
 * brands.
 *
 *   R1 own post: asked once per source asset — the first approve asks for every asset, the next post asks only for its
 *      new asset; nothing is written until the line is ticked
 *   R2 sponsored: the own-media word does not cover it; the deal's confirmation is asked once per deal (brand), on top of
 *      any missing assets; the words stored are the words shown, with the version
 *   R3 approve answers what Copy & save needs: the caption and signed media (the ready preview when there is one); the
 *      item records detail.approval; nothing is posted (still pending, still ready)
 *   R4 revoke: the word is taken back (kept as the record), asked again on the next "Post it"; another athlete's id is 404
 *   R5 refusals: not theirs / not a post (404), answered (409 closed), before the guard (409 not_guarded), no media,
 *      an asset gone from their library (409 media_gone, nothing written)
 *   R6 the queue says what "Post it" will still ask (ReadyItem.rights)
 *   R7 disclosure: the #ad note and the sponsored line only with #ad; "ask" asks paid / gifted / affiliate / none first
 *      (an answer puts #ad first through the final guard, or leaves the post unsponsored)
 *   R8 a sponsored confirmation is keyed on the newest matching deal / gift / affiliate record; a new deal asks again
 *   R9 approve refuses what the queue leaves out (resting, needs generated media, not made)
 */
jest.mock("../../db", () => ({ db: {} }));

import type { ActionDecisionDetail } from "../../../shared/plan";
import type { PostKit } from "../../../shared/postKit";
import { RIGHTS_OWN_MEDIA_LINE, RIGHTS_WORDS_VERSION, rightsSponsoredLine } from "../../../shared/readyQueue";
import { createMemoryStore, type AgentStore } from "../research/store";
import { postAction } from "../postKit/testRows";
import { listQueue } from "./queue";
import type { MaterialConnection } from "../postKit/disclosure";
import { DISCLOSURE_QUESTION } from "../../../shared/readyQueue";
import { approveItem, createMemoryRightsStore, dealKeyFor, dealKeyOf, listRights, revokeRights, type RightsDeps } from "./rights";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const NOW = new Date("2026-11-10T15:00:00.000Z");

const photo = (assetId: string) => ({ assetId, mediaType: "photo" as const, clip: null, durationSec: null, provenance: "camera" as const });
const kit = (assets: string[], over: Partial<PostKit> = {}): PostKit => ({
  contract: "post-kit/1", momentDecisionId: null, idea: { hook: "Hook", format: "feed", platform: "instagram", timing: "This week" },
  formatFromMoment: false, brief: { show: "s", captionAngle: "c", avoid: "" },
  assets: assets.map(photo), shortlist: [], caption: { text: "Caption line.", hashtags: [], edited: false },
  treatmentPlan: { aspect: "4:5", cropToFill: true, order: assets, trims: [], stills: [], overlayText: null, lookPreset: "natural", musicMood: null, coverFrame: null, totalSec: null },
  aiGenerationNeeded: { value: false, reason: "r" }, match: { runId: null, skillVersion: null, candidates: 1, costMicroUsd: 0, noneFitNote: null },
  builtAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", guard: { version: 2, at: "2026-11-01T00:00:00.000Z", disclosure: null },
  ...over,
});
const brandTarget = (name: string): Partial<ActionDecisionDetail> => ({
  deliverable: { type: "post_brief", title: "t", body: "", target: { subjectKind: "brand", name }, platform: "instagram", thread: null, connector: null },
});

let store: AgentStore;
let rights: ReturnType<typeof createMemoryRightsStore>;
let library: Set<string>;
let connections: MaterialConnection[] = [];
const signed: string[] = [];
function deps(): RightsDeps {
  return {
    store, rights, now: NOW, preferences: async () => [], connections: async () => connections,
    media: {
      async search() { return []; },
      async newlyTagged() { return []; },
      async load(athleteId, ids) { return new Map(ids.filter((id) => athleteId === A && library.has(id)).map((id) => [id, { id, gcsPath: `${id}.jpg` } as any])); },
      async urls(row) { return { thumbUrl: `https://signed.example/${row.gcsPath}`, videoUrl: null }; },
    },
    render: {
      async sign(_athleteId: string, p: any) { signed.push(p.key); return { items: p.outputs.map((o: any) => `https://signed.example/out/${o.assetId}`), coverUrl: null }; },
    } as any,
  };
}
async function item(assets: string[], det: Partial<ActionDecisionDetail> = {}, over: Partial<PostKit> = {}, athleteId = A) {
  return store.insertDecision(athleteId, { runId: null, skillId: "plan", kind: "action", suggested: "Post", why: "w", evidence: [], detail: postAction({ state: "made", ...det, prepared: { postKit: kit(assets, over) } }) as unknown as Record<string, unknown> });
}

beforeEach(() => {
  store = createMemoryStore();
  rights = createMemoryRightsStore(() => NOW);
  library = new Set(["a1", "a2", "a3"]);
  connections = [];
  signed.length = 0;
});

describe("R1 own post: once per source asset", () => {
  it("asks for every asset first, then only the new one; nothing is written until ticked", async () => {
    const first = await item(["a1", "a2"]);
    const ask = await approveItem(deps(), A, first.id, {});
    expect(ask).toEqual({
      approved: false,
      needs: { missingAssetIds: ["a1", "a2"], sponsored: null, disclosure: null, complete: false },
      words: { version: RIGHTS_WORDS_VERSION, ownMedia: RIGHTS_OWN_MEDIA_LINE, sponsored: null, adNote: null, disclosureQuestion: null, disclosureOptions: null },
    });
    expect(rights.all()).toEqual([]);
    expect((await approveItem(deps(), A, first.id, { ownMedia: true })).approved).toBe(true);
    expect(rights.all().map((r) => [r.scope, r.assetId, r.itemId, r.words, r.wordsVersion])).toEqual([
      ["own_posts", "a1", first.id, RIGHTS_OWN_MEDIA_LINE, RIGHTS_WORDS_VERSION],
      ["own_posts", "a2", first.id, RIGHTS_OWN_MEDIA_LINE, RIGHTS_WORDS_VERSION],
    ]);
    // The next post shares a1 and adds a3: only a3 is asked.
    const next = await item(["a1", "a3"]);
    expect(await approveItem(deps(), A, next.id, {})).toMatchObject({ approved: false, needs: { missingAssetIds: ["a3"] } });
    await approveItem(deps(), A, next.id, { ownMedia: true });
    // A post of only confirmed assets asks nothing at all.
    const third = await item(["a2", "a3"]);
    expect((await approveItem(deps(), A, third.id, {})).approved).toBe(true);
    expect(rights.all()).toHaveLength(3);
  });
});

describe("R2 sponsored: once per deal, never covered by the own-media word", () => {
  it("asks the deal's line on top of missing assets; once per deal; another deal asks again", async () => {
    const own = await item(["a1"]);
    await approveItem(deps(), A, own.id, { ownMedia: true });
    const brand = await item(["a1"], brandTarget("Brand One"), { guard: { version: 2, at: "2026-11-01T00:00:00.000Z", disclosure: "ad" } });
    const ask = await approveItem(deps(), A, brand.id, { ownMedia: true });
    expect(ask).toEqual({
      approved: false,
      needs: { missingAssetIds: [], sponsored: { brand: "Brand One", confirmed: false, kind: null }, disclosure: "ad", complete: false },
      words: { version: RIGHTS_WORDS_VERSION, ownMedia: null, sponsored: rightsSponsoredLine("Brand One"), adNote: expect.stringContaining("#ad"), disclosureQuestion: null, disclosureOptions: null },
    });
    expect((await approveItem(deps(), A, brand.id, { sponsoredRights: true })).approved).toBe(true);
    expect(rights.all().find((r) => r.scope === "sponsored")).toMatchObject({ dealKey: dealKeyOf("Brand One"), brand: "Brand One", words: rightsSponsoredLine("Brand One"), assetId: null });
    // The same deal (the name written another way) asks only for a new asset.
    const again = await item(["a2"], brandTarget("brand one"), { guard: { version: 2, at: "2026-11-01T00:00:00.000Z", disclosure: "ad" } });
    expect(await approveItem(deps(), A, again.id, {})).toMatchObject({ approved: false, needs: { missingAssetIds: ["a2"], sponsored: { confirmed: true } } });
    // Another deal asks its own line.
    const other = await item(["a1"], brandTarget("Brand Two"), { guard: { version: 2, at: "2026-11-01T00:00:00.000Z", disclosure: "ad" } });
    expect(await approveItem(deps(), A, other.id, {})).toMatchObject({ approved: false, needs: { missingAssetIds: [], sponsored: { brand: "Brand Two", confirmed: false } } });
  });
});

describe("R3 approved: what Copy & save needs, nothing posted", () => {
  it("the caption and the kit's signed photos; detail.approval; still pending", async () => {
    const d = await item(["a1", "a2"]);
    const r = await approveItem(deps(), A, d.id, { ownMedia: true });
    expect(r).toMatchObject({
      approved: true, caption: "Caption line.",
      media: [{ assetId: "a1", kind: "image", url: "https://signed.example/a1.jpg" }, { assetId: "a2", kind: "image", url: "https://signed.example/a2.jpg" }],
      item: { id: d.id, rights: { missingAssetIds: [], sponsored: null, disclosure: null, complete: true } },
    });
    const row = (await store.getDecision(A, d.id))!;
    expect(row.response).toBe("pending");
    expect(row.detail!.approval).toEqual({ at: NOW.toISOString(), assetIds: ["a1", "a2"], sponsored: null, wordsVersion: RIGHTS_WORDS_VERSION });
  });

  it("the rendered preview when it is ready", async () => {
    const d = await item(["a1"], {}, {
      preview: { contract: "post-kit-render/1", key: "k1", status: "ready", jobId: null, outputs: [{ assetId: "out-1", kind: "video", sourceAssetId: "a1" }], coverAssetId: "out-1", notes: [], error: null, requestedAt: "x", renderedAt: "y" },
    });
    const r = await approveItem(deps(), A, d.id, { ownMedia: true });
    expect(r).toMatchObject({ approved: true, media: [{ assetId: "out-1", kind: "video", url: "https://signed.example/out/out-1" }] });
  });
});

describe("R4 revoke", () => {
  it("takes a word back (the record stays) and it is asked again", async () => {
    const d = await item(["a1"]);
    await approveItem(deps(), A, d.id, { ownMedia: true });
    const [live] = await listRights(deps(), A);
    expect(live).toMatchObject({ scope: "own_posts", assetId: "a1", words: RIGHTS_OWN_MEDIA_LINE, attestedAt: NOW.toISOString() });
    await expect(revokeRights(deps(), B, live.id)).rejects.toMatchObject({ status: 404 });
    expect(await revokeRights(deps(), A, live.id)).toEqual({ revoked: true });
    await expect(revokeRights(deps(), A, live.id)).rejects.toMatchObject({ status: 404 });
    expect(await listRights(deps(), A)).toEqual([]);
    expect(rights.all()[0].revokedAt).toBe(NOW.toISOString());
    const next = await item(["a1"]);
    expect(await approveItem(deps(), A, next.id, {})).toMatchObject({ approved: false, needs: { missingAssetIds: ["a1"] } });
    await approveItem(deps(), A, next.id, { ownMedia: true });
    expect(rights.all()).toHaveLength(2);
  });
});

describe("R5 refusals", () => {
  it("not theirs, not a post, answered, before the guard, no media, media gone", async () => {
    const d = await item(["a1"]);
    await expect(approveItem(deps(), B, d.id, { ownMedia: true })).rejects.toMatchObject({ status: 404 });
    const goal = await store.insertDecision(A, { runId: null, skillId: "plan", kind: "goal", suggested: "g", why: "w", evidence: [], detail: {} });
    await expect(approveItem(deps(), A, goal.id, {})).rejects.toMatchObject({ status: 404 });
    const done = await item(["a1"]);
    await store.respondDecision(A, done.id, "accepted", "posted");
    await expect(approveItem(deps(), A, done.id, {})).rejects.toMatchObject({ status: 409, code: "closed" });
    const old = await item(["a1"], {}, { guard: undefined });
    await expect(approveItem(deps(), A, old.id, {})).rejects.toMatchObject({ status: 409, code: "not_guarded" });
    const empty = await item([]);
    await expect(approveItem(deps(), A, empty.id, {})).rejects.toMatchObject({ status: 409, code: "no_assets" });
    library.delete("a1");
    await expect(approveItem(deps(), A, d.id, { ownMedia: true })).rejects.toMatchObject({ status: 409, code: "media_gone" });
    expect(rights.all()).toEqual([]);
  });
});

describe("R6 the queue says what Post it will ask", () => {
  it("ReadyItem.rights before and after", async () => {
    const d = await item(["a1"], brandTarget("Brand One"), { guard: { version: 2, at: "2026-11-01T00:00:00.000Z", disclosure: "ad" } });
    expect((await listQueue(deps(), A)).items[0].rights).toEqual({ missingAssetIds: ["a1"], sponsored: { brand: "Brand One", confirmed: false, kind: null }, disclosure: "ad", complete: false });
    await approveItem(deps(), A, d.id, { ownMedia: true, sponsoredRights: true });
    expect((await listQueue(deps(), A)).items[0].rights).toEqual({ missingAssetIds: [], sponsored: { brand: "Brand One", confirmed: true, kind: null }, disclosure: "ad", complete: true });
  });
});

describe("R7 disclosure: the #ad note only with #ad; \"ask\" asks first (review round 1, item 5)", () => {
  it("a brand-target post with no #ad shows no #ad note and no sponsored line until they answer", async () => {
    const d = await item(["a1"], brandTarget("Brand One"), { caption: { text: "Love my new Brand One shoes.", hashtags: [], edited: false }, guard: { version: 2, at: "x", disclosure: "ask" } });
    const ask = await approveItem(deps(), A, d.id, { ownMedia: true });
    expect(ask).toMatchObject({
      approved: false, needs: { disclosure: "ask", sponsored: null, complete: false },
      words: { adNote: null, sponsored: null, disclosureQuestion: DISCLOSURE_QUESTION, disclosureOptions: [{ value: "paid" }, { value: "gifted" }, { value: "affiliate" }, { value: "none" }] },
    });
    expect(rights.all()).toEqual([]);
  });

  it("paid / gifted / affiliate: #ad goes first (the guard runs again) and the post becomes sponsored", async () => {
    const d = await item(["a1"], brandTarget("Brand One"), { caption: { text: "Love my new Brand One shoes.", hashtags: [], edited: false }, guard: { version: 2, at: "x", disclosure: "ask" } });
    const r = await approveItem(deps(), A, d.id, { ownMedia: true, disclosure: "gifted" });
    // Answered: now it is an #ad post, so the deal's line (and the note) is asked.
    expect(r).toMatchObject({ approved: false, needs: { disclosure: "ad", sponsored: { brand: "Brand One", confirmed: false, kind: "gifted" } }, words: { adNote: expect.stringContaining("#ad"), sponsored: "I have the rights to use them in a gifted post for Brand One.", disclosureQuestion: null } });
    const row = (await store.getDecision(A, d.id))!;
    const kitNow = (row.detail as any).prepared.postKit;
    expect(kitNow.caption.text).toBe("#ad Love my new Brand One shoes.");
    expect(kitNow.caption.hashtags).toEqual(["#ad"]);
    expect(kitNow.guard).toMatchObject({ disclosure: "ad" });
    expect(row.detail!.disclosureAnswer).toEqual({ answer: "gifted", at: NOW.toISOString() });
    const ok = await approveItem(deps(), A, d.id, { ownMedia: true, sponsoredRights: true });
    expect(ok).toMatchObject({ approved: true, caption: "#ad Love my new Brand One shoes." });
  });

  it("none: no #ad, no sponsored line; approved with the own-media line alone", async () => {
    const d = await item(["a1"], brandTarget("Brand One"), { caption: { text: "Love my new Brand One shoes.", hashtags: [], edited: false }, guard: { version: 2, at: "x", disclosure: "ask" } });
    // The answer comes back first with the sheet it leaves (ticks sent with it do not count), then the tick approves.
    expect(await approveItem(deps(), A, d.id, { ownMedia: true, disclosure: "none" })).toMatchObject({ approved: false, needs: { disclosure: null, sponsored: null, missingAssetIds: ["a1"] }, words: { sponsored: null, adNote: null } });
    expect(rights.all()).toEqual([]);
    const r = await approveItem(deps(), A, d.id, { ownMedia: true });
    expect(r).toMatchObject({ approved: true, caption: "Love my new Brand One shoes.", item: { rights: { disclosure: null, sponsored: null, complete: true } } });
    expect(rights.all().map((x) => x.scope)).toEqual(["own_posts"]);
  });
});

describe("R8 per deal, by the deal record (review round 1, item 6)", () => {
  it("keys on the newest matching record; a new deal with the same brand asks again; no record = the brand", async () => {
    connections = [{ brand: "Brand One", kind: "deal", codes: [], ref: "deal:old", since: "2026-01-01T00:00:00.000Z" }];
    const first = await item(["a1"], brandTarget("Brand One"), { guard: { version: 2, at: "2026-11-01T00:00:00.000Z", disclosure: "ad" } });
    await approveItem(deps(), A, first.id, { ownMedia: true, sponsoredRights: true });
    expect(rights.all().find((r) => r.scope === "sponsored")!.dealKey).toBe("deal:old");
    const same = await item(["a1"], brandTarget("brand one"), { guard: { version: 2, at: "2026-11-01T00:00:00.000Z", disclosure: "ad" } });
    expect((await approveItem(deps(), A, same.id, {})).approved).toBe(true);
    // A new deal with the same brand: asked again, keyed on the new record.
    connections = [...connections, { brand: "Brand One", kind: "gift", codes: [], ref: "deal:new", since: "2026-11-01T00:00:00.000Z" }];
    const next = await item(["a1"], brandTarget("Brand One"), { guard: { version: 2, at: "2026-11-01T00:00:00.000Z", disclosure: "ad" } });
    expect(await approveItem(deps(), A, next.id, {})).toMatchObject({ approved: false, needs: { sponsored: { confirmed: false } } });
    await approveItem(deps(), A, next.id, { sponsoredRights: true });
    expect(rights.all().filter((r) => r.scope === "sponsored").map((r) => r.dealKey)).toEqual(["deal:old", "deal:new"]);
    expect(dealKeyFor("Other Co", connections)).toBe(dealKeyOf("Other Co"));
  });
});

describe("R9 approve uses the queue's readiness test (review round 1, item 7)", () => {
  it("resting, needing generated media, or not made: refused like the queue leaves them out", async () => {
    const rest = await item(["a1"], { cardTap: { state: "not_now", at: NOW.toISOString(), until: new Date(NOW.getTime() + 86_400_000).toISOString() } } as any);
    await expect(approveItem(deps(), A, rest.id, { ownMedia: true })).rejects.toMatchObject({ status: 409, code: "resting" });
    const gen = await item(["a1"], {}, { aiGenerationNeeded: { value: true, reason: "r" } });
    await expect(approveItem(deps(), A, gen.id, { ownMedia: true })).rejects.toMatchObject({ status: 409, code: "no_assets" });
    const toStart = await item(["a1"], { state: "to_start" });
    await expect(approveItem(deps(), A, toStart.id, { ownMedia: true })).rejects.toMatchObject({ status: 409, code: "not_ready" });
    expect(rights.all()).toEqual([]);
  });
});

describe("R10 review round 2", () => {
  const AD = { guard: { version: 2, at: "2026-11-01T00:00:00.000Z", disclosure: "ad" as const } };
  it("an answer in the same call as the ticks never stores words they did not see: the new sheet comes back first", async () => {
    const d = await item(["a1"], brandTarget("Brand One"), { caption: { text: "Love my new Brand One shoes.", hashtags: [], edited: false }, guard: { version: 2, at: "x", disclosure: "ask" } });
    const r = await approveItem(deps(), A, d.id, { disclosure: "paid", ownMedia: true, sponsoredRights: true });
    expect(r).toMatchObject({ approved: false, needs: { disclosure: "ad", missingAssetIds: ["a1"], sponsored: { brand: "Brand One", confirmed: false } }, words: { sponsored: rightsSponsoredLine("Brand One") } });
    expect(rights.all()).toEqual([]);
    // The next call, with the sheet they now saw: approved.
    expect((await approveItem(deps(), A, d.id, { ownMedia: true, sponsoredRights: true })).approved).toBe(true);
  });

  it("the first Post it stands: a second approve never moves detail.approval.at later", async () => {
    const d = await item(["a1"]);
    await approveItem(deps(), A, d.id, { ownMedia: true });
    const first = ((await store.getDecision(A, d.id))!.detail as any).approval.at;
    const later = { ...deps(), now: new Date(NOW.getTime() + 3_600_000) };
    await approveItem(later, A, d.id, {});
    expect(((await store.getDecision(A, d.id))!.detail as any).approval.at).toBe(first);
  });

  it("no brand target: a deal the caption names is the partner of an #ad post", async () => {
    connections = [{ brand: "Brand One", kind: "deal", codes: [], ref: "deal:x1", since: "2026-10-01T00:00:00.000Z" }];
    const d = await item(["a1"], {}, { ...AD, caption: { text: "#ad Training in my Brand One kit.", hashtags: ["#ad"], edited: false } });
    expect(await approveItem(deps(), A, d.id, { ownMedia: true })).toMatchObject({ approved: false, needs: { sponsored: { brand: "Brand One", confirmed: false } } });
    await approveItem(deps(), A, d.id, { ownMedia: true, sponsoredRights: true });
    expect(rights.all().find((x) => x.scope === "sponsored")!.dealKey).toBe("deal:x1");
    // Without #ad, a named brand is not a sponsorship.
    const plain = await item(["a2"], {}, { caption: { text: "Training in my Brand One kit.", hashtags: [], edited: false } });
    expect(await approveItem(deps(), A, plain.id, { ownMedia: true })).toMatchObject({ approved: true, item: { rights: { sponsored: null } } });
  });

  it("the queue's disclosure agrees with a \"none\" answer", async () => {
    const d = await item(["a1"], brandTarget("Brand One"), { caption: { text: "Love Brand One.", hashtags: [], edited: false }, guard: { version: 2, at: "x", disclosure: "ask" } });
    await approveItem(deps(), A, d.id, { disclosure: "none" });
    expect((await listQueue(deps(), A)).items[0]).toMatchObject({ guard: { disclosure: null }, rights: { disclosure: null } });
  });
});

describe("R11 a deleted photo keeps the word (owner decision 10 Nov 2026)", () => {
  it("the word stays (asset_ref names it), shows in the list, and never counts for any asset again", async () => {
    const d = await item(["a1"]);
    await approveItem(deps(), A, d.id, { ownMedia: true });
    expect(rights.all()[0]).toMatchObject({ assetId: "a1", assetRef: "media:a1", assetKind: "photo" });
    rights.assetDeleted("a1");
    const [kept] = await listRights(deps(), A);
    expect(kept).toMatchObject({ scope: "own_posts", assetId: null, assetRef: "media:a1", assetKind: "photo" });
    // A kept word with no asset is not a confirmation of anything: a post using another asset asks for it.
    const next = await item(["a2"]);
    expect(await approveItem(deps(), A, next.id, {})).toMatchObject({ approved: false, needs: { missingAssetIds: ["a2"] } });
    await approveItem(deps(), A, next.id, { ownMedia: true });
    expect(rights.all().map((r) => [r.assetId, r.assetRef])).toEqual([[null, "media:a1"], ["a2", "media:a2"]]);
  });
});

describe("R12 the sponsored line is worded for the kind of post (rights/2)", () => {
  it("their answer names it; else the matching record; else a sponsored post; #ad rules unchanged", async () => {
    expect(rightsSponsoredLine("Brand One")).toBe("I have the rights to use them in a sponsored post for Brand One.");
    expect(rightsSponsoredLine("Brand One", "paid")).toBe("I have the rights to use them in a sponsored post for Brand One.");
    expect(rightsSponsoredLine("Brand One", "gifted")).toBe("I have the rights to use them in a gifted post for Brand One.");
    expect(rightsSponsoredLine("Brand One", "affiliate")).toBe("I have the rights to use them in an affiliate post for Brand One.");
    // Answered "affiliate": the stored word is the affiliate wording, at rights/2.
    const asked = await item(["a1"], brandTarget("Brand One"), { caption: { text: "Love Brand One.", hashtags: [], edited: false }, guard: { version: 2, at: "x", disclosure: "ask" } });
    expect(await approveItem(deps(), A, asked.id, { disclosure: "affiliate" })).toMatchObject({ words: { sponsored: "I have the rights to use them in an affiliate post for Brand One." } });
    await approveItem(deps(), A, asked.id, { ownMedia: true, sponsoredRights: true });
    expect(rights.all().find((r) => r.scope === "sponsored")).toMatchObject({ words: "I have the rights to use them in an affiliate post for Brand One.", wordsVersion: "rights/2" });
    // No answer: the newest matching record's kind (a gift).
    connections = [{ brand: "Brand Two", kind: "deal", codes: [], ref: "deal:old", since: "2026-01-01T00:00:00.000Z" }, { brand: "Brand Two", kind: "gift", codes: [], ref: "deal:new", since: "2026-10-01T00:00:00.000Z" }];
    const gifted = await item(["a2"], brandTarget("Brand Two"), { guard: { version: 2, at: "x", disclosure: "ad" } });
    expect(await approveItem(deps(), A, gifted.id, {})).toMatchObject({ needs: { sponsored: { kind: "gifted" } }, words: { sponsored: "I have the rights to use them in a gifted post for Brand Two.", adNote: expect.stringContaining("#ad") } });
  });
});
