/**
 * manifest.test.ts — the target manifest (quality-scrappy piece 1, ADI-QS-GO): every fact sourced, the one fact the
 * dialect rests on pinned, the payload check proven both ways, and — P1c — the payloads this product can compile today
 * checked against their targets.
 *
 * ⚠️ MUTATIONS (docs/probes/quality-scrappy.md):
 *   M1a — Seedance accepts a negative prompt (manifest.ts): "Seedance takes no negative prompt" reds by name.
 *   M1e — the check not wired into previewGeneration: "a negative prompt to Seedance is refused at the quote" reds.
 */
jest.mock("../../../db", () => ({
  db: {},
  pool: { end: async () => {}, on: () => {} },
}));

import {
  MODELS,
  routeFor,
  supportedDurationsFor,
  videoRouteFor,
} from "../../config";
import { plannedInputs, previewGeneration } from "../../preview";
import type { CreativeBrief } from "../../brief";
import type { ShotType } from "../../types";
import { clipBrief } from "../../video/seedance.cells";
import {
  TARGETS,
  dialectFor,
  payloadOf,
  payloadViolations,
  targetFor,
  type PayloadView,
} from "./manifest";

const ENV_KEYS = [
  "STUDIO_DIALECTS",
  "STUDIO_ALL_ON",
  "STUDIO_VIDEO_PROVIDER",
  "STUDIO_VIDEO_MODEL",
  "STUDIO_VIDEO_BROLL_MODEL",
  "STUDIO_VIDEO_BROLL_PROVIDER",
];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const view = (over: Partial<PayloadView> = {}): PayloadView => ({
  references: 0,
  lastFrame: false,
  generateAudio: false,
  seed: false,
  negativePrompt: false,
  passthrough: [],
  ...over,
});
const target = (model: string, provider: "vertex" | "openrouter") => {
  const t = targetFor(model, provider);
  if (!t) throw new Error(`no manifest entry for ${model}@${provider}`);
  return t;
};

describe("every fact says where it came from", () => {
  it("one entry per (model, provider), keys unique", () => {
    const keys = TARGETS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(
      [
        "veo-3.1-generate-001@vertex",
        `${MODELS.veo}@openrouter`,
        `${MODELS.seedance}@openrouter`,
        `${MODELS.seedanceFast}@openrouter`,
        `${MODELS.kling}@openrouter`,
        "gemini-3-pro-image@vertex",
      ].sort(),
    );
  });

  it.each(TARGETS.map((t) => [t.key, t] as const))(
    "%s: every field carries a source",
    (_k, t) => {
      const facts = [
        ...Object.values(t.accepts),
        t.references,
        t.durations,
        t.aspects,
        t.resolutions,
        t.sizes,
        t.text,
      ];
      for (const f of facts) {
        expect(typeof f.source).toBe("string");
        expect(f.source.length).toBeGreaterThan(10);
        expect(typeof f.verified).toBe("boolean");
      }
    },
  );

  it("the routes the product takes today all have an entry", () => {
    const routed = [
      videoRouteFor("identity"),
      videoRouteFor("broll"),
      videoRouteFor("transition"),
      routeFor("image.generate"),
    ];
    for (const r of routed)
      expect(targetFor(r.model, r.provider)).not.toBeNull();
  });

  it("the durations agree with config.ts supportedDurationsFor — one fact, two homes, no drift", () => {
    for (const t of TARGETS.filter((x) => x.task === "video.generate"))
      expect([...(t.durations.value ?? [])]).toEqual(
        supportedDurationsFor(t.model),
      );
  });
});

describe("the facts the dialect rests on", () => {
  it("Seedance takes no negative prompt — an avoid list can only travel as prose", () => {
    for (const m of [MODELS.seedance, MODELS.seedanceFast]) {
      const t = target(m, "openrouter");
      expect(t.accepts.negativePrompt.value).toBe(false);
      expect(payloadViolations(t, view({ negativePrompt: true }))).toEqual([
        "a negative prompt",
      ]);
    }
  });

  // quality-scrappy piece 7 moved this claim ON PURPOSE: it read "only Seedance has a dialect" until Gemini 3 Pro Image
  // was given one (compile/geminiDialect.ts). Every other model is still pinned to none.
  it("Seedance and Gemini 3 Pro Image have a dialect, whatever provider each is on — no other model does", () => {
    expect(dialectFor(MODELS.seedanceFast)).toBe("seedance");
    expect(dialectFor(MODELS.seedance)).toBe("seedance");
    // Its Vertex id AND its OpenRouter id: one model, one dialect, whichever pipe the route names.
    expect(dialectFor("gemini-3-pro-image")).toBe("gemini-image");
    expect(dialectFor(MODELS.nanoPro)).toBe("gemini-image");
    for (const m of [
      MODELS.veo,
      "veo-3.1-generate-001",
      MODELS.kling,
      MODELS.nanoFlash,
      "gemini-3.1-flash-image",
      "unknown/model",
      undefined,
    ])
      expect(dialectFor(m)).toBeNull();
  });
});

describe("payloadViolations, both ways", () => {
  it("an unverified accept counts as a refusal: a negative prompt to Veo on Vertex", () => {
    const t = target("veo-3.1-generate-001", "vertex");
    expect(t.accepts.negativePrompt.verified).toBe(false);
    expect(payloadViolations(t, view({ negativePrompt: true }))).toEqual([
      "a negative prompt",
    ]);
  });

  it("a last frame to Veo on Vertex is refused; to Kling it goes", () => {
    expect(
      payloadViolations(
        target("veo-3.1-generate-001", "vertex"),
        view({ lastFrame: true }),
      ),
    ).toEqual(["a last frame"]);
    expect(
      payloadViolations(
        target(MODELS.kling, "openrouter"),
        view({ lastFrame: true }),
      ),
    ).toEqual([]);
  });

  it("durations, shapes and sizes the target does not serve", () => {
    expect(
      payloadViolations(
        target("veo-3.1-generate-001", "vertex"),
        view({ durationSeconds: 5, aspectRatio: "4:5" }),
      ),
    ).toEqual(["a 5s clip", "a 4:5 frame"]);
    expect(
      payloadViolations(
        target(MODELS.seedanceFast, "openrouter"),
        view({ size: "1080x1920" }),
      ),
    ).toEqual(["a 1080x1920 output"]);
    expect(
      payloadViolations(
        target(MODELS.seedanceFast, "openrouter"),
        view({ size: "720x1280", durationSeconds: 4 }),
      ),
    ).toEqual([]);
  });

  it("a provider parameter the target does not list", () => {
    expect(
      payloadViolations(
        target(MODELS.seedanceFast, "openrouter"),
        view({ passthrough: ["cfg_scale"] }),
      ),
    ).toEqual(['the parameter "cfg_scale"']);
    expect(
      payloadViolations(
        target(MODELS.kling, "openrouter"),
        view({ passthrough: ["cfg_scale"] }),
      ),
    ).toEqual([]);
  });

  it("payloadOf reads the planner's shapes: Vertex's parameters, OpenRouter's top level, image sizes", () => {
    expect(
      payloadOf(
        { prompt: "x", durationSeconds: 8 },
        { parameters: { generateAudio: true, negativePrompt: "blur" } },
        "vertex",
      ),
    ).toMatchObject({
      generateAudio: true,
      negativePrompt: true,
      passthrough: ["generateAudio"],
    });
    expect(
      payloadOf(
        { prompt: "x", width: 720, height: 1280 },
        { negative_prompt: "blur", parameters: { generateAudio: false } },
        "openrouter",
      ),
    ).toMatchObject({
      size: "720x1280",
      negativePrompt: true,
      generateAudio: false,
      passthrough: [],
    });
    expect(
      payloadOf(
        { prompt: "x" },
        { generationConfig: { imageConfig: { imageSize: "2K" } } },
        "vertex",
      ).passthrough,
    ).toEqual(["imageSize"]);
  });
});

/**
 * P1c — "the manifest assert over today's reachable payload matrix finds 0 violations". Every shot type, on every
 * provider its route can be switched to, at every duration its model serves, with and without sound where the route
 * takes it — compiled by the REAL planner, then judged.
 */
describe("P1c: what the planner compiles today, judged against its target", () => {
  const PERSON = [
    {
      role: "person",
      ref: "athletes/a/uploads/her.jpg",
      mediaAssetId: "11111111-1111-4111-8111-111111111111",
      label: "me",
    },
  ];
  const cells: {
    name: string;
    shot: ShotType;
    env: Record<string, string>;
    brief: (d: number, audio: boolean) => CreativeBrief;
  }[] = [
    {
      name: "identity on Vertex",
      shot: "identity",
      env: {},
      brief: (d, audio) =>
        clipBrief({
          references: PERSON,
          durationSeconds: d,
          ...(audio ? { audio: true } : {}),
        } as Partial<CreativeBrief["job"]>),
    },
    {
      name: "b-roll on Seedance-fast",
      shot: "broll",
      env: {},
      brief: (d, audio) =>
        clipBrief({
          durationSeconds: d,
          ...(audio ? { audio: true } : {}),
        } as Partial<CreativeBrief["job"]>),
    },
    {
      name: "b-roll on Seedance 2.0",
      shot: "broll",
      env: { STUDIO_VIDEO_BROLL_MODEL: MODELS.seedance },
      brief: (d, audio) =>
        clipBrief({
          durationSeconds: d,
          ...(audio ? { audio: true } : {}),
        } as Partial<CreativeBrief["job"]>),
    },
    {
      name: "bridge on Kling",
      shot: "transition",
      env: {},
      brief: (d) =>
        clipBrief({
          references: PERSON,
          durationSeconds: d,
          lastFrame: {
            ref: "athletes/a/uploads/next.jpg",
            mediaAssetId: "22222222-2222-4222-8222-222222222222",
          },
        } as Partial<CreativeBrief["job"]>),
    },
  ];

  const rows = cells.flatMap((c) => {
    for (const [k, v] of Object.entries(c.env)) process.env[k] = v;
    const model = videoRouteFor(c.shot).model;
    for (const k of Object.keys(c.env)) delete process.env[k];
    const durations = supportedDurationsFor(model) ?? [];
    const audios = c.shot === "transition" ? [false] : [false, true];
    return durations.flatMap((d) =>
      audios.map((a) => [c.name, d, a ? "sound" : "silent", c] as const),
    );
  });

  it("the matrix is not empty", () => expect(rows.length).toBeGreaterThan(40));

  it.each(rows)("%s, %ss, %s: no violations", (_n, d, sound, cell) => {
    for (const [k, v] of Object.entries(cell.env)) process.env[k] = v;
    const planned = plannedInputs(cell.brief(d, sound === "sound"), {});
    expect(planned.shotType).toBe(cell.shot);
    const route = planned.videoRoute!;
    const t = targetFor(route.model, route.provider);
    expect(t).not.toBeNull();
    expect(
      payloadViolations(
        t!,
        payloadOf(planned.inputs, planned.providerParams, route.provider),
      ),
    ).toEqual([]);
  });
});

describe("the check at the quote (behind STUDIO_DIALECTS)", () => {
  // A probe-style caller asking Seedance for a negative prompt it has no parameter for.
  const asksForNegative = () =>
    previewGeneration(
      clipBrief({ durationSeconds: 4 } as Partial<CreativeBrief["job"]>),
      {
        providerParams: { negative_prompt: "people" },
      },
    );

  it("a negative prompt to Seedance is refused at the quote with the flag on", () => {
    process.env.STUDIO_DIALECTS = "true";
    const p = asksForNegative();
    expect(p.status).toBe("blocked");
    expect(p.blockers.map((b) => b.note).join(" ")).toContain(
      "a negative prompt",
    );
  });

  it("flag off: the same quote is what it was — ready, no new blocker", () => {
    const p = asksForNegative();
    expect(p.status).toBe("ready");
    expect(p.blockers).toEqual([]);
  });

  it("the master does not turn the check on", () => {
    process.env.STUDIO_ALL_ON = "true";
    expect(asksForNegative().status).toBe("ready");
  });
});
