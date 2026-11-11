/**
 * DeckSpread — the deck laid out like cards on a table: a 3-column grid of mini-cards, the whole
 * deck visible at once, reordered by long-press-and-drag (Fable's "spread"). Cover is pinned to
 * slot 0; a dashed "+" tile trails the last card. Built on reanimated + gesture-handler (no extra
 * dep). Each tile is absolutely positioned by its slot; dragging one shuffles the others' slots
 * live, and the committed order flows back up via onReorder.
 */
import React, { useCallback, useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, type LayoutChangeEvent } from "react-native";
import { Feather } from "@expo/vector-icons";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  useAnimatedReaction,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { CardMiniTile } from "./CardMiniTile";
import { Fonts, Colors, Brand, Bold } from "../../constants/theme";
import type { Card } from "../card-native/types";

const COLS = 3;
const GAP = 10;
// Snappy settle — cards drop into slots quickly (founder: the old spring felt "slightly loose").
const SPRING = { damping: 26, stiffness: 360, mass: 0.7 } as const;

export interface SpreadCard {
  id: string;
  type: string;
  title: string;
  image: string | null;
  rich?: Card;
  locked?: boolean;                 // cover — pinned first, not draggable
  badge?: "New" | "Edited" | null;
}

type Positions = Record<string, number>;

// Shift slots when `from` moves to `to` (worklet — runs on the UI thread inside the pan).
function objectMove(obj: Positions, from: number, to: number): Positions {
  "worklet";
  const next: Positions = Object.assign({}, obj);
  for (const id in obj) {
    if (obj[id] === from) next[id] = to;
    else if (from < to && obj[id] > from && obj[id] <= to) next[id] = obj[id] - 1;
    else if (from > to && obj[id] >= to && obj[id] < from) next[id] = obj[id] + 1;
  }
  return next;
}

export function DeckSpread({
  cards, onReorder, onTapCard, onAdd,
}: {
  cards: SpreadCard[];
  onReorder: (orderedIds: string[]) => void;
  onTapCard: (id: string) => void;
  onAdd: () => void;
}) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    setWidth((p) => (Math.abs(p - w) < 1 ? p : w));
  };

  const cellW = width > 0 ? (width - GAP * (COLS - 1)) / COLS : 0;
  const tileH = cellW * 1.42;
  const cellH = tileH + 22;                 // tile + title line

  const n = cards.length;
  const rows = Math.ceil((n + 1) / COLS);   // +1 for the add tile
  const gridH = rows > 0 ? rows * (cellH + GAP) - GAP : 0;

  // id → slot. Reseeded whenever the set OR order changes (idsKey captures both).
  const positions = useSharedValue<Positions>({});
  const idsKey = cards.map((c) => c.id).join(",");
  useEffect(() => {
    const map: Positions = {};
    cards.forEach((c, i) => { map[c.id] = i; });
    positions.value = map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const commit = useCallback(() => {
    const map = positions.value;
    const ordered = Object.keys(map).sort((a, b) => map[a] - map[b]);
    onReorder(ordered);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onReorder]);

  if (width === 0) return <View style={styles.measure} onLayout={onLayout} />;

  return (
    <View style={[styles.grid, { height: gridH }]} onLayout={onLayout}>
      {cards.map((c, i) => (
        <MovableTile
          key={c.id}
          card={c}
          number={i + 1}
          positions={positions}
          cellW={cellW}
          cellH={cellH}
          tileH={tileH}
          maxSlot={n - 1}
          onCommit={commit}
          onTap={() => onTapCard(c.id)}
        />
      ))}
      <AddTile slot={n} cellW={cellW} cellH={cellH} tileH={tileH} onAdd={onAdd} />
    </View>
  );
}

function slotX(pos: number, cellW: number) { "worklet"; return (pos % COLS) * (cellW + GAP); }
function slotY(pos: number, cellH: number) { "worklet"; return Math.floor(pos / COLS) * (cellH + GAP); }

function MovableTile({
  card, number, positions, cellW, cellH, tileH, maxSlot, onCommit, onTap,
}: {
  card: SpreadCard;
  number: number;
  positions: SharedValue<Positions>;
  cellW: number;
  cellH: number;
  tileH: number;
  maxSlot: number;
  onCommit: () => void;
  onTap: () => void;
}) {
  const id = card.id;
  const moving = useSharedValue(false);
  const scale = useSharedValue(1);
  const tx = useSharedValue(slotX(positions.value[id] ?? number - 1, cellW));
  const ty = useSharedValue(slotY(positions.value[id] ?? number - 1, cellH));

  // Follow slot changes (from our own or a neighbour's drag) when we're not the one moving.
  useAnimatedReaction(
    () => positions.value[id],
    (pos, prev) => {
      if (pos == null || moving.value) return;
      const x = slotX(pos, cellW);
      const y = slotY(pos, cellH);
      if (prev == null) { tx.value = x; ty.value = y; }
      else { tx.value = withSpring(x, SPRING); ty.value = withSpring(y, SPRING); }
    },
    [cellW, cellH],
  );

  const pan = Gesture.Pan()
    .enabled(!card.locked)
    .activateAfterLongPress(150)
    .onStart(() => { moving.value = true; scale.value = withSpring(1.06, SPRING); })
    .onUpdate((e) => {
      const pos = positions.value[id];
      tx.value = slotX(pos, cellW) + e.translationX;
      ty.value = slotY(pos, cellH) + e.translationY;
      let col = Math.round(tx.value / (cellW + GAP));
      let row = Math.round(ty.value / (cellH + GAP));
      col = Math.max(0, Math.min(COLS - 1, col));
      row = Math.max(0, row);
      let newSlot = row * COLS + col;
      newSlot = Math.max(1, Math.min(maxSlot, newSlot));   // never before the locked cover
      if (newSlot !== pos) positions.value = objectMove(positions.value, pos, newSlot);
    })
    .onEnd(() => {
      const pos = positions.value[id];
      tx.value = withSpring(slotX(pos, cellW), SPRING);
      ty.value = withSpring(slotY(pos, cellH), SPRING);
    })
    .onFinalize(() => {
      scale.value = withSpring(1, SPRING);
      if (moving.value) { moving.value = false; scheduleOnRN(onCommit); }
    });

  const tap = Gesture.Tap().maxDuration(260).onEnd((_e, ok) => { if (ok) scheduleOnRN(onTap); });
  const gesture = Gesture.Exclusive(pan, tap);

  const aStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
      { scale: scale.value },
    ],
    zIndex: moving.value ? 20 : 1,
  }));

  return (
    <Animated.View style={[styles.cell, { width: cellW }, aStyle]}>
      <GestureDetector gesture={gesture}>
        <View>
          <View style={[styles.tileInner, { height: tileH }]}>
            <CardMiniTile
              rich={card.rich}
              type={card.type}
              title={card.title}
              image={card.image}
              accent={card.type === "fit" || card.type === "whyFits"}
            />
            <View style={styles.numBadge}><Text style={styles.numBadgeText}>{number}</Text></View>
            {card.locked && (
              <View style={styles.lockChip}>
                <Feather name="lock" size={8} color={Bold.onDark} />
                <Text style={styles.lockChipText}>First</Text>
              </View>
            )}
            {!card.locked && card.badge && (
              <View style={[styles.badge, card.badge === "New" && styles.badgeNew]}>
                <Text style={styles.badgeText}>{card.badge}</Text>
              </View>
            )}
          </View>
          <Text style={styles.title} numberOfLines={1}>{card.title}</Text>
        </View>
      </GestureDetector>
    </Animated.View>
  );
}

function AddTile({
  slot, cellW, cellH, tileH, onAdd,
}: { slot: number; cellW: number; cellH: number; tileH: number; onAdd: () => void }) {
  const x = (slot % COLS) * (cellW + GAP);
  const y = Math.floor(slot / COLS) * (cellH + GAP);
  return (
    <View style={[styles.cell, { width: cellW, transform: [{ translateX: x }, { translateY: y }] }]}>
      <Pressable style={[styles.addTile, { height: tileH }]} onPress={onAdd}>
        <View style={styles.addPlus}><Feather name="plus" size={20} color={Colors.light.primary} /></View>
        <Text style={styles.addText}>Add{"\n"}a card</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  measure: { width: "100%", height: 1 },
  grid:    { width: "100%", position: "relative" },
  cell:    { position: "absolute", left: 0, top: 0 },
  tileInner: {
    width: "100%", borderRadius: 14, overflow: "hidden", backgroundColor: Brand.heroBg,
    shadowColor: "#0D0B08", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.22, shadowRadius: 12, elevation: 4,
  },
  title: { fontFamily: Fonts.bodySemiBold, fontSize: 11, color: Colors.light.textSecondary, marginTop: 6, paddingHorizontal: 2 },

  numBadge: {
    position: "absolute", top: 7, left: 7, minWidth: 20, height: 20, borderRadius: 10,
    backgroundColor: "rgba(12,13,16,0.6)", borderWidth: 1, borderColor: "rgba(255,255,255,0.3)",
    alignItems: "center", justifyContent: "center", paddingHorizontal: 5,
  },
  numBadgeText: { fontFamily: Fonts.bodyBold, fontSize: 11, color: Bold.onDark },
  lockChip: {
    position: "absolute", top: 8, right: 8, flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: "rgba(12,13,16,0.55)", borderRadius: 99, paddingHorizontal: 7, paddingVertical: 3,
  },
  lockChipText: { fontFamily: Fonts.bodyBold, fontSize: 8, letterSpacing: 0.6, textTransform: "uppercase", color: Bold.onDark },
  badge: {
    position: "absolute", top: 8, right: 8, backgroundColor: Colors.light.primary,
    borderRadius: 99, paddingHorizontal: 8, paddingVertical: 3,
  },
  badgeNew:  { backgroundColor: "#1A9960" },
  badgeText: { fontFamily: Fonts.bodyBold, fontSize: 8.5, letterSpacing: 0.5, textTransform: "uppercase", color: "#FFFFFF" },

  addTile: {
    width: "100%", borderRadius: 14, borderWidth: 1.5, borderColor: Colors.light.primary,
    borderStyle: "dashed", backgroundColor: "rgba(200,50,90,0.05)",
    alignItems: "center", justifyContent: "center", gap: 8,
  },
  addPlus: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.light.primaryLight,
    alignItems: "center", justifyContent: "center",
  },
  addText: { fontFamily: Fonts.bodyBold, fontSize: 12, color: Colors.light.primary, textAlign: "center", lineHeight: 15 },
});
