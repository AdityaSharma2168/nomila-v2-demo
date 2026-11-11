/**
 * publicCardLogic.test — the pure half of her public card editor.
 *
 *   L1 errors: apiRequest's "<status>: <json>" becomes { status, code, error, nextChangeAt }; a network failure is status 0
 *   L2 decisionsFrom rebuilds her decisions without ever re-approving wording she has not seen (a stale "made" approval
 *      goes back WITHOUT its hash), keeps hidden chapters and renamed titles, and leaves Highlights out of the order
 *   L3 the edits: approve pins a made line's hash; hide; chapter hide/rename; reorder never moves Highlights
 *   L4 her words: state lines, item notes (each block), chapter notes, the cut list, the handle and publish refusals
 *   L5 the visitor's page maps the content as the server's snapshotAdapter does (identity + quote on the header,
 *      compact stats with "as of", page caps), and the tiles are copied as resolved at publish
 */
import {
  approveItem, canMove, cardStatus, chapterNote, cutLine, decisionsFrom, doorUnavailable, handleErrorLine, handleProblem,
  hideItem, itemLine, itemNote, moveChapter, pageModel, problemLine, publicCardError, publicCardUrl, displayUrl,
  publishErrorLine, publishSummary, renameChapter, reviewMeta, setChapterHidden, waitingCount, ERROR_COPY,
} from "./publicCardLogic";
import { CONTENT_DRAFT, NEW_DRAFT, chapter, content, httpError, item, state } from "../screens/me/__fixtures__/publicCard";

describe("L1 errors", () => {
  it("reads the server's error body", () => {
    expect(publicCardError(httpError(429, { error: "A handle can change once a month.", code: "too_soon", nextChangeAt: "2026-11-07T00:00:00.000Z" })))
      .toEqual({ status: 429, code: "too_soon", error: "A handle can change once a month.", nextChangeAt: "2026-11-07T00:00:00.000Z" });
  });
  it("a network failure is status 0, and says so", () => {
    const p = publicCardError(new TypeError("Network request failed"));
    expect(p.status).toBe(0);
    expect(problemLine(p)).toBe(ERROR_COPY.network);
  });
  it("404 is the server's flag being off; 500 never shows the raw body", () => {
    expect(problemLine(publicCardError(httpError(404, { error: "The public card is not available yet.", code: "disabled" })))).toBe(ERROR_COPY.disabled);
    expect(problemLine(publicCardError(new Error("500: {\"error\":\"public card operation failed\"}")))).toBe(ERROR_COPY.load);
  });
});

describe("L2 decisionsFrom", () => {
  const dec = decisionsFrom(CONTENT_DRAFT);
  it("an approved made line keeps its pin; a stale approval goes back without a hash", () => {
    expect(dec.items!["hl-id"]).toEqual({ state: "approved", textHash: "h-id" });
    expect(dec.items!["st-rise"]).toEqual({ state: "approved" });
  });
  it("undecided items are not written; hidden items are", () => {
    expect(dec.items!["st-origin"]).toBeUndefined();
    expect(dec.items!["im-cause"]).toEqual({ state: "hidden" });
  });
  it("chapters: hidden and a renamed title only; order without Highlights", () => {
    expect(dec.chapters).toEqual({ impact: { hidden: true, title: "What I care about" } });
    expect(dec.order).toEqual(["story", "impact"]);
  });
  it("a new athlete has nothing decided", () => {
    expect(decisionsFrom(NEW_DRAFT)).toEqual({ items: {}, chapters: {}, order: [] });
  });
});

describe("L3 the edits", () => {
  it("approving a made line pins THIS wording; a said line needs no hash", () => {
    const origin = CONTENT_DRAFT.chapters[1].items[0];
    expect(approveItem({}, origin).items!["st-origin"]).toEqual({ state: "approved", textHash: "h-origin" });
    expect(approveItem({}, item("x")).items!.x).toEqual({ state: "approved" });
    expect(hideItem({}, "x").items!.x).toEqual({ state: "hidden" });
  });
  it("chapters hide, unhide and rename; Highlights never hides; an empty name is the default", () => {
    expect(setChapterHidden({}, "story", true).chapters!.story).toEqual({ hidden: true });
    expect(setChapterHidden({ chapters: { story: { hidden: true, title: "X" } } }, "story", false).chapters!.story).toEqual({ title: "X" });
    expect(setChapterHidden({}, "highlights", true)).toEqual({});
    const ch = chapter("story", []);
    expect(renameChapter({}, ch, "  My road  ").chapters!.story).toEqual({ title: "My road" });
    expect(renameChapter({ chapters: { story: { title: "My road" } } }, ch, "").chapters!.story).toEqual({});
    expect(renameChapter({}, ch, "x".repeat(80)).chapters!.story!.title).toHaveLength(60);
  });
  it("reorder: one step, never above Highlights, never Highlights itself", () => {
    expect(moveChapter(["highlights", "story", "impact"], "impact", -1)).toEqual(["impact", "story"]);
    expect(moveChapter(["highlights", "story", "impact"], "story", -1)).toEqual(["story", "impact"]);
    expect(moveChapter(["highlights", "story", "impact"], "highlights", 1)).toEqual(["story", "impact"]);
    const chs = CONTENT_DRAFT.chapters;
    expect(canMove(chs, "story", -1)).toBe(false);
    expect(canMove(chs, "story", 1)).toBe(true);
    expect(canMove(chs, "impact", 1)).toBe(false);
    expect(canMove(chs, "highlights", 1)).toBe(false);
  });
});

describe("L4 her words", () => {
  it("state: draft / live vN / offline", () => {
    expect(cardStatus(state()).chip).toBe("Draft");
    expect(cardStatus(CONTENT_DRAFT.card)).toEqual({ chip: "Live · v2", line: "Live since 5 Oct 2026 · version 2.", live: true });
    expect(cardStatus(state({ status: "unpublished" })).chip).toBe("Offline");
  });
  it("the link and the review meta", () => {
    const url = publicCardUrl("https://api.example.test/", "sam-lee");
    expect(url).toBe("https://api.example.test/p/sam-lee");
    expect(displayUrl(url)).toBe("api.example.test/p/sam-lee");
    expect(waitingCount(CONTENT_DRAFT)).toBe(4);
    expect(reviewMeta(CONTENT_DRAFT)).toBe("4 items wait for you");
    expect(reviewMeta(NEW_DRAFT)).toBe("Add a chapter or turn on a door to publish");
  });
  it("every item note says why", () => {
    const [id, stat, aff] = CONTENT_DRAFT.chapters[0].items;
    const [origin, rise] = CONTENT_DRAFT.chapters[1].items;
    expect(itemNote(id)).toBe("Shows when you publish.");
    expect(itemNote(stat)).toBe("Approve to show this.");
    expect(itemNote(aff)).toBe("Nomila found this. Approve to confirm it's right.");
    expect(itemNote(origin)).toBe("Nomila wrote this. Approve this exact wording to show it.");
    expect(itemNote(rise)).toMatch(/wording changed since you approved/);
    expect(itemNote(item("x", { blockedBy: "over_limit", publishable: false }))).toMatch(/already shows as many/);
    expect(itemNote(id, "hidden")).toMatch(/Hidden/);
    expect(itemLine(stat)).toEqual({ text: "Instagram followers: 12.4K", detail: null });
    expect(itemLine(CONTENT_DRAFT.picks[0])).toEqual({ text: "Trail shoe", detail: "Example Store · $120" });
  });
  it("chapter notes: hidden, short of the minimum, Highlights", () => {
    expect(chapterNote(CONTENT_DRAFT.chapters[0])).toBe("Always first on your card.");
    expect(chapterNote(CONTENT_DRAFT.chapters[1])).toBe("Shows once 2 items are approved (0 so far).");
    expect(chapterNote(CONTENT_DRAFT.chapters[2])).toBe("Hidden. This chapter won't show.");
  });
  it("the cut list names the kind and the reason, never text", () => {
    expect(cutLine({ key: "k", kind: "beat", reason: "no_basis" })).toEqual({ title: "Story beat", why: "Nomila couldn't point to where it came from, so it was left out." });
  });
  it("Book and Shop say why they can't work", () => {
    expect(doorUnavailable("book", { book: false, shop: true })).toMatch(/published offer and payouts/);
    expect(doorUnavailable("shop", { book: true, shop: false })).toMatch(/live pick/);
    expect(doorUnavailable("partner", { book: false, shop: false })).toBeNull();
  });
  it("handle: shape first, then every refusal with its date", () => {
    expect(handleProblem("ab")).toMatch(/3–30/);
    expect(handleProblem("Sam--Lee")).toMatch(/3–30/);
    expect(handleProblem(" Sam-Lee ")).toBeNull();
    expect(handleErrorLine(publicCardError(httpError(409, { code: "taken", error: "That handle is taken." })))).toBe("That link is taken. Try another.");
    expect(handleErrorLine(publicCardError(httpError(409, { code: "reserved", error: "x" })))).toMatch(/reserved/);
    expect(handleErrorLine(publicCardError(httpError(422, { code: "invalid", error: "x" })))).toMatch(/3–30/);
    expect(handleErrorLine(publicCardError(httpError(429, { code: "too_soon", error: "x", nextChangeAt: "2026-11-07T00:00:00.000Z" })))).toBe("You can change your link once a month. Next change: 7 Nov 2026.");
  });
  it("publish refusals: the 422 sentence verbatim, a handle first, the network", () => {
    expect(publishErrorLine(publicCardError(httpError(422, { code: "invalid", error: "Add a chapter or turn on a door to publish" })))).toBe("Add a chapter or turn on a door to publish");
    expect(publishErrorLine(publicCardError(httpError(409, { code: "needs_handle", error: "Pick a handle before publishing." })))).toBe("Pick your link before publishing.");
    expect(publishErrorLine(publicCardError(new Error("offline")))).toBe(ERROR_COPY.network);
  });
});

describe("L5 the visitor's page", () => {
  it("maps the content as the page does", () => {
    const m = pageModel(content());
    expect(m.identityLine).toBe("Builder of teams");
    expect(m.quote).toBe("Show up early.");
    expect(m.cards.map((c) => c.headline)).toEqual(["Sam Lee", "Story"]);
    expect(m.cards[0].items).toEqual([{ type: "stat", label: "Instagram followers", value: "12.4K", asOf: "as of 8 Oct" }]);
    expect(m.cards[1].items[0]).toEqual({ type: "beat", label: "Origin", text: "Started at nine." });
    expect(m.tiles.map((t) => t.slot)).toEqual(["tl", "tr", "bl", "br"]);
  });
  it("the publish summary names chapters and live doors", () => {
    expect(publishSummary(content())).toEqual({ chapters: ["Highlights", "Story"], doors: ["Partner", "Shop", "Create", "Ask Mila"] });
  });
});
