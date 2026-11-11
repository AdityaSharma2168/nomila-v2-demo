import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITY_LISTS } from "./capabilities";
import {
  CAPABILITY_ENTRIES,
  IMAGE_MOTIONS,
  entrySchema,
  readImageMotion,
  type Cite,
} from "./capabilityEntries";
import { PLAN_ITEM_KINDS } from "./types";

const REPO = join(__dirname, "..", "..", "..");
const lines = new Map<string, string[]>();
const lineOf = (c: Cite): string | undefined => {
  if (!lines.has(c.file))
    lines.set(c.file, readFileSync(join(REPO, c.file), "utf8").split("\n"));
  return lines.get(c.file)![c.line - 1];
};

describe("capability entries are measured, cited, and field-scoped", () => {
  it("every entry parses against the schema", () => {
    for (const e of CAPABILITY_ENTRIES)
      expect(entrySchema.safeParse(e).success).toBe(true);
  });

  /** ⚠️ MUTATION: drop the "automatic entry is free" refine — this reds by name (tap-to-send). */
  it("a paid entry is never automatic: the app never spends without her tap", () => {
    const i2v = CAPABILITY_ENTRIES.find((e) => e.id === "i2v")!;
    expect(i2v.cost.kind).toBe("registry");
    expect(entrySchema.safeParse({ ...i2v, auto: true }).success).toBe(false);
    const look = CAPABILITY_ENTRIES.find((e) => e.id === "look.preset")!;
    expect(entrySchema.safeParse({ ...look, auto: true, group: "paid" }).success).toBe(false);
    expect(CAPABILITY_ENTRIES.filter((e) => e.auto && e.cost.kind !== "free")).toEqual([]);
  });

  it("entry cites a ledger line that doesn't exist: every cite's quote is on its line", () => {
    const broken = CAPABILITY_ENTRIES.flatMap((e) =>
      e.reliability.cites
        .filter((c) => !(lineOf(c) ?? "").includes(c.quote))
        .map((c) => `${e.id} → ${c.file}:${c.line} "${c.quote}"`),
    );
    expect(broken).toEqual([]);
  });

  it("ids are unique, and field + wire names one entry", () => {
    const ids = CAPABILITY_ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const scoped = CAPABILITY_ENTRIES.filter(
      (e) => e.field !== "item.kind",
    ).map((e) => `${e.field}:${e.wire}`);
    expect(new Set(scoped).size).toBe(scoped.length);
  });

  it("every plannable item kind has at least one entry, and every item entry is a real kind", () => {
    const kinds = new Set(
      CAPABILITY_ENTRIES.flatMap((e) => (e.itemKind ? [e.itemKind] : [])),
    );
    for (const k of PLAN_ITEM_KINDS) expect(kinds.has(k)).toBe(true);
    for (const e of CAPABILITY_ENTRIES.filter((x) => x.field === "item.kind"))
      expect(e.itemKind).toBe(e.wire);
  });

  it("generated entries carry likeness risk and a registry price; kept ones are free", () => {
    const i2v = CAPABILITY_ENTRIES.find((e) => e.id === "i2v")!;
    expect(i2v.likenessRisk).toBe("high");
    expect(i2v.cost.kind).toBe("registry");
    for (const e of CAPABILITY_ENTRIES.filter(
      (x) => x.field === "image.motion" || x.id === "clip.camera",
    ))
      expect(e.cost.kind).toBe("free");
  });

  it("the Board cannot hold a caption or a text graphic yet, and neither is a plan kind (gap list)", () => {
    for (const id of ["caption", "text_graphic"]) {
      const e = CAPABILITY_ENTRIES.find((x) => x.id === id)!;
      expect(e.onBoard).toBe(false);
      expect(e.itemKind).toBeNull();
    }
  });
});

describe("image.motion and shot.movement are separate vocabularies (PR 6 naming contract)", () => {
  it("image.motion's wire names are dolly | zoom | sweep | punch, and pan is not one of them", () => {
    expect([...IMAGE_MOTIONS]).toEqual(["dolly", "zoom", "sweep", "punch"]);
    expect((IMAGE_MOTIONS as readonly string[]).includes("pan")).toBe(false);
  });

  it("the two fields are disjoint as scoped names: no entry addresses shot.movement, and the words they share are only ever written with their field", () => {
    const shared = IMAGE_MOTIONS.filter((m) =>
      (CAPABILITY_LISTS.movement as readonly string[]).includes(m),
    );
    // dolly is in both lists by design (decision 1) — so the entries must never let it stand alone.
    expect(shared).toEqual(["dolly"]);
    const motionEntries = CAPABILITY_ENTRIES.filter(
      (e) => e.field === "image.motion",
    );
    for (const e of motionEntries) expect(e.id).toBe(`image.motion.${e.wire}`);
  });

  it('alias dropped: a stored or replied "pan" on an image item still reads as dolly', () => {
    expect(readImageMotion("pan")).toBe("dolly");
    expect(readImageMotion("dolly")).toBe("dolly");
    expect(readImageMotion("zoom")).toBe("zoom");
    expect(readImageMotion("whip_pan")).toBeNull();
    expect(readImageMotion(null)).toBeNull();
  });
});
