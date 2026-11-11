/**
 * fidelity.test.ts — brief fidelity's deterministic half (PR 16, R-10, M5).
 */
import { checkFidelity, forbidden, type FidelityBrief } from "./fidelity";

const brief: FidelityBrief = {
  constraints: ["do not show any stopwatch"],
  output: { type: "video", aspect_ratio: "9:16" },
  productLine: "the carbon plate spike",
  tone: ["hushed"],
};
const good =
  "DIRECTION: she laces the carbon plate spike\nfeel: hushed · documentary\nconstraint: do not show any stopwatch";
const pass = (checks: ReturnType<typeof checkFidelity>, name: string) =>
  checks.find((c) => c.check === name)!.pass;

describe("brief fidelity — the half asserted in code", () => {
  it("reads what a do-not forbids", () => {
    expect(forbidden("do not show any stopwatch")).toBe("stopwatch");
    expect(forbidden("mention @partner in the caption")).toBeNull();
  });

  it("a prompt that carries every confirmed line passes", () => {
    const c = checkFidelity(brief, [
      { kind: "video", aspectRatio: "9:16", text: good },
    ]);
    expect(c.every((x) => x.pass)).toBe(true);
  });

  it("a constraint present in the prompt but contradicted passes fidelity — it must FAIL", () => {
    const c = checkFidelity(brief, [
      {
        kind: "video",
        aspectRatio: "9:16",
        text: `${good}\nA stopwatch glints on her wrist.`,
      },
    ]);
    expect(pass(c, "constraints")).toBe(false);
  });

  it("a constraint absent from a prompt fails; the wrong output kind and aspect fail; a missing product line and tone fail", () => {
    const c = checkFidelity(brief, [
      { kind: "image", aspectRatio: "4:5", text: "DIRECTION: her on a track" },
    ]);
    expect(Object.fromEntries(c.map((x) => [x.check, x.pass]))).toEqual({
      constraints: false,
      output: false,
      product: false,
      tone: false,
    });
  });
});
