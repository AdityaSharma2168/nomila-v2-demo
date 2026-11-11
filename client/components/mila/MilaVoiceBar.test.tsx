/**
 * MilaVoiceBar.test — the inline voice bar in the Muse look: a frosted bar saying the header's own status words
 * (milaActivity), no pink ground or outline, and the same behaviour as before (End voice ends; "Mic off" receipt).
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { StyleSheet } from "react-native";
import { MilaVoiceBar } from "./MilaVoiceBar";
import { ACTIVITY_LABEL } from "./milaActivity";

jest.mock("@expo/vector-icons", () => ({ Feather: () => null }));
jest.mock("expo-blur", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { BlurView: (p: Record<string, unknown>) => React.createElement(View, p) };
});

describe("MilaVoiceBar", () => {
  it.each([
    ["connecting", ACTIVITY_LABEL.connecting],
    ["listening", ACTIVITY_LABEL.listening],
    ["speaking", ACTIVITY_LABEL.speaking],
  ] as const)("%s: says the header's word on a frosted bar with no border", (state, word) => {
    render(<MilaVoiceBar variant="composer" state={state} justEnded={false} onEnd={jest.fn()} />);
    expect(screen.getByText(word)).toBeTruthy();
    expect(screen.getByLabelText(`Voice is on. ${word}.`)).toBeTruthy();
    expect(screen.getAllByTestId("frost-blur").length).toBeGreaterThanOrEqual(1);
    const bar = StyleSheet.flatten(screen.getByTestId("mila-voice-bar").props.style);
    expect(bar.borderWidth ?? 0).toBe(0);
  });

  it("End voice still ends the session", () => {
    const onEnd = jest.fn();
    render(<MilaVoiceBar variant="composer" state="listening" justEnded={false} onEnd={onEnd} />);
    fireEvent.press(screen.getByLabelText("End voice session"));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("says Mic off just after it ends, and nothing otherwise", () => {
    const { rerender } = render(<MilaVoiceBar state="idle" justEnded onEnd={jest.fn()} />);
    expect(screen.getByText("Mic off")).toBeTruthy();
    rerender(<MilaVoiceBar state="idle" justEnded={false} onEnd={jest.fn()} />);
    expect(screen.queryByText("Mic off")).toBeNull();
  });

  it("offers Tap to hear Mila when the browser blocks her audio, and the tap resumes it", () => {
    const onResumeAudio = jest.fn();
    render(
      <MilaVoiceBar variant="composer" state="speaking" justEnded={false} onEnd={jest.fn()} audioBlocked onResumeAudio={onResumeAudio} />,
    );
    expect(screen.queryByText(ACTIVITY_LABEL.speaking)).toBeNull();
    fireEvent.press(screen.getByLabelText("Tap to hear Mila"));
    expect(onResumeAudio).toHaveBeenCalledTimes(1);
    // End voice is still there.
    expect(screen.getByLabelText("End voice session")).toBeTruthy();
  });
});
