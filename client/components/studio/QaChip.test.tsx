/**
 * QaChip.test.tsx — the chip, rendered, with the hook and the flag mocked at the module boundary.
 * No network. What is asserted is what the server test cannot see: that the COMPONENT puts nothing
 * on screen the wire did not say, and nothing at all with the flag off.
 *
 * REVERT CHECKS, red by name:
 *   "verdict chip renders with STUDIO_QA_DISPLAY off" → drop the flag check in QaChip
 *   "verdict shown as a score with a threshold"        → render spendUsd, or a number with a comparator
 *   "identity observation shown as pass/fail"          → label the observation with the verdict's word
 */
import { render, screen } from "@testing-library/react-native";
import type { QaWire } from "../../hooks/use-studio-qa";

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    Feather: ({ name }: { name: string }) =>
      React.createElement(Text, null, `icon:${name}`),
  };
});

const flags = { STUDIO_QA_DISPLAY: true, STUDIO_IDENTITY_DRIFT: true };
jest.mock("../../lib/flags", () => flags);

const hook: { data: QaWire | undefined; calls: number } = {
  data: undefined,
  calls: 0,
};
jest.mock("../../hooks/use-studio-qa", () => ({
  useAssetQa: () => {
    hook.calls += 1;
    return { data: hook.data };
  },
}));

import { costText, QaChip, verdictText } from "./QaChip";

const ASSET = "22222222-2222-4222-8222-222222222222";

const wire = (over: Partial<QaWire> = {}): QaWire => ({
  assetId: ASSET,
  verdict: {
    wording: "flag",
    label: "Flagged for a look",
    subject: "generate",
    at: "2026-09-23T00:00:00.000Z",
    unknownChecks: 1,
    identityObservation: {
      caption: "Observation only, not a check",
      caveat: "Observation only, never a verdict.",
    },
    spendUsd: 0.0123,
  },
  cost: { usd: 0.1344, basis: "estimated", source: "job_quote" },
  ...over,
});

const allText = () => (screen.toJSON() ? JSON.stringify(screen.toJSON()) : "");

beforeEach(() => {
  flags.STUDIO_QA_DISPLAY = true;
  hook.data = wire();
  hook.calls = 0;
});

describe("off is nothing", () => {
  /** ⚠️ MUTATION "verdict chip renders with STUDIO_QA_DISPLAY off": drop `if (!STUDIO_QA_DISPLAY) return null`. */
  it("renders nothing and mounts no query when the flag is off — whatever the hook would say", () => {
    flags.STUDIO_QA_DISPLAY = false;
    render(<QaChip assetId={ASSET} />);
    expect(screen.queryByTestId("qa-chip")).toBeNull();
    expect(hook.calls).toBe(0);
  });

  it("renders nothing for no asset, and nothing before the answer arrives", () => {
    render(<QaChip assetId={null} />);
    expect(screen.queryByTestId("qa-chip")).toBeNull();
    hook.data = undefined;
    render(<QaChip assetId={ASSET} />);
    expect(screen.queryByTestId("qa-chip")).toBeNull();
  });
});

describe("on: two words of state, and a price", () => {
  it("shows the server's label and the cost with its basis", () => {
    render(<QaChip assetId={ASSET} />);
    expect(screen.getByText("Flagged for a look")).toBeTruthy();
    expect(screen.getByText("$0.13 quoted")).toBeTruthy();
    expect(screen.getByText("icon:flag")).toBeTruthy();
  });

  it("a pass reads as passed; a billed cost drops the word 'quoted'", () => {
    hook.data = wire({
      verdict: {
        ...wire().verdict!,
        wording: "pass",
        label: "Passed the check",
        identityObservation: null,
      },
      cost: { usd: 0.13, basis: "authoritative", source: "edit_row" },
    });
    render(<QaChip assetId={ASSET} />);
    expect(screen.getByText("Passed the check")).toBeTruthy();
    expect(screen.getByText("$0.13")).toBeTruthy();
    expect(screen.getByText("icon:check")).toBeTruthy();
  });

  it("no verdict yet → 'Not checked', and the cost still shows", () => {
    hook.data = wire({ verdict: null });
    render(<QaChip assetId={ASSET} />);
    expect(screen.getByText("Not checked")).toBeTruthy();
    expect(screen.getByText("$0.13 quoted")).toBeTruthy();
  });

  /** ⚠️ MUTATION "verdict shown as a score with a threshold": render `verdict.spendUsd` or `unknownChecks` as a score. */
  it("puts NO score, count or threshold on screen — only the label and the price", () => {
    render(<QaChip assetId={ASSET} />);
    const text = allText();
    // The inspection's own spend and the unknown-check count are on the wire; neither is a verdict.
    expect(text).not.toContain("0.0123");
    expect(text).not.toMatch(/\b1\b\s*(of|\/)\s*\d/);
    expect(text).not.toMatch(/threshold|≥|<=|>=|out of/i);
    // The only money on screen is the generation's cost.
    expect(screen.getAllByText(/\$\d/)).toHaveLength(1);
  });

  /** ⚠️ MUTATION "identity observation shown as pass/fail": label the line "Identity passed"/"failed". */
  it("captions the identity observation as an observation, never pass/fail/flag", () => {
    render(<QaChip assetId={ASSET} />);
    expect(
      screen.getByText("Identity: observation only, not a check"),
    ).toBeTruthy();
    const text = allText();
    expect(text).not.toMatch(/Identity[^"]*(pass|fail|flag)/i);
  });

  it("has no press handler — nothing here retries, rerolls or loops", () => {
    render(<QaChip assetId={ASSET} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("the pure helpers", () => {
  it("costText carries the basis with the money", () => {
    expect(costText(null)).toBeNull();
    expect(
      costText({ usd: 0.5, basis: "estimated", source: "job_quote" }),
    ).toBe("$0.50 quoted");
    expect(
      costText({ usd: 0.5, basis: "authoritative", source: "edit_row" }),
    ).toBe("$0.50");
  });
  it("verdictText is the label, or 'Not checked'", () => {
    expect(verdictText(null)).toBe("Not checked");
    expect(verdictText(wire().verdict)).toBe("Flagged for a look");
  });
});

describe("drift (PR 17, R-6): one more observation line, and only with its flag on", () => {
  const withDrift = () =>
    wire({
      verdict: {
        ...wire().verdict!,
        driftObservation: {
          caption: "Observation only, not a check",
          line: "Face measured across 4 frames. Changed most around 3.2s.",
        },
      },
    });

  it("drift shown as pass/fail — the line is captioned as an observation and carries the server's sentence only", () => {
    flags.STUDIO_IDENTITY_DRIFT = true;
    hook.data = withDrift();
    render(<QaChip assetId={ASSET} />);
    const line = screen.getByTestId("qa-drift");
    expect(line).toHaveTextContent(
      "Drift: observation only, not a check — Face measured across 4 frames. Changed most around 3.2s.",
    );
    expect(line).not.toHaveTextContent(/passed|failed|flagged/i);
  });

  it("no drift on the wire → no drift line", () => {
    flags.STUDIO_IDENTITY_DRIFT = true;
    hook.data = wire();
    render(<QaChip assetId={ASSET} />);
    expect(screen.queryByTestId("qa-drift")).toBeNull();
  });

  it("with EXPO_PUBLIC_STUDIO_IDENTITY_DRIFT off the chip is exactly PR 11's, drift on the wire or not", () => {
    flags.STUDIO_IDENTITY_DRIFT = false;
    hook.data = withDrift();
    render(<QaChip assetId={ASSET} />);
    expect(screen.queryByTestId("qa-drift")).toBeNull();
    flags.STUDIO_IDENTITY_DRIFT = true;
  });
});

/**
 * quality-scrappy piece 2: a structure finding on the chip. ⚠️ MUTATION M2g: ignore `structure` when working out
 * `flagged` — "a clip the vision checks passed but that came back black is flagged" reds.
 */
describe("structure (quality-scrappy piece 2): flags the chip in the same two words, one plain line", () => {
  const passing = () => ({
    ...wire().verdict!,
    wording: "pass" as const,
    label: "Passed the check",
    identityObservation: null,
  });

  it("a clip the vision checks passed but that came back black is flagged, and says why in a sentence", () => {
    hook.data = wire({
      verdict: passing(),
      structure: {
        wording: "flag",
        label: "Flagged for a look",
        lines: ["Part of it is a black screen."],
      },
    });
    render(<QaChip assetId={ASSET} />);
    expect(screen.getByText("Flagged for a look")).toBeTruthy();
    expect(screen.getByText("icon:flag")).toBeTruthy();
    expect(screen.getByTestId("qa-structure")).toBeTruthy();
    expect(screen.getByText("Part of it is a black screen.")).toBeTruthy();
  });

  it("a stitch with only a structure record that passed reads as passed, with no extra line", () => {
    hook.data = wire({
      verdict: null,
      structure: { wording: "pass", label: "Passed the check", lines: [] },
    });
    render(<QaChip assetId={ASSET} />);
    expect(screen.getByText("Passed the check")).toBeTruthy();
    expect(screen.getByText("icon:check")).toBeTruthy();
    expect(screen.queryByTestId("qa-structure")).toBeNull();
  });

  it("no structure on the wire → the chip is exactly what it was", () => {
    hook.data = wire({ verdict: passing() });
    render(<QaChip assetId={ASSET} />);
    expect(screen.getByText("Passed the check")).toBeTruthy();
    expect(screen.queryByTestId("qa-structure")).toBeNull();
  });
});
