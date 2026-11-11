/**
 * ConfirmBriefStep.test — the confirm surface, rendered: inferred lines read differently from literal
 * ones, and nothing proceeds until each inferred line is confirmed.
 *
 * REVERT CHECKS, red by name:
 *   RC-1  render every row with the same label prefix   → "renders the inferred lines distinguishably from the literal ones"
 *   RC-2  enable "Use this brief" from the start         → "nothing proceeds unconfirmed…"
 *   RC-3  hand a rebuilt object to onConfirm             → "…goes on with the proposal it was given, unchanged"
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Linking } from "react-native";
import { echoBrief } from "../../../server/studio/direction/echo";
import { validateBriefProposal } from "../../../server/studio/direction/envelope";
import {
  confirmRows,
  READ_AS_IMAGE,
  readProposal,
  UNVERIFIED_LINE,
  type BriefProposal,
} from "../../screens/studio/directionLogic";
import { ConfirmBriefStep } from "./ConfirmBriefStep";

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    Feather: ({ name }: { name: string }) =>
      React.createElement(Text, null, `icon:${name}`),
  };
});
jest.mock("../../lib/haptics", () => {
  const noop = () => {};
  const fns = {
    tap: noop,
    press: noop,
    select: noop,
    success: noop,
    warning: noop,
    error: noop,
  };
  return { ...fns, haptics: fns };
});

/** As it arrives: the server's tool, through JSON, through the reader. */
const arrived = (): BriefProposal =>
  readProposal(
    JSON.parse(
      JSON.stringify(
        echoBrief({ brand: "Solstice", productLine: "the matte-black bottle" }),
      ),
    ),
  )!;

const isDisabled = (label: string) =>
  screen.getByLabelText(label).props.accessibilityState?.disabled === true;

describe("ConfirmBriefStep", () => {
  it("renders the inferred lines distinguishably from the literal ones", () => {
    const p = arrived();
    render(
      <ConfirmBriefStep
        proposal={p}
        brandName="Solstice"
        onBack={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    const inferred = p.flags.filter((f) => f.basis === "inferred").length;
    const literal = p.flags.filter((f) => f.basis === "literal").length;
    expect(inferred).toBeGreaterThan(0);
    expect(literal).toBe(2);
    expect(screen.getAllByLabelText(/^Inferred: /)).toHaveLength(inferred);
    expect(screen.getAllByLabelText(/^From the brief: /)).toHaveLength(literal);
    // A literal line shows the words it was read from; an inferred one its because and a Confirm.
    expect(screen.getByText("“Solstice”")).toBeTruthy();
    expect(screen.getAllByText(/fixed sample/)).toHaveLength(inferred);
    expect(screen.getAllByLabelText(/^Confirm /)).toHaveLength(inferred);
    expect(screen.queryByLabelText("Confirm Brand")).toBeNull(); // literal: read, not tapped
  });

  it("nothing proceeds unconfirmed: 'Use this brief' is off until every inferred line is confirmed, then goes on with the proposal it was given, unchanged", () => {
    const p = arrived();
    const onConfirm = jest.fn();
    render(
      <ConfirmBriefStep
        proposal={p}
        brandName="Solstice"
        onBack={jest.fn()}
        onConfirm={onConfirm}
      />,
    );
    expect(isDisabled("Use this brief")).toBe(true);
    fireEvent.press(screen.getByLabelText("Use this brief"));
    expect(onConfirm).not.toHaveBeenCalled();

    const confirms = screen.getAllByLabelText(/^Confirm /);
    confirms.slice(0, -1).forEach((b) => fireEvent.press(b));
    expect(isDisabled("Use this brief")).toBe(true); // one left

    fireEvent.press(confirms[confirms.length - 1]);
    expect(isDisabled("Use this brief")).toBe(false);
    expect(screen.getAllByLabelText(/^Confirmed /)).toHaveLength(
      confirms.length,
    );

    fireEvent.press(screen.getByLabelText("Use this brief"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][0]).toBe(p); // the very object, not a copy
  });

  it("a confirmed line can be un-confirmed, and the door closes again", () => {
    const p = arrived();
    render(
      <ConfirmBriefStep
        proposal={p}
        brandName="Solstice"
        onBack={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    screen.getAllByLabelText(/^Confirm /).forEach((b) => fireEvent.press(b));
    expect(isDisabled("Use this brief")).toBe(false);
    fireEvent.press(screen.getByLabelText("Confirmed Feel"));
    expect(isDisabled("Use this brief")).toBe(true);
  });

  it("Back is hers at any point", () => {
    const onBack = jest.fn();
    render(
      <ConfirmBriefStep
        proposal={arrived()}
        brandName="Solstice"
        onBack={onBack}
        onConfirm={jest.fn()}
      />,
    );
    fireEvent.press(screen.getByLabelText("Back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

/** A moment as research_moment writes it, on the echo's brief — valid by the server's schema. */
const momentArrived = (
  sources: {
    title: string | null;
    url: string | null;
    domain: string | null;
  }[],
): BriefProposal => {
  const base = echoBrief({
    brand: "Solstice",
    productLine: "the matte-black bottle",
  });
  const wireObj = {
    ...base,
    sourceTool: "research_moment",
    brief: { ...base.brief, story: "Derby week: Crosstown United at home" },
    flags: [
      ...base.flags,
      {
        path: "story",
        basis: "inferred",
        because: "found by web search — localpaper.example",
      },
    ],
    extras: {
      constraints: [],
      notes: ["Found by web search: 2 sources cited."],
      moment: {
        title: "Derby week: Crosstown United at home",
        summary: "The town's derby returns.",
        sources,
        searchQueries: ["crosstown derby"],
        dateBasis: "none",
        timingRemoved: ["2026"],
      },
    },
  };
  expect(validateBriefProposal(wireObj).ok).toBe(true);
  return readProposal(JSON.parse(JSON.stringify(wireObj)))!;
};

describe("ConfirmBriefStep — a moment", () => {
  /** ⚠️ MUTATION: render the sources list for an empty list — "an unverified moment says so" reds. */
  it("an unverified moment says so, in its own words, and still waits for every inferred line", () => {
    const p = momentArrived([]);
    render(
      <ConfirmBriefStep
        proposal={p}
        brandName="Solstice"
        onBack={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    expect(screen.getByLabelText("Unverified moment")).toHaveTextContent(
      UNVERIFIED_LINE,
    );
    expect(
      screen.getByText(/Confirm only if you know it is real/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Timing the search supplied was removed: 2026/),
    ).toBeTruthy();
    expect(isDisabled("Use this brief")).toBe(true);
  });

  it("a cited moment lists its sources by domain, each a clickable link to its page, and says nothing about being unverified", () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never);
    render(
      <ConfirmBriefStep
        proposal={momentArrived([
          {
            title: "Derby preview",
            url: "https://r.example/a",
            domain: "localpaper.example",
          },
          {
            title: null,
            url: "https://league.example/f",
            domain: "league.example",
          },
        ])}
        brandName="Solstice"
        onBack={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    expect(screen.getByText("localpaper.example")).toBeTruthy();
    expect(screen.getByText("league.example")).toBeTruthy();
    expect(screen.queryByLabelText("Unverified moment")).toBeNull();
    // OpenAI's terms: web results are shown with prominent, clickable citations.
    fireEvent.press(screen.getByLabelText("Open source: localpaper.example"));
    expect(open).toHaveBeenCalledWith("https://r.example/a");
    fireEvent.press(screen.getByLabelText("Open source: league.example"));
    expect(open).toHaveBeenCalledWith("https://league.example/f");
    open.mockRestore();
  });

});

describe("ConfirmBriefStep — what the tool noticed", () => {
  /** ⚠️ MUTATION: drop the notes card — "the tool's own notes are shown" reds; keep the ordinary lead
   *  for an unavailable extraction — "a document read as an image says so above the rows" reds. */
  it("the tool's own notes are shown, and a document read as an image says so above the rows", () => {
    const base = arrived();
    const thin: BriefProposal = {
      ...base,
      extras: {
        ...base.extras,
        extraction: "unavailable",
        notes: [
          "I read this as an image — no text could be quoted.",
          "Read 2 of 2 pages.",
        ],
      },
    };
    render(
      <ConfirmBriefStep
        proposal={thin}
        brandName="Solstice"
        onBack={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    expect(screen.getByLabelText("Read as an image")).toHaveTextContent(
      READ_AS_IMAGE,
    );
    expect(screen.getByLabelText("What I noticed")).toBeTruthy();
    expect(screen.getByText("Read 2 of 2 pages.")).toBeTruthy();
  });

  it("with text extracted and nothing noticed, the lead is the ordinary one and no notes card is drawn", () => {
    const base = arrived();
    render(
      <ConfirmBriefStep
        proposal={{ ...base, extras: { ...base.extras, notes: [] } }}
        brandName="Solstice"
        onBack={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    expect(screen.queryByLabelText("Read as an image")).toBeNull();
    expect(screen.queryByLabelText("What I noticed")).toBeNull();
  });
});

describe("ConfirmBriefStep — a reference", () => {
  it("renders the reference as a human line under a CONTEXT badge, with no Confirm pill, and the door opens once the other inferred lines are tapped", () => {
    const base = arrived();
    const intent = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `dim_${i}`,
        { summary: `d${i}`, basis: "observed" },
      ]),
    );
    const p = readProposal(
      JSON.parse(
        JSON.stringify({
          ...base,
          sourceTool: "decompose_reference",
          brief: {
            ...base.brief,
            references: [{ ref: "ref_1", role: "style_reference", intent }],
          },
          flags: [
            ...base.flags,
            {
              path: "references",
              basis: "inferred",
              because: "the reference, decomposed along 9 dimensions",
            },
          ],
        }),
      ),
    )!;
    render(
      <ConfirmBriefStep
        proposal={p}
        brandName="Solstice"
        onBack={jest.fn()}
        onConfirm={jest.fn()}
      />,
    );
    expect(
      screen.getByText("style reference · read on 9 of 12 dimensions"),
    ).toBeTruthy();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
    expect(screen.queryByLabelText("Confirm References")).toBeNull();
    expect(screen.getByText("CONTEXT")).toBeTruthy();
    for (const path of p.flags
      .filter((f) => f.basis === "inferred" && f.path !== "references")
      .map((f) => f.path)) {
      const label = confirmRows(p).find((r) => r.path === path)!.label;
      fireEvent.press(screen.getByLabelText(`Confirm ${label}`));
    }
    expect(isDisabled("Use this brief")).toBe(false);
  });
});
