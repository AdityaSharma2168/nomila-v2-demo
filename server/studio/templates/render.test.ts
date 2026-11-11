/**
 * render.test.ts — the `studio-template/1` envelope (quality-scrappy piece 4, ADI-QS-GO R1): what renders, and every
 * reason a published body falls back to the TS literal — each with its own test and its own warning line.
 *
 * ⚠️ MUTATIONS (docs/probes/quality-scrappy.md):
 *   M4a — the required-placeholder check dropped: "a template without {{direction}} falls back to the literal" reds.
 *   M4b — the blank-line collapse dropped: "an absent piece leaves no blank paragraph" reds.
 *   M8b — the tidying moved back AFTER the pieces are put in (piece 4's order): "her words are never tidied" reds.
 *   M8c — an empty sentence-level piece keeps its space: "an absent sentence leaves no double space" reds.
 */
const warn = jest.fn();
jest.mock("../../logger", () => ({
  createLogger: () => ({
    warn,
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import {
  REGISTRY_TEMPLATES,
  TEMPLATE_FORMAT,
  parseEnvelope,
  registryTemplateOn,
  renderTemplate,
  type FrozenTemplate,
} from "./render";

const META = {
  model_target: "veo-3.1-generate-001",
  provider: "vertex",
  dialect: null,
  asset_slots: ["frame"],
  allowed_params: ["generateAudio"],
  avoid: [],
  rubric_id: null,
};
const envelope = (
  template: string,
  meta: Record<string, unknown> = META,
  format = TEMPLATE_FORMAT,
) => JSON.stringify({ format, meta, template });
const frozen = (body: string): FrozenTemplate => ({
  key: "studio.video.identity-static",
  source: "registry",
  version: 3,
  hash: "abc123def456",
  body,
});
const PIECES = {
  opening: "OPEN.",
  direction: "DIRECTION: hers.",
  carrier: "",
  camera: "CAMERA.",
  preservation: "KEEP HER.",
  discipline: "NO SCREENS.",
};
const render = (body: string) =>
  renderTemplate(frozen(body), "studio.video.identity-static", () => PIECES);

beforeEach(() => warn.mockClear());

describe("a usable envelope renders from the literal's own pieces", () => {
  it("places each piece where the template puts it", () => {
    const r = render(
      envelope(
        "{{preservation}}\n\n{{opening}} {{direction}}\n\n{{camera}}\n\n{{discipline}}",
      ),
    );
    expect(r?.prompt).toBe(
      "KEEP HER.\n\nOPEN. DIRECTION: hers.\n\nCAMERA.\n\nNO SCREENS.",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("an absent piece leaves no blank paragraph", () => {
    const r = render(
      envelope(
        "{{opening}}\n\n{{carrier}}\n\n{{direction}}\n\n{{preservation}}",
      ),
    );
    expect(r?.prompt).toBe("OPEN.\n\nDIRECTION: hers.\n\nKEEP HER.");
  });

  // quality-scrappy piece 8 found this in piece 4's renderer: it tidied AFTER her words were put in, so a direction with
  // three newlines or a trailing space came back different from the literal. The tidying is the TEMPLATE's now.
  it("her words are never tidied — three newlines and a trailing space in a piece come back exactly", () => {
    const hers = "DIRECTION: first line   \n\n\n\nsecond line  ";
    const r = renderTemplate(
      frozen(envelope("{{opening}}\n\n{{direction}}\n\n{{preservation}}")),
      "studio.video.identity-static",
      () => ({ ...PIECES, direction: hers }),
    );
    expect(r?.prompt).toBe(`OPEN.\n\n${hers}\n\nKEEP HER.`);
  });

  it("an absent sentence leaves no double space — a native edit's instruction paragraph (piece 8)", () => {
    const r = renderTemplate(
      frozen(
        envelope(
          "{{references}}\n\n{{clause}} {{text}} {{scope}} {{preservation}} {{framing}} {{keep}} {{aspect}}\n\n{{style}}\n\n{{donts}}",
          { ...META, model_target: "gemini-3-pro-image" },
        ),
      ),
      "studio.image.edit.recolor",
      () => ({
        references: "",
        clause: "make the shorts black.",
        text: "",
        scope: "Keep everything else exactly as-is — change only the shorts.",
        preservation: "Keep the light.",
        framing: "",
        keep: "",
        aspect: "",
        style: "",
        donts: "",
      }),
    );
    expect(r?.prompt).toBe(
      "make the shorts black. Keep everything else exactly as-is — change only the shorts. Keep the light.",
    );
  });

  it("a headline face (meta.font, piece 8) is a non-empty string or absent — anything else is bad_meta", () => {
    for (const font of ["", "  ", 12, null])
      expect(
        parseEnvelope(
          "studio.image.edit.display_text",
          envelope(
            "{{references}} {{clause}} {{text}} {{scope}} {{aspect}} {{donts}}",
            { ...META, font },
          ),
        ),
      ).toMatchObject({ ok: false, reason: "bad_meta" });
    expect(
      parseEnvelope(
        "studio.image.edit.display_text",
        envelope(
          "{{references}} {{clause}} {{text}} {{scope}} {{aspect}} {{donts}}",
          { ...META, font: "Futura Bold" },
        ),
      ),
    ).toMatchObject({ ok: true, meta: { font: "Futura Bold" } });
  });

  it("returns the envelope's metadata beside the prompt", () => {
    expect(render(envelope("{{direction}} {{preservation}}"))?.meta).toEqual(
      META,
    );
  });
});

describe("every fallback reason: the literal is used, and a warning says why", () => {
  const cases: [string, string, string][] = [
    ["not_json", "this is not json", "not_json"],
    [
      "wrong_format",
      envelope("{{direction}} {{preservation}}", META, "studio-template/9"),
      "wrong_format",
    ],
    [
      "no_template",
      JSON.stringify({ format: TEMPLATE_FORMAT, meta: META, template: "  " }),
      "no_template",
    ],
    [
      "bad_meta",
      envelope("{{direction}} {{preservation}}", { ...META, avoid: "rain" }),
      "bad_meta",
    ],
    [
      "dialect_mismatch",
      envelope("{{direction}} {{preservation}}", {
        ...META,
        dialect: "seedance",
      }),
      "dialect_mismatch",
    ],
    [
      "unknown_placeholder",
      envelope("{{direction}} {{preservation}} {{athlete_name}}"),
      "unknown_placeholder",
    ],
  ];
  it.each(cases)("%s", (_n, body, reason) => {
    expect(render(body)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({
      reason,
      version: 3,
      hash: "abc123def456",
    });
  });

  it("a template without {{direction}} falls back to the literal", () => {
    expect(render(envelope("{{opening}} {{preservation}}"))).toBeNull();
    expect(warn.mock.calls[0][0]).toMatchObject({
      reason: "missing_placeholder",
      detail: "direction",
    });
  });

  it("a 'her' template without its preservation clause falls back to the literal", () => {
    expect(render(envelope("{{opening}} {{direction}}"))).toBeNull();
    expect(warn.mock.calls[0][0]).toMatchObject({
      reason: "missing_placeholder",
      detail: "preservation",
    });
  });

  it("the Nano generate template must keep the likeness block ({{references}})", () => {
    // Piece 8 added {{aspect}} — the Gemini dialect's canvas — to what every image template must keep.
    expect(REGISTRY_TEMPLATES["studio.image.generate"].required).toEqual([
      "direction",
      "references",
      "aspect",
    ]);
    const r = parseEnvelope(
      "studio.image.generate",
      envelope("{{direction}}", {
        ...META,
        model_target: "gemini-3-pro-image",
      }),
    );
    expect(r).toMatchObject({
      ok: false,
      reason: "missing_placeholder",
      detail: "references,aspect",
    });
  });

  it("the Seedance template must keep {{sound}}, empty or not", () => {
    const r = parseEnvelope(
      "studio.video.broll-seedance",
      envelope("{{direction}} {{avoid}}", { ...META, dialect: "seedance" }),
    );
    expect(r).toMatchObject({
      ok: false,
      reason: "missing_placeholder",
      detail: "sound",
    });
  });
});

describe("which frozen record applies", () => {
  it("only a registry record for the same key, with a body", () => {
    const f = frozen(envelope("{{direction}} {{preservation}}"));
    expect(registryTemplateOn(f, "studio.video.identity-static")).toBe(f);
    expect(registryTemplateOn(f, "studio.image.generate")).toBeNull();
    expect(
      registryTemplateOn(
        { ...f, source: "code", body: undefined },
        "studio.video.identity-static",
      ),
    ).toBeNull();
    expect(
      registryTemplateOn(undefined, "studio.video.identity-static"),
    ).toBeNull();
  });
});
