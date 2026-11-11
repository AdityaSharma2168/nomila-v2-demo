/**
 * ComingUpStrip — Home's "Coming up" (AGENT_V3 + the server's AGENT_PLAN), promoted from the approved prototype (draft
 * PR #900, client/screens/prototypes/ComingUpStrip): the next two or three dated events from GET /me/agent/goals
 * `comingUp`, each saying whether its actions are ready. Drawn like Home's "What matters next": the section head, one white
 * card, 12 × 14 rows with a 40 leading mark, title + meta, a right-hand state and the quiet chevron. The leading mark is
 * the date leaf (a 40 black tile, the day over the month; a month-only date reads "December"). "N ready" is the blue chip:
 * it waits on you. A tap anywhere on a row opens its prepared post kit (kitActionId) when there is one, else Goals at the
 * goal timed for it; nothing here acts.
 *
 *   ComingUpStrip   the strip over served items (pure; null when there is nothing coming up)
 *   HomeComingUp    the strip over the Goals read; draws nothing while the route is dark (404), loading or failing, so
 *                   Home is exactly as before then
 */
import React from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Card, Chip, SectionHead, useReducedMotion } from "../ui";
import { Bold, BoldType } from "../../constants/theme";
import { comingUpMeta, dateLeaf, readyWords } from "../../lib/agent/goalsLogic";
import { useAgentGoalsPlan } from "../../lib/agent/hooks";
import type { ComingUpItem } from "../../../shared/plan";
import type { DatePrecision } from "../../../shared/agent";

export const COMING_UP_COPY = { heading: "Coming up" } as const;
const MAX = 3;

export function DateLeaf({ iso, precision }: { iso: string; precision: DatePrecision }) {
  const d = dateLeaf(iso, precision);
  return (
    <View style={styles.leaf} accessibilityElementsHidden importantForAccessibility="no" testID="date-leaf">
      <Text style={styles.leafDay}>{d.day}</Text>
      {d.month ? <Text style={styles.leafMonth}>{d.month}</Text> : null}
    </View>
  );
}

export function ComingUpStrip({ items, onOpen }: { items: ReadonlyArray<ComingUpItem>; onOpen: (item: ComingUpItem) => void }) {
  const reduced = useReducedMotion();
  const shown = items.slice(0, MAX);
  if (!shown.length) return null;
  return (
    <View style={styles.section} testID="home-coming-up">
      <SectionHead title={COMING_UP_COPY.heading} style={styles.in} />
      <Card bold style={styles.list}>
        {shown.map((e, i) => {
          const r = readyWords(e.actionsReady);
          const meta = comingUpMeta(e);
          return (
            <Pressable
              key={e.factId}
              onPress={() => onOpen(e)}
              accessibilityRole="button"
              accessibilityLabel={`${e.label}. ${meta}. ${r.text}`}
              testID={`coming-up-${e.factId}`}
              style={({ pressed }) => [styles.row, i === shown.length - 1 && styles.rowLast, pressed && styles.rowPressed, pressed && !reduced && styles.pressed]}
            >
              <DateLeaf iso={e.date} precision={e.precision} />
              <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={2}>{e.label}</Text>
                <Text style={styles.rowMeta} numberOfLines={1}>{meta}</Text>
              </View>
              {r.ready ? <Chip bold="blue" testID={`coming-up-ready-${e.factId}`}>{r.text}</Chip> : <Text style={styles.quiet} numberOfLines={2}>{r.text}</Text>}
              <Feather name="chevron-right" size={18} color={Bold.quiet} />
            </Pressable>
          );
        })}
      </Card>
    </View>
  );
}

/** Home's strip over the Goals read. Nothing at all unless the route answers with something coming up. */
export function HomeComingUp({ enabled, onOpen }: { enabled: boolean; onOpen: (item: ComingUpItem) => void }) {
  const q = useAgentGoalsPlan(enabled);
  const items = q.data?.comingUp ?? [];
  if (!enabled || !items.length) return null;
  return <ComingUpStrip items={items} onOpen={onOpen} />;
}

const styles = StyleSheet.create({
  in:         { paddingHorizontal: Bold.gutter },
  section:    { marginTop: 16, gap: 10 },
  list:       { marginHorizontal: Bold.gutter },
  row:        { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: Bold.line, backgroundColor: Bold.paper },
  rowLast:    { borderBottomWidth: 0 },
  rowPressed: { backgroundColor: Bold.ground },
  pressed:    { transform: [{ scale: Bold.pressScale }] },
  rowText:    { flex: 1, minWidth: 0, gap: 2 },
  rowTitle:   { ...BoldType.rowTitle, color: Bold.ink },
  rowMeta:    { ...BoldType.rowMeta, color: Bold.mute },
  quiet:      { ...BoldType.caption, color: Bold.mute, maxWidth: 96, textAlign: "right" },
  leaf:       { width: 40, height: 40, borderRadius: Bold.radius.control, backgroundColor: Bold.ink, alignItems: "center", justifyContent: "center" },
  leafDay:    { ...BoldType.h4, color: Bold.onDark, lineHeight: 16 },
  leafMonth:  { ...BoldType.label, color: Bold.onDarkLabel, lineHeight: 12, letterSpacing: 0.8 },
});
