/**
 * StudioContentStrip — the Posts & Ads shelf, reading REAL content instead of SAMPLE_POSTS.
 *
 * IT IS EXPECTED TO BE EMPTY. Nothing generates until U2, so `origin='generated'` returns zero rows
 * for everyone today. That empty state is the deliverable: five invented tiles (a gorjana reel, a
 * Nike teaser, a Celsius ad) told the athlete she had work she does not have. An honest empty shelf
 * is worth more than a convincing lie, and it is the only version that stays correct the day real
 * content lands.
 *
 * THE BADGES ARE REAL STATE, NOT DECORATION. `approvalStatus` is clearance — draft / approved /
 * rejected, from studio/approval.ts — and `published` is whether it actually went out. Those are
 * two different questions and a third ("did the render finish") is a job status this strip never
 * shows. The old mock's "Draft"/"Sched" badges were guesses at a machine that now exists.
 *
 * Rendered ONLY on the STUDIO_ENABLED path. With the flag off, StudioScreen renders SAMPLE_POSTS
 * exactly as it does in production today and never mounts this component.
 */
import React from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { StudioContentItem, StudioContentState } from "../../hooks/use-studio";
import { BorderRadius, Colors, Fonts, Spacing, Bold } from "../../constants/theme";

const TILE_W = 120;   // matches StudioScreen's shelf footprint (120×160)

/** Clearance + publish state → one badge. Kept tiny; the detail lives on the asset screen. */
function badgeFor(item: StudioContentItem): { text: string; tone: "posted" | "ready" | "draft" } | null {
  if (item.published) return { text: "Posted", tone: "posted" };
  if (item.approvalStatus === "approved") return { text: "Ready", tone: "ready" };
  if (item.approvalStatus === "draft") return { text: "Draft", tone: "draft" };
  return null;
}

export function StudioContentStrip({
  items, state, onPressItem,
}: {
  items: StudioContentItem[];
  state: StudioContentState;
  onPressItem: (item: StudioContentItem) => void;
}) {
  if (state === "loading") return <SkeletonTile />;

  // "Unavailable" (the server has the flag off) and "error" both resolve to the same honest
  // statement: we cannot show content right now. Neither invents tiles.
  if (state === "unavailable" || state === "error") {
    return (
      <EmptyTile
        icon="cloud-off"
        title={state === "unavailable" ? "Not switched on yet" : "Couldn't load"}
        body={state === "unavailable" ? "Making posts isn't live on your account yet." : "Pull to refresh and try again."}
      />
    );
  }

  if (items.length === 0) {
    return (
      <EmptyTile
        icon="layers"
        title="Nothing made yet"
        body="What you make in Studio shows up here."
      />
    );
  }

  return (
    <>
      {items.map((item) => {
        const badge = badgeFor(item);
        return (
          <Pressable key={item.assetId} style={styles.tile} onPress={() => onPressItem(item)}>
            {item.thumbUrl ? (
              <>
                <Image source={{ uri: item.thumbUrl }} style={styles.img} resizeMode="cover" />
                <View style={styles.scrim} pointerEvents="none" />
              </>
            ) : null}
            <View style={styles.top}>
              {badge ? (
                <View style={[styles.badge, styles[badge.tone]]}>
                  <Text style={styles.badgeTxt}>{badge.text}</Text>
                </View>
              ) : <View />}
            </View>
            <Text style={styles.cap} numberOfLines={2}>
              {item.caption?.trim() || "Untitled"}
            </Text>
          </Pressable>
        );
      })}
    </>
  );
}

function EmptyTile({ icon, title, body }: { icon: React.ComponentProps<typeof Feather>["name"]; title: string; body: string }) {
  return (
    <View style={styles.empty}>
      <Feather name={icon} size={20} color={Colors.light.textMuted} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

function SkeletonTile() {
  return <View style={[styles.empty, styles.skeleton]} />;
}

const styles = StyleSheet.create({
  tile: {
    width: TILE_W, height: Math.round((TILE_W * 4) / 3), borderRadius: 18, padding: 10,
    justifyContent: "space-between", overflow: "hidden", backgroundColor: "#1a1412",
  },
  img: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", borderRadius: 12 },
  scrim: { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", borderRadius: 12, backgroundColor: "rgba(10,8,7,0.34)" },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  badge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  draft:  { backgroundColor: "rgba(255,255,255,0.16)" },
  ready:  { backgroundColor: "rgba(0,0,0,0.55)" },
  posted: { backgroundColor: "rgba(78,175,110,0.32)" },
  badgeTxt: {
    fontFamily: Fonts.bodyBold, fontSize: 8.5, fontWeight: "800", color: Bold.onDark,
    textTransform: "uppercase", letterSpacing: 0.3,
  },
  cap: { fontFamily: Fonts.bodySemiBold, fontSize: 12.5, fontWeight: "700", color: "#FFFFFF", lineHeight: 16 },

  empty: {
    width: TILE_W * 1.6, height: Math.round((TILE_W * 4) / 3), borderRadius: BorderRadius.md,
    alignItems: "center", justifyContent: "center", gap: 5, paddingHorizontal: Spacing.md,
    backgroundColor: Colors.light.card, borderWidth: 1, borderStyle: "dashed", borderColor: Colors.light.border,
  },
  skeleton: { borderStyle: "solid", backgroundColor: Colors.light.backgroundSecondary, borderColor: Colors.light.borderLight },
  emptyTitle: { fontFamily: Fonts.bodyBold, fontSize: 13, fontWeight: "700", color: Colors.light.text, marginTop: 4 },
  emptyBody: { fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16, color: Colors.light.textMuted, textAlign: "center" },
});
