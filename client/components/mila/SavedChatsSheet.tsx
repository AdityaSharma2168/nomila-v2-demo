// Saved-chats list (Phase-2 memory, reopen side). A full-screen sheet listing
// this athlete's past Ask Mila conversations, most-recent first; tapping one
// hands its id up so the overlay can reopen it (useMilaChat.openConversation).
//
// Best-effort: a failed fetch shows the empty state, never an error that blocks
// the chat. Long-press a row to delete that chat; "Delete all chats" sits at the
// foot of the list. Both confirm first (client/lib/milaChats.ts).
//
// Look (owner direction, 8 Oct 2026, "much like Muse"; DESIGN.md §16): the same as the
// Ask Mila overlay it opens from — a frosted round close button (Frost), and each chat a
// light card with the soft lift (milaSurface), no outlines.

import React, { useEffect, useState } from "react";
import { fetch } from "expo/fetch";
import {
  Modal,
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getApiUrl, getAuthHeaders } from "../../lib/query-client";
import { N, oppsFont } from "../deals/opps/tokens";
import { haptics } from "../../lib/haptics";
import { Frost } from "./Frost";
import { MILA_CARD } from "./milaSurface";

/** The overlay's frosted top-bar circle: 40 visible, hitSlop 10 → a 60pt target. */
const TOP_BTN = 40;
import { confirmDeleteAllChats, confirmDeleteChat } from "../../lib/milaChats";

interface ConversationListItem {
  id:         string;
  title:      string | null;
  updated_at: string | null;
}

// Compact relative time for the list — "just now" → "3d ago" → a date. Purely
// presentational; the server sends an ISO timestamp.
function timeAgo(iso?: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return new Date(then).toLocaleDateString();
}

export function SavedChatsSheet({
  visible,
  onClose,
  onSelect,
  onDeleted,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (conversationId: string) => void;
  /** A chat was deleted (its id), or every chat ("all"). The overlay starts fresh
   *  if the open conversation was among them. */
  onDeleted?: (conversationId: string | "all") => void;
}) {
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<ConversationListItem[]>([]);
  const [loading, setLoading] = useState(false);

  // Refetch each time the sheet opens — recency + titles change as the athlete chats.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const authHeaders = await getAuthHeaders();
        const res = await fetch(`${getApiUrl()}/api/v1/me/conversations`, {
          method: "GET",
          headers: { ...authHeaders },
        });
        if (!res.ok) {
          if (!cancelled) setItems([]);
          return;
        }
        const data = (await res.json()) as {
          conversations?: ConversationListItem[];
        };
        if (!cancelled) setItems(data.conversations ?? []);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.topBar}>
          <Text style={styles.topTitle}>Saved chats</Text>
          <Pressable
            onPress={onClose}
            hitSlop={10}
            accessibilityLabel="Close"
            style={({ pressed }) => [styles.topBtn, pressed && { opacity: 0.7 }]}
          >
            <Frost radius={TOP_BTN / 2} style={styles.topBtnGlass}>
              <Feather name="x" size={17} color={N.ink700} />
            </Frost>
          </Pressable>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={N.ink500} />
          </View>
        ) : items.length === 0 ? (
          <View style={styles.center}>
            <Feather name="message-circle" size={28} color={N.ink300} />
            <Text style={styles.emptyText}>No saved chats yet</Text>
          </View>
        ) : (
          <ScrollView
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
          >
            {items.map((c) => (
              <Pressable
                key={c.id}
                onPress={() => onSelect(c.id)}
                onLongPress={async () => {
                  haptics.press();
                  if (await confirmDeleteChat(c.id)) {
                    setItems((prev) => prev.filter((x) => x.id !== c.id));
                    onDeleted?.(c.id);
                  }
                }}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
                accessibilityLabel={`Open chat: ${c.title ?? "Untitled"}`}
                accessibilityHint="Long-press to delete this chat"
                accessibilityActions={[{ name: "delete", label: "Delete this chat" }]}
                onAccessibilityAction={async (e) => {
                  if (e.nativeEvent.actionName === "delete" && (await confirmDeleteChat(c.id))) {
                    setItems((prev) => prev.filter((x) => x.id !== c.id));
                    onDeleted?.(c.id);
                  }
                }}
              >
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {c.title ?? "Untitled chat"}
                  </Text>
                  <Text style={styles.rowMeta}>{timeAgo(c.updated_at)}</Text>
                </View>
                <Feather name="chevron-right" size={18} color={N.ink300} />
              </Pressable>
            ))}
            <Text style={styles.hint}>Long-press a chat to delete it.</Text>
            <Pressable
              onPress={async () => {
                haptics.press();
                if (await confirmDeleteAllChats()) {
                  setItems([]);
                  onDeleted?.("all");
                }
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Delete all chats"
              style={({ pressed }) => [styles.deleteAll, pressed && { opacity: 0.7 }]}
            >
              <Feather name="trash-2" size={14} color={N.ink500} />
              <Text style={styles.deleteAllText}>Delete all chats</Text>
            </Pressable>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: N.cream100 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 6,
    paddingBottom: 12,
    paddingHorizontal: 20,
  },
  topTitle: {
    fontFamily: oppsFont(800),
    fontSize: 17,
    color: N.ink900,
    letterSpacing: -0.2,
  },
  // Frosted circle, no outline — the overlay's top-bar button.
  topBtn: { marginLeft: "auto", width: TOP_BTN, height: TOP_BTN, borderRadius: TOP_BTN / 2 },
  topBtnGlass: { width: TOP_BTN, height: TOP_BTN, alignItems: "center", justifyContent: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  emptyText: {
    fontFamily: oppsFont(500),
    fontSize: 14.5,
    color: N.ink500,
  },
  list: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 24, gap: 10 },
  // A light card with the soft lift, no border (milaSurface).
  row: {
    ...MILA_CARD,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  rowText: { flex: 1, gap: 3 },
  rowTitle: {
    fontFamily: oppsFont(600),
    fontSize: 15,
    color: N.ink900,
  },
  rowMeta: {
    fontFamily: oppsFont(400),
    fontSize: 12.5,
    color: N.ink500,
  },
  hint: {
    fontFamily: oppsFont(400),
    fontSize: 12.5,
    color: N.ink500,
    textAlign: "center",
    marginTop: 6,
  },
  deleteAll: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
  },
  deleteAllText: {
    fontFamily: oppsFont(600),
    fontSize: 13.5,
    color: N.ink500,
  },
});
