/**
 * mediaPickerLogic.test.ts — the shared picker's decisions, without a renderer.
 *
 * REVERT CHECKS, red by name:
 *   RC4a  stripRows without the pinning            → "a photo picked from page 3 shows in the strip with its mark"
 *   RC4b  synced added to the Board's origins       → "synced posts are never offered on the Board or the Agent"
 *   RC4c  originsFor passes every selected chip     → "a chip the mount does not offer never reaches the query"
 *   RC4d  uploadOutcome picks without the list      → "an upload is picked only if the server lists it for this mount"
 */
import {
  MOUNT_ORIGINS,
  ORIGIN_CHIP,
  markFor,
  mediaQuery,
  originsFor,
  rowFromWire,
  stripRows,
  uploadOutcome,
  type PickerContext,
  type PickerRow,
  isStaleCursor,
  tileLabel,
} from "./mediaPickerLogic";

const photo = (id: string): PickerRow => ({
  kind: "photo",
  assetId: id,
  imageUrl: `https://x/${id}.jpg`,
  thumbUrl: `https://x/${id}-t.jpg`,
  origin: "Uploaded",
});

describe("what each mount offers", () => {
  it("synced posts are never offered on the Board or the Agent", () => {
    const boardAndAgent: PickerContext[] = [
      "board",
      "agent-pick",
      "agent-product",
      "agent-video",
    ];
    for (const m of boardAndAgent)
      expect(MOUNT_ORIGINS[m]).toEqual(["upload", "generated"]);
  });

  it("the Video tab offers all three, as its lists always did", () => {
    expect(MOUNT_ORIGINS["video-clip"]).toEqual([
      "upload",
      "generated",
      "synced",
    ]);
    expect(MOUNT_ORIGINS["video-still"]).toEqual([
      "upload",
      "generated",
      "synced",
    ]);
  });

  it("names the synced chip for every platform it covers, not for one of them", () => {
    expect(ORIGIN_CHIP).toEqual({
      upload: "Uploaded",
      generated: "Made here",
      synced: "From your accounts",
    });
  });
});

describe("chips", () => {
  it("no chip on means everything the mount allows", () => {
    expect(originsFor([], ["upload", "generated"])).toEqual([
      "upload",
      "generated",
    ]);
  });

  it("chips narrow to what she turned on", () => {
    expect(originsFor(["generated"], ["upload", "generated"])).toEqual([
      "generated",
    ]);
  });

  it("a chip the mount does not offer never reaches the query", () => {
    expect(originsFor(["synced", "upload"], ["upload", "generated"])).toEqual([
      "upload",
    ]);
    expect(originsFor(["synced"], ["upload", "generated"])).toEqual([
      "upload",
      "generated",
    ]);
  });

  it("builds one query string per set, whatever order the chips were tapped in", () => {
    expect(
      mediaQuery({
        kind: "photos",
        origins: ["upload", "generated"],
        still: true,
        limit: 24,
      }),
    ).toBe(
      mediaQuery({
        kind: "photos",
        origins: ["generated", "upload"],
        still: true,
        limit: 24,
      }),
    );
    expect(
      mediaQuery({
        kind: "clips",
        origins: ["synced"],
        q: "red dress",
        cursor: "abc",
      }),
    ).toBe("kind=clips&origin=synced&cursor=abc&q=red+dress");
  });

  it("a lookup by id carries the mount's own filters and the ids, and no page (Investigation 12)", () => {
    expect(
      mediaQuery({
        kind: "photos",
        origins: ["upload", "generated"],
        still: true,
        ids: ["id-1"],
      }),
    ).toBe("kind=photos&still=1&origin=generated%2Cupload&ids=id-1");
  });
});

describe("the strip", () => {
  it("a photo picked from page 3 shows in the strip with its mark", () => {
    const firstPage = [photo("a"), photo("b")];
    const seen = new Map([
      ["deep", photo("deep")],
      ...firstPage.map((r) => [r.assetId, r] as const),
    ]);

    const strip = stripRows(firstPage, ["b", "deep"], seen);

    expect(strip.map((r) => r.assetId)).toEqual(["deep", "a", "b"]);
    expect(markFor("deep", ["b", "deep"], true)).toBe("2");
  });

  it("a mount that holds no selection draws the first page as it is, and marks nothing", () => {
    const firstPage = [photo("a"), photo("b")];
    expect(stripRows(firstPage, undefined, new Map())).toEqual(firstPage);
    expect(markFor("a", undefined, true)).toBeNull();
  });

  it("numbers picks in pick order, and marks un-numbered selection with an empty mark", () => {
    expect(markFor("c", ["a", "c"], true)).toBe("2");
    expect(markFor("c", ["a", "c"], false)).toBe("");
    expect(markFor("z", ["a", "c"], true)).toBeNull();
  });
});

describe("rows off the wire", () => {
  it("carries a clip's fields as the timeline reads them — null duration kept null — and her words for the origin", () => {
    const row = rowFromWire(
      {
        kind: "clip",
        assetId: "c1",
        videoUrl: "https://x/c1.mp4",
        posterUrl: null,
        durationSec: 8,
        durationPreciseSec: null,
        origin: "generated",
      },
      (o) => (o === "generated" ? "Made here" : o),
    );
    expect(row).toEqual({
      kind: "clip",
      assetId: "c1",
      videoUrl: "https://x/c1.mp4",
      posterUrl: null,
      durationSec: 8,
      durationPreciseSec: null,
      origin: "Made here",
      // Absent from an older server: no beats to cut, and no read state — no affordance (PR 9.5).
      beats: 0,
      read: null,
      tagged: true,
      subject: null,
      shot: null,
      reject: false,
      madeHereNotHer: false,
    });
  });

  it("carries a clip's read state as the server served it — what the 'Read this clip' pill renders (PR 9.5)", () => {
    const read = { state: "unread" as const, quotedUsd: 0.0069 };
    const row = rowFromWire(
      {
        kind: "clip",
        assetId: "c1",
        videoUrl: "https://x/c1.mp4",
        posterUrl: null,
        durationSec: 8,
        durationPreciseSec: null,
        origin: "generated",
        read,
      },
      (o) => o,
    );
    expect(row).toMatchObject({ kind: "clip", beats: 0, read });
  });

  it("carries a clip's beat count — what lets the Agent form cut a picked video", () => {
    const row = rowFromWire(
      {
        kind: "clip",
        assetId: "c1",
        videoUrl: "https://x/c1.mp4",
        posterUrl: null,
        durationSec: 8,
        durationPreciseSec: null,
        origin: "upload",
        beats: 6,
      },
      (o) => o,
    );
    expect(row.kind === "clip" && row.beats).toBe(6);
  });
});

describe("an upload made from the picker", () => {
  it("an upload is picked only if the server lists it for this mount", () => {
    const listed = [photo("new"), photo("old")];
    expect(uploadOutcome("new", listed, false)).toEqual({ pick: listed[0] });
    expect(uploadOutcome("missing", listed, false)).toEqual({
      refusal: "It's in your library, but it can't be used here.",
    });
  });

  it("a HEIC the Video tab cannot hold is refused in the door's own words, naming the format", () => {
    expect(uploadOutcome("heic", [photo("old")], true, "image/heic")).toEqual({
      refusal:
        "It's in your library, but it's in a format we can't put in a video yet (HEIC) — save it as a JPEG and add it again.",
    });
  });
});

describe("PR 12 — the tile's label, and a cursor gone stale (docs/probes/library-fields.md)", () => {
  const label = (o: string) => o;
  const photo = (over: Record<string, unknown> = {}) =>
    rowFromWire(
      {
        kind: "photo",
        assetId: "p1",
        imageUrl: "i",
        thumbUrl: "t",
        origin: "upload",
        ...over,
      } as never,
      label,
    );

  /** ⚠️ MUTATION "the picker labels an untagged row with a subject": default `tagged` to false, or keep the subject on an unread row — reds. */
  it("an unread row is 'Not read yet' with no subject; an older server's row is read, with nothing to say", () => {
    const unread = photo({
      tagged: false,
      subject: "the_athlete",
      shotType: "portrait",
    });
    expect(unread).toMatchObject({
      tagged: false,
      subject: null,
      shot: null,
      reject: false,
    });
    expect(tileLabel(unread, true)).toBe("Not read yet");
    const older = photo();
    expect(older).toMatchObject({
      tagged: true,
      subject: null,
      shot: null,
      reject: false,
    });
    expect(tileLabel(older, true)).toBeNull();
  });

  it("who and the shot, in her words — and nothing at all with the flag off, or on a clip", () => {
    const her = photo({
      tagged: true,
      subject: "the_athlete",
      shotType: "text_graphic",
    });
    expect(tileLabel(her, true)).toBe("You · text graphic");
    expect(
      tileLabel(
        photo({ tagged: true, subject: "another_person", shotType: "group" }),
        true,
      ),
    ).toBe("Someone else · group");
    expect(
      tileLabel(
        photo({ tagged: true, subject: "nobody", shotType: null }),
        true,
      ),
    ).toBe("No one");
    expect(tileLabel(her, false)).toBeNull();
    const clip = rowFromWire(
      {
        kind: "clip",
        assetId: "c1",
        videoUrl: "v",
        posterUrl: null,
        durationSec: 3,
        durationPreciseSec: null,
        origin: "upload",
      },
      label,
    );
    expect(tileLabel(clip, true)).toBeNull();
  });

  /** ⚠️ MUTATION "picker hides or unlabels a reject-disposition photo": return null on a reject — reds. */
  it("a reject is offered and SAYS so — 'not usable' rides after who and the shot", () => {
    const reject = photo({
      tagged: true,
      subject: "the_athlete",
      shotType: "portrait",
      reject: true,
    });
    expect(reject.kind === "photo" && reject.reject).toBe(true);
    expect(tileLabel(reject, true)).toBe("You · portrait · not usable");
    expect(tileLabel(photo({ tagged: true, reject: true }), true)).toBe(
      "not usable",
    );
  });

  /** ⚠️ MUTATION "a video row with subject=another_person shows You": in rowFromWire's clip arm, drop the facts — the clip label reds by name. */
  it("a clip is labelled off its poster tag like a photo — someone else stays someone else; a bare clip says nothing (ruling 24 Sep)", () => {
    const wire = {
      kind: "clip",
      assetId: "c1",
      videoUrl: "v",
      posterUrl: null,
      durationSec: 3,
      durationPreciseSec: null,
      origin: "upload",
    } as const;
    expect(
      tileLabel(
        rowFromWire(
          {
            ...wire,
            tagged: true,
            subject: "another_person",
            shotType: "action",
          },
          label,
        ),
        true,
      ),
    ).toBe("Someone else · action");
    expect(
      tileLabel(rowFromWire({ ...wire, tagged: false }, label), true),
    ).toBe("Not read yet");
    expect(
      tileLabel(
        rowFromWire(
          {
            ...wire,
            tagged: true,
            subject: "the_athlete",
            shotType: "portrait",
            reject: true,
          },
          label,
        ),
        true,
      ),
    ).toBe("You · portrait · not usable");
    expect(tileLabel(rowFromWire(wire, label), true)).toBeNull();
  });

  /** ⚠️ MUTATION "a made-here still with no person reference shows You": drop the madeHereNotHer arm in tileLabel — reds by name. */
  it("a made-here row whose job carried no photo of her says so, whatever the tag says — on a photo and on a clip (ruling 24 Sep)", () => {
    expect(
      tileLabel(
        photo({
          tagged: true,
          subject: "the_athlete",
          shotType: "action",
          madeHereNotHer: true,
        }),
        true,
      ),
    ).toBe("Made here · not from you");
    expect(
      tileLabel(
        photo({
          tagged: true,
          subject: "the_athlete",
          shotType: "action",
          madeHereNotHer: true,
          reject: true,
        }),
        true,
      ),
    ).toBe("Made here · not from you · not usable");
    expect(
      tileLabel(photo({ tagged: false, madeHereNotHer: true }), true),
    ).toBe("Made here · not from you");
    const wire = {
      kind: "clip",
      assetId: "c1",
      videoUrl: "v",
      posterUrl: null,
      durationSec: 3,
      durationPreciseSec: null,
      origin: "upload",
    } as const;
    expect(
      tileLabel(
        rowFromWire(
          {
            ...wire,
            tagged: true,
            subject: "the_athlete",
            shotType: "action",
            madeHereNotHer: true,
          },
          label,
        ),
        true,
      ),
    ).toBe("Made here · not from you");
    // Made here FROM her, or an upload: the tag speaks.
    expect(
      tileLabel(
        photo({
          tagged: true,
          subject: "the_athlete",
          shotType: "action",
          madeHereNotHer: false,
        }),
        true,
      ),
    ).toBe("You · action");
    expect(
      tileLabel(
        photo({ tagged: true, subject: "the_athlete", shotType: "action" }),
        true,
      ),
    ).toBe("You · action");
  });

  /** ⚠️ MUTATION "stale cursor strands the picker": return false — the hook never restarts. */
  it("a 400 on the cursor we sent is stale; a first page's 400, or any other field, is an ordinary error", () => {
    expect(isStaleCursor(400, { field: "cursor" }, "abc")).toBe(true);
    expect(isStaleCursor(400, { field: "cursor" }, null)).toBe(false);
    expect(isStaleCursor(400, { field: "limit" }, "abc")).toBe(false);
    expect(isStaleCursor(500, { field: "cursor" }, "abc")).toBe(false);
    expect(isStaleCursor(400, null, "abc")).toBe(false);
  });
});
