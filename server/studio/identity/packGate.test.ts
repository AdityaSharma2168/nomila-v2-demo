/**
 * packGate.test — who may be in her pack (PR 17, R-2), and every refusal by name.
 *
 * REVERT CHECKS, red by name:
 *   "pack accepts a photo with no face"  → drop the likenessDecision call in packDecision
 *   "pack accepts a generated photo"     → drop the origin arm
 *   "pack accepts someone else"          → drop the subject arm
 */
import {
  packDecision,
  selectPack,
  PACK_REFUSAL_COPY,
  type PackCandidateRow,
} from "./packGate";
import { PACK_MAX, PACK_MIN } from "./types";

const her = (
  id: string,
  over: Partial<{
    origin: string;
    face: string | undefined;
    subject: string | undefined;
    present: boolean;
    disposition: string;
    prominence: number;
    vision: false;
    shot: string;
  }> = {},
): PackCandidateRow => ({
  assetId: id,
  origin: over.origin ?? "upload",
  metadata:
    over.vision === false
      ? {}
      : {
          vision: {
            ...(over.subject === undefined && !("subject" in over)
              ? { subject: "the_athlete" }
              : over.subject !== undefined
                ? { subject: over.subject }
                : {}),
            athlete_present: over.present ?? true,
            athlete_prominence: over.prominence ?? 0.9,
            disposition: over.disposition ?? "as_is",
            shot_type: over.shot ?? "portrait",
            ...("face" in over
              ? over.face !== undefined
                ? { face_visibility: over.face }
                : {}
              : { face_visibility: "clear" }),
          },
        },
});

describe("packDecision — one photograph, judged", () => {
  it("accepts a clear-faced, non-generated photo of her", () => {
    const d = packDecision(her("a"));
    expect(d.refusal).toBeNull();
    expect(d.entry).toEqual({
      assetId: "a",
      faceSizeFrac: null,
      prominence: 0.9,
      faceVisibility: "clear",
      shotType: "portrait",
    });
  });

  it("pack accepts a photo with no face — REFUSED, likeness_no_face", () => {
    expect(packDecision(her("a", { face: "none" })).refusal).toBe(
      "likeness_no_face",
    );
  });

  it("pack accepts a generated photo — REFUSED, generated", () => {
    expect(packDecision(her("a", { origin: "generated" })).refusal).toBe(
      "generated",
    );
  });

  it("pack accepts a made-here-without-her still — REFUSED as generated, by the origin arm, before #584's rule 3", () => {
    // identity_bound false is what #584 keys rule 3 on; the pack gate never consults it because
    // origin refuses first. Drop the origin arm and this reds beside "pack accepts a generated photo".
    const d = packDecision({
      ...her("a", { origin: "generated" }),
      identityBound: false,
    } as never);
    expect(d.refusal).toBe("generated");
    expect(d.refusal).not.toBe("likeness_not_from_her");
  });

  it("pack accepts someone else — REFUSED, not_you", () => {
    expect(packDecision(her("a", { subject: "another_person" })).refusal).toBe(
      "not_you",
    );
    expect(packDecision(her("a", { subject: "nobody" })).refusal).toBe(
      "not_you",
    );
  });

  it("refuses a reject-disposition photo, by name", () => {
    expect(packDecision(her("a", { disposition: "reject" })).refusal).toBe(
      "rejected",
    );
  });

  it("refuses an unread photo through PR 12's gate, with PR 12's reason", () => {
    expect(packDecision(her("a", { vision: false })).refusal).toBe(
      "reference_unread",
    );
  });

  it("a partial face is a fill-in, not an accept: face_partial WITH an entry", () => {
    const d = packDecision(her("a", { face: "partial" }));
    expect(d.refusal).toBe("face_partial");
    expect(d.entry?.faceVisibility).toBe("partial");
  });

  it("an old row without face_visibility but tagged as her reads as partial (PR 12 R-3 fallback)", () => {
    const d = packDecision(her("a", { face: undefined }));
    expect(d.refusal).toBe("face_partial");
  });

  it("every refusal has copy that names the reason", () => {
    for (const [k, v] of Object.entries(PACK_REFUSAL_COPY)) {
      expect(typeof v).toBe("string");
      expect(v.length).toBeGreaterThan(20);
      expect(k).not.toBe("");
    }
  });

  it("each of the four gate reasons is distinct", () => {
    const reasons = [
      packDecision(her("a", { face: "none" })).refusal,
      packDecision(her("b", { origin: "generated" })).refusal,
      packDecision(her("c", { subject: "another_person" })).refusal,
      packDecision(her("d", { disposition: "reject" })).refusal,
    ];
    expect(new Set(reasons).size).toBe(4);
  });
});

describe("selectPack — her order, clear first, partial only to fill", () => {
  const ids = (n: number, prefix = "c") =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it("twelve clear photos make a complete pack of twelve, in her order", () => {
    const sel = selectPack(ids(12).map((id) => her(id)));
    expect(sel.pack.map((e) => e.assetId)).toEqual(ids(12));
    expect(sel.incomplete).toBe(false);
    expect(sel.partialAdmitted).toBe(false);
    expect(sel.refused).toEqual([]);
  });

  it("with fewer than PACK_MIN clear faces, partial ones fill up to PACK_MIN and the profile says so", () => {
    const rows = [
      ...ids(7).map((id) => her(id)),
      ...ids(6, "p").map((id) => her(id, { face: "partial" })),
    ];
    const sel = selectPack(rows);
    expect(sel.pack).toHaveLength(PACK_MIN);
    expect(sel.pack.slice(7).every((e) => e.faceVisibility === "partial")).toBe(
      true,
    );
    expect(sel.partialAdmitted).toBe(true);
    expect(
      sel.refused.filter((r) => r.refusal === "face_partial"),
    ).toHaveLength(3);
  });

  it("with PACK_MIN clear faces, no partial one is admitted", () => {
    const rows = [
      ...ids(10).map((id) => her(id)),
      her("p0", { face: "partial" }),
    ];
    const sel = selectPack(rows);
    expect(sel.pack.every((e) => e.faceVisibility === "clear")).toBe(true);
    expect(sel.partialAdmitted).toBe(false);
    expect(sel.refused).toEqual([{ assetId: "p0", refusal: "face_partial" }]);
  });

  it("caps at PACK_MAX and names what did not fit", () => {
    const sel = selectPack(ids(18).map((id) => her(id)));
    expect(sel.pack).toHaveLength(PACK_MAX);
    expect(sel.overCap).toEqual(["c15", "c16", "c17"]);
  });

  it("fewer than PACK_MIN in total is saved as incomplete", () => {
    const sel = selectPack(ids(4).map((id) => her(id)));
    expect(sel.pack).toHaveLength(4);
    expect(sel.incomplete).toBe(true);
  });

  it("refused rows are named beside the accepted ones, never silently dropped", () => {
    const sel = selectPack([
      her("ok"),
      her("gen", { origin: "generated" }),
      her("them", { subject: "another_person" }),
    ]);
    expect(sel.pack.map((e) => e.assetId)).toEqual(["ok"]);
    expect(sel.refused).toEqual([
      { assetId: "gen", refusal: "generated" },
      { assetId: "them", refusal: "not_you" },
    ]);
  });
});

describe("the body-shot nudge (walk-driven amendment to R-3)", () => {
  const ids = (n: number, prefix = "c") =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it("pack saves silently with no body shot — a pack of close-ups saves AND says so", () => {
    const sel = selectPack(ids(12).map((id) => her(id)));
    expect(sel.pack).toHaveLength(12);
    expect(sel.noBodyShot).toBe(true);
  });

  it("one action or lifestyle shot clears the nudge; an empty pack does not nudge", () => {
    expect(
      selectPack([
        ...ids(11).map((id) => her(id)),
        her("a", { shot: "action" }),
      ]).noBodyShot,
    ).toBe(false);
    expect(
      selectPack([
        ...ids(11).map((id) => her(id)),
        her("l", { shot: "lifestyle" }),
      ]).noBodyShot,
    ).toBe(false);
    expect(selectPack([]).noBodyShot).toBe(false);
  });

  it("the entry carries the tagger's shot_type word, null on an old row", () => {
    expect(packDecision(her("a", { shot: "action" })).entry?.shotType).toBe(
      "action",
    );
    const old = her("b");
    delete (
      (old.metadata as { vision: Record<string, unknown> }).vision as Record<
        string,
        unknown
      >
    ).shot_type;
    expect(packDecision(old).entry?.shotType).toBeNull();
  });
});
