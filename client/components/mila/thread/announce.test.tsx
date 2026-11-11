/**
 * announce.test — VoiceOver hears the status line on iOS (AccessibilityInfo.announceForAccessibility, mocked): only when
 * its words change, at most once every 2 s (a change inside the gap is held and the newest is spoken when it ends),
 * never on Android or the web (their live regions read it), and nothing is spoken after unmount.
 */
import React from "react";
import { act, render } from "@testing-library/react-native";
import { AccessibilityInfo, Platform } from "react-native";
import { ANNOUNCE_MIN_GAP_MS, createAnnouncer, useStatusAnnouncement } from "./announce";

function Probe({ label, os = "ios" }: { label: string | null; os?: string }) {
  useStatusAnnouncement(label, os);
  return null;
}

let spy: jest.SpyInstance;
beforeEach(() => {
  jest.useFakeTimers();
  // RN's jest setup already makes this a jest.fn, which spyOn hands back as it is: clear what earlier tests left on it.
  spy = jest.spyOn(AccessibilityInfo, "announceForAccessibility").mockImplementation(() => {});
  spy.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("createAnnouncer (the throttle)", () => {
  it("speaks a new line at once, never the same words twice in a row, and drops the trailing ellipsis", () => {
    const said: string[] = [];
    const a = createAnnouncer((t) => said.push(t));
    a.update("Thinking…");
    a.update("Thinking…");
    expect(said).toEqual(["Thinking"]);
  });

  it("at most once every 2 s: a burst inside the gap speaks only its newest line, when the gap ends", () => {
    const said: string[] = [];
    const a = createAnnouncer((t) => said.push(t));
    a.update("Thinking…");
    jest.advanceTimersByTime(300);
    a.update("Looking at your deals…");
    a.update("Reading your inbox…");
    expect(said).toEqual(["Thinking"]);
    jest.advanceTimersByTime(ANNOUNCE_MIN_GAP_MS - 301);
    expect(said).toEqual(["Thinking"]);
    jest.advanceTimersByTime(1);
    expect(said).toEqual(["Thinking", "Reading your inbox"]);
    // A change well after the gap is spoken at once.
    jest.advanceTimersByTime(ANNOUNCE_MIN_GAP_MS);
    a.update("Writing your reply…");
    expect(said).toEqual(["Thinking", "Reading your inbox", "Writing your reply"]);
  });

  it("an empty line drops what was held; the same line after it is spoken again; dispose cancels the wait", () => {
    const said: string[] = [];
    const a = createAnnouncer((t) => said.push(t));
    a.update("Thinking…");
    a.update("Looking at your deals…");
    a.update(null);
    jest.advanceTimersByTime(ANNOUNCE_MIN_GAP_MS * 2);
    expect(said).toEqual(["Thinking"]);
    a.update("Thinking…");
    expect(said).toEqual(["Thinking", "Thinking"]);
    a.update("Mila is still working…");
    a.dispose();
    jest.advanceTimersByTime(ANNOUNCE_MIN_GAP_MS * 2);
    expect(said).toEqual(["Thinking", "Thinking"]);
  });
});

describe("useStatusAnnouncement", () => {
  it("iOS: announces each new status line through AccessibilityInfo, throttled; nothing after unmount", () => {
    expect(Platform.OS).toBe("ios"); // the test platform: the hook's default reads it
    const view = render(<Probe label="Thinking…" os={Platform.OS} />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith("Thinking");
    view.rerender(<Probe label="Thinking…" />);
    view.rerender(<Probe label="Looking at your deals…" />);
    expect(spy).toHaveBeenCalledTimes(1);
    act(() => { jest.advanceTimersByTime(ANNOUNCE_MIN_GAP_MS); });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith("Looking at your deals");
    view.rerender(<Probe label="Mila is still working…" />);
    view.unmount();
    act(() => { jest.advanceTimersByTime(ANNOUNCE_MIN_GAP_MS * 2); });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it.each(["android", "web"])("%s: never announces (its live region reads the line)", (os) => {
    const view = render(<Probe label="Thinking…" os={os} />);
    view.rerender(<Probe label="Looking at your deals…" os={os} />);
    act(() => { jest.advanceTimersByTime(ANNOUNCE_MIN_GAP_MS * 2); });
    expect(spy).not.toHaveBeenCalled();
  });
});
