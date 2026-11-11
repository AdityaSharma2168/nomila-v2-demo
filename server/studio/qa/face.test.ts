/**
 * qa/face — why a face crop came back empty, and whose photograph it was (R0.b's follow-up).
 *
 * The vision call is the network boundary and is mocked; the box parse (`boxToRect`) is the real one, so
 * "a box that does not parse" is measured against the same reader production uses. What is under test is
 * the closed code on the answer and the photo's id on the call and its warning — the two things the
 * identity observation needed and did not have when one of her references came back with no distance.
 */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock("../../logger", () => ({ createLogger: () => mockLogger }));
jest.mock("./vision", () => ({
  ...jest.requireActual("./vision"),
  askVision: jest.fn(),
  probeScale: jest.fn(async (bytes: Buffer) => ({
    bytes,
    width: 100,
    height: 100,
  })),
  cropRect: jest.fn(async () => Buffer.from("crop")),
}));

import { faceCrop } from "./face";
import { askVision } from "./vision";

const mockAsk = askVision as jest.MockedFunction<typeof askVision>;
const answer = (value: unknown, error: string | null = null) =>
  ({ value, error, latencyMs: 5, usage: null }) as Awaited<
    ReturnType<typeof askVision>
  >;

beforeEach(() => jest.clearAllMocks());

describe("faceCrop says why it found nothing, and names the photograph", () => {
  it("no_face when the model finds none, vision_error when the call or its answer fails, unusable_box when the box does not parse", async () => {
    const photo = Buffer.from("photo");
    const cases: [ReturnType<typeof answer>, string][] = [
      [
        answer({ found: false, box_2d: null, confidence: 0, obscured: false }),
        "no_face",
      ],
      [answer(null, "unparseable answer"), "vision_error"],
      [answer(null, "qa vision call failed"), "vision_error"],
      [
        answer({
          found: true,
          box_2d: "not a box",
          confidence: 0.9,
          obscured: false,
        }),
        "unusable_box",
      ],
    ];
    for (const [res, miss] of cases) {
      mockAsk.mockResolvedValueOnce(res);
      const out = await faceCrop(photo, "image/jpeg", "references", "ref-1");
      expect({ miss: out.miss, crop: out.crop }).toEqual({ miss, crop: null });
    }
    // And a face that was found carries no miss.
    mockAsk.mockResolvedValueOnce(
      answer({
        found: true,
        box_2d: [100, 400, 250, 600],
        confidence: 0.9,
        obscured: false,
      }),
    );
    const found = await faceCrop(photo, "image/jpeg", "references", "ref-1");
    expect(found.miss).toBeNull();
    expect(found.crop).not.toBeNull();
  });

  it("puts the photo's id on the vision ask and on the unusable-box warning", async () => {
    mockAsk.mockResolvedValueOnce(
      answer({
        found: true,
        box_2d: "not a box",
        confidence: 0.9,
        obscured: false,
      }),
    );
    await faceCrop(Buffer.from("photo"), "image/jpeg", "references", "ref-2");

    expect(mockAsk).toHaveBeenCalledWith(
      expect.objectContaining({ name: "face:references", assetId: "ref-2" }),
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { label: "references", assetId: "ref-2" },
      "face reported found but the box did not parse",
    );
  });
});
