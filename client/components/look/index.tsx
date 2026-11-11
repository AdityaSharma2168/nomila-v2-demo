// The one Nomila look's shared components (owner-approved 22 Oct 2026). Every restyled screen builds from these; they
// read `useLook()` so they follow the phone's light/dark setting. Old components in components/ui stay for the screens
// not yet restyled.
//
//   LookButton          pill: "primary" (raspberry-coral fill), "secondary" (outlined), "ghost" (text only)
//   LookSheet           the default home for any short decision: slides up over the current view, swipe/✕ to close
//   LookCard            white soft card, 20 corners, wide soft shadow, no border
//   LookChip            a pill choice or a status chip (selected state for pickers)
//   UndoToast           "Accepted · Undo" for 10 s instead of a confirm dialog
//   SuggestedTimeChips  the next good times as one-tap chips
//   PresetPicker        availability presets + day chips
import React, { useEffect, useRef } from "react";
import { ActivityIndicator, Animated, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Look, useLook } from "../../constants/theme";
import { DAY_CHIPS, PRESETS, type AvailabilityPreset, type OpenTime } from "../../lib/lookLogic";

type ButtonKind = "primary" | "secondary" | "ghost";

export function LookButton({ children, onPress, kind = "primary", small, loading, disabled, icon, style, testID, accessibilityLabel }: {
  children: string; onPress: () => void; kind?: ButtonKind; small?: boolean; loading?: boolean; disabled?: boolean;
  icon?: React.ComponentProps<typeof Feather>["name"]; style?: StyleProp<ViewStyle>; testID?: string; accessibilityLabel?: string;
}) {
  const L = useLook();
  const bg = kind === "primary" ? L.act : kind === "secondary" ? L.ink : "transparent";
  const fg = kind === "primary" ? L.onAct : kind === "secondary" ? L.card : L.ink;
  return (
    <Pressable onPress={onPress} disabled={disabled || loading} testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? children}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      style={({ pressed }) => [s.button, { height: small ? Look.buttonSmall : Look.button, backgroundColor: bg },
        kind === "ghost" && { paddingHorizontal: 8 }, (disabled && !loading) && { opacity: 0.45 },
        pressed && { transform: [{ scale: Look.pressScale }] }, style]}>
      {loading ? <ActivityIndicator color={fg} /> : (
        <>
          {icon ? <Feather name={icon} size={18} color={fg} /> : null}
          <Text style={[Look.type.button, { color: fg }]} numberOfLines={1}>{children}</Text>
        </>
      )}
    </Pressable>
  );
}

export function LookCard({ children, style, onPress, testID, accessibilityLabel }: {
  children: React.ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; testID?: string; accessibilityLabel?: string;
}) {
  const L = useLook();
  const base = [s.card, { backgroundColor: L.card }, L.shadow as ViewStyle, L.dark && { borderWidth: 1, borderColor: L.line }, style];
  if (!onPress) return <View style={base} testID={testID}>{children}</View>;
  return (
    <Pressable onPress={onPress} testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [...base, pressed && { transform: [{ scale: Look.pressScale }] }]}>
      {children}
    </Pressable>
  );
}

export function LookChip({ children, selected, onPress, tone = "neutral", icon, style, testID }: {
  children: string; selected?: boolean; onPress?: () => void; tone?: "neutral" | "act" | "gold" | "green";
  icon?: React.ComponentProps<typeof Feather>["name"]; style?: StyleProp<ViewStyle>; testID?: string;
}) {
  const L = useLook();
  const tones = {
    neutral: { bg: L.card, fg: L.ink, line: L.line },
    act:     { bg: L.actTint, fg: L.actTintInk, line: L.actTint },
    gold:    { bg: L.goldTint, fg: L.goldInk, line: L.goldTint },
    green:   { bg: L.greenTint, fg: L.green, line: L.greenTint },
  }[tone];
  const sel = selected ? { bg: L.act, fg: L.onAct, line: L.act } : tones;
  const body = (
    <>
      {icon ? <Feather name={icon} size={14} color={sel.fg} /> : null}
      <Text style={[Look.type.bodyStrong, { color: sel.fg, fontSize: 15 }]} numberOfLines={1}>{children}</Text>
    </>
  );
  const chipStyle = [s.chip, { backgroundColor: sel.bg, borderColor: sel.line, minHeight: onPress ? Look.chip : 32 }, style];
  if (!onPress) return <View style={chipStyle} testID={testID}>{body}</View>;
  return (
    <Pressable onPress={onPress} testID={testID} accessibilityRole="button" accessibilityState={{ selected: !!selected }} accessibilityLabel={children}
      style={({ pressed }) => [...chipStyle, pressed && { transform: [{ scale: Look.pressScale }] }]}>
      {body}
    </Pressable>
  );
}

export function LookSheet({ visible, onClose, title, sub, children, footer, testID }: {
  visible: boolean; onClose: () => void; title?: string; sub?: string; children: React.ReactNode; footer?: React.ReactNode; testID?: string;
}) {
  const L = useLook();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: L.scrim }]} onPress={onClose} accessibilityLabel="Close" testID={testID ? `${testID}-scrim` : undefined} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={s.sheetWrap} pointerEvents="box-none">
        <View style={[s.sheet, { backgroundColor: L.bg }]} testID={testID}>
          <View style={[s.grab, { backgroundColor: L.line }]} />
          {title ? (
            <View style={s.sheetHead}>
              <View style={{ flex: 1 }}>
                <Text style={[Look.type.heading, { color: L.ink }]}>{title}</Text>
                {sub ? <Text style={[Look.type.meta, { color: L.ink2, marginTop: 2 }]}>{sub}</Text> : null}
              </View>
              <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close" style={[s.close, { backgroundColor: L.card, borderColor: L.line }]}>
                <Feather name="x" size={18} color={L.ink} />
              </Pressable>
            </View>
          ) : null}
          <View style={s.sheetBody}>{children}</View>
          {footer ? <View style={s.sheetFoot}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function UndoToast({ text, onUndo, visible, testID }: { text: string; onUndo: () => void; visible: boolean; testID?: string }) {
  const L = useLook();
  const y = useRef(new Animated.Value(80)).current;
  useEffect(() => { Animated.timing(y, { toValue: visible ? 0 : 80, duration: 180, useNativeDriver: true }).start(); }, [visible, y]);
  if (!visible) return null;
  return (
    <Animated.View style={[s.toast, { backgroundColor: L.dark ? L.card : L.ink, transform: [{ translateY: y }] }]} testID={testID} accessibilityLiveRegion="polite">
      <Text style={[Look.type.bodyStrong, { color: L.dark ? L.ink : L.bg, flex: 1 }]} numberOfLines={2}>{text}</Text>
      <Pressable onPress={onUndo} hitSlop={10} accessibilityRole="button" accessibilityLabel="Undo" testID={testID ? `${testID}-undo` : "undo"} style={s.undo}>
        <Text style={[Look.type.button, { color: L.dark ? L.act : "#FF9CB5" }]}>Undo</Text>
      </Pressable>
    </Animated.View>
  );
}

export function SuggestedTimeChips({ times, label, format, selected, onPick, more, testID }: {
  times: OpenTime[]; label?: string; format: (iso: string) => string; selected?: string | null;
  onPick: (t: OpenTime) => void; more?: { label: string; onPress: () => void }; testID?: string;
}) {
  const L = useLook();
  return (
    <View style={s.times} testID={testID}>
      {label ? <Text style={[Look.type.label, { color: L.ink2 }]}>{label}</Text> : null}
      <View style={s.wrap}>
        {times.map((t) => (
          <LookChip key={t.startsAt} selected={selected === t.startsAt} onPress={() => onPick(t)} testID={`time-${t.startsAt}`}>{format(t.startsAt)}</LookChip>
        ))}
        {more ? <LookChip onPress={more.onPress} icon="calendar" testID="more-times">{more.label}</LookChip> : null}
      </View>
    </View>
  );
}

export function PresetPicker({ value, onChange, days, onDays, calendarConnected, exclude, testID }: {
  value: AvailabilityPreset; onChange: (p: AvailabilityPreset) => void; days: number[]; onDays: (d: number[]) => void;
  calendarConnected: boolean;
  /** Presets that don't apply here (an open group needs set times, so no "Only when I say"). */
  exclude?: AvailabilityPreset[];
  testID?: string;
}) {
  const L = useLook();
  const presets = (Object.keys(PRESETS) as AvailabilityPreset[]).filter((p) => (p !== "after_practice" || calendarConnected) && !exclude?.includes(p));
  return (
    <View style={{ gap: 10 }} testID={testID}>
      {presets.map((p) => {
        const on = p === value;
        return (
          <Pressable key={p} onPress={() => { onChange(p); onDays(PRESETS[p].days); }} accessibilityRole="radio" accessibilityState={{ selected: on }} testID={`preset-${p}`}
            style={[s.preset, { backgroundColor: on ? L.actTint : L.card, borderColor: on ? L.act : L.line }]}>
            <Text style={[Look.type.bodyStrong, { color: on ? L.actTintInk : L.ink, flex: 1 }]}>{PRESETS[p].label}</Text>
            <Text style={[Look.type.meta, { color: on ? L.actTintInk : L.ink2 }]}>{PRESETS[p].hint}</Text>
          </Pressable>
        );
      })}
      {value !== "only_when_i_say" ? (
        <>
          <Text style={[Look.type.label, { color: L.ink2, marginTop: 6 }]}>Fine-tune</Text>
          <View style={s.wrap}>
            {DAY_CHIPS.map((d) => {
              const on = days.includes(d.day);
              return <LookChip key={d.day} selected={on} onPress={() => onDays(on ? days.filter((x) => x !== d.day) : [...days, d.day])} testID={`day-${d.day}`}>{d.label}</LookChip>;
            })}
          </View>
        </>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  button:    { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 22, borderRadius: Look.radius.pill },
  card:      { borderRadius: Look.radius.card, padding: 16 },
  chip:      { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, borderRadius: Look.radius.chip, borderWidth: 1.5 },
  sheetWrap: { flex: 1, justifyContent: "flex-end" },
  sheet:     { borderTopLeftRadius: Look.radius.sheet, borderTopRightRadius: Look.radius.sheet, paddingBottom: 28, maxHeight: "92%" },
  grab:      { width: 40, height: 5, borderRadius: 3, alignSelf: "center", marginTop: 8, marginBottom: 6 },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: Look.gutter, paddingTop: 8, paddingBottom: 12 },
  close:     { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 1 },
  sheetBody: { paddingHorizontal: Look.gutter, gap: 14 },
  sheetFoot: { paddingHorizontal: Look.gutter, paddingTop: 16, gap: 10 },
  toast:     { position: "absolute", left: 16, right: 16, bottom: 28, borderRadius: 16, paddingVertical: 12, paddingLeft: 16, paddingRight: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  undo:      { minHeight: 44, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" },
  times:     { gap: 8 },
  wrap:      { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  preset:    { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, paddingHorizontal: 16, borderRadius: 16, borderWidth: 1.5 },
});
