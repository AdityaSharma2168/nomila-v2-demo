/**
 * mediaOperations.test.ts — the audit inventory stays whole (capability layer v3 §1 and §3 rule 7): every edit op,
 * classifier operation, router task, and video or music module in the code has a row — an entry, internal, later or
 * never — and no row names one that is gone. A new operation without a row reds here by name.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STUDIO_EDIT_OPS } from "../../shared/schema";
import { CAPABILITY_ENTRIES } from "./agent/capabilityEntries";
import { MEDIA_OPERATIONS, laterCapabilities, type OperationSource } from "./mediaOperations";

const names = (source: OperationSource) => MEDIA_OPERATIONS.filter((r) => r.source === source).map((r) => r.name).sort();

/** The string members of an exported union type, read from the source (types have no runtime list). */
function unionMembers(file: string, type: string): string[] {
  const src = readFileSync(join(__dirname, file), "utf8");
  const start = src.indexOf(`export type ${type} =`);
  expect(start).toBeGreaterThanOrEqual(0);
  // The union ends at the first member followed by ";" (a comment inside it may hold a semicolon of its own).
  const end = src.slice(start).search(/"\s*;/);
  const body = src.slice(start, start + end + 1);
  return [...body.matchAll(/^\s*\|\s*"([^"]+)"/gm)].map((m) => m[1]).sort();
}

const modules = (dir: string) =>
  readdirSync(join(__dirname, dir))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => f.slice(0, -3))
    .sort();

describe("every media operation in the code has a row, and every row is still in the code", () => {
  it("the Studio's typed photo edits (STUDIO_EDIT_OPS)", () => {
    expect(names("edit_op")).toEqual([...STUDIO_EDIT_OPS].sort());
  });

  it("the classifier's edit operations (classify.ts EditOperation)", () => {
    const members = unionMembers("classify.ts", "EditOperation");
    expect(members.length).toBeGreaterThan(10);
    expect(names("classify_op")).toEqual(members);
  });

  it("the router's tasks (types.ts GenerationTask)", () => {
    const members = unionMembers("types.ts", "GenerationTask");
    expect(members).toContain("video.generate");
    expect(names("router_task")).toEqual(members);
  });

  it("every video and music module", () => {
    expect(names("video_module")).toEqual(modules("video"));
    expect(names("music_module")).toEqual(modules("music"));
  });
});

describe("what a row says", () => {
  it("an entry row names real library entries; other rows name none", () => {
    const ids = new Set(CAPABILITY_ENTRIES.map((e) => e.id));
    for (const r of MEDIA_OPERATIONS) {
      if (r.status === "entry") {
        expect([r.name, (r.entries ?? []).length > 0]).toEqual([r.name, true]);
        for (const id of r.entries ?? []) expect([r.name, id, ids.has(id)]).toEqual([r.name, id, true]);
      } else expect([r.name, r.entries]).toEqual([r.name, undefined]);
      if (r.status === "later") expect([r.name, (r.later ?? []).length > 0]).toEqual([r.name, true]);
    }
  });

  it("a later capability is never also a library entry (it would be both promised and withheld)", () => {
    const ids = new Set(CAPABILITY_ENTRIES.map((e) => e.id));
    expect(laterCapabilities().filter((n) => ids.has(n))).toEqual([]);
    expect(new Set(laterCapabilities()).size).toBe(laterCapabilities().length);
  });

  it("kits never make a picture from nothing: generation from words alone is never offered", () => {
    expect(MEDIA_OPERATIONS.find((r) => r.source === "router_task" && r.name === "image.generate")?.status).toBe("never");
    expect(MEDIA_OPERATIONS.find((r) => r.source === "classify_op" && r.name === "GENERATE")?.status).toBe("never");
  });
});
