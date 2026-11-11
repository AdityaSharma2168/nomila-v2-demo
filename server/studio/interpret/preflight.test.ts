/**
 * preflight.test.ts — R1's preflight names the field Vertex refuses, instead of a bare 400 (the
 * interpreter, I.3). `send` is a stand-in that refuses on one field at a time; no model is called.
 */
import {
  DETECTION_CONFIG,
  preflight,
  variantsOf,
  wireLines,
  type Send,
  type WireRequest,
} from "./preflight";

const DETECTION_MODEL = "gemini-3.5-flash";

/** interpret/1's wire, as R1 sent it on 2026-09-14 — the request Vertex refused. */
const INTERPRET_1 = {
  model: "gemini-3.5-flash",
  contents: [],
  config: {
    responseMimeType: "application/json",
    responseJsonSchema: { type: "object" },
    temperature: 0,
    thinkingConfig: { thinkingLevel: "MINIMAL", includeThoughts: false },
  },
} as unknown as WireRequest;

/** A Vertex that refuses any request carrying `refuses`. */
const refusing = (
  refuses: (p: WireRequest) => boolean,
): Send<string> & { sent: WireRequest[] } => {
  const sent: WireRequest[] = [];
  const send = (async (p: WireRequest) => {
    sent.push(p);
    return refuses(p)
      ? {
          ok: false as const,
          error:
            '400 INVALID_ARGUMENT {"error":{"message":"the whole answer"}}',
        }
      : { ok: true as const, value: "{}" };
  }) as Send<string> & { sent: WireRequest[] };
  send.sent = sent;
  return send;
};

const has = (p: WireRequest, k: string) =>
  k in (p.config as Record<string, unknown>);

describe("the preflight names the field Vertex refuses", () => {
  it("names the schema when the schema is what is refused — interpret/1's own wire", async () => {
    const send = refusing((p) => has(p, "responseJsonSchema"));
    const r = await preflight(INTERPRET_1, DETECTION_MODEL, send);
    expect(r).toMatchObject({
      kind: "named",
      field: "config.responseJsonSchema",
      calls: 2,
    });
    expect(r.kind === "named" && r.error).toContain("the whole answer");
  });

  it("names the thinking config when that is what is refused, past a field that is not", async () => {
    const send = refusing((p) => has(p, "thinkingConfig"));
    const r = await preflight(INTERPRET_1, DETECTION_MODEL, send);
    expect(r).toMatchObject({
      kind: "named",
      field: "config.thinkingConfig",
      calls: 3,
    });
    expect(r.kind === "named" && r.tried.map((t) => t.field)).toEqual([
      "config.responseJsonSchema",
    ]);
  });

  it("names the model id when detection's model is accepted and ours is not", async () => {
    const product = { ...INTERPRET_1, model: "gemini-9-flash" } as WireRequest;
    const send = refusing((p) => p.model !== DETECTION_MODEL);
    expect(await preflight(product, DETECTION_MODEL, send)).toMatchObject({
      kind: "named",
      field: "model",
    });
  });

  it("says so when even detection's request shape is refused — the difference is not in the config", async () => {
    const send = refusing(() => true);
    const r = await preflight(INTERPRET_1, DETECTION_MODEL, send);
    expect(r.kind).toBe("unnamed");
    expect(send.sent.at(-1)?.config).toEqual(DETECTION_CONFIG);
  });

  it("sends the product's request once and nothing else when it is accepted", async () => {
    const send = refusing(() => false);
    expect(await preflight(INTERPRET_1, DETECTION_MODEL, send)).toEqual({
      kind: "accepted",
      value: "{}",
      calls: 1,
    });
    expect(send.sent).toHaveLength(1);
  });
});

describe("the wire, beside detection's", () => {
  it("marks every field that differs, and only those", () => {
    const lines = wireLines(INTERPRET_1, DETECTION_MODEL);
    const marked = lines
      .filter((l) => l.includes("← differs"))
      .map((l) => l.split(" ")[0]);
    expect(marked).toEqual([
      "config.responseJsonSchema",
      "config.thinkingConfig",
    ]);
  });

  it("walks back one field at a time, then the model, then detection's whole shape", () => {
    expect(
      variantsOf(
        { ...INTERPRET_1, model: "other" } as WireRequest,
        DETECTION_MODEL,
      ).map((v) => v.field),
    ).toEqual([
      "config.responseJsonSchema",
      "config.thinkingConfig",
      "model",
      "every differing field at once (detection's request shape)",
    ]);
  });
});
