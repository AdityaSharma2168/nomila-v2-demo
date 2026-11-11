// Concept 0.4 Slice 2 · the small marks My Intelligence draws. Meaning is carried by SHAPE plus the words beside it,
// never by colour alone (there are no per-dimension colours outside the ring).
//
//   <StateGlyph kind="strength" />     ▲ filled · "gap" ▽ outline · "unknown" ◌ dashed ring   (always next to its label)
//   <CitationGlyph kind="grounded" />  ● filled · site_only ◐ · nomila_supplied ◇ · unrecorded ◌ · not_support ⊘
//
// A source's own logo is ui/LogoMark (the evidence sheet draws it at 24) — never a generic icon.

import React from "react";
import Svg, { Circle, Line, Path, Polygon } from "react-native-svg";
import type { CitationGlyph as CitationGlyphKind, StateGlyph as StateGlyphKind } from "../../lib/myIntelligenceLogic";
import { Bold } from "../../constants/theme";

export function StateGlyph({ kind, size = 10, color = Bold.ink2 }: { kind: StateGlyphKind; size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 12 12" accessibilityElementsHidden importantForAccessibility="no">
      {kind === "strength" ? <Polygon points="6,1 11,10 1,10" fill={color} /> : null}
      {kind === "gap" ? <Polygon points="1,2 11,2 6,11" fill="none" stroke={color} strokeWidth={1.6} /> : null}
      {kind === "unknown" ? <Circle cx={6} cy={6} r={4.5} fill="none" stroke={color} strokeWidth={1.4} strokeDasharray="2 1.6" /> : null}
    </Svg>
  );
}

export function CitationGlyph({ kind, size = 12, color = Bold.ink }: { kind: CitationGlyphKind; size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 12 12" accessibilityElementsHidden importantForAccessibility="no">
      {kind === "grounded" ? <Circle cx={6} cy={6} r={5} fill={color} /> : null}
      {kind === "site_only" ? (
        <>
          <Circle cx={6} cy={6} r={4.6} fill="none" stroke={color} strokeWidth={1.4} />
          <Path d="M6 1.4 A4.6 4.6 0 0 1 6 10.6 Z" fill={color} />
        </>
      ) : null}
      {kind === "nomila_supplied" ? <Polygon points="6,1 11,6 6,11 1,6" fill="none" stroke={color} strokeWidth={1.5} /> : null}
      {kind === "unrecorded" ? <Circle cx={6} cy={6} r={4.6} fill="none" stroke={color} strokeWidth={1.4} strokeDasharray="1.8 1.6" /> : null}
      {kind === "not_support" ? (
        <>
          <Circle cx={6} cy={6} r={4.6} fill="none" stroke={color} strokeWidth={1.4} />
          <Line x1={2.6} y1={9.4} x2={9.4} y2={2.6} stroke={color} strokeWidth={1.4} />
        </>
      ) : null}
    </Svg>
  );
}
