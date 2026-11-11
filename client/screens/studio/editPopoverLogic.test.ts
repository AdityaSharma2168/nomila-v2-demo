/**
 * editPopoverLogic.test.ts — the popover's pure rules (PR 9, Lane 3a), each mutation red by name:
 *   "edit offered on an unselected photo"      — lastPickedAfterToggle answers on a deselect
 *   "popover blocks selection"                 — toggleIn changes with a popover open
 *   "edited selection loses derived_from"      — swapIn puts in an id other than the accepted asset's
 *   "edit affordance renders anywhere outside the picker popup" — a structural walk of client/
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  briefLinesFrom,
  canAccept,
  lastPickedAfterToggle,
  MANUAL_OPS,
  paramsFor,
  swapIn,
  toggleIn,
} from "./editPopoverLogic";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

describe("the popover follows the toggle, never the other way round", () => {
  /** ⚠️ MUTATION "edit offered on an unselected photo": return the id on a deselect. */
  it("offers the photo she just SELECTED, at its ordinal, and nothing on a deselect", () => {
    const before = [A];
    const after = toggleIn(before, B, 12);
    expect(after).toEqual([A, B]);
    expect(lastPickedAfterToggle("picked", before, after, B)).toEqual({
      list: "picked",
      assetId: B,
      ordinal: 2,
    });
    const removed = toggleIn(after, A, 12);
    expect(removed).toEqual([B]);
    expect(lastPickedAfterToggle("picked", after, removed, A)).toBeNull();
  });

  it("nothing at the cap: a pick that could not add offers no edit", () => {
    const full = [A, B, C];
    const same = toggleIn(full, "dddddddd-0000-4000-8000-000000000004", 3);
    expect(same).toBe(full);
    expect(
      lastPickedAfterToggle(
        "products",
        full,
        same,
        "dddddddd-0000-4000-8000-000000000004",
      ),
    ).toBeNull();
  });

  /** ⚠️ MUTATION "popover blocks selection": make toggleIn consult a popover flag, or pass it one. */
  it("the toggle is one pure function of the list — its parameters are the list, the id and the cap, and AgentScreen passes exactly those", () => {
    const logic = readFileSync(join(__dirname, "editPopoverLogic.ts"), "utf8");
    const sig = /export const toggleIn = \(\s*([^)]*)\)/.exec(logic)?.[1] ?? "";
    const names = sig
      .split(",")
      .map((x) => x.trim().split(/[:=]/)[0].trim())
      .filter(Boolean);
    expect(names).toEqual(["l", "assetId", "cap"]);
    expect(toggleIn([], A, 12)).toEqual([A]);
    expect(toggleIn([A], A, 12)).toEqual([]);
    const screen = readFileSync(join(__dirname, "AgentScreen.tsx"), "utf8");
    const calls = [...screen.matchAll(/toggleIn\(([^;]*?)\)/g)].map(
      (m) => m[1],
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const args of calls) {
      expect(args.split(",").length).toBe(3);
      expect(args).not.toMatch(/lastPicked|popover|editSheet/i);
    }
  });
});

describe("the accepted edit takes the source's place", () => {
  /** ⚠️ MUTATION "edited selection loses derived_from": swap in the source id, or a made-up one. */
  it("swaps EXACTLY the accepted asset's id into the source's slot, once, in place", () => {
    expect(
      swapIn([A, B, C], B, "eeeeeeee-0000-4000-8000-000000000005"),
    ).toEqual([A, "eeeeeeee-0000-4000-8000-000000000005", C]);
    expect(
      swapIn([A, B, C], "zzzzzzzz-0000-4000-8000-000000000009", C),
    ).toEqual([A, B, C]);
    // Already there (a double accept): nothing changes.
    expect(swapIn([A, B], A, B)).toEqual([A, B]);
  });
});

describe("what the recommendation pass reads", () => {
  it("the brief's constraints, product line and story — trimmed, capped at twelve; nothing from nothing", () => {
    expect(briefLinesFrom(null)).toEqual([]);
    expect(briefLinesFrom({})).toEqual([]);
    expect(
      briefLinesFrom({
        constraints: [" No Nike marks on kit or ball. ", "", 3],
        product: { line: "the matte-black ball" },
        story: "Without theatrics.",
      }),
    ).toEqual([
      "No Nike marks on kit or ball.",
      "the matte-black ball",
      "Without theatrics.",
    ]);
    expect(
      briefLinesFrom({
        constraints: Array.from({ length: 20 }, (_, i) => `c${i}`),
      }),
    ).toHaveLength(12);
  });

  it("the manual ops are the four; the ad op is Lane 4's door and is not offered here", () => {
    expect(MANUAL_OPS.map((m) => m.op)).toEqual([
      "recolour",
      "garment",
      "product",
      "background_clean",
    ]);
    expect(paramsFor("ad", { headline: "x" }, null)).toBeNull();
  });
});

describe("the sheet's params and its one rule", () => {
  it("builds each op's params only when its required words are there", () => {
    expect(paramsFor("recolour", { target: "jersey" }, null)).toBeNull();
    expect(
      paramsFor("recolour", { target: "jersey", colour: "red" }, null),
    ).toEqual({ target: "jersey", colour: "red" });
    expect(
      paramsFor(
        "garment",
        { garment: "jersey", brand: "adidas", design: "stripe" },
        null,
      ),
    ).toBeNull();
    expect(
      paramsFor("garment", { garment: "jersey", brand: "adidas" }, null),
    ).toEqual({ garment: "jersey", brand: "adidas" });
    expect(paramsFor("product", { thing: "ball" }, null)).toBeNull();
    expect(paramsFor("product", { thing: "ball" }, A)).toEqual({
      mode: "place",
      productAssetId: A,
      thing: "ball",
    });
    // The two photo-less modes (Adi, 23 Sep 2026): a drawn add needs no product pick; a remove needs a target.
    expect(paramsFor("product", { mode: "add", thing: "cone" }, null)).toEqual({
      mode: "add",
      thing: "cone",
    });
    expect(paramsFor("product", { mode: "add", thing: "" }, A)).toBeNull();
    expect(
      paramsFor("product", { mode: "remove", target: "water bottle" }, null),
    ).toEqual({ mode: "remove", target: "water bottle" });
    expect(
      paramsFor("product", { mode: "remove", thing: "x" }, null),
    ).toBeNull();
    expect(paramsFor("background_clean", {}, null)).toEqual({});
    expect(
      paramsFor("background_clean", { setting: "x".repeat(50) }, null),
    ).toEqual({ setting: "x".repeat(40) });
  });

  /** ⚠️ MUTATION "accept without preview shown": canAccept true before a preview url exists. */
  it("Accept exists only on the preview step with a ready edit that has a url", () => {
    const edit = {
      id: "e",
      status: "ready",
      url: "https://signed.example/x",
    } as never;
    expect(canAccept("preview", edit)).toBe(true);
    expect(canAccept("quote", edit)).toBe(false);
    expect(
      canAccept("preview", { id: "e", status: "ready", url: null } as never),
    ).toBe(false);
    expect(
      canAccept("preview", { id: "e", status: "quoted", url: "u" } as never),
    ).toBe(false);
    expect(canAccept("preview", null)).toBe(false);
  });
});

describe("the edit affordance lives in one place", () => {
  /** ⚠️ MUTATION "edit affordance renders anywhere outside the picker popup": import EditPopover / EditSheet elsewhere. */
  it("EditPopover and EditSheet are imported by AgentScreen alone — not the Board, not the plan list, not the Video tab", () => {
    const root = join(__dirname, "..", "..");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|jsx?)$/.test(n) && !/\.test\./.test(n)) files.push(p);
      }
    };
    walk(root);
    const importers = files.filter((p) => {
      const src = readFileSync(p, "utf8");
      return (
        /from "[^"]*\/EditPopover"|from "[^"]*\/EditSheet"/.test(src) &&
        !p.endsWith("EditPopover.tsx") &&
        !p.endsWith("EditSheet.tsx")
      );
    });
    expect(importers.map((p) => p.replace(root, "client")).sort()).toEqual([
      "client/screens/studio/AgentScreen.tsx",
    ]);
  });
});
