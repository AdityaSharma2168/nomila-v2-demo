/**
 * ThreadsScreen — every Create anything conversation, so leaving one does not end it.
 *
 * Starting a new thread used to wipe the last one with no warning, which made the back arrow a
 * destructive action wearing the costume of a navigation control.
 *
 * Archiving takes a thread off the list rather than deleting it, and says nothing about what it
 * made: anything generated is on the Made shelf either way, because the thread is the conversation
 * and the shelf is the work.
 *
 * ─── REAL NOW, BEHIND EXPO_PUBLIC_STUDIO_SESSIONS ──────────────────────────────────────────────
 *
 * useStudioThreads reads GET /studio/sessions (session persistence plan v2 §4): open threads, then
 * archived ones, 30 of each, newest first — no paging in v1. A row opens its thread; "+" mints a new
 * one and leaves this one open (D3a); archive and restore are the only other things a row does
 * (D8: nothing is deleted). With the flag off the hook is the stub it was, and this screen is the
 * empty state it always showed.
 *
 * A failed read and a server with threads switched off are each said for what they are — never
 * shown as "Nothing here yet", which would tell her she has no threads when we could not ask.
 */
import React from "react";
import {
  View,
  Text,
  ScrollView,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Image,
  ActivityIndicator,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { StudioStackParamList } from "../../navigation/MainTabNavigator";
import { HapticPressable } from "../../components/HapticPressable";
import { Colors, Fonts, Spacing } from "../../constants/theme";
import { useStudioThreads, type StudioThread } from "../../hooks/use-studio-pending";
import { newId, useSetArchived } from "../../hooks/use-studio-sessions";
import { relativeTime } from "./threadLogic";

export function ThreadsScreen() {
  const nav = useNavigation<NativeStackNavigationProp<StudioStackParamList>>();
  const { data, isLoading, isError, isUnavailable } = useStudioThreads();
  const archive = useSetArchived();

  const live = data.filter((t) => !t.archived);
  const archived = data.filter((t) => t.archived);
  const now = Date.now();

  const open = (sessionId: string) =>
    nav.navigate("StudioCreateAnything", { sessionId });

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.topbar}>
        <HapticPressable
          onPress={() => nav.goBack()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Feather name="chevron-left" size={22} color={Colors.light.text} />
        </HapticPressable>
        <Text style={styles.topTitle}>Your threads</Text>
        <HapticPressable
          style={styles.newBtn}
          // A NEW key every press, so this is a fresh mount with an empty tray rather than a pop
          // back to the thread she just left. `navigate` alone does not push when the screen is
          // already in the stack — which, arriving here from it, it always is. See
          // CreateAnythingRoute for the mechanism.
          onPress={() =>
            nav.navigate("StudioCreateAnything", { sessionId: newId() })
          }
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel="New thread"
        >
          <Feather name="plus" size={18} color={Colors.light.buttonText} />
        </HapticPressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
      >
        {isLoading ? (
          <View style={styles.empty}>
            <ActivityIndicator color={Colors.light.textMuted} />
          </View>
        ) : isError ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              Couldn&apos;t load your threads
            </Text>
            <Text style={styles.emptyBody}>
              They&apos;re still there. Come back to this in a moment.
            </Text>
          </View>
        ) : isUnavailable ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              Threads aren&apos;t kept here yet
            </Text>
            <Text style={styles.emptyBody}>
              What you make is on your Made shelf. The conversation lasts until
              you leave it.
            </Text>
          </View>
        ) : live.length === 0 && archived.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Nothing here yet</Text>
            <Text style={styles.emptyBody}>
              Ask for something and the thread keeps itself.
            </Text>
          </View>
        ) : null}

        {live.length > 0 ? (
          <>
            <Text style={styles.label}>OPEN</Text>
            {live.map((t) => (
              <ThreadRow
                key={t.id}
                thread={t}
                now={now}
                busy={
                  archive.isPending && archive.variables?.sessionId === t.id
                }
                onOpen={() => open(t.id)}
                onArchive={() =>
                  archive.mutate({ sessionId: t.id, archived: true })
                }
              />
            ))}
          </>
        ) : null}

        {archived.length > 0 ? (
          <>
            <Text style={[styles.label, { marginTop: 22 }]}>ARCHIVED</Text>
            {archived.map((t) => (
              <ThreadRow
                key={t.id}
                thread={t}
                now={now}
                busy={
                  archive.isPending && archive.variables?.sessionId === t.id
                }
                onOpen={() => open(t.id)}
                onArchive={() =>
                  archive.mutate({ sessionId: t.id, archived: false })
                }
              />
            ))}
          </>
        ) : null}

        {archive.isError ? (
          <Text style={styles.failed}>{archive.error.message}</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ThreadRow({
  thread,
  now,
  busy,
  onOpen,
  onArchive,
}: {
  thread: StudioThread;
  now: number;
  busy: boolean;
  onOpen: () => void;
  /** Archive an open thread, restore an archived one. */
  onArchive: () => void;
}) {
  const when = relativeTime(thread.updatedAt, now);
  return (
    <View style={styles.row}>
      <HapticPressable
        style={styles.rowMain}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`Open ${thread.title}`}
      >
        <View style={styles.thumb}>
          {thread.thumbUrl ? (
            <Image
              source={{ uri: thread.thumbUrl }}
              style={StyleSheet.absoluteFill}
            />
          ) : (
            <View style={[StyleSheet.absoluteFill, styles.thumbBlank]}>
              <Feather
                name="zap"
                size={15}
                color={Colors.light.tabIconDefault}
              />
            </View>
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {thread.title}
          </Text>
          <Text style={styles.rowSub}>
            {when ? `${when} · ` : ""}
            {thread.thumbUrl ? "made something" : "nothing made yet"}
          </Text>
        </View>
      </HapticPressable>
      <HapticPressable
        style={styles.rowAction}
        onPress={onArchive}
        disabled={busy}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={
          thread.archived
            ? `Restore ${thread.title}`
            : `Archive ${thread.title}`
        }
        accessibilityState={{ disabled: busy, busy }}
      >
        {busy ? (
          <ActivityIndicator size="small" color={Colors.light.textMuted} />
        ) : (
          <Feather
            name={thread.archived ? "rotate-ccw" : "archive"}
            size={15}
            color={Colors.light.textSecondary}
          />
        )}
      </HapticPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  topbar: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: Spacing.xl, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: Colors.light.border,
  },
  topTitle: { flex: 1, fontFamily: Fonts.bodyBold, fontSize: 15.5, fontWeight: "700", color: Colors.light.text },
  newBtn: {
    width: 34, height: 34, borderRadius: 99, backgroundColor: Colors.light.primary,
    alignItems: "center", justifyContent: "center",
  },
  body: { padding: Spacing.xl, paddingBottom: 30 },
  label: {
    fontFamily: Fonts.bodyBold, fontSize: 10.5, fontWeight: "700", letterSpacing: 1.3,
    color: Colors.light.textMuted, marginBottom: 9,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 15,
    padding: 10,
    marginBottom: 8,
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
  },
  rowAction: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.light.border,
  },
  thumb: {
    width: 42, height: 52, borderRadius: 10, overflow: "hidden",
    backgroundColor: Colors.light.backgroundSecondary,
  },
  thumbBlank: { alignItems: "center", justifyContent: "center" },
  rowTitle: { fontFamily: Fonts.bodyBold, fontSize: 13, fontWeight: "700", color: Colors.light.text },
  rowSub: { fontFamily: Fonts.body, fontSize: 11, color: Colors.light.textMuted, marginTop: 3 },
  failed: {
    fontFamily: Fonts.body,
    fontSize: 12,
    lineHeight: 17,
    color: Colors.light.textSecondary,
    marginTop: 10,
  },
  empty: { alignItems: "center", paddingTop: 40 },
  emptyTitle: { fontFamily: Fonts.bodyBold, fontSize: 15, fontWeight: "700", color: Colors.light.text },
  emptyBody: {
    fontFamily: Fonts.body, fontSize: 13, lineHeight: 19, color: Colors.light.textMuted,
    marginTop: 5, textAlign: "center", maxWidth: 260,
  },
});
