/**
 * The interpreter, client side (the interpreter, I.6): which asks travel to the preview as an edit of her
 * frame, what the card's tags say, and the ad asks' copy — the server's own lines, word for word.
 *
 * The property asserted hardest: an ask becomes an edit ONLY when the server said the preview may
 * interpret it, the flag is on, and she has a frame. Every other ask is exactly today's ask, and an
 * interpreted sentence is never a generate.
 */
// The server's freeze module reads the database at brief assembly; this suite only reads its copy.
jest.mock("../../server/db", () => ({
  db: {},
  pool: { end: async () => {}, on: () => {} },
}));

import { freezeRefusalNote } from "../../server/studio/nativeIntent";
import type { StudioClassification } from "../hooks/use-studio";
import {
  askCopyFor,
  engineIntentFor,
  lineTagFor,
  previewCard,
  routeWithServer,
  type Attachment,
} from "./studio-contract";

const frame = (assetId: string | null = "base"): Attachment => ({
  id: `f:${assetId}`,
  role: "source-frame",
  name: "her.jpg",
  uri: null,
  assetId,
});

const ask = (
  over: Partial<StudioClassification> = {},
): StudioClassification => ({
  op: null,
  targets: [],
  initialPath: "ASK",
  steps: [],
  reason: "brand_change",
  ...over,
});

const S = "switch my jersey over to adidas";

describe("routeWithServer — an ask the interpreter may take", () => {
  it("goes to the preview as an edit of her frame, asking nothing here", () => {
    const out = routeWithServer(
      "photo",
      ask({ interpretable: true }),
      S,
      [frame()],
      null,
      true,
    );
    expect(out).toEqual({
      intent: "image.edit",
      editBase: frame(),
      askReason: null,
      interpreting: true,
    });
  });

  it("uses the frame she MARKED, not the first photo", () => {
    const out = routeWithServer(
      "photo",
      ask({ interpretable: true }),
      S,
      [frame("first"), frame("marked")],
      "marked",
      true,
    );
    expect(out.editBase?.assetId).toBe("marked");
  });

  it("is today's ask with the flag off, when the server said no, or from a server that never says", () => {
    const today = {
      intent: engineIntentFor("photo", S, [frame()]),
      editBase: null,
      askReason: "brand_change",
    };
    for (const [c, flag] of [
      [ask({ interpretable: true }), false],
      [ask({ interpretable: false }), true],
      [ask(), true],
    ] as const) {
      const out = routeWithServer("photo", c, S, [frame()], null, flag);
      expect(out).toMatchObject(today);
      expect("interpreting" in out).toBe(false);
    }
    // And a caller that never passes the flag.
    expect(
      "interpreting" in
        routeWithServer("photo", ask({ interpretable: true }), S, [frame()]),
    ).toBe(false);
  });

  it("never interprets without a frame — and never turns an interpreted sentence into a generate", () => {
    const out = routeWithServer(
      "photo",
      ask({ interpretable: true }),
      S,
      [],
      null,
      true,
    );
    expect(out.askReason).toBe("brand_change");
    expect("interpreting" in out).toBe(false);
  });

  it("never reaches the classifier for motion", () => {
    expect(
      routeWithServer(
        "video",
        ask({ interpretable: true }),
        S,
        [frame()],
        null,
        true,
      ),
    ).toEqual({ intent: "video.generate", editBase: null, askReason: null });
  });
});

describe("the card's tags", () => {
  it("says where each line came from, in her language", () => {
    expect(lineTagFor("yours")).toBe("your words");
    expect(lineTagFor("suggested")).toBe("our suggestion");
    expect(lineTagFor("brand")).toBe("required by the brand");
    expect(lineTagFor(null)).toBeNull();
  });
});

describe("which card a preview shows, and whether it can be refused (I.6; A3b)", () => {
  const LOOK = {
    kind: "change" as const,
    text: "Make it warmer",
    source: "yours" as const,
  };
  const KEEP = {
    kind: "constraint" as const,
    text: "Keep your face, hair, body and pose as they are",
    source: "yours" as const,
  };

  it("shows the interpreter's card with 'Not what I meant' — a reading she can take back", () => {
    expect(
      previewCard({ interpretation: { lines: [LOOK, KEEP] }, card: null }),
    ).toEqual({ lines: [LOOK, KEEP], refusable: true });
  });

  it("shows the rules' card when her keep froze beside their steps — the same lines, and nothing to refuse", () => {
    expect(
      previewCard({ interpretation: null, card: { lines: [LOOK, KEEP] } }),
    ).toEqual({ lines: [LOOK, KEEP], refusable: false });
  });

  it("shows no card on every other preview, exactly as before", () => {
    expect(previewCard({ interpretation: null, card: null })).toBeNull();
    expect(
      previewCard({ interpretation: { lines: [] }, card: { lines: [] } }),
    ).toBeNull();
  });
});

describe("the ad's asks — the server's own lines, word for word", () => {
  it("says the same thing on the blocked preview and wherever a screen renders the code", () => {
    for (const code of [
      "ad_needs_brand",
      "ad_brand_mismatch",
      "ad_too_many_changes",
    ]) {
      const server = freezeRefusalNote({
        ok: false,
        reason: "not_routed",
        askReason: code,
      });
      expect({ code, client: askCopyFor(code) }).toEqual({
        code,
        client: server,
      });
      expect(server).not.toContain("_");
    }
  });

  it("tells her WHERE to name a brand — Create anything has no picker (M5)", () => {
    expect(askCopyFor("ad_needs_brand")).toMatch(/Brand post/);
    expect(askCopyFor("ad_needs_brand")).not.toBe(
      askCopyFor("fast_path_declined"),
    );
  });
});
