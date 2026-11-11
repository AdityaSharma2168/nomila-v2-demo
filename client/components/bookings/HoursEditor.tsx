// HoursEditor — "When can fans book you?" with flexible hours (owner request, Nov 2026; design "Option B"). Used by
// the new-session sheet (step 3) and the offer editor's "Edit hours" sheet:
//
//   1 Quick start   Weekday evenings · Weekends · (After practice, calendar connected) · (Only when I say). A quick
//                   start FILLS the editor below; it no longer locks the hours.
//   2 Which days?   Mon–Sun chips
//   3 What time?    From / Until cards → a time wheel in 15-minute steps (the hours for every picked day)
//   4 Different hours on some days   a switch: each day lists its own hours as pills (tap to edit, × to remove),
//                   "+ Add hours" for another block that day, "+ Another day"
//   5 What fans see the hours in one line ("Mon, Wed, Thu 6:00–9:00 pm · Tue 7:00–8:15 am, 5:30–8:00 pm")
// The rules (model, validation, summary, open times) are client/lib/availabilityLogic.ts.
import React, { useState } from "react";
import { Platform, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Feather } from "@expo/vector-icons";
import { LookButton, LookChip, LookSheet } from "../look";
import { Look, useLook } from "../../constants/theme";
import {
  DAY_MINUTES, DAY_SHORT, PRESET_HOURS, WEEK_ORDER, addBlock, blockProblem, commonBlock, fmtBlock, fmtClock, hoursDays,
  hoursProblems, hoursSummary, matchingPreset, presetHours, removeBlock, setAllBlocks, setBlock, snapMinutes,
  suggestBlock, toggleDay, type Block, type WeekHours,
} from "../../lib/availabilityLogic";
import type { HoursPreset } from "../../lib/bookingsTypes";

const DEFAULT_BLOCK: Block = PRESET_HOURS.weekday_evenings.block;

export function HoursEditor({ hours, onChange, minutes, calendarConnected = false, request, onRequest, testID }: {
  hours: WeekHours; onChange: (h: WeekHours) => void;
  /** The session's length: each block must fit one. */
  minutes: number;
  calendarConnected?: boolean;
  /** "Only when I say" (fans ask for a time): shown only when the caller passes onRequest. */
  request?: boolean; onRequest?: (on: boolean) => void;
  testID?: string;
}) {
  const L = useLook();
  const [common, setCommon] = useState<Block>(() => commonBlock(hours) ?? firstBlock(hours) ?? DEFAULT_BLOCK);
  const [different, setDifferent] = useState(() => hoursDays(hours).length > 0 && commonBlock(hours) === null);
  const [edit, setEdit] = useState<null | { day: number | null; index: number; focus: "start" | "end" }>(null);
  const [moreDays, setMoreDays] = useState(false);
  const presets = (Object.keys(PRESET_HOURS) as HoursPreset[]).filter((p) => p !== "after_practice" || calendarConnected);
  const picked = request ? null : matchingPreset(hours);
  const days = hoursDays(hours);
  const problems = request ? [] : hoursProblems(hours, minutes);

  const quick = (p: HoursPreset) => {
    onRequest?.(false);
    setCommon(PRESET_HOURS[p].block);
    setDifferent(false);
    setMoreDays(false);
    onChange(presetHours(p));
  };
  const flipDifferent = (on: boolean) => {
    setDifferent(on);
    setMoreDays(false);
    if (!on) onChange(setAllBlocks(hours, common));
  };
  const editing: Block | null = edit ? (edit.day === null ? common : hours[edit.day]?.[edit.index] ?? null) : null;
  const done = (b: Block) => {
    if (!edit) return;
    if (edit.day === null) { setCommon(b); onChange(setAllBlocks(hours, b)); }
    else onChange(setBlock(hours, edit.day, edit.index, b));
    setEdit(null);
  };

  return (
    <View style={s.group} testID={testID}>
      <Text style={[Look.type.label, { color: L.ink2 }]}>Quick start</Text>
      <View style={s.wrap}>
        {presets.map((p) => <LookChip key={p} selected={picked === p} onPress={() => quick(p)} testID={`preset-${p}`}>{PRESET_HOURS[p].label}</LookChip>)}
        {onRequest ? <LookChip selected={!!request} onPress={() => onRequest(true)} testID="preset-only_when_i_say">Only when I say</LookChip> : null}
      </View>

      {request ? (
        <Text style={[Look.type.meta, { color: L.muted }]}>Fans ask for a time; you say yes or offer another.</Text>
      ) : (
        <>
          <Text style={[Look.type.label, { color: L.ink2 }]}>Which days?</Text>
          <View style={s.wrap}>
            {WEEK_ORDER.map((d) => (
              <LookChip key={d} selected={days.includes(d)} onPress={() => onChange(toggleDay(hours, d, common))} testID={`day-${d}`}>{DAY_SHORT[d]}</LookChip>
            ))}
          </View>

          {!different ? (
            <>
              <Text style={[Look.type.label, { color: L.ink2 }]}>What time?</Text>
              <View style={s.cards}>
                <TimeCard label="From" value={fmtClock(common.start)} onPress={() => setEdit({ day: null, index: 0, focus: "start" })} testID="hours-from" />
                <TimeCard label="Until" value={fmtClock(common.end)} onPress={() => setEdit({ day: null, index: 0, focus: "end" })} testID="hours-until" />
              </View>
            </>
          ) : null}

          <View style={s.switchRow}>
            <Text style={[Look.type.bodyStrong, { color: L.ink, flex: 1 }]}>Different hours on some days</Text>
            <Switch value={different} onValueChange={flipDifferent} trackColor={{ false: L.line, true: L.act }} thumbColor={L.card}
              accessibilityLabel="Different hours on some days" testID="hours-different" />
          </View>

          {different ? (
            <View style={s.days} testID="hours-per-day">
              {days.map((d) => {
                const next = suggestBlock(hours[d] ?? [], minutes);
                return (
                  <View key={d} style={[s.dayRow, { borderColor: L.line }]} testID={`hours-day-${d}`}>
                    <Text style={[Look.type.bodyStrong, s.dayName, { color: L.ink }]}>{DAY_SHORT[d]}</Text>
                    <View style={[s.wrap, { flex: 1 }]}>
                      {(hours[d] ?? []).map((b, i) => (
                        <BlockPill key={`${b.start}-${b.end}`} text={fmtBlock(b)} onPress={() => setEdit({ day: d, index: i, focus: "start" })}
                          onRemove={() => onChange(removeBlock(hours, d, i))} testID={`block-${d}-${i}`} />
                      ))}
                      {next ? <LookChip icon="plus" onPress={() => onChange(addBlock(hours, d, next))} testID={`add-hours-${d}`}>Add hours</LookChip> : null}
                    </View>
                  </View>
                );
              })}
              {days.length < 7 ? (
                <View style={s.wrap}>
                  {moreDays
                    ? WEEK_ORDER.filter((d) => !days.includes(d)).map((d) => (
                      <LookChip key={d} icon="plus" onPress={() => { onChange(toggleDay(hours, d, common)); setMoreDays(false); }} testID={`another-day-${d}`}>{DAY_SHORT[d]}</LookChip>
                    ))
                    : <LookChip icon="plus" onPress={() => setMoreDays(true)} testID="another-day">Another day</LookChip>}
                </View>
              ) : null}
            </View>
          ) : null}

          {problems.length ? <Text style={[Look.type.meta, { color: L.actTintInk }]} accessibilityLiveRegion="polite" testID="hours-problem">{problems[0]}</Text> : null}
          {days.length ? (
            <>
              <Text style={[Look.type.label, { color: L.ink2 }]}>What fans see</Text>
              <Text style={[Look.type.body, { color: L.ink }]} testID="hours-summary">{hoursSummary(hours)}</Text>
            </>
          ) : null}
        </>
      )}

      {edit && editing ? (
        <BlockSheet visible title={edit.day === null ? "Your hours" : `${DAY_SHORT[edit.day]} hours`} block={editing} focus={edit.focus} minutes={minutes}
          onDone={done} onClose={() => setEdit(null)}
          onRemove={edit.day !== null ? () => { onChange(removeBlock(hours, edit.day!, edit.index)); setEdit(null); } : undefined} />
      ) : null}
    </View>
  );
}

function firstBlock(h: WeekHours): Block | null {
  const d = hoursDays(h)[0];
  return d === undefined ? null : { ...h[d]![0] };
}

function TimeCard({ label, value, onPress, active, testID }: { label: string; value: string; onPress: () => void; active?: boolean; testID: string }) {
  const L = useLook();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${label} ${value}`} testID={testID}
      style={({ pressed }) => [s.card, { backgroundColor: active ? L.actTint : L.card, borderColor: active ? L.act : L.line }, pressed && { transform: [{ scale: Look.pressScale }] }]}>
      <Text style={[Look.type.label, { color: active ? L.actTintInk : L.ink2 }]}>{label}</Text>
      <Text style={[Look.type.heading, { color: active ? L.actTintInk : L.ink }]} testID={`${testID}-value`}>{value}</Text>
    </Pressable>
  );
}

function BlockPill({ text, onPress, onRemove, testID }: { text: string; onPress: () => void; onRemove: () => void; testID: string }) {
  const L = useLook();
  return (
    <View style={[s.pill, { backgroundColor: L.card, borderColor: L.line }]}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Edit ${text}`} testID={testID} style={s.pillText}>
        <Text style={[Look.type.bodyStrong, { color: L.ink, fontSize: 15 }]} numberOfLines={1}>{text}</Text>
      </Pressable>
      <Pressable onPress={onRemove} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Remove ${text}`} testID={`${testID}-remove`} style={s.pillX}>
        <Feather name="x" size={16} color={L.ink2} />
      </Pressable>
    </View>
  );
}

/** One block's From / Until on a time wheel (15-minute steps). */
export function BlockSheet({ visible, title, block, focus: focus0 = "start", minutes, onDone, onClose, onRemove }: {
  visible: boolean; title: string; block: Block; focus?: "start" | "end"; minutes: number;
  onDone: (b: Block) => void; onClose: () => void; onRemove?: () => void;
}) {
  const L = useLook();
  const [draft, setDraft] = useState<Block>(block);
  const [focus, setFocus] = useState<"start" | "end">(focus0);
  const problem = blockProblem(draft, minutes);
  const value = focus === "start" ? draft.start : draft.end;
  const pick = (m: number) => setDraft((b) => focus === "start" ? { ...b, start: m === DAY_MINUTES ? 0 : m } : { ...b, end: m === 0 ? DAY_MINUTES : m });
  return (
    <LookSheet visible={visible} onClose={onClose} title={title} testID="block-sheet"
      footer={
        <>
          <LookButton onPress={() => onDone(draft)} disabled={!!problem} testID="block-sheet-done">Done</LookButton>
          {onRemove ? <LookButton kind="ghost" small onPress={onRemove} testID="block-sheet-remove">Remove these hours</LookButton> : null}
        </>
      }>
      <View style={s.cards}>
        <TimeCard label="From" value={fmtClock(draft.start)} active={focus === "start"} onPress={() => setFocus("start")} testID="block-from" />
        <TimeCard label="Until" value={fmtClock(draft.end)} active={focus === "end"} onPress={() => setFocus("end")} testID="block-until" />
      </View>
      <TimeWheel key={focus} minutes={value} onChange={pick} />
      {problem ? <Text style={[Look.type.meta, { color: L.actTintInk }]} accessibilityLiveRegion="polite" testID="block-problem">{problem}</Text> : null}
    </LookSheet>
  );
}

/**
 * A time of day in 15-minute steps. iOS: the native wheel (minuteInterval 15). Android and web: hour · minute · am/pm
 * chip columns in the same sheet (Android's picker is a separate dialog and web has none).
 */
export function TimeWheel({ minutes, onChange }: { minutes: number; onChange: (m: number) => void }) {
  const L = useLook();
  const m = minutes % DAY_MINUTES;
  if (Platform.OS === "ios") {
    const d = new Date(2000, 0, 1, Math.floor(m / 60), m % 60);
    return (
      <View style={{ alignItems: "center" }}>
        <DateTimePicker value={d} mode="time" display="spinner" minuteInterval={15} textColor={L.ink}
          onChange={(_e: unknown, t?: Date) => { if (t) onChange(snapMinutes(t.getHours() * 60 + t.getMinutes())); }} testID="time-wheel" />
      </View>
    );
  }
  const h24 = Math.floor(m / 60), min = m % 60, pm = h24 >= 12, h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const set = (h: number, mm: number, isPm: boolean) => onChange(((h % 12) + (isPm ? 12 : 0)) * 60 + mm);
  return (
    <View style={s.group} testID="time-columns">
      <Text style={[Look.type.label, { color: L.ink2 }]}>Hour</Text>
      <View style={s.wrap}>{[12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((h) => <LookChip key={h} selected={h === h12} onPress={() => set(h, min, pm)} testID={`wheel-hour-${h}`}>{String(h)}</LookChip>)}</View>
      <Text style={[Look.type.label, { color: L.ink2 }]}>Minute</Text>
      <View style={s.wrap}>{[0, 15, 30, 45].map((x) => <LookChip key={x} selected={x === min} onPress={() => set(h12, x, pm)} testID={`wheel-min-${x}`}>{`:${String(x).padStart(2, "0")}`}</LookChip>)}</View>
      <View style={s.wrap}>
        <LookChip selected={!pm} onPress={() => set(h12, min, false)} testID="wheel-am">am</LookChip>
        <LookChip selected={pm} onPress={() => set(h12, min, true)} testID="wheel-pm">pm</LookChip>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  group:     { gap: 10 },
  wrap:      { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  cards:     { flexDirection: "row", gap: 10 },
  card:      { flex: 1, minHeight: 64, borderRadius: Look.radius.card, borderWidth: 1.5, paddingHorizontal: 14, paddingVertical: 10, gap: 2, justifyContent: "center" },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  days:      { gap: 10 },
  dayRow:    { flexDirection: "row", alignItems: "flex-start", gap: 10, borderTopWidth: 1, paddingTop: 10 },
  dayName:   { width: 40, lineHeight: 44 },
  pill:      { flexDirection: "row", alignItems: "center", minHeight: Look.chip, borderRadius: Look.radius.chip, borderWidth: 1.5, paddingLeft: 14 },
  pillText:  { minHeight: Look.chip, justifyContent: "center" },
  pillX:     { minHeight: Look.chip, minWidth: 36, alignItems: "center", justifyContent: "center" },
});
