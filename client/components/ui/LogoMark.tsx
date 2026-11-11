// LogoMark — the ONE way a brand, an organisation or a platform shows its mark (visual rules, Oct 2026).
//
//   <LogoMark logoUrl domain name size={36} />      a white square, corner 0.28 × size, 1px border, the logo inset to 72%
//   <LogoMark platform="tiktok" name="TikTok" />    a connected platform: its site's mark through the same chain
//   <LogoMark domain={null} name="Acme" />           no source ⇒ the name's initials on the soft ground
//   <LogoMark … fallbackIcon="flag" />               an organisation with no site of its own: a Feather glyph instead
//   <LogoMark … bold />                              look B (DESIGN.md, Oct 2026): corner 4, the cool line, initials in ink
//
// Source chain = lib/brand-logo `brandLogoChain(logoUrl, domain ?? platformDomain(platform))`: the stored logo (never a
// dead Clearbit URL; a Yoku logo in its fail-on-miss form) → Google's favicon for the domain (given, or read off the
// stored logo's URL) → the initials. A source that fails to load steps down to the next, never straight to initials. Never a brand-colour fill, never a guessed
// domain. Sizes on the Concept 0.4 surfaces: 24 (inline source), 36–40 (rows, cards), 48 (a hero mark).

import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { brandLogoChain, platformDomain } from "../../lib/brand-logo";
import { Colors, Type, Bold, BoldType } from "../../constants/theme";
import { Photo } from "./Photo";

const C = Colors.light;
type IconName = React.ComponentProps<typeof Feather>["name"];

export const LOGO_MARK_SIZES = { sm: 24, md: 36, lg: 52 } as const;

export interface LogoMarkProps {
  /** The stored logo (inbox_brands.logo_url); a dead Clearbit URL is ignored. */
  logoUrl?: string | null;
  /** The brand's or organisation's own domain. */
  domain?: string | null;
  /** A connected platform id (instagram, tiktok, gmail…); its site is the domain when none is given. */
  platform?: string | null;
  /** What the mark stands for: the initials fallback and the accessibility label. */
  name: string;
  /** 24 · 36 · 52 on the Concept 0.4 surfaces; legacy brand rows pass their own through BrandLogo. */
  size?: number;
  /** For an organisation with nothing to load (a national team): this glyph instead of the initials. */
  fallbackIcon?: IconName;
  /** Look B: corner 4, the cool line, initials in ink (900). */
  bold?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map((w) => w[0]) : [name.trim().slice(0, 1)];
  return letters.join("").toUpperCase() || "?";
}

export function LogoMark({ logoUrl, domain, platform, name, size = LOGO_MARK_SIZES.md, fallbackIcon, bold, style, testID }: LogoMarkProps) {
  const chain = brandLogoChain(logoUrl, domain ?? platformDomain(platform));
  const chainKey = chain.join(" ");
  const [step, setStep] = useState(0);
  // A reused instance whose source changes (the analytics badge swaps platforms) starts over.
  useEffect(() => { setStep(0); }, [chainKey]);
  const uri = chain[step] ?? null;
  const box = { width: size, height: size, borderRadius: bold ? Bold.radius.control : Math.round(size * 0.28) };
  const inset = Math.round(size * 0.72);

  if (uri) {
    return (
      <View style={[styles.mark, bold && styles.markBold, box, style]} accessibilityRole="image" accessibilityLabel={name} testID={testID ?? "logo-mark"}>
        <Photo uri={uri} style={{ width: inset, height: inset }} contentFit="contain" transition={0} onError={() => setStep((n) => n + 1)} />
      </View>
    );
  }
  return (
    <View style={[styles.mark, bold ? styles.markBold : styles.blank, box, style]} accessibilityRole="image" accessibilityLabel={name} testID={testID ?? "logo-mark-fallback"}>
      {fallbackIcon
        ? <Feather name={fallbackIcon} size={Math.round(size * 0.45)} color={bold ? Bold.ink : C.textMuted} />
        : <Text style={[bold ? styles.initialsBold : styles.initials, { fontSize: Math.round(size * 0.36), lineHeight: Math.round(size * 0.44) }]}>{initialsOf(name)}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  mark:         { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  markBold:     { backgroundColor: Bold.paper, borderColor: Bold.line },
  blank:        { backgroundColor: C.backgroundDefault, borderColor: C.backgroundDefault },
  initials:     { fontFamily: Type.chip.fontFamily, color: C.textMuted, letterSpacing: 0.3 },
  initialsBold: { fontFamily: BoldType.chip.fontFamily, color: Bold.ink, letterSpacing: -0.3 },
});
