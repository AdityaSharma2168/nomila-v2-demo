/**
 * MusicSuggestion.test.tsx — the suggestion, rendered: she sees the track AND why.
 */
import { render, screen } from "@testing-library/react-native";
import { MusicSuggestion } from "./MusicSuggestion";

// The icon set needs a native module; mocked at the boundary exactly as PublishPill.test.tsx does.
jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    Feather: ({ name }: { name: string }) =>
      React.createElement(Text, null, `icon:${name}`),
  };
});

const reason = "warm · 84 BPM, slow · energy 2/5";

describe("the Suggested line", () => {
  it("names the suggested track", () => {
    render(<MusicSuggestion label="Walking Around" reason={reason} />);
    expect(screen.getByText("Suggested: Walking Around")).toBeTruthy();
  });

  it("shows the reason she is given, as the server wrote it", () => {
    render(<MusicSuggestion label="Walking Around" reason={reason} />);
    expect(screen.getByText(reason)).toBeTruthy();
  });

  it("reads both out to a screen reader", () => {
    render(<MusicSuggestion label="Walking Around" reason={reason} />);
    expect(
      screen.getByLabelText(`Suggested track: Walking Around. ${reason}`),
    ).toBeTruthy();
  });
});
