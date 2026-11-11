/** broadcast audience — "who's watching": a scoreboard hero stat (giant Anton number + volt "%"),
 *  a follow-strip of platform cells, and skewed volt geo bars. Faithful port of broadcast.ts's
 *  `.k-aud` (audienceCard). */
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { BroadcastPanel, BcKicker } from "./Chrome";
import { Rise, CountUp, AnimatedBar } from "../Chrome";
import { BC } from "./theme";
import type { CardProps, AudienceCardData } from "../types";

export function BroadcastAudienceCard({ data, active }: CardProps<AudienceCardData>) {
  const fallback = data.stats[0]?.n ?? data.headline;

  return (
    <BroadcastPanel active={active} bug="REACH" contentStyle={{ paddingTop: 42, paddingBottom: 24 }}>
      <BcKicker delay={20}>{data.eyebrow}</BcKicker>

      <Rise delay={90} style={styles.heroRow}>
        {data.share != null ? (
          <>
            <CountUp value={Math.round(data.share)} active={active} style={styles.heroN} />
            <Text style={styles.heroPct}>%</Text>
          </>
        ) : (
          <Text style={styles.heroN} numberOfLines={1}>{fallback}</Text>
        )}
      </Rise>

      <Rise delay={130} style={styles.heroCapWrap}>
        <Text style={styles.heroCap} numberOfLines={3}>{data.headline}</Text>
        {!!data.sub && <Text style={styles.heroSub} numberOfLines={1}>{data.sub}</Text>}
      </Rise>

      {data.stats.length > 0 && (
        <Rise delay={190} style={styles.strip}>
          {data.stats.map((s, i) => (
            <React.Fragment key={s.k}>
              {i > 0 && <View style={styles.stripDivider} />}
              <View style={[styles.stripCell, i === 0 && styles.stripCellBig]}>
                {i === 0 && <View style={styles.stripAccent} />}
                <Text style={styles.fsN} numberOfLines={1}>{s.n}</Text>
                <Text style={styles.fsL} numberOfLines={1}>{s.k}</Text>
              </View>
            </React.Fragment>
          ))}
        </Rise>
      )}

      {data.geo.length > 0 && (
        <>
          <View style={styles.geoKicker}>
            <BcKicker delay={240}>Where they live</BcKicker>
          </View>
          <View style={styles.geo}>
            {data.geo.map((g, i) => {
              const other = g.label.toLowerCase() === "other";
              return (
                <Rise key={g.label} delay={280 + i * 60} style={styles.geoRow}>
                  <Text style={[styles.geoName, other && styles.geoFaint]} numberOfLines={1}>{g.label}</Text>
                  <View style={styles.geoTrackWrap}>
                    <AnimatedBar
                      pct={g.pct ?? 0}
                      active={active}
                      delay={320 + i * 60}
                      color={other ? BC.faint : BC.volt}
                      track={BC.track}
                      height={7}
                    />
                  </View>
                  <Text style={[styles.geoVal, other && styles.geoFaint]} numberOfLines={1}>
                    {g.pct != null ? `${Math.round(g.pct)}%` : ""}
                  </Text>
                </Rise>
              );
            })}
          </View>
        </>
      )}
    </BroadcastPanel>
  );
}

const styles = StyleSheet.create({
  heroRow: { marginTop: 12, flexDirection: "row", alignItems: "baseline", gap: 10 },
  heroN: {
    fontFamily: BC.display, fontSize: 92, lineHeight: 116, color: BC.paper, letterSpacing: 0.5,
    includeFontPadding: false, textAlignVertical: "center",
  },
  heroPct: {
    fontFamily: BC.display, fontSize: 44, lineHeight: 58, color: BC.volt,
    includeFontPadding: false, textAlignVertical: "center",
  },

  heroCapWrap: { marginTop: 4 },
  heroCap: { fontFamily: BC.condBold, fontSize: 16, lineHeight: 20, letterSpacing: 1.6, textTransform: "uppercase", color: BC.paper },
  heroSub: { marginTop: 3, fontFamily: BC.cond, fontSize: 13, letterSpacing: 2, textTransform: "uppercase", color: BC.mut },

  strip: {
    marginTop: 16,
    marginBottom: 18,
    flexDirection: "row",
    alignItems: "stretch",
    backgroundColor: BC.panel,
  },
  stripDivider: { width: 1, backgroundColor: BC.line },
  stripCell: { flex: 1, position: "relative", backgroundColor: BC.panel, paddingHorizontal: 12, paddingVertical: 9 },
  stripCellBig: { backgroundColor: BC.panel2 },
  stripAccent: { position: "absolute", left: 0, right: 0, top: 0, height: 2, backgroundColor: BC.volt },
  fsN: {
    fontFamily: BC.display, fontSize: 24, lineHeight: 28, color: BC.paper, letterSpacing: 0.3,
    includeFontPadding: false, textAlignVertical: "center",
  },
  fsL: { marginTop: 3, fontFamily: BC.cond, fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: BC.mut },

  geoKicker: { marginBottom: 6 },
  geo: { gap: 8 },
  geoRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  geoName: { width: 52, fontFamily: BC.condBold, fontSize: 13, letterSpacing: 1.8, textTransform: "uppercase", color: BC.paper },
  geoTrackWrap: { flex: 1, overflow: "hidden", transform: [{ skewX: "-24deg" }] },
  geoVal: { width: 44, textAlign: "right", fontFamily: BC.display, fontSize: 16, color: BC.paper, letterSpacing: 0.3 },
  geoFaint: { color: BC.faint },
});
