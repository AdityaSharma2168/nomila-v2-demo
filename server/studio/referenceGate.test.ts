/**
 * referenceGate.test — the casting law at the reference door (PR 12, R-5), as a table.
 *
 * ⚠️ MUTATIONS, each red by name:
 *   "an unclassified image reaches a generation call"      — likenessDecision returns null for an unread row
 *   "a no-face photo is accepted as a person likeness ref"  — drop the face arm
 *   "an old row without face_visibility is refused"         — read vision.face_visibility raw (no faceOf fallback)
 */
import {
  likenessDecision,
  madeHereNotHer,
  readStateOf,
  REFERENCE_REFUSAL_COPY,
  unreadRefusal,
} from "./referenceGate";

const read = (vision: Record<string, unknown>) => ({ vision });
const pending = null;
const failed = {
  enrichment: {
    abandoned_at: "2026-09-23T00:00:00Z",
    abandoned_reason: "oversize",
  },
};
const capped = {
  enrichment: {
    abandoned_at: "2026-09-23T00:00:00Z",
    abandoned_reason: "attempts",
  },
};

describe("read state — why a row is unread, in three words", () => {
  it("read / pending / failed / capped", () => {
    expect(readStateOf(read({ subject: "the_athlete" }))).toBe("read");
    expect(readStateOf(pending)).toBe("pending");
    expect(readStateOf({})).toBe("pending");
    expect(readStateOf({ enrichment: { attempts: 2 } })).toBe("pending"); // mid-backoff is still pending
    expect(readStateOf(failed)).toBe("failed");
    expect(readStateOf(capped)).toBe("capped");
  });

  it("each unread state has its own reason and its own sentence", () => {
    expect(unreadRefusal(pending)).toBe("reference_unread");
    expect(unreadRefusal(failed)).toBe("reference_read_failed");
    expect(unreadRefusal(capped)).toBe("reference_read_capped");
    expect(unreadRefusal(read({ subject: "nobody" }))).toBeNull();
    const copies = new Set(Object.values(REFERENCE_REFUSAL_COPY));
    expect(copies.size).toBe(5);
  });
});

describe("likenessDecision — the gate as a table", () => {
  /** ⚠️ MUTATION "an unclassified image reaches a generation call": return null for an unread row. */
  it("an unread photo is not a person or product reference — by its read state", () => {
    expect(likenessDecision(pending, "person")).toBe("reference_unread");
    expect(likenessDecision(pending, "product")).toBe("reference_unread");
    expect(likenessDecision(failed, "person")).toBe("reference_read_failed");
    expect(likenessDecision(capped, "product")).toBe("reference_read_capped");
  });

  it("an object reference is a thing she pointed at — the tagger has nothing to say, read or not", () => {
    expect(likenessDecision(pending, "object")).toBeNull();
    expect(
      likenessDecision(
        read({ subject: "the_athlete", face_visibility: "none" }),
        "object",
      ),
    ).toBeNull();
  });

  /** ⚠️ MUTATION "a no-face photo is accepted as a person likeness ref": drop the face arm. */
  it("no face, no likeness — a person reference with face_visibility none is refused; a product one is not", () => {
    const noFace = read({
      subject: "the_athlete",
      face_visibility: "none",
      role: "identity",
    });
    expect(likenessDecision(noFace, "person")).toBe("likeness_no_face");
    expect(likenessDecision(noFace, "product")).toBeNull();
    expect(
      likenessDecision(
        read({ subject: "the_athlete", face_visibility: "partial" }),
        "person",
      ),
    ).toBeNull();
    expect(
      likenessDecision(
        read({ subject: "the_athlete", face_visibility: "clear" }),
        "person",
      ),
    ).toBeNull();
  });

  /** ⚠️ MUTATION "an old row without face_visibility is refused": read the key raw. */
  it("a row with other lanes' keys beside vision — clip_read (PR 9.5), enrich_spend, embedding — is judged on vision alone", () => {
    const video = {
      vision: { subject: "the_athlete", face_visibility: "partial", beats: [] },
      clip_read: {
        state: "done",
        at: "2026-09-23T00:00:00Z",
        quotedUsd: 0.01,
        billedUsd: 0.01,
      },
      enrich_spend: { day: "2026-09-23", usd: 0.01 },
      embedding: [1, 0, 0],
    };
    expect(likenessDecision(video, "person")).toBeNull();
    expect(readStateOf(video)).toBe("read");
    // A clip mid-read with no vision yet is pending — its clip_read mark does not make it read.
    expect(
      likenessDecision(
        {
          clip_read: {
            state: "reading",
            startedAt: "2026-09-23T00:00:00Z",
            quotedUsd: 0.01,
          },
        },
        "person",
      ),
    ).toBe("reference_unread");
  });

  it("an old row — tagged before face_visibility existed — is accepted as a likeness on what it does say (R-3)", () => {
    expect(
      likenessDecision(read({ subject: "the_athlete" }), "person"),
    ).toBeNull();
    expect(
      likenessDecision(
        read({ athlete_present: true, description: "she runs" }),
        "person",
      ),
    ).toBeNull(); // pre-ternary
    // …and a row that says nobody / someone else is there has no face OF HERS to lend.
    expect(likenessDecision(read({ subject: "nobody" }), "person")).toBe(
      "likeness_no_face",
    );
    expect(
      likenessDecision(read({ subject: "another_person" }), "person"),
    ).toBe("likeness_no_face");
  });
});

describe("rule 3 — made here without her is not her (ruling 24 Sep 2026)", () => {
  const her = read({
    subject: "the_athlete",
    face_visibility: "clear",
    role: "identity",
  });

  it("madeHereRefuses false (the generation door, ADI-R19-BOARD3) lets a made-here row through as a likeness; unread still refuses", () => {
    const made = { origin: "generated", identityBound: false } as const;
    expect(
      likenessDecision(her, "person", made, { madeHereRefuses: false }),
    ).toBeNull();
    // The default — every other caller, the identity pack's included — is rule 3 as before (the test below).
    expect(likenessDecision(her, "person", made)).toBe("likeness_not_from_her");
    // Only rule 3 moves: an unread photo is still refused.
    expect(
      likenessDecision(null, "person", made, { madeHereRefuses: false }),
    ).toBe("reference_unread");
  });

  /** ⚠️ MUTATION "a made-here still with no person reference is accepted as a likeness reference": drop rule 3 in likenessDecision — the first two red. */
  it("a generated row whose job carried no person reference is refused as a likeness, whatever the tag says — and not as a product", () => {
    expect(
      likenessDecision(her, "person", {
        origin: "generated",
        identityBound: false,
      }),
    ).toBe("likeness_not_from_her");
    expect(
      likenessDecision(read({ subject: "the_athlete" }), "person", {
        origin: "generated",
        identityBound: false,
      }),
    ).toBe("likeness_not_from_her");
    expect(
      likenessDecision(her, "product", {
        origin: "generated",
        identityBound: false,
      }),
    ).toBeNull();
    expect(
      likenessDecision(her, "object", {
        origin: "generated",
        identityBound: false,
      }),
    ).toBeNull();
  });

  it("a generated row FROM her passes; an upload is never 'made here'; an unknown job is unknown, not refused", () => {
    expect(
      likenessDecision(her, "person", {
        origin: "generated",
        identityBound: true,
      }),
    ).toBeNull();
    expect(
      likenessDecision(her, "person", {
        origin: "upload",
        identityBound: false,
      }),
    ).toBeNull();
    expect(
      likenessDecision(her, "person", {
        origin: "generated",
        identityBound: null,
      }),
    ).toBeNull();
    expect(likenessDecision(her, "person")).toBeNull();
    expect(madeHereNotHer({ origin: "generated", identityBound: false })).toBe(
      true,
    );
    expect(madeHereNotHer({ origin: "generated", identityBound: null })).toBe(
      false,
    );
    expect(madeHereNotHer(null)).toBe(false);
  });

  it("rule 3 outranks the face rule, and an unread row is still unread first", () => {
    expect(
      likenessDecision(
        read({ subject: "the_athlete", face_visibility: "none" }),
        "person",
        { origin: "generated", identityBound: false },
      ),
    ).toBe("likeness_not_from_her");
    expect(
      likenessDecision(pending, "person", {
        origin: "generated",
        identityBound: false,
      }),
    ).toBe("reference_unread");
  });
});

describe("PR 19 (ADI-R19-FACE): the face arm, switchable at the reference door", () => {
  const noFace = {
    vision: {
      subject: "the_athlete",
      athlete_present: true,
      face_visibility: "none",
    },
  };
  it("faceRejects false lets an unclear face through; the default refuses as before; not-from-her refuses either way", () => {
    expect(likenessDecision(noFace, "person")).toBe("likeness_no_face");
    expect(
      likenessDecision(noFace, "person", null, { faceRejects: false }),
    ).toBeNull();
    expect(
      likenessDecision(
        noFace,
        "person",
        { origin: "generated", identityBound: false },
        { faceRejects: false },
      ),
    ).toBe("likeness_not_from_her");
    // Unread still refuses.
    expect(likenessDecision(null, "person", null, { faceRejects: false })).toBe(
      "reference_unread",
    );
  });
});
