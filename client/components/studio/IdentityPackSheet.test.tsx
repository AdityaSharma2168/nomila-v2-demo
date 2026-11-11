/**
 * IdentityPackSheet.test.tsx — the pack surface, rendered, with the hooks and the flag mocked at the
 * module boundary. No network.
 *
 * REVERT CHECKS, red by name:
 *   "pack surface renders with STUDIO_IDENTITY_PACK off" → drop the flag check in IdentityPackSheet
 *   "pack shows a pass/fail word about her face"          → caption the standing with a verdict word
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import type {
  CandidateWire,
  IdentityProfileWire,
} from "../../hooks/use-identity-pack";

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    Feather: ({ name }: { name: string }) =>
      React.createElement(Text, null, `icon:${name}`),
  };
});

const flags = { STUDIO_IDENTITY_PACK: true };
jest.mock("../../lib/flags", () => flags);

const invalidate = jest.fn(async () => {});
jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: invalidate }),
}));

class RightsAckRequiredMock extends Error {}
const pick = jest.fn();
const uploadMutateAsync = jest.fn();
jest.mock("../../hooks/use-media-library", () => ({
  pickFromCameraRoll: (...a: unknown[]) => pick(...a),
  RightsAckRequired: RightsAckRequiredMock,
  useUploadMediaBatch: () => ({
    mutateAsync: uploadMutateAsync,
    isPending: false,
  }),
}));
jest.mock("../media/RightsAckPanel", () => {
  const React = require("react");
  const { Pressable, Text } = require("react-native");
  return {
    RightsAckPanel: ({ onConfirm }: { onConfirm: () => void }) =>
      React.createElement(
        Pressable,
        { onPress: onConfirm, testID: "rights-ack-confirm" },
        React.createElement(Text, null, "I own these"),
      ),
  };
});

const state: {
  profile: IdentityProfileWire | null;
  candidates: CandidateWire[];
  calls: number;
} = {
  profile: null,
  candidates: [],
  calls: 0,
};
const saveMutate = jest.fn();
const saveData: { value: unknown } = { value: undefined };
const calibrateMutate = jest.fn();
jest.mock("../../hooks/use-identity-pack", () => ({
  useIdentityProfile: () => {
    state.calls += 1;
    return {
      data: state.profile
        ? {
            profile: state.profile,
            quote: { faceBoxUsd: 0.0065, embedUsd: 0.0012, usd: 0.0077 },
          }
        : undefined,
    };
  },
  useIdentityCandidates: () => {
    state.calls += 1;
    return { data: { candidates: state.candidates }, isLoading: false };
  },
  useSavePack: () => ({
    mutate: saveMutate,
    isPending: false,
    data: saveData.value,
    error: null,
  }),
  useCalibratePack: () => ({
    mutate: calibrateMutate,
    isPending: false,
    data: undefined,
    error: null,
  }),
}));

import { IdentityPackSheet, refusalWord } from "./IdentityPackSheet";

/** Every string a rendered tree would put on screen, joined. Props and styles are not text. */
function renderedText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node + " ";
  if (Array.isArray(node)) return node.map(renderedText).join("");
  if (typeof node === "object" && "children" in (node as object))
    return renderedText((node as { children?: unknown }).children);
  return "";
}

const cand = (
  id: string,
  over: Partial<CandidateWire> = {},
): CandidateWire => ({
  assetId: id,
  thumbUrl: `https://x/${id}`,
  eligible: true,
  refusal: null,
  reason: null,
  inPack: false,
  ...over,
});
const profile = (
  over: Partial<IdentityProfileWire> = {},
): IdentityProfileWire => ({
  pack: [],
  incomplete: true,
  min: 10,
  max: 15,
  band: null,
  controlPassed: null,
  controlMeasuredAt: null,
  embedder: null,
  standing: "No pack yet.",
  ...over,
});

beforeEach(() => {
  flags.STUDIO_IDENTITY_PACK = true;
  state.profile = profile();
  state.candidates = [];
  state.calls = 0;
  saveMutate.mockReset();
  saveData.value = undefined;
  calibrateMutate.mockReset();
  invalidate.mockClear();
  pick.mockReset();
  uploadMutateAsync.mockReset();
});

describe("off is nothing", () => {
  it("pack surface renders with STUDIO_IDENTITY_PACK off — renders nothing and mounts no hook", () => {
    flags.STUDIO_IDENTITY_PACK = false;
    state.candidates = [cand("a")];
    render(<IdentityPackSheet visible onClose={() => {}} />);
    expect(screen.queryByTestId("identity-pack-sheet")).toBeNull();
    expect(state.calls).toBe(0);
  });
});

describe("on: her photos, judged, and the standing as the server says it", () => {
  it("a refused tile says why and cannot be picked; an eligible one can", () => {
    state.candidates = [
      cand("gen", {
        eligible: false,
        refusal: "generated",
        reason: "This was made here, not photographed.",
      }),
      cand("them", { eligible: false, refusal: "not_you", reason: "Not you." }),
      cand("nf", {
        eligible: false,
        refusal: "likeness_no_face",
        reason: "No face.",
      }),
      cand("ok"),
    ];
    render(<IdentityPackSheet visible onClose={() => {}} />);
    expect(screen.getByText("Made here")).toBeTruthy();
    expect(screen.getByText("Not you")).toBeTruthy();
    expect(screen.getByText("No face")).toBeTruthy();
    fireEvent.press(screen.getByTestId("pack-tile-gen"));
    expect(screen.getByTestId("pack-count")).toHaveTextContent(
      "0 of 15 picked",
    );
    fireEvent.press(screen.getByTestId("pack-tile-ok"));
    expect(screen.getByTestId("pack-count")).toHaveTextContent(
      "1 of 15 picked",
    );
    fireEvent.press(screen.getByTestId("pack-save"));
    expect(saveMutate).toHaveBeenCalledWith({ assetIds: ["ok"] });
  });

  it("never more than max picked", () => {
    state.profile = profile({ max: 2 });
    state.candidates = [cand("a"), cand("b"), cand("c")];
    render(<IdentityPackSheet visible onClose={() => {}} />);
    for (const id of ["a", "b", "c"])
      fireEvent.press(screen.getByTestId(`pack-tile-${id}`));
    expect(screen.getByTestId("pack-count")).toHaveTextContent("2 of 2 picked");
  });

  it("pack shows a pass/fail word about her face — the standing is the server's sentence, and it carries no verdict word", () => {
    state.profile = profile({
      pack: [
        {
          assetId: "a",
          faceSizeFrac: 0.3,
          prominence: 0.9,
          faceVisibility: "clear",
        },
      ],
      incomplete: true,
      band: {
        min: 0.2,
        max: 0.5,
        pairs: 66,
        measuredAt: "2026-09-24T00:00:00.000Z",
      },
      controlPassed: false,
      standing:
        "Measured, but the stranger control did not pass: a stranger scored inside her band. Identity stays an observation, never a check.",
    });
    render(<IdentityPackSheet visible onClose={() => {}} />);
    const standing = screen.getByTestId("pack-standing");
    expect(standing).toHaveTextContent(/stranger control did not pass/);
    // Rendered TEXT only — style numbers (opacities) are not what she reads.
    const text = renderedText(screen.toJSON()).toLowerCase();
    expect(text).not.toMatch(
      /identity (passed|failed)|face (passed|failed)|0\.5|0\.2|threshold/,
    );
  });

  it("the measure button says the quote first, and pressing it is the go", () => {
    state.profile = profile({
      pack: [
        {
          assetId: "a",
          faceSizeFrac: null,
          prominence: 0.9,
          faceVisibility: "clear",
        },
      ],
    });
    render(<IdentityPackSheet visible onClose={() => {}} />);
    expect(screen.getByTestId("pack-measure")).toHaveTextContent(
      "Measure · $0.0077",
    );
    fireEvent.press(screen.getByTestId("pack-measure"));
    expect(calibrateMutate).toHaveBeenCalledTimes(1);
  });

  it("refusalWord names every gate reason in two words", () => {
    expect(refusalWord("generated")).toBe("Made here");
    expect(refusalWord("not_you")).toBe("Not you");
    expect(refusalWord("likeness_no_face")).toBe("No face");
    expect(refusalWord("rejected")).toBe("Set aside");
    expect(refusalWord(null)).toBeNull();
  });
});

describe("Add photos — the library's upload, on the sheet", () => {
  const assets = [{ uri: "file:///a.jpg" }, { uri: "file:///b.jpg" }];

  it("an uploaded photo is auto-picked into the pack — it lands in the list as 'Still reading' and is NOT picked", async () => {
    state.candidates = [cand("old")];
    pick.mockResolvedValue({ assets, truncated: null });
    uploadMutateAsync.mockImplementation(async () => {
      // The server's answer: two rows, unread until the tagger runs — as the refetched list shows them.
      state.candidates = [
        cand("old"),
        cand("up1", {
          eligible: false,
          refusal: "reference_unread",
          reason: "We're still reading this photo.",
        }),
        cand("up2", {
          eligible: false,
          refusal: "reference_unread",
          reason: "We're still reading this photo.",
        }),
      ];
      return {
        succeeded: [{ asset_id: "up1" }, { asset_id: "up2" }],
        failed: [],
      };
    });
    render(<IdentityPackSheet visible onClose={() => {}} />);
    fireEvent.press(screen.getByTestId("pack-add-photos"));
    await screen.findByTestId("pack-upload-note");
    expect(pick).toHaveBeenCalledWith("photo", { multiple: true });
    expect(uploadMutateAsync).toHaveBeenCalledWith({
      assets,
      ackRights: false,
    });
    expect(invalidate).toHaveBeenCalled();
    expect(screen.getAllByText("Still reading")).toHaveLength(2);
    expect(screen.getByTestId("pack-count")).toHaveTextContent(
      "0 of 15 picked",
    );
    expect(screen.getByTestId("pack-upload-note")).toHaveTextContent(
      /Added 2 of 2/,
    );
  });

  it("an unread upload can be picked — pressing a 'Still reading' tile does nothing", () => {
    state.candidates = [
      cand("up1", {
        eligible: false,
        refusal: "reference_unread",
        reason: "We're still reading this photo.",
      }),
    ];
    render(<IdentityPackSheet visible onClose={() => {}} />);
    fireEvent.press(screen.getByTestId("pack-tile-up1"));
    expect(screen.getByTestId("pack-count")).toHaveTextContent(
      "0 of 15 picked",
    );
    fireEvent.press(screen.getByTestId("pack-save"));
    expect(saveMutate).not.toHaveBeenCalled();
  });

  it("the rights attestation is the same panel the library upload uses, and confirming re-sends with ackRights", async () => {
    pick.mockResolvedValue({ assets, truncated: null });
    uploadMutateAsync
      .mockRejectedValueOnce(new RightsAckRequiredMock("ack"))
      .mockResolvedValueOnce({ succeeded: [{ asset_id: "up1" }], failed: [] });
    render(<IdentityPackSheet visible onClose={() => {}} />);
    fireEvent.press(screen.getByTestId("pack-add-photos"));
    const confirm = await screen.findByTestId("rights-ack-confirm");
    fireEvent.press(confirm);
    await screen.findByTestId("pack-upload-note");
    expect(uploadMutateAsync).toHaveBeenLastCalledWith({
      assets,
      ackRights: true,
    });
  });
});

describe("the body-shot nudge", () => {
  it("pack saves silently with no body shot — the nudge shows after a close-up-only save, and only then", () => {
    saveData.value = {
      profile: profile(),
      refused: [],
      overCap: [],
      partialAdmitted: false,
      nudge:
        "Add a full-length photo so your build carries too — every photo here is a close-up.",
    };
    render(<IdentityPackSheet visible onClose={() => {}} />);
    expect(screen.getByTestId("pack-nudge")).toHaveTextContent(
      /full-length photo/,
    );
  });

  it("no nudge when the server sent none", () => {
    saveData.value = {
      profile: profile(),
      refused: [],
      overCap: [],
      partialAdmitted: false,
      nudge: null,
    };
    render(<IdentityPackSheet visible onClose={() => {}} />);
    expect(screen.queryByTestId("pack-nudge")).toBeNull();
  });
});
