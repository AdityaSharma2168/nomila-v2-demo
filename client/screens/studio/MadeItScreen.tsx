/**
 * MadeItScreen — it exists now. Saving already happened; posting is a separate decision.
 *
 * ─── SAVED IS NOT A QUESTION ───────────────────────────────────────────────────────────────────
 * The work is on her shelf the moment it renders, whether she posts it or not. So this screen says
 * that ONCE and moves on. An earlier version said it four times — a banner, the download sub-line,
 * the schedule sub-line and the footer — which is what reassurance turns into when nobody counts it.
 *
 * ─── THE CAPTION LIVES HERE, NOT ON THE SPEND SCREEN ───────────────────────────────────────────
 * You write a caption for a thing that exists. On the Make it screen it was asking her to write
 * copy for something she had not yet agreed to pay for, and captions cost nothing and stay
 * editable after posting, so they have no business inside a spend decision.
 *
 * ─── SCHEDULING IS OPTIONAL AND COLLAPSED ──────────────────────────────────────────────────────
 * Most of the time the answer is "not yet". The platform and time controls only appear if she asks
 * for them, and "Save and exit" is a real ending rather than a way out of a form.
 */
import React, { useMemo, useState } from "react";
import {
  View, Text, ScrollView, SafeAreaView, StatusBar, StyleSheet, Image, TextInput,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { StudioStackParamList } from "../../navigation/MainTabNavigator";
import { HapticPressable } from "../../components/HapticPressable";
import { Colors, Fonts, Spacing } from "../../constants/theme";
import { useFixtures } from "../../hooks/use-studio-pending";
import {
  PLATFORMS, SLOTS, combine, dayOptions, fitsFormat, offsetNote, recommendedSlot, timeLabel,
} from "./scheduleLogic";

export function MadeItScreen() {
  const nav = useNavigation<NativeStackNavigationProp<StudioStackParamList>>();
  const { params } = useRoute<RouteProp<StudioStackParamList, "StudioMade">>();
  const { data: fixtures } = useFixtures();

  const [downloaded, setDownloaded] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [platforms, setPlatforms] = useState<string[]>(["instagram"]);
  const [mode, setMode] = useState<"recommended" | "now" | "custom">("recommended");
  const [slot, setSlot] = useState<number>(SLOTS[0]);
  const [dayIndex, setDayIndex] = useState(0);
  const [caption, setCaption] = useState("");

  // One `now` for the whole render, so the recommendation and the offset under it cannot be
  // computed a few milliseconds apart and disagree.
  const now = useMemo(() => new Date(), []);
  const days = useMemo(() => dayOptions(now), [now]);
  const rec = useMemo(() => recommendedSlot(fixtures, now), [fixtures, now]);

  // A day AND a time. The offset line cannot be honest without both — "1h 30m before kickoff" is
  // only true once we know which day it goes out on.
  const chosenAt = mode === "recommended" ? rec.at : combine(days[dayIndex].date, slot);
  const chosenMinutes = mode === "recommended" ? rec.minutes : slot;
  const offset = mode === "now" ? null : offsetNote(chosenAt, fixtures, now);

  const home = () => nav.navigate("StudioHome");

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.topbar}>
        <HapticPressable onPress={home} hitSlop={8} accessibilityRole="button" accessibilityLabel="Done">
          <Feather name="chevron-left" size={22} color={Colors.light.text} />
        </HapticPressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.topTitle}>It is made</Text>
          <Text style={styles.topSub}>Posting is up to you.</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.piece}>
          <View style={styles.thumb}>
            {params.heroUri ? (
              <Image source={{ uri: params.heroUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            ) : (
              <View style={[StyleSheet.absoluteFill, styles.blank]}>
                <Feather name="image" size={16} color={Colors.light.tabIconDefault} />
              </View>
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.pieceTitle} numberOfLines={2}>{params.title}</Text>
            <Text style={styles.pieceSub}>
              {params.format} · {params.brandName ?? "yours"}
            </Text>
          </View>
        </View>

        {/* Said once. */}
        <View style={styles.saved}>
          <Feather name="check-circle" size={16} color={Colors.light.success} />
          <Text style={styles.savedTxt}>
            <Text style={styles.savedBold}>Saved to your Made shelf</Text>
            {params.brandName ? ", under Brand posts." : ", under Personal posts."}
          </Text>
        </View>

        <HapticPressable
          style={[styles.row, downloaded && styles.rowDone]}
          onPress={() => setDownloaded(true)}
          accessibilityRole="button"
          accessibilityLabel={downloaded ? "In your camera roll" : "Download to camera roll"}
        >
          <View style={styles.rowIcon}>
            <Feather name={downloaded ? "check" : "download"} size={17}
              color={downloaded ? Colors.light.success : Colors.light.textMuted} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>
              {downloaded ? "In your camera roll" : "Download to camera roll"}
            </Text>
            <Text style={styles.rowSub}>
              {downloaded ? "Full resolution, no watermark." : "A copy on your phone, full resolution."}
            </Text>
          </View>
        </HapticPressable>

        <HapticPressable
          style={[styles.row, scheduling && styles.rowOn]}
          onPress={() => setScheduling((s) => !s)}
          accessibilityRole="button"
          accessibilityState={{ expanded: scheduling }}
          accessibilityLabel="Schedule a post"
        >
          <View style={[styles.rowIcon, scheduling && styles.rowIconOn]}>
            <Feather name="calendar" size={17}
              color={scheduling ? Colors.light.primary : Colors.light.textMuted} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>Schedule a post</Text>
            <Text style={styles.rowSub}>
              {scheduling ? "Pick where it goes and when." : "Optional — you can do this later."}
            </Text>
          </View>
          <Feather name={scheduling ? "chevron-down" : "chevron-right"} size={16}
            color={Colors.light.tabIconDefault} />
        </HapticPressable>

        {scheduling ? (
          <>
            <Text style={styles.label}>WHERE IT GOES</Text>
            {PLATFORMS.map((p) => {
              const fits = fitsFormat(p, params.format);
              const on = fits && platforms.includes(p.key);
              return (
                <HapticPressable
                  key={p.key}
                  style={[styles.plat, on && styles.platOn, !fits && styles.platOff]}
                  disabled={!fits}
                  onPress={() =>
                    setPlatforms((ps) => (ps.includes(p.key) ? ps.filter((x) => x !== p.key) : [...ps, p.key]))
                  }
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on, disabled: !fits }}
                  accessibilityLabel={p.label}
                >
                  <View style={[styles.box, on && styles.boxOn]}>
                    {on ? <Feather name="check" size={11} color={Colors.light.buttonText} /> : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.platName}>{p.label}</Text>
                    <Text style={styles.platNote}>
                      {fits ? p.note : `A ${params.format} does not fit here.`}
                    </Text>
                  </View>
                </HapticPressable>
              );
            })}

            <Text style={styles.label}>WHEN</Text>
            <Mode
              on={mode === "recommended"}
              title={`Recommended · ${dayLabel(rec.at, days)} at ${timeLabel(rec.minutes)}`}
              sub={rec.why}
              onPress={() => setMode("recommended")}
            />
            <Mode
              on={mode === "now"}
              title="Post now"
              sub="It goes out as soon as it finishes rendering."
              onPress={() => setMode("now")}
            />
            <Mode
              on={mode === "custom"}
              title="Pick a time"
              sub={mode === "custom" ? null : "Choose the slot yourself."}
              onPress={() => setMode("custom")}
            />
            {mode === "custom" ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.slots}>
                {days.map((d, i) => (
                  <HapticPressable
                    key={d.label}
                    style={[styles.slot, dayIndex === i && styles.slotOn]}
                    onPress={() => setDayIndex(i)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: dayIndex === i }}
                    accessibilityLabel={d.label}
                  >
                    <Text style={[styles.slotTxt, dayIndex === i && styles.slotTxtOn]}>{d.label}</Text>
                  </HapticPressable>
                ))}
              </ScrollView>
            ) : null}
            {mode === "custom" ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.slots}>
                {SLOTS.map((m) => (
                  <HapticPressable
                    key={m}
                    style={[styles.slot, slot === m && styles.slotOn]}
                    onPress={() => setSlot(m)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: slot === m }}
                    accessibilityLabel={timeLabel(m)}
                  >
                    <Text style={[styles.slotTxt, slot === m && styles.slotTxtOn]}>{timeLabel(m)}</Text>
                  </HapticPressable>
                ))}
              </ScrollView>
            ) : null}

            {offset ? (
              <View style={styles.offset}>
                <Feather name="zap" size={14} color={Colors.light.primary} />
                <Text style={styles.offsetTxt}>{offset}</Text>
              </View>
            ) : null}
          </>
        ) : null}

        <Text style={styles.label}>THE CAPTION</Text>
        <View style={styles.capBox}>
          <TextInput
            style={styles.capInput}
            value={caption}
            onChangeText={setCaption}
            placeholder="Write it yourself, or leave it and I will draft one."
            placeholderTextColor={Colors.light.tabIconDefault}
            multiline
          />
        </View>
        <Text style={styles.capNote}>Change it any time after it goes out.</Text>
      </ScrollView>

      <View style={styles.footer}>
        {scheduling ? (
          <>
            <Text style={styles.footLine}>
              {mode === "now" ? "Going out now" : `Going out ${dayLabel(chosenAt, days)} at ${timeLabel(chosenMinutes)}`}
              {`  ·  ${platforms.length || "no"} ${platforms.length === 1 ? "place" : "places"}`}
            </Text>
            <HapticPressable
              haptic="press"
              style={[styles.cta, platforms.length === 0 && styles.ctaOff]}
              disabled={platforms.length === 0}
              onPress={home}
              accessibilityRole="button"
              accessibilityLabel={mode === "now" ? "Post it now" : "Schedule it"}
            >
              <Text style={styles.ctaTxt}>{mode === "now" ? "Post it now" : "Schedule it"}</Text>
            </HapticPressable>
            <HapticPressable style={styles.quiet} onPress={home} accessibilityRole="button">
              <Text style={styles.quietTxt}>Save without scheduling</Text>
            </HapticPressable>
          </>
        ) : (
          <HapticPressable haptic="press" style={styles.cta} onPress={home} accessibilityRole="button" accessibilityLabel="Save and exit">
            <Text style={styles.ctaTxt}>Save and exit</Text>
          </HapticPressable>
        )}
      </View>
    </SafeAreaView>
  );
}

/** "Today" / "Tomorrow" / "Sat" for a moment, matching the chips rather than restating a date. */
function dayLabel(at: Date, days: { date: Date; label: string }[]): string {
  const found = days.find((d) => d.date.toDateString() === at.toDateString());
  return found?.label ?? at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function Mode({
  on, title, sub, onPress,
}: {
  on: boolean; title: string; sub: string | null; onPress: () => void;
}) {
  return (
    <HapticPressable
      style={[styles.mode, on && styles.modeOn]}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={sub ? `${title}. ${sub}` : title}
    >
      <View style={[styles.radio, on && styles.radioOn]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.modeTitle}>{title}</Text>
        {sub ? <Text style={styles.modeSub}>{sub}</Text> : null}
      </View>
    </HapticPressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  topbar: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: Spacing.xl, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: Colors.light.border,
  },
  topTitle: { fontFamily: Fonts.bodyBold, fontSize: 15.5, fontWeight: "700", color: Colors.light.text },
  topSub: { fontFamily: Fonts.body, fontSize: 11, color: Colors.light.textMuted },

  body: { padding: Spacing.xl, paddingBottom: 26 },

  piece: {
    flexDirection: "row", alignItems: "center", gap: 11,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 15, padding: 10,
  },
  thumb: {
    width: 44, height: 54, borderRadius: 10, overflow: "hidden",
    backgroundColor: Colors.light.backgroundSecondary,
  },
  blank: { alignItems: "center", justifyContent: "center" },
  pieceTitle: { fontFamily: Fonts.bodyBold, fontSize: 13.5, fontWeight: "700", color: Colors.light.text },
  pieceSub: { fontFamily: Fonts.body, fontSize: 11.5, color: Colors.light.textMuted, marginTop: 2 },

  saved: {
    flexDirection: "row", alignItems: "center", gap: 9, marginTop: 9,
    backgroundColor: Colors.light.successLight, borderRadius: 14, padding: 11,
  },
  savedTxt: { flex: 1, fontFamily: Fonts.body, fontSize: 12, lineHeight: 17, color: Colors.light.text },
  savedBold: { fontFamily: Fonts.bodyBold, fontWeight: "700" },

  row: {
    flexDirection: "row", alignItems: "center", gap: 11, marginTop: 8,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 14, padding: 12,
  },
  rowDone: { borderColor: Colors.light.success },
  rowOn: { borderColor: Colors.light.primary, backgroundColor: Colors.light.primaryLight },
  rowIcon: {
    width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.light.backgroundDefault,
  },
  rowIconOn: { backgroundColor: Colors.light.card },
  rowTitle: { fontFamily: Fonts.bodyBold, fontSize: 13.5, fontWeight: "700", color: Colors.light.text },
  rowSub: { fontFamily: Fonts.body, fontSize: 11.5, color: Colors.light.textMuted, marginTop: 1 },

  label: {
    fontFamily: Fonts.bodyBold, fontSize: 10.5, fontWeight: "700", letterSpacing: 1.3,
    color: Colors.light.textMuted, marginTop: 20, marginBottom: 8,
  },

  plat: {
    flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 7,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 13, padding: 11,
  },
  platOn: { borderColor: Colors.light.primary, backgroundColor: Colors.light.primaryLight },
  platOff: { opacity: 0.45 },
  box: {
    width: 19, height: 19, borderRadius: 6, borderWidth: 2, borderColor: Colors.light.border,
    alignItems: "center", justifyContent: "center",
  },
  boxOn: { borderColor: Colors.light.primary, backgroundColor: Colors.light.primary },
  platName: { fontFamily: Fonts.bodyBold, fontSize: 13.5, fontWeight: "700", color: Colors.light.text },
  platNote: { fontFamily: Fonts.body, fontSize: 11, color: Colors.light.textMuted, marginTop: 1 },

  mode: {
    flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 14, padding: 12,
  },
  modeOn: { borderColor: Colors.light.primary, backgroundColor: Colors.light.primaryLight },
  radio: {
    width: 18, height: 18, borderRadius: 99, borderWidth: 2, borderColor: Colors.light.border,
  },
  radioOn: { borderColor: Colors.light.primary, backgroundColor: Colors.light.primary },
  modeTitle: { fontFamily: Fonts.bodyBold, fontSize: 13.5, fontWeight: "700", color: Colors.light.text },
  modeSub: {
    fontFamily: Fonts.body, fontSize: 11.5, lineHeight: 16,
    color: Colors.light.textMuted, marginTop: 2,
  },

  slots: { gap: 6, paddingBottom: 4 },
  slot: {
    borderRadius: 99, paddingHorizontal: 12, paddingVertical: 7,
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
  },
  slotOn: { borderColor: Colors.light.primary, backgroundColor: Colors.light.primary },
  slotTxt: { fontFamily: Fonts.bodyBold, fontSize: 12, fontWeight: "700", color: Colors.light.text },
  slotTxtOn: { color: Colors.light.buttonText },

  offset: {
    flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 12,
    backgroundColor: Colors.light.primaryLight, borderWidth: 1, borderColor: Colors.light.primary,
    borderRadius: 13, padding: 11,
  },
  offsetTxt: { flex: 1, fontFamily: Fonts.bodyBold, fontSize: 12, lineHeight: 17, color: Colors.light.text },

  capBox: {
    backgroundColor: Colors.light.card, borderWidth: 1, borderColor: Colors.light.border,
    borderRadius: 14, padding: 12,
  },
  capInput: {
    fontFamily: Fonts.body, fontSize: 13.5, lineHeight: 19,
    color: Colors.light.text, minHeight: 60, padding: 0, textAlignVertical: "top",
  },
  capNote: { fontFamily: Fonts.body, fontSize: 11, color: Colors.light.textMuted, marginTop: 7 },

  footer: {
    borderTopWidth: 1, borderTopColor: Colors.light.border, backgroundColor: Colors.light.card,
    paddingHorizontal: Spacing.xl, paddingTop: 11, paddingBottom: 16,
  },
  footLine: { fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted, marginBottom: 9 },
  cta: { backgroundColor: Colors.light.primary, borderRadius: 14, paddingVertical: 15, alignItems: "center" },
  ctaOff: { backgroundColor: Colors.light.backgroundTertiary },
  ctaTxt: { fontFamily: Fonts.bodyBold, fontSize: 15, fontWeight: "700", color: Colors.light.buttonText },
  quiet: { alignItems: "center", paddingVertical: 12 },
  quietTxt: { fontFamily: Fonts.bodySemiBold, fontSize: 13, fontWeight: "600", color: Colors.light.textMuted },
});
