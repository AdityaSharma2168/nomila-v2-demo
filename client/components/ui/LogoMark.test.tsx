/**
 * LogoMark.test — the one logo presentation: a white square with the mark inset, the source chain (stored logo → the
 * domain's favicon → initials; a platform through its site; never Clearbit), the initials fallback, and the glyph
 * fallback for an organisation with no site. BrandLogo and PlatformIcon are thin wrappers over it.
 */
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { Image } from "react-native";
import { LogoMark, initialsOf } from "./LogoMark";
import { BrandLogo } from "../BrandLogo";
import { PlatformIcon } from "../PlatformIcon";

jest.mock("@expo/vector-icons", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { Feather: ({ name }: { name: string }) => React.createElement(Text, null, `icon:${name}`) };
});

const uri = () => screen.UNSAFE_queryAllByType(Image).map((i: any) => String(i.props.source?.uri ?? ""));

test("the stored logo first; a dead Clearbit logo falls through to the domain's favicon; a platform goes through its site", () => {
  const a = render(<LogoMark logoUrl="https://cdn.example/p.png" domain="brand.example" name="Brand P" />);
  expect(uri()).toEqual(["https://cdn.example/p.png"]);
  a.unmount();
  const b = render(<LogoMark logoUrl="https://logo.clearbit.com/brand.example" domain="brand.example" name="Brand P" />);
  expect(uri()).toEqual(["https://www.google.com/s2/favicons?domain=brand.example&sz=128"]);
  b.unmount();
  render(<LogoMark platform="tiktok" name="TikTok" size={36} />);
  expect(uri()).toEqual(["https://www.google.com/s2/favicons?domain=tiktok.com&sz=128"]);
  expect(JSON.stringify(screen.toJSON())).not.toContain("clearbit");
});

test("the square: corner 0.28 × size, the mark inset to 72%, a 1px border, white ground", () => {
  render(<LogoMark domain="brand.example" name="Brand P" size={52} />);
  const box = screen.getByTestId("logo-mark");
  const flat = Object.assign({}, ...[box.props.style].flat(Infinity).filter(Boolean));
  expect(flat).toMatchObject({ width: 52, height: 52, borderRadius: 15, borderWidth: 1, backgroundColor: "#FFFFFF" });
  const img = screen.UNSAFE_getByType(Image);
  expect(img.props.style).toMatchObject({ width: 37, height: 37 });
});

test("no source ⇒ the name's initials on the soft ground; a failed load ⇒ the same; an org with a glyph ⇒ the glyph", () => {
  const a = render(<LogoMark domain={null} name="Brand Two" />);
  expect(screen.getByTestId("logo-mark-fallback")).toBeTruthy();
  expect(screen.getByText("BT")).toBeTruthy();
  expect(uri()).toEqual([]);
  a.unmount();
  const b = render(<LogoMark domain="brand.example" name="Brand P" />);
  fireEvent(screen.UNSAFE_getByType(Image), "error");
  expect(screen.getByText("BP")).toBeTruthy();
  b.unmount();
  render(<LogoMark domain={null} name="U-20 National Team" fallbackIcon="flag" />);
  expect(screen.getByText("icon:flag")).toBeTruthy();
  expect(initialsOf("gorjana")).toBe("G");
  expect(initialsOf("  ")).toBe("?");
});

test("BrandLogo and PlatformIcon are the same mark: no Clearbit, no brand colour; legacy deal rows keep the name guess", () => {
  const a = render(<BrandLogo brandName="Brand P" brandDomain="brand.example" size={36} borderRadius={10} />);
  expect(uri()).toEqual(["https://www.google.com/s2/favicons?domain=brand.example&sz=128"]);
  a.unmount();
  // A stored Yoku logo is used as stored.
  const y = render(<BrandLogo brandName="Brand P" logoUrl="https://cdn.yoku.app/brand.example/type/logo/w/256/format/png/fallback/404" size={36} />);
  expect(uri()).toEqual(["https://cdn.yoku.app/brand.example/type/logo/w/256/format/png/fallback/404"]);
  y.unmount();
  // The older deal / Mila rows that know only a name keep their last-resort `.com` favicon (no brand list).
  const b = render(<BrandLogo brandName="Brand P" size={36} />);
  expect(uri()).toEqual(["https://www.google.com/s2/favicons?domain=brandp.com&sz=128"]);
  b.unmount();
  // LogoMark itself (the Concept 0.4 surfaces) never guesses: no domain ⇒ initials.
  const m = render(<LogoMark name="Brand P" size={36} />);
  expect(uri()).toEqual([]);
  expect(screen.getByText("BP")).toBeTruthy();
  m.unmount();
  render(<PlatformIcon platform="instagram" color="#E1306C" size={24} />);
  expect(uri()).toEqual(["https://www.google.com/s2/favicons?domain=instagram.com&sz=128"]);
  expect(JSON.stringify(screen.toJSON())).not.toContain("#E1306C");
});

test("a stored logo that fails to load steps down to the domain's favicon before the initials (a Yoku miss is never a letter)", () => {
  render(<LogoMark logoUrl="https://cdn.yoku.app/brand.example/type/logo/w/256/format/png/fallback/lettermark" name="Brand P" size={36} />);
  expect(uri()).toEqual(["https://cdn.yoku.app/brand.example/type/logo/w/256/format/png/fallback/404"]);
  fireEvent(screen.UNSAFE_getByType(Image), "error");
  expect(uri()).toEqual(["https://www.google.com/s2/favicons?domain=brand.example&sz=128"]);
  expect(screen.queryByText("BP")).toBeNull();
  fireEvent(screen.UNSAFE_getByType(Image), "error");
  expect(uri()).toEqual([]);
  expect(screen.getByText("BP")).toBeTruthy();
});
