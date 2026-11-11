/**
 * treatBookImages — every cast slot is treated (face-aware crop + the one look's neutral "campaign" grade) at its slot's shape, statement slots also
 * get a toned backdrop, and the cover is cut out only when the cut-out is on, a mask exists and the photo is a decent
 * match or busy. photoTreat and the bucket are mocked.
 */
jest.mock("../../lib/photoTreat", () => ({
  treatedPath: jest.fn(async (p: string, o: { shape: string; treatment: string }) => `${p}#${o.shape}.${o.treatment}`),
  cutoutEnabled: jest.fn(() => false),
  hasMask: jest.fn(async () => false),
  isBusy: jest.fn(async () => false),
}));
jest.mock("../../lib/mediaStore", () => ({ readObject: jest.fn(async () => ({ buf: Buffer.from(""), contentType: "image/jpeg" })) }));

import { cutoutEnabled, hasMask, isBusy, treatedPath } from "../../lib/photoTreat";
import { treatBookImages } from "./treat";

const face = { x: 0.4, y: 0.1, w: 0.2, h: 0.1 };
const cast = {
  cover: { gcsPath: "c.jpg", tier: "decent" as const, tags: { face_box: face } },
  big_idea: { gcsPath: "b.jpg", tier: "strong" as const, tags: { face_box: null } },
  "pillar.0": { gcsPath: "p.jpg", tier: "strong" as const, tags: null },
  story: null,
};
const images = { cover: "c.jpg", big_idea: "b.jpg", "pillar.0": "p.jpg", story: null };

describe("treatBookImages", () => {
  beforeEach(() => jest.clearAllMocks());

  it("crops and grades every photo at its slot's shape, passing her face, and tones the statement slots", async () => {
    const out = await treatBookImages(cast, images);
    // Full-bleed pages (cover, big idea, pillars) are cropped tall; inset photos 4:5.
    expect(out.images).toEqual({ cover: "c.jpg#statement.photo", big_idea: "b.jpg#statement.photo", "pillar.0": "p.jpg#statement.photo", story: null });
    expect(out.backdrops).toEqual({ big_idea: "b.jpg#statement.tonal" });
    expect(treatedPath).toHaveBeenCalledWith("c.jpg", expect.objectContaining({ shape: "statement", treatment: "photo", look: "campaign", face }));
    expect(treatedPath).toHaveBeenCalledWith("b.jpg", expect.objectContaining({ shape: "statement", treatment: "tonal", look: "campaign" }));
    expect(treatedPath).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ look: "luxe" }));
  });

  it("cuts the cover out only when the cut-out is on, a mask exists, and the photo is decent (or busy)", async () => {
    (cutoutEnabled as jest.Mock).mockReturnValue(true);
    (hasMask as jest.Mock).mockResolvedValue(true);
    expect((await treatBookImages(cast, images)).images.cover).toBe("c.jpg#statement.cutout");
    // A strong, calm cover stays a photo.
    const strong = { ...cast, cover: { ...cast.cover, tier: "strong" as const } };
    (isBusy as jest.Mock).mockResolvedValue(false);
    expect((await treatBookImages(strong, images)).images.cover).toBe("c.jpg#statement.photo");
    (isBusy as jest.Mock).mockResolvedValue(true);
    expect((await treatBookImages(strong, images)).images.cover).toBe("c.jpg#statement.cutout");
    // No mask → no cut-out.
    (hasMask as jest.Mock).mockResolvedValue(false);
    expect((await treatBookImages(cast, images)).images.cover).toBe("c.jpg#statement.photo");
  });
});
