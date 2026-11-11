/**
 * freeze.test.ts — the prompt registry read-through (quality-scrappy piece 4, ADI-QS-GO R1/R2), against real SQL: the
 * `prompts` table in PGlite, the real planner, the three templates. Flag off the brief is untouched; on with nothing
 * published every prompt is byte-identical and the brief still names its template; a published row is frozen with
 * its version and hash and the run renders it — even after a newer version is published.
 *
 * ⚠️ MUTATIONS (docs/probes/quality-scrappy.md):
 *   M4c — the freeze drops the row's `body` (so the run would have nothing frozen to render): "a publish after the
 *         quote does not move the queued job" reds.
 *   M4d — the target check dropped: "a row written for another model is not frozen" reds.
 */
jest.mock("../../db", () => require("../../testUtils/pgliteDb"));

import { sql } from "drizzle-orm";
import { client, db, initTestDb, closeTestDb } from "../../testUtils/pgliteDb";
import { prompts } from "../../../shared/schema";
import SHARED from "../video/prompts.golden.json";
import { plannedInputs, previewGeneration } from "../preview";
import type { CreativeBrief } from "../brief";
import { clipBrief } from "../video/seedance.cells";
import { TEMPLATE_FORMAT } from "./render";
import { clearTemplateCache } from "./registry";
import {
  SEED_AUTHOR,
  SEED_TEMPLATES,
  seedBody,
  seedHash,
  seedSql,
} from "./seeds";
import type { RegistryTemplateKey } from "./render";
import { withPromptTemplate } from "./freeze";
import { readNativeIntent } from "../nativeEdit";

const PERSON = [
  {
    role: "person",
    ref: "athletes/a/uploads/her.jpg",
    mediaAssetId: "11111111-1111-4111-8111-111111111111",
    label: "me",
  },
];
const identityBrief = () =>
  clipBrief({
    references: PERSON,
    direction: {
      set: "chosen",
      statement: "She looks into the camera and breaks into a smile.",
      untrusted: false,
      featuredPieces: [],
    },
  } as Partial<CreativeBrief["job"]>);
const brollBrief = () => clipBrief();
const imageBrief = () =>
  clipBrief({ deliverable: "post", references: PERSON } as Partial<
    CreativeBrief["job"]
  >);

const META = (over: Record<string, unknown> = {}) => ({
  model_target: "veo-3.1-generate-001",
  provider: "vertex",
  dialect: null,
  asset_slots: ["frame"],
  allowed_params: ["generateAudio"],
  avoid: [],
  rubric_id: "her-v1",
  ...over,
});
async function publish(
  key: string,
  version: number,
  template: string,
  meta: Record<string, unknown>,
) {
  await db.execute(
    sql`UPDATE prompts SET status = 'archived' WHERE key = ${key} AND status = 'published'`,
  );
  const body = JSON.stringify({ format: TEMPLATE_FORMAT, meta, template });
  await db.insert(prompts).values({
    key,
    version,
    body,
    status: "published",
    hash: `h${version}`.padEnd(12, "0"),
  } as never);
  clearTemplateCache();
}

const ENV = [
  "STUDIO_PROMPT_REGISTRY",
  "STUDIO_ALL_ON",
  "STUDIO_DIALECTS",
  "STUDIO_VIDEO_BROLL_MODEL",
];
let saved: Record<string, string | undefined> = {};
beforeAll(async () => {
  await initTestDb();
});
afterAll(async () => {
  await closeTestDb();
});
beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  await db.delete(prompts);
  clearTemplateCache();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const prompt = (b: CreativeBrief) => plannedInputs(b, {}).inputs.prompt;

describe("flag off, and on with nothing published", () => {
  it("flag off: the brief comes back untouched", async () => {
    const b = identityBrief();
    expect(await withPromptTemplate(b)).toBe(b);
  });

  it("on (under the master), nothing published: every template's prompt is byte-identical, and the brief names its key", async () => {
    process.env.STUDIO_ALL_ON = "true";
    const cells: [CreativeBrief, string, string | null][] = [
      [
        identityBrief(),
        "studio.video.identity-static",
        (SHARED["identity-static"] as string[]).join("\n"),
      ],
      [
        brollBrief(),
        "studio.video.broll-no-marks",
        (SHARED["broll-no-marks"] as string[]).join("\n"),
      ],
      [imageBrief(), "studio.image.generate", null],
    ];
    for (const [b, key, golden] of cells) {
      const frozen = await withPromptTemplate(b);
      // Piece 9: every frozen record also names what the resolver read to choose it.
      expect(frozen.job.template).toEqual({
        key,
        source: "code",
        version: null,
        hash: null,
        inputs: expect.objectContaining({ ops: expect.any(Array) }),
      });
      expect(prompt(frozen)).toBe(golden ?? prompt(b));
    }
  });

  // Piece 8 moved this claim ON PURPOSE: it read "an edit has no template to freeze" until every Create Anything template
  // joined the registry. An edit now freezes its key like a generate; a crop, which no model is sent, still has none.
  it("an edit freezes its template's key — the masked edit's, a native edit's by operation — and a crop none", async () => {
    process.env.STUDIO_PROMPT_REGISTRY = "true";
    const edit = (job: Record<string, unknown> = {}) =>
      clipBrief({
        mode: "edit",
        deliverable: "post",
        source: {
          mediaAssetId: "x",
          ref: "athletes/a/p.jpg",
          width: 1000,
          height: 1500,
          editRegions: [],
        },
        ...job,
      } as unknown as Partial<CreativeBrief["job"]>);
    const intent = (changes: Record<string, unknown>[]) => ({
      editIntent: {
        version: 1,
        initialPath: "FULL_IMAGE",
        steps: changes.map((c) => ({
          op: c.op,
          targets: [c.target ?? "photo"],
          value: c.change,
          scope: "REGION",
        })),
        changes,
        imageSize: "2K",
      },
    });
    const keyOf = async (b: CreativeBrief) => {
      // Each is a runnable intent, so a missing key is never an invalid one's.
      if (b.job.editIntent) expect(readNativeIntent(b).kind).toBe("native");
      return (await withPromptTemplate(b)).job.template;
    };
    expect(await keyOf(edit())).toEqual({
      key: "studio.image.edit.masked",
      source: "code",
      version: null,
      hash: null,
      inputs: {
        ops: ["masked"],
        ad: false,
        roles: [],
        brand: false,
        styleSpec: false,
      },
    });
    expect(
      (
        await keyOf(
          edit(intent([{ op: "RECOLOR", target: "shorts", change: "black" }])),
        )
      )?.key,
    ).toBe("studio.image.edit.recolor");
    expect(
      (
        await keyOf(
          edit(
            intent([
              { op: "RECOLOR", target: "shorts", change: "black" },
              { op: "CHANGE_BACKGROUND", target: null, change: "a stadium" },
            ]),
          ),
        )
      )?.key,
    ).toBe("studio.image.edit.compound");
    expect(
      await keyOf(edit(intent([{ op: "CROP", target: null, change: "4:5" }]))),
    ).toBeUndefined();
  });
});

describe("a published row", () => {
  beforeEach(() => {
    process.env.STUDIO_PROMPT_REGISTRY = "true";
  });

  it("the Veo 'her' template: frozen with its version and hash, and the quote renders it", async () => {
    await publish(
      "studio.video.identity-static",
      2,
      "HER TEMPLATE v2.\n\n{{direction}}\n\n{{camera}}\n\n{{preservation}}",
      META(),
    );
    const frozen = await withPromptTemplate(identityBrief());
    expect(frozen.job.template).toMatchObject({
      key: "studio.video.identity-static",
      source: "registry",
      version: 2,
    });
    const p = prompt(frozen);
    expect(
      p.startsWith("HER TEMPLATE v2.\n\nDIRECTION: She looks into the camera"),
    ).toBe(true);
    expect(p).toContain("The person keeps her exact face");
    // and the job the quote opens carries it: createGenerationJob copies preview.brief
    expect(previewGeneration(frozen, {}).brief.job.template).toMatchObject({
      version: 2,
      hash: "h200000000000".slice(0, 12),
    });
  });

  it("a publish after the quote does not move the queued job — the run renders the frozen body", async () => {
    await publish(
      "studio.video.identity-static",
      1,
      "V1 {{direction}} {{preservation}}",
      META(),
    );
    const quoted = await withPromptTemplate(identityBrief());
    const atQuote = prompt(quoted);
    await publish(
      "studio.video.identity-static",
      2,
      "V2 {{direction}} {{preservation}}",
      META(),
    );
    expect(prompt(quoted)).toBe(atQuote); // the run, re-deriving from the frozen brief
    expect(atQuote.startsWith("V1 ")).toBe(true);
    expect(
      prompt(await withPromptTemplate(identityBrief())).startsWith("V2 "),
    ).toBe(true); // a new quote
  });

  it("a row written for another model is not frozen — the literal applies", async () => {
    await publish(
      "studio.video.identity-static",
      3,
      "WRONG TARGET {{direction}} {{preservation}}",
      META({
        model_target: "bytedance/seedance-2.0-fast",
        provider: "openrouter",
      }),
    );
    const frozen = await withPromptTemplate(identityBrief());
    expect(frozen.job.template).toMatchObject({
      source: "code",
      version: null,
    });
    expect(prompt(frozen)).toBe(
      (SHARED["identity-static"] as string[]).join("\n"),
    );
  });

  it("a malformed row is not frozen — the literal applies", async () => {
    await db.insert(prompts).values({
      key: "studio.video.identity-static",
      version: 4,
      body: "{not json",
      status: "published",
      hash: "bad000000000",
    } as never);
    const frozen = await withPromptTemplate(identityBrief());
    expect(frozen.job.template?.source).toBe("code");
    expect(prompt(frozen)).toBe(
      (SHARED["identity-static"] as string[]).join("\n"),
    );
  });

  // quality-scrappy piece 9 — the resolver's candidates, against the real table.
  // ⚠️ MUTATIONS: M9a the base tried before its variants — "a published variant wins over its base" reds; M9e a variant
  // not rendered under its base (registryTemplateOn exact-match only) — "the run renders the frozen variant" reds.
  const NANO_META = () =>
    META({
      model_target: "gemini-3-pro-image",
      asset_slots: ["character"],
      allowed_params: ["imageSize"],
    });
  const NANO_BODY = (mark: string) =>
    `${mark}\n\n{{opening}}\n\n{{references}}\n\n{{aspect}}\n\n{{direction}}`;

  it("a published variant wins over its base, where its condition holds: her photo attached freezes '+her'", async () => {
    await publish(
      "studio.image.generate",
      3,
      NANO_BODY("BASE v3"),
      NANO_META(),
    );
    await publish(
      "studio.image.generate+her",
      1,
      NANO_BODY("HER v1"),
      NANO_META(),
    );
    const withHer = await withPromptTemplate(imageBrief());
    expect(withHer.job.template).toMatchObject({
      key: "studio.image.generate+her",
      source: "registry",
      version: 1,
      inputs: { ops: ["generate"], roles: ["person"] },
    });
    const none = await withPromptTemplate(
      clipBrief({ deliverable: "post" } as Partial<CreativeBrief["job"]>),
    );
    expect(none.job.template).toMatchObject({
      key: "studio.image.generate",
      version: 3,
    });
  });

  it("the run renders the frozen variant, under its base's placeholders", async () => {
    await publish(
      "studio.image.generate+her",
      1,
      NANO_BODY("HER v1"),
      NANO_META(),
    );
    const frozen = await withPromptTemplate(imageBrief());
    const p = prompt(frozen);
    expect(
      p.startsWith("HER v1\n\nGenerate a single photorealistic photograph"),
    ).toBe(true);
    expect(p).toContain("HER LIKENESS");
  });

  it("a variant that drops what its base must keep is passed over, with a warning — the next candidate stands", async () => {
    await publish(
      "studio.image.generate+her",
      1,
      "HER v1\n\n{{opening}}\n\n{{direction}}",
      NANO_META(),
    );
    const frozen = await withPromptTemplate(imageBrief());
    expect(frozen.job.template).toMatchObject({
      key: "studio.image.generate",
      source: "code",
    });
    expect(prompt(frozen)).toBe(prompt(imageBrief()));
  });

  it("the Nano image-generate template renders with her likeness block in it", async () => {
    await publish(
      "studio.image.generate",
      1,
      "NANO v1\n\n{{opening}}\n\n{{references}}\n\n{{aspect}}\n\n{{direction}}",
      META({
        model_target: "gemini-3-pro-image",
        asset_slots: ["character"],
        allowed_params: ["imageSize"],
      }),
    );
    const frozen = await withPromptTemplate(imageBrief());
    expect(frozen.job.template).toMatchObject({
      key: "studio.image.generate",
      source: "registry",
      version: 1,
    });
    const p = prompt(frozen);
    expect(
      p.startsWith("NANO v1\n\nGenerate a single photorealistic photograph"),
    ).toBe(true);
    expect(p).toContain("HER LIKENESS");
    expect(p).toContain("DIRECTION: An empty football stadium");
  });

  it("the Seedance template (dialect on): its meta.avoid joins the Avoid clause", async () => {
    process.env.STUDIO_DIALECTS = "true";
    await publish(
      "studio.video.broll-seedance",
      1,
      "{{subject}}\n\n{{direction}}\n\n{{camera}}\n\n{{sound}}\n\n{{avoid}}",
      META({
        model_target: "bytedance/seedance-2.0-fast",
        provider: "openrouter",
        dialect: "seedance",
        avoid: ["rain"],
      }),
    );
    const frozen = await withPromptTemplate(brollBrief());
    expect(frozen.job.template).toMatchObject({
      key: "studio.video.broll-seedance",
      source: "registry",
    });
    const p = prompt(frozen);
    expect(p.endsWith("captions, cuts, rain.")).toBe(true);
    expect(p).not.toContain("Photorealistic"); // the template left {{style}} out, and that is its choice
  });
});

describe("the seed rows render byte-identical to the literal — publishing one is a proven no-op", () => {
  const seed = async (key: RegistryTemplateKey) => {
    await db.insert(prompts).values({
      key,
      version: SEED_TEMPLATES[key].version,
      body: seedBody(key),
      status: "published",
      hash: seedHash(key),
      note: SEED_TEMPLATES[key].note,
    } as never);
    clearTemplateCache();
  };
  beforeEach(() => {
    process.env.STUDIO_PROMPT_REGISTRY = "true";
  });

  const withSound = (b: CreativeBrief) => ({
    ...b,
    job: { ...b.job, audio: true as const },
  });
  const campaign = (b: CreativeBrief) => ({
    ...b,
    job: {
      ...b.job,
      campaign: {
        planId: "00000000-0000-4000-8000-000000000014",
        tone: ["calm"],
        style: "documentary",
        energy: "steady",
        constraints: ["do not show a competitor's logo"],
        concept: "Quiet power",
        aesthetic: "moody",
        objective: "grow-following",
        references: [],
      },
    },
  });

  it.each([
    ["identity-static", () => identityBrief()],
    ["identity-static with sound", () => withSound(identityBrief())],
    [
      "identity-static with a campaign",
      () => campaign(identityBrief()) as CreativeBrief,
    ],
  ])("studio.video.identity-static — %s", async (_n, brief) => {
    await seed("studio.video.identity-static");
    const frozen = await withPromptTemplate(brief());
    expect(frozen.job.template).toMatchObject({
      source: "registry",
      version: 1,
      hash: seedHash("studio.video.identity-static"),
    });
    expect(prompt(frozen)).toBe(prompt(brief()));
  });

  it.each([
    ["plain", () => brollBrief()],
    ["with sound", () => withSound(brollBrief())],
    ["with a campaign", () => campaign(brollBrief()) as CreativeBrief],
  ])("studio.video.broll-seedance (dialect on) — %s", async (_n, brief) => {
    process.env.STUDIO_DIALECTS = "true";
    await seed("studio.video.broll-seedance");
    const frozen = await withPromptTemplate(brief());
    expect(frozen.job.template).toMatchObject({
      source: "registry",
      version: 1,
    });
    expect(prompt(frozen)).toBe(prompt(brief()));
  });

  it.each([
    ["with her likeness", () => imageBrief()],
    [
      "with nothing attached",
      () => clipBrief({ deliverable: "post" } as Partial<CreativeBrief["job"]>),
    ],
  ])("studio.image.generate — %s", async (_n, brief) => {
    await seed("studio.image.generate");
    const frozen = await withPromptTemplate(brief());
    expect(frozen.job.template).toMatchObject({
      source: "registry",
      version: 2,
    });
    expect(prompt(frozen)).toBe(prompt(brief()));
  });
});

describe("the seed SQL Adi runs on dev, run here first", () => {
  it("as draft: a row per template at its seed's version, all inert — nothing frozen from a draft", async () => {
    process.env.STUDIO_PROMPT_REGISTRY = "true";
    await client.exec(seedSql("draft"));
    clearTemplateCache();
    const rows = await db.select().from(prompts);
    // Piece 8: every Create Anything template, 18 in all; the generate at version 2 (piece 4's version 1 had no {{aspect}}).
    expect(rows.map((r) => [r.key, r.version, r.status]).sort()).toEqual(
      (Object.keys(SEED_TEMPLATES) as RegistryTemplateKey[])
        .map((k) => [k, k === "studio.image.generate" ? 2 : 1, "draft"])
        .sort(),
    );
    expect(rows).toHaveLength(18);
    expect(
      (await withPromptTemplate(identityBrief())).job.template?.source,
    ).toBe("code");
  });

  it("as published: frozen, hashes as the table's convention, re-running is a no-op", async () => {
    process.env.STUDIO_PROMPT_REGISTRY = "true";
    await client.exec(seedSql("published"));
    await client.exec(seedSql("published"));
    clearTemplateCache();
    expect(await db.select().from(prompts)).toHaveLength(18);
    const frozen = await withPromptTemplate(identityBrief());
    expect(frozen.job.template).toMatchObject({
      source: "registry",
      version: 1,
      hash: seedHash("studio.video.identity-static"),
    });
    expect(prompt(frozen)).toBe(prompt(identityBrief()));
  });

  it("piece 4's generate seed, published before piece 8: archived by the new SQL, and version 2 published in its place", async () => {
    process.env.STUDIO_PROMPT_REGISTRY = "true";
    const v1 = JSON.stringify({
      format: TEMPLATE_FORMAT,
      meta: SEED_TEMPLATES["studio.image.generate"].meta,
      template:
        "{{opening}}\n\n{{references}}\n\n{{audience}}\n\n{{text_rules}}\n\n{{brand}}\n\n{{style}}\n\n{{goal}}\n\n{{direction}}",
    });
    await db.insert(prompts).values({
      key: "studio.image.generate",
      version: 1,
      body: v1,
      status: "published",
      hash: "piece4seed01",
      created_by: SEED_AUTHOR,
    } as never);
    await client.exec(seedSql("published"));
    clearTemplateCache();
    const rows = (await db.select().from(prompts))
      .filter((r) => r.key === "studio.image.generate")
      .map((r) => [r.version, r.status])
      .sort();
    expect(rows).toEqual([
      [1, "archived"],
      [2, "published"],
    ]);
    expect((await withPromptTemplate(imageBrief())).job.template).toMatchObject(
      {
        source: "registry",
        version: 2,
      },
    );
  });

  it("a published row someone else wrote is never archived: the SQL stops instead, and changes nothing", async () => {
    await db.insert(prompts).values({
      key: "studio.image.edit.recolor",
      version: 7,
      body: "{}",
      status: "published",
      hash: "notours00000",
      created_by: "mia",
    } as never);
    await expect(client.exec(seedSql("published"))).rejects.toThrow();
    await client.exec("ROLLBACK;").catch(() => undefined);
    const rows = await db.select().from(prompts);
    expect(rows.map((r) => [r.key, r.version, r.status])).toEqual([
      ["studio.image.edit.recolor", 7, "published"],
    ]);
  });
});
