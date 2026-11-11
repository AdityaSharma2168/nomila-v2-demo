// PlatformIcon — a connected platform's mark (Gmail, Outlook, Instagram, …): a thin wrapper over ui/LogoMark, so a
// platform is drawn exactly like a brand (white square, the site's mark, initials when nothing loads). `color` is
// accepted for the older call sites and ignored: the mark never takes a brand colour.

import React from "react";
import { LogoMark } from "./ui/LogoMark";

interface PlatformIconProps {
  platform: string;
  color?:   string;
  size?:    number;
}

export function PlatformIcon({ platform, size = 20 }: PlatformIconProps) {
  return <LogoMark platform={platform} name={platform} size={size} />;
}
