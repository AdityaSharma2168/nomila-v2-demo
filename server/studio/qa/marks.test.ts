/**
 * qa/marks — the NIL rules, on mocked vision.
 *
 * The cases here are the corpus's own, by name, because they are the ones that decide whether the
 * check is worth having: q5-p1-B's invented swoosh, 2.4b's requested-arrival-plus-silent-removal,
 * q3-b's adidas-over-Nike, and 3.1's destroyed wordmark.
 */
import { brandOf, checkMarks, wasRequested } from "./marks";
import type { ComparisonPair } from "./types";

jest.mock("./vision", () => {
  const actual = jest.requireActual("./vision");
  return {
    ...actual,
    askVision: jest.fn(),
    probeScale: jest.fn(async (b: Buffer) => ({
      bytes: b,
      width: 100,
      height: 100,
    })),
    cropRect: jest.fn(async (b: Buffer) => b),
  };
});

import { askVision } from "./vision";
const mockAsk = askVision as jest.MockedFunction<typeof askVision>;

const pair = (instruction: string): ComparisonPair => ({
  sourceAssetId: "src",
  sourceBytes: Buffer.from("s"),
  sourceMimeType: "image/png",
  outputAssetId: "out",
  outputBytes: Buffer.from("o"),
  outputMimeType: "image/png",
  chainDepth: 1,
  instruction,
});

const ok = <T>(value: T) => ({
  value,
  error: null,
  latencyMs: 5,
  usage: { inputTokens: 900, outputTokens: 120 },
});

/** Whole-frame marks, then no garments found (so pass 2 contributes nothing). */
function onlyWholeFrame(marks: unknown) {
  mockAsk
    .mockResolvedValueOnce(ok(marks) as never) // pass 1
    .mockResolvedValueOnce(ok([]) as never) // garments: source
    .mockResolvedValueOnce(ok([]) as never); // garments: output
}

beforeEach(() => jest.clearAllMocks());

describe("brandOf / wasRequested", () => {
  it("recognises apparel brands and ignores crests and numbers", () => {
    expect(brandOf("Nike swoosh")).toBe("nike");
    expect(brandOf("adidas three stripes")).toBe("adidas");
    expect(brandOf("STANFORD")).toBeNull();
    expect(brandOf("8")).toBeNull();
    expect(brandOf("Pac-12 logo")).toBeNull();
  });

  it("reads a brand request out of her sentence", () => {
    expect(
      wasRequested("adidas logo", "add an adidas logo to the jersey"),
    ).toBe(true);
    expect(
      wasRequested("Nike swoosh", "add an adidas logo to the jersey"),
    ).toBe(false);
    expect(wasRequested("Nike swoosh", "make the shorts black and green")).toBe(
      false,
    );
  });

  it("handles non-brand marks by their distinctive words", () => {
    expect(wasRequested("number 10", "put a number 10 on the jersey")).toBe(
      true,
    );
    expect(wasRequested("STANFORD wordmark", "make the jersey red")).toBe(
      false,
    );
  });
});

describe("an invented mark fails — q5-p1-B", () => {
  it("fails when a swoosh appears and the instruction never mentioned Nike", async () => {
    onlyWholeFrame([
      { name: "Stanford tree crest", change: "survived", where: "shorts" },
      {
        name: "Nike swoosh",
        change: "appeared",
        where: "shorts",
        note: "not in source",
      },
    ]);
    const r = await checkMarks(pair("make the shorts black and green"));
    expect(r.status).toBe("fail");
    expect(r.detail!.appeared[0].requested).toBe(false);
    expect(r.summary).toMatch(/nobody asked for/);
  });

  it("fails when an existing mark is redrawn — the repainted tree", async () => {
    onlyWholeFrame([
      {
        name: "Stanford tree crest",
        change: "altered",
        where: "shorts",
        note: "white outline, 3x size",
      },
    ]);
    const r = await checkMarks(pair("make the shorts black and green"));
    expect(r.status).toBe("fail");
    expect(r.summary).toMatch(/redrawn/);
  });
});

describe("a requested arrival is the edit working — 2.4b", () => {
  it("does not count an adidas logo against an instruction that asked for one", async () => {
    onlyWholeFrame([
      { name: "adidas logo", change: "appeared", where: "jersey" },
      { name: "STANFORD", change: "survived", where: "jersey" },
    ]);
    const r = await checkMarks(pair("add an adidas logo to the jersey"));
    expect(r.detail!.appeared[0].requested).toBe(true);
    expect(r.status).toBe("pass");
  });

  it("still flags the swoosh that was silently replaced", async () => {
    onlyWholeFrame([
      { name: "adidas logo", change: "appeared", where: "jersey" },
      { name: "Nike swoosh", change: "disappeared", where: "jersey" },
    ]);
    const r = await checkMarks(pair("add an adidas logo to the jersey"));
    expect(r.status).toBe("flag");
    expect(r.summary).toMatch(/vanished/);
    // Adi verdicted this image CLEAN. Flagging it is correct, not a false positive.
    expect(r.detail!.disappeared).toHaveLength(1);
  });
});

describe("brand conflict — q3-b", () => {
  it("flags adidas on the jersey and Nike on the boots", async () => {
    onlyWholeFrame([
      { name: "adidas logo", change: "appeared", where: "jersey" },
      { name: "Nike swoosh", change: "survived", where: "cleats" },
      { name: "Nike swoosh", change: "survived", where: "socks" },
    ]);
    const r = await checkMarks(
      pair("make the jersey red and add an adidas logo"),
    );
    expect(r.detail!.conflict).toEqual({
      brands: ["adidas", "nike"],
      preExisting: false,
    });
    expect(r.status).toBe("flag");
    expect(r.summary).toMatch(/competing brands/);
  });

  it("does not treat a school crest and a conference mark as competing", async () => {
    onlyWholeFrame([
      { name: "STANFORD", change: "survived", where: "jersey" },
      { name: "Pac-12 logo", change: "survived", where: "sleeve" },
      { name: "Nike swoosh", change: "survived", where: "chest" },
    ]);
    const r = await checkMarks(pair("make the jersey red"));
    expect(r.detail!.conflict).toBeNull();
    expect(r.status).toBe("pass");
  });

  it("ignores a brand that only exists in the source when judging conflict", async () => {
    onlyWholeFrame([
      { name: "Nike swoosh", change: "disappeared", where: "jersey" },
      { name: "adidas logo", change: "appeared", where: "jersey" },
    ]);
    const r = await checkMarks(pair("add an adidas logo"));
    expect(r.detail!.outputBrands).toEqual(["adidas"]);
    expect(r.detail!.conflict).toBeNull();
  });
});

describe("a destroyed wordmark — 3.1", () => {
  it("flags marks that vanished", async () => {
    onlyWholeFrame([
      { name: "STANFORD", change: "disappeared", where: "jersey" },
      { name: "8", change: "disappeared", where: "jersey" },
    ]);
    const r = await checkMarks(
      pair("make the jersey red and the shorts black"),
    );
    expect(r.status).toBe("flag");
    expect(r.detail!.disappeared).toHaveLength(2);
  });
});

describe("clean output — 1.1", () => {
  it("passes when everything survived", async () => {
    onlyWholeFrame([
      { name: "STANFORD", change: "survived", where: "jersey" },
      { name: "8", change: "survived", where: "jersey" },
      { name: "Nike swoosh", change: "survived", where: "chest" },
    ]);
    const r = await checkMarks(
      pair("change the color of the jersey to purple"),
    );
    expect(r.status).toBe("pass");
    expect(r.summary).toMatch(/3 mark\(s\) intact/);
  });
});

describe("the second pass", () => {
  it("pairs garments by name and merges what the zoom found", async () => {
    mockAsk
      .mockResolvedValueOnce(
        ok([
          { name: "STANFORD", change: "survived", where: "jersey" },
        ]) as never,
      )
      .mockResolvedValueOnce(
        ok([{ label: "shorts", box_2d: [500, 200, 700, 600] }]) as never,
      )
      .mockResolvedValueOnce(
        ok([{ label: "shorts", box_2d: [520, 210, 720, 610] }]) as never,
      )
      .mockResolvedValueOnce(
        ok([
          { name: "Nike swoosh", change: "appeared", where: "shorts" },
        ]) as never,
      );

    const r = await checkMarks(pair("make the shorts black and green"));
    expect(r.detail!.zoomedRegions).toEqual(["shorts"]);
    expect(r.detail!.passes).toBe(2);
    // Found ONLY by the zoom, and it still fails the check — the whole point of pass 2.
    expect(r.status).toBe("fail");
  });

  it("skips a garment the source does not also have, rather than guessing a pairing", async () => {
    mockAsk
      .mockResolvedValueOnce(
        ok([
          { name: "STANFORD", change: "survived", where: "jersey" },
        ]) as never,
      )
      .mockResolvedValueOnce(
        ok([{ label: "jersey", box_2d: [100, 200, 400, 600] }]) as never,
      )
      .mockResolvedValueOnce(
        ok([{ label: "jacket", box_2d: [100, 200, 400, 600] }]) as never,
      );

    const r = await checkMarks(pair("make it a jacket"));
    expect(r.detail!.zoomedRegions).toEqual([]);
    expect(r.detail!.passes).toBe(1);
  });

  it("does not double-count a mark both passes saw", async () => {
    mockAsk
      .mockResolvedValueOnce(
        ok([
          { name: "Nike swoosh", change: "appeared", where: "shorts" },
        ]) as never,
      )
      .mockResolvedValueOnce(
        ok([{ label: "shorts", box_2d: [500, 200, 700, 600] }]) as never,
      )
      .mockResolvedValueOnce(
        ok([{ label: "shorts", box_2d: [520, 210, 720, 610] }]) as never,
      )
      .mockResolvedValueOnce(
        ok([
          { name: "nike swoosh", change: "appeared", where: "shorts" },
        ]) as never,
      );

    const r = await checkMarks(pair("make the shorts green"));
    expect(r.detail!.appeared).toHaveLength(1);
  });
});

describe("failure is `unknown`, never a pass", () => {
  it("reports unknown when the comparison does not parse", async () => {
    mockAsk.mockResolvedValue({
      value: null,
      error: "unparseable answer",
      latencyMs: 5,
      usage: null,
    } as never);
    const r = await checkMarks(pair("make the jersey red"));
    expect(r.status).toBe("unknown");
    expect(r.status).not.toBe("pass");
    expect(r.detail).toBeNull();
  });

  it("counts every vision call in the spend", async () => {
    onlyWholeFrame([{ name: "STANFORD", change: "survived", where: "jersey" }]);
    const r = await checkMarks(pair("make the jersey red"));
    expect(r.spend.visionCalls).toBe(3);
    expect(r.spend.usd).toBeGreaterThan(0);
  });
});

describe("a mark that rode in on an object she asked for — the acceptance run's finding", () => {
  it("does not count BOLYN on a ball she asked to add", async () => {
    onlyWholeFrame([
      { name: "BOLYN logo", change: "appeared", where: "soccer ball" },
    ]);
    const r = await checkMarks(
      pair(
        "add the soccer ball from the second image, place it between her cleats",
      ),
    );
    expect(r.detail!.appeared[0].requested).toBe(true);
    expect(r.status).toBe("pass");
  });

  it("does not count the Gatorade G on a bottle she asked to place", async () => {
    onlyWholeFrame([
      {
        name: "Gatorade logo",
        change: "appeared",
        where: "water bottle on head",
      },
    ]);
    const r = await checkMarks(
      pair("place the water bottle from the second image on top of her head"),
    );
    expect(r.status).toBe("pass");
  });

  it("STILL fails an invented swoosh on shorts she merely mentioned recolouring", async () => {
    // The case the exclusion exists for. "make the shorts black and green" names the shorts, and a
    // naive "she mentioned it" rule would call this requested and lose the PR's main true positive.
    onlyWholeFrame([
      { name: "Nike swoosh", change: "appeared", where: "shorts" },
    ]);
    const r = await checkMarks(pair("make the shorts black and green"));
    expect(r.detail!.appeared[0].requested).toBe(false);
    expect(r.status).toBe("fail");
  });

  it("still fails an unrequested mark on a non-garment when no addition was asked for", async () => {
    onlyWholeFrame([
      { name: "Nike swoosh", change: "appeared", where: "soccer ball" },
    ]);
    const r = await checkMarks(
      pair("change the background to a beach at sunset"),
    );
    expect(r.status).toBe("fail");
  });
});

describe("a brand conflict must be CREATED by the edit", () => {
  it("does not flag adidas kit + Nike cleats that were both already in the source", async () => {
    // q2-a: a background swap on a photograph where she wears both brands. Verdicted CLEAN.
    onlyWholeFrame([
      { name: "adidas logo", change: "survived", where: "sports bra" },
      { name: "Nike swoosh", change: "survived", where: "cleats" },
    ]);
    const r = await checkMarks(
      pair("change the background to a beach at sunset"),
    );
    expect(r.detail!.sourceBrands).toEqual(["adidas", "nike"]);
    expect(r.detail!.conflict).toBeNull();
    expect(r.status).toBe("pass");
  });

  it("still flags q3-b, where the edit ADDED the second brand", async () => {
    onlyWholeFrame([
      { name: "adidas logo", change: "appeared", where: "jersey" },
      { name: "Nike swoosh", change: "survived", where: "cleats" },
    ]);
    const r = await checkMarks(
      pair("make the jersey red and add an adidas logo"),
    );
    expect(r.detail!.sourceBrands).toEqual(["nike"]);
    expect(r.detail!.conflict).toEqual({
      brands: ["adidas", "nike"],
      preExisting: false,
    });
    expect(r.status).toBe("flag");
  });
});

describe("who asked — an interpreted job's provenance (the interpreter, I.5; N7, C-6)", () => {
  // Cell 1a's verdict: an adidas ad over a Nike kit. The swap brought adidas in and took Nike away, and
  // both are the brand's (M2) — neither is in her words, and C names only adidas.
  const C_1A =
    'change my jersey to an adidas jersey, change my socks to adidas socks, change my cleats to adidas cleats, and add the headline "OWN THE MOMENT" across the top';
  const SWAP = {
    arrivals: [{ brand: "adidas", source: "brand" as const }],
    departures: [{ brand: "nike", source: "brand" as const }],
  };
  const withProvenance = (instruction: string, provenance = SWAP) => ({
    ...pair(instruction),
    provenance,
  });

  it("reads the swapped-away Nike marks as the brand's request, and passes the swap", async () => {
    onlyWholeFrame([
      { name: "adidas three stripes", change: "appeared", where: "jersey" },
      { name: "adidas logo", change: "appeared", where: "cleats" },
      // Two names: the check merges one name's sightings (`merge`).
      { name: "Nike swoosh", change: "disappeared", where: "jersey" },
      { name: "Nike logo", change: "disappeared", where: "cleats" },
      { name: "STANFORD", change: "survived", where: "jersey" },
    ]);
    const r = await checkMarks(withProvenance(C_1A));
    expect(r.status).toBe("pass");
    expect(r.detail!.appeared.map((m) => [m.requested, m.requestedBy])).toEqual(
      [
        [true, "brand"],
        [true, "brand"],
      ],
    );
    expect(
      r.detail!.disappeared.map((m) => [m.requested, m.requestedBy]),
    ).toEqual([
      [true, "brand"],
      [true, "brand"],
    ]);
    expect(r.summary).toBe(
      "1 mark(s) intact, 2 requested arrival(s), 2 requested departure(s).",
    );
  });

  it("still flags a mark nobody asked to take away — a crest is no brand's departure", async () => {
    onlyWholeFrame([
      { name: "Nike swoosh", change: "disappeared", where: "socks" },
      { name: "STANFORD", change: "disappeared", where: "jersey" },
    ]);
    const r = await checkMarks(withProvenance(C_1A));
    expect(r.status).toBe("flag");
    expect(r.summary).toBe("1 mark(s) vanished: STANFORD.");
    expect(r.detail!.disappeared.map((m) => m.requested)).toEqual([
      true,
      false,
    ]);
  });

  it("still flags the Nike the swap MISSED — a surviving mark beside the arrival is a conflict", async () => {
    onlyWholeFrame([
      { name: "adidas logo", change: "appeared", where: "jersey" },
      { name: "Nike swoosh", change: "survived", where: "socks" },
    ]);
    const r = await checkMarks(withProvenance(C_1A));
    expect(r.detail!.conflict).toEqual({
      brands: ["adidas", "nike"],
      preExisting: false,
    });
    expect(r.status).toBe("flag");
  });

  it("still fails a brand nobody brought in", async () => {
    onlyWholeFrame([{ name: "Puma cat", change: "appeared", where: "shorts" }]);
    const r = await checkMarks(withProvenance(C_1A));
    expect(r.status).toBe("fail");
    expect(r.detail!.appeared[0]).toMatchObject({ requested: false });
    expect("requestedBy" in r.detail!.appeared[0]).toBe(false);
  });

  it("changes nothing without provenance: 2.4b's silent removal still flags, with no new field", async () => {
    onlyWholeFrame([
      { name: "adidas logo", change: "appeared", where: "jersey" },
      { name: "Nike swoosh", change: "disappeared", where: "jersey" },
    ]);
    const r = await checkMarks(pair("add an adidas logo to the jersey"));
    expect(r.status).toBe("flag");
    // The mocked vision call hands back the fixture as it is, so the entry is exactly the fixture's.
    expect(r.detail!.disappeared[0]).toEqual({
      name: "Nike swoosh",
      change: "disappeared",
      where: "jersey",
    });
    expect("requestedBy" in r.detail!.appeared[0]).toBe(false);
  });
});
