/**
 * SourceLinks.test — the web sources a search found, as links: only http(s), de-duplicated and capped; a tap opens the
 * page on native; on web each one is a real anchor (href, new tab, noopener) rather than a click handler.
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { Linking, Platform } from "react-native";
import { linkableSources, SourceLinks, sourceLabel } from "./SourceLinks";

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});

const SOURCES = [
  { url: "https://www.example.com/a", title: "A" },
  { url: "javascript:alert(1)", title: "bad" },
  { url: "ftp://files.example.com/x" },
  { url: "https://www.example.com/a", title: "dupe" },
  { url: "http://news.example.org/b", domain: "news.example.org" },
];

describe("SourceLinks", () => {
  const os = Platform.OS;
  afterEach(() => { (Platform as { OS: string }).OS = os; jest.restoreAllMocks(); });

  it("keeps only http(s) links, once each, and names each by its site", () => {
    expect(linkableSources(SOURCES).map((s) => s.url)).toEqual(["https://www.example.com/a", "http://news.example.org/b"]);
    expect(sourceLabel({ url: "https://www.example.com/a" })).toBe("example.com");
  });

  it("native: a tap opens the page in the browser", () => {
    (Platform as { OS: string }).OS = "ios";
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true as never);
    render(<SourceLinks sources={SOURCES} />);
    fireEvent.press(screen.getByLabelText("Open source: example.com"));
    expect(open).toHaveBeenCalledWith("https://www.example.com/a");
  });

  it("web: each source is an anchor with its href, opening in a new tab without an opener", () => {
    (Platform as { OS: string }).OS = "web";
    render(<SourceLinks sources={SOURCES} />);
    const link = screen.getByText("news.example.org");
    expect(link.props.href).toBe("http://news.example.org/b");
    expect(link.props.hrefAttrs).toEqual({ target: "_blank", rel: "noopener noreferrer" });
  });

  it("nothing linkable: nothing drawn", () => {
    render(<SourceLinks sources={[{ url: "javascript:alert(1)" }]} testID="row" />);
    expect(screen.queryByTestId("row")).toBeNull();
  });
});
