// BrandLogo — a brand's mark on the deal surfaces: a thin wrapper over ui/LogoMark so every brand row shares one
// presentation and one source chain (the stored logo → the domain's favicon → initials; never Clearbit).
// `borderRadius` is accepted for the older call sites and ignored: the mark's corner is its own.
//
// The older deal and Mila surfaces sometimes know only a brand's NAME. They have always shown that name's `.com`
// favicon rather than initials ("brand logos everywhere"), so this wrapper keeps that last-resort guess — generic,
// no brand list. Concept 0.4 surfaces use LogoMark directly and never guess.

import React from "react";
import { LogoMark } from "./ui/LogoMark";
import { domainFromLogoUrl } from "../lib/brand-logo";

interface BrandLogoProps {
  brandName:     string;
  brandDomain?:  string | null;
  /** The stored logo (inbox_brands.logo_url) when the row carries one. */
  logoUrl?:      string | null;
  size?:         number;
  borderRadius?: number;
}

/** "Red Bull" → "redbull.com". Only when nothing better is known. */
export function guessedBrandDomain(brandName: string): string | null {
  const slug = brandName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return slug ? `${slug}.com` : null;
}

export function BrandLogo({ brandName, brandDomain, logoUrl, size = 44 }: BrandLogoProps) {
  const domain = brandDomain ?? domainFromLogoUrl(logoUrl) ?? (logoUrl ? null : guessedBrandDomain(brandName));
  return <LogoMark logoUrl={logoUrl} domain={domain} name={brandName} size={size} />;
}
