/**
 * fill-atmosphere-library.test.ts — the import runner's library-state sync and de-dup, with no network and no
 * database: downloadPexelsPhoto / downloadUnsplashPhoto and the libraryStore module are faked.
 *
 *   - a (source, id) already in the library has its `active` flag synced to the list's (apply: written and logged;
 *     dry run: previewed only) when they disagree; a row the list already agrees with is left alone ("skipped_present");
 *     a new active entry not yet present still downloads and is added, untouched by the sync logic.
 *   - the duplicate check is scoped by (source, id): the same numeric id string under two different sources is NOT a
 *     duplicate, but the same (source, id) twice IS.
 *   - a dry run that cannot reach the database (presentRows rejects) still runs; it just cannot preview the sync.
 */
import sharp from "sharp";

jest.mock("../server/services/atmosphere/library", () => ({
  ...jest.requireActual("../server/services/atmosphere/library"),
  downloadUnsplashPhoto: jest.fn(),
  downloadPexelsPhoto: jest.fn(),
}));
jest.mock("../server/services/atmosphere/libraryStore", () => ({
  presentRows: jest.fn(),
  setActive: jest.fn(),
  addPhoto: jest.fn(),
  close: jest.fn(),
}));

import { downloadPexelsPhoto, downloadUnsplashPhoto } from "../server/services/atmosphere/library";
import * as libraryStore from "../server/services/atmosphere/libraryStore";
import { run, type Args, type Processed } from "./fill-atmosphere-library";

const presentRows = libraryStore.presentRows as jest.Mock;
const setActive = libraryStore.setActive as jest.Mock;
const addPhoto = libraryStore.addPhoto as jest.Mock;
const close = libraryStore.close as jest.Mock;

const base: Args = { list: "unused.json", apply: false, limit: 100, check: null, maxUsd: 1, reviewedBy: null, outDir: null, sheet: null, curated: false };
const applyArgs: Args = { ...base, apply: true, reviewedBy: "Reviewer" };

const general = (page: string, licence: string, active?: boolean) =>
  ({ page, category: "general", purposes: ["texture"], licence, ...(active !== undefined ? { active } : {}) });

const statusOf = (out: Processed[], id: string) => out.find((p) => p.id === id)?.status;
const detailOf = (out: Processed[], id: string) => out.find((p) => p.id === id)?.detail;

beforeEach(() => {
  jest.clearAllMocks();
  presentRows.mockResolvedValue(new Map());
  close.mockResolvedValue(undefined);
});

describe("de-dup is scoped by (source, id)", () => {
  it("the same numeric id string under two different sources is not a duplicate", async () => {
    const entries = [
      general("https://unsplash.com/photos/thing-12345678901", "Unsplash License", false),
      general("https://www.pexels.com/photo/thing-12345678901/", "Pexels License", false),
    ];
    await expect(run(base, entries)).resolves.toBeDefined();
  });

  it("the same (source, id) twice is a duplicate", async () => {
    const entries = [
      general("https://www.pexels.com/photo/thing-12345678901/", "Pexels License", false),
      general("https://www.pexels.com/photo/another-thing-12345678901/", "Pexels License", false),
    ];
    await expect(run(base, entries)).rejects.toThrow(/12345678901 is listed twice/);
  });
});

describe("syncing an already-present row's active flag to the list", () => {
  // DB state: unsplash:AAAAAAAAAAA active=true, pexels:22222222 active=false, unsplash:BBBBBBBBBBB active=true.
  const dbMap = new Map([["unsplash:AAAAAAAAAAA", true], ["pexels:22222222", false], ["unsplash:BBBBBBBBBBB", true]]);
  const entries = () => [
    general("https://unsplash.com/photos/thing-AAAAAAAAAAA", "Unsplash License", false),  // list says inactive now
    general("https://www.pexels.com/photo/thing-22222222/", "Pexels License", true),      // list says active now
    general("https://unsplash.com/photos/thing-BBBBBBBBBBB", "Unsplash License", true),   // list agrees: no change
  ];

  it("apply: writes and logs the flips the list disagrees with; leaves the agreeing row alone; never re-downloads", async () => {
    presentRows.mockResolvedValue(dbMap);
    const out = await run(applyArgs, entries());
    expect(statusOf(out, "AAAAAAAAAAA")).toBe("deactivated");
    expect(detailOf(out, "AAAAAAAAAAA")).toBe("active: true → false");
    expect(statusOf(out, "22222222")).toBe("activated");
    expect(detailOf(out, "22222222")).toBe("active: false → true");
    expect(statusOf(out, "BBBBBBBBBBB")).toBe("skipped_present");
    expect(setActive).toHaveBeenCalledTimes(2);
    expect(setActive).toHaveBeenCalledWith("unsplash", "AAAAAAAAAAA", false);
    expect(setActive).toHaveBeenCalledWith("pexels", "22222222", true);
    expect(downloadUnsplashPhoto).not.toHaveBeenCalled();
    expect(downloadPexelsPhoto).not.toHaveBeenCalled();
    expect(addPhoto).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("dry run: previews the same flips without writing them", async () => {
    presentRows.mockResolvedValue(dbMap);
    const out = await run(base, entries());
    expect(statusOf(out, "AAAAAAAAAAA")).toBe("would_deactivate");
    expect(statusOf(out, "22222222")).toBe("would_activate");
    expect(statusOf(out, "BBBBBBBBBBB")).toBe("skipped_present");
    expect(setActive).not.toHaveBeenCalled();
  });

  it("apply: a new active entry not yet present is unaffected by the sync logic and still downloads", async () => {
    presentRows.mockResolvedValue(dbMap);
    const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#4a7" } }).jpeg().toBuffer();
    (downloadPexelsPhoto as jest.Mock).mockResolvedValue({ bytes: jpeg, fileUrl: "https://images.pexels.com/photos/999/pexels-photo-999.jpeg" });
    addPhoto.mockResolvedValue({ gcs_path: "atmosphere/shared/general/999.webp" });
    const out = await run(applyArgs, [...entries(), general("https://www.pexels.com/photo/new-thing-999/", "Pexels License", true)]);
    expect(statusOf(out, "999")).toBe("added");
    expect(addPhoto).toHaveBeenCalledTimes(1);
    expect(setActive).toHaveBeenCalledTimes(2); // only the two synced rows above; the new one goes through addPhoto, not setActive
  });
});

describe("a dry run that cannot reach the database", () => {
  it("still runs: no sync preview, same as a dry run always behaved before the sync feature existed", async () => {
    presentRows.mockRejectedValue(new Error("DATABASE_URL must be set"));
    const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#4a7" } }).jpeg().toBuffer();
    (downloadUnsplashPhoto as jest.Mock).mockResolvedValue({ bytes: jpeg, fileUrl: "https://images.unsplash.com/photo-1" });
    const out = await run(base, [
      general("https://unsplash.com/photos/thing-CCCCCCCCCCC", "Unsplash License", true),
      general("https://unsplash.com/photos/thing-DDDDDDDDDDD", "Unsplash License", false),
    ]);
    expect(statusOf(out, "CCCCCCCCCCC")).toBe("would_add");  // no present-check happened; treated as not present
    expect(statusOf(out, "DDDDDDDDDDD")).toBe("skipped_inactive");
    expect(close).not.toHaveBeenCalled(); // no store was ever successfully loaded
  });
});
