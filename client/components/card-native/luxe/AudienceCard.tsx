/** luxe audience — giant Didone share number, italic Didone lede, a two-column stat grid and
 *  gold geo bars. Mirrors server/services/themes/luxe.ts's `audienceCard()` (.didone-num, .lede,
 *  .ital, .statgrid, .stat .n/.l, .geo .g/.c/.bar/.p). */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { LuxeShell, LuxeEyebrow } from "./Chrome";
import { Rise, RiseText, AnimatedBar, CountUp } from "../Chrome";
import { LX } from "./theme";
import type { CardProps, AudienceCardData } from "../types";

export function LuxeAudienceCard({ data, active }: CardProps<AudienceCardData>) {
  const hasShare = data.share != null;
  const heroShare = hasShare ? Math.round(data.share as number) : 0;
  const heroFallback = data.stats[0]?.n ?? data.headline;
  const gridStats = data.stats.slice(1);

  return (
    <LuxeShell bg={data.bg} active={active}>
      <LuxeEyebrow delay={20}>{data.eyebrow}</LuxeEyebrow>

      <Rise delay={140}>
        {hasShare ? (
          <CountUp value={heroShare} active={active} suffix="%" style={styles.heroNum} />
        ) : (
          <Text style={styles.heroNum}>{heroFallback}</Text>
        )}
      </Rise>

      {(!!data.headline || !!data.sub) && (
        <RiseText delay={200} style={styles.lede}>
          {data.headline}
          {!!data.sub && <Text style={styles.ital}> {data.sub}</Text>}
        </RiseText>
      )}

      {gridStats.length > 0 && (
        <Rise delay={260} style={styles.statgrid}>
          {gridStats.map((s) => (
            <View key={s.k} style={styles.statCell}>
              <Text style={styles.statN}>{s.n}</Text>
              <Text style={styles.statL}>{s.k}</Text>
            </View>
          ))}
        </Rise>
      )}

      {data.geo.length > 0 && (
        <View style={styles.geo}>
          {data.geo.map((g, i) => (
            <Rise key={g.label} delay={320 + i * 60} style={styles.geoRow}>
              <Text style={styles.geoLabel} numberOfLines={1}>{g.label}</Text>
              <View style={{ flex: 1 }}>
                <AnimatedBar
                  pct={g.pct ?? 0}
                  color={LX.or}
                  track="rgba(244,238,226,0.15)"
                  active={active}
                  delay={360 + i * 60}
                  height={1.5}
                />
              </View>
              <Text style={styles.geoPct}>{g.pct != null ? `${Math.round(g.pct)}%` : ""}</Text>
            </Rise>
          ))}
        </View>
      )}
    </LuxeShell>
  );
}

const styles = StyleSheet.create({
  heroNum: {
    fontFamily: LX.didone,
    fontSize: 88,
    lineHeight: 106,
    includeFontPadding: false,
    letterSpacing: 0,
    color: LX.ivory,
  },

  lede: {
    marginTop: 6,
    fontFamily: LX.sans,
    fontSize: 12.5,
    letterSpacing: 1.6,
    lineHeight: 21,
    color: LX.ivoryDim,
  },
  ital: { fontFamily: LX.didoneItalic, fontStyle: "italic", color: LX.or },

  statgrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 16,
  },
  statCell: { width: "50%", paddingRight: 12, marginBottom: 12 },
  statN: { fontFamily: LX.didone, fontSize: 29, lineHeight: 36, color: LX.ivory, includeFontPadding: false },
  statL: { marginTop: 5, fontFamily: LX.sans, fontSize: 8.5, letterSpacing: 2.6, textTransform: "uppercase", color: LX.ivoryMut },

  geo: { marginTop: 12 },
  geoRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 9 },
  geoLabel: { width: 64, fontFamily: LX.sans, fontSize: 9.5, letterSpacing: 2.85, textTransform: "uppercase", color: LX.ivoryDim },
  geoPct: { width: 38, textAlign: "right", fontFamily: LX.didoneItalic, fontStyle: "italic", fontSize: 15, color: LX.or },
});
