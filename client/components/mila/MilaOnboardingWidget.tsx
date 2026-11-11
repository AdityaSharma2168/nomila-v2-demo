/**
 * MilaOnboardingWidget.tsx — the first-entry receipt card.
 *
 * Rendered from an `onboarding_update` widget (server/mila/widgets.ts) after Mila calls
 * complete_onboarding_step. Two parts, each present only when there is something to show:
 *
 *   Saved      one line per profile fact Mila wrote from the athlete's own words, with Undo.
 *              Undo posts to the receipt (/agent-actions/:id/undo) — the same reversible-action
 *              log every other Mila action uses — and strikes the line through on success.
 *   The doors  after the greeting: two buttons. A tap completes the `doors` step directly
 *              (mode 'form'); saying it to Mila completes it through her tool instead. Either
 *              way the run finishes and the launcher closes onboarding via onDone.
 *
 * Tap-to-act: the buttons are the only thing here that changes state, and both act on this
 * card's own run id. A stale card in scrollback can only ever complete its own step, which the
 * server refuses once it is done (409 → treated as done).
 */

import React, { useCallback, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { getApiUrl, getAuthHeaders } from "../../lib/query-client";
import { haptics } from "../../lib/haptics";
import { N, oppsFont } from "../deals/opps/tokens";
import type { OnboardingUpdateWidgetData } from "../../hooks/use-mila-chat";
import { MILA_CARD } from "./milaSurface";

type Door = "profile" | "deals";

const DOOR_COPY: Record<Door, { title: string; sub: string; icon: React.ComponentProps<typeof Feather>["name"] }> = {
  profile: { title: "Build my profile with Mila", sub: "A few questions, then your public card.", icon: "user" },
  deals:   { title: "Show me my deals",           sub: "See what's in your inbox first.",         icon: "inbox" },
};

export function MilaOnboardingWidget({
  data,
  onDone,
}: {
  data: OnboardingUpdateWidgetData;
  /** Fired once the run is finished (door chosen here, or already finished elsewhere). */
  onDone?: (door: Door | null) => void;
}) {
  const [undone, setUndone] = useState<Set<string>>(new Set());
  const [busyUndo, setBusyUndo] = useState<string | null>(null);
  const [busyDoor, setBusyDoor] = useState<Door | null>(null);
  const [error, setError] = useState<string | null>(null);

  const undo = useCallback(async (agentActionId: string) => {
    haptics.press();
    setBusyUndo(agentActionId);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${getApiUrl()}/api/v1/me/agent-actions/${agentActionId}/undo`, { method: "POST", headers });
      if (res.ok || res.status === 409) setUndone((prev) => new Set(prev).add(agentActionId));
      else setError("Couldn't undo that. Try again.");
    } catch {
      setError("Couldn't undo that. Try again.");
    } finally {
      setBusyUndo(null);
    }
  }, []);

  const choose = useCallback(async (door: Door) => {
    haptics.press();
    setBusyDoor(door);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${getApiUrl()}/api/v1/me/workflow/runs/${data.runId}/steps/doors/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ fields: { door, mode: "form" }, mode: "form" }),
      });
      // 409 = the step was already answered (in words, or from another device) — that is done too.
      if (res.ok || res.status === 409) onDone?.(door);
      else setError("Couldn't save that. Try again, or just tell Mila.");
    } catch {
      setError("Couldn't save that. Try again, or just tell Mila.");
    } finally {
      setBusyDoor(null);
    }
  }, [data.runId, onDone]);

  const showDoors = data.next === "doors" && !data.door;
  const saved = data.saved ?? [];

  if (!saved.length && !showDoors && data.next !== "done") return null;

  return (
    <View style={styles.card}>
      {saved.length > 0 && (
        <View style={styles.section}>
          <View style={styles.headRow}>
            <Feather name="check-circle" size={14} color={N.successInk} />
            <Text style={styles.headText}>Saved to your profile</Text>
          </View>
          {saved.map((s, i) => {
            const isUndone = !!s.agentActionId && undone.has(s.agentActionId);
            return (
              <View key={`${s.field}-${i}`} style={styles.factRow}>
                <View style={styles.factText}>
                  <Text style={styles.factLabel}>{s.label}</Text>
                  <Text style={[styles.factValue, isUndone && styles.struck]} numberOfLines={2}>{s.value}</Text>
                </View>
                {s.agentActionId && !isUndone ? (
                  <Pressable
                    onPress={() => undo(s.agentActionId!)}
                    disabled={busyUndo === s.agentActionId}
                    hitSlop={8}
                    accessibilityLabel={`Undo saving ${s.label}`}
                    style={({ pressed }) => [styles.undoBtn, pressed && { opacity: 0.7 }]}
                  >
                    {busyUndo === s.agentActionId
                      ? <ActivityIndicator size="small" color={N.ink500} />
                      : <Text style={styles.undoText}>Undo</Text>}
                  </Pressable>
                ) : isUndone ? (
                  <Text style={styles.undoneText}>Undone</Text>
                ) : null}
              </View>
            );
          })}
        </View>
      )}

      {showDoors && (
        <View style={styles.section}>
          <Text style={styles.doorsHead}>Where do you want to start?</Text>
          {(Object.keys(DOOR_COPY) as Door[]).map((door) => {
            const c = DOOR_COPY[door];
            const busy = busyDoor === door;
            return (
              <Pressable
                key={door}
                onPress={() => choose(door)}
                disabled={busyDoor !== null}
                accessibilityRole="button"
                accessibilityLabel={c.title}
                style={({ pressed }) => [styles.door, pressed && styles.doorPressed, busyDoor !== null && !busy && { opacity: 0.6 }]}
              >
                <View style={styles.doorIcon}>
                  <Feather name={c.icon} size={18} color={N.ink700} />
                </View>
                <View style={styles.doorText}>
                  <Text style={styles.doorTitle}>{c.title}</Text>
                  <Text style={styles.doorSub}>{c.sub}</Text>
                </View>
                {busy ? <ActivityIndicator size="small" color={N.ink500} /> : <Feather name="chevron-right" size={18} color={N.ink300} />}
              </Pressable>
            );
          })}
        </View>
      )}

      {data.next === "done" && !showDoors && (
        <View style={styles.doneRow}>
          <Feather name="check" size={14} color={N.successInk} />
          <Text style={styles.doneText}>{data.door === "deals" ? "Taking you to your deals." : data.door === "profile" ? "Let's build your profile." : "You're all set."}</Text>
        </View>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // A light Mila card with the soft lift, no border (milaSurface).
  card: {
    ...MILA_CARD,
    padding: 14,
    gap: 14,
  },
  section: { gap: 10 },
  headRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  headText: { fontFamily: oppsFont(600), fontSize: 12, color: N.ink500, letterSpacing: 0.3, textTransform: "uppercase" },
  factRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  factText: { flex: 1, gap: 1 },
  factLabel: { fontFamily: oppsFont(500), fontSize: 12, color: N.ink500 },
  factValue: { fontFamily: oppsFont(600), fontSize: 15, color: N.ink900 },
  struck: { textDecorationLine: "line-through", color: N.ink300 },
  undoBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: N.cream200 },
  undoText: { fontFamily: oppsFont(600), fontSize: 13, color: N.ink700 },
  undoneText: { fontFamily: oppsFont(500), fontSize: 12, color: N.ink300 },
  doorsHead: { fontFamily: oppsFont(700), fontSize: 15, color: N.ink900 },
  // A soft cream row inside the card — no outline; pressing deepens the cream.
  door: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    backgroundColor: N.cream100,
  },
  doorPressed: { backgroundColor: N.cream300 },
  doorIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: N.white, alignItems: "center", justifyContent: "center" },
  doorText: { flex: 1, gap: 2 },
  doorTitle: { fontFamily: oppsFont(600), fontSize: 15, color: N.ink900 },
  doorSub: { fontFamily: oppsFont(400), fontSize: 12.5, color: N.ink500 },
  doneRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  doneText: { fontFamily: oppsFont(500), fontSize: 13.5, color: N.ink700 },
  error: { fontFamily: oppsFont(500), fontSize: 12.5, color: N.errorInk },
});
