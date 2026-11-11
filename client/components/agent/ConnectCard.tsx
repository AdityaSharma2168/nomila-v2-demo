/**
 * ConnectCard (agent/1 `connect`) — Mila asks to connect a service when she needs it: the service, WHY (what it unlocks,
 * specific to the athlete's ask), and what it can access in plain words, with Connect / Not now. Connecting goes through
 * the existing OAuth door (hooks/use-platform-oauth: POST /me/connect/:platform, the same flow Settings uses) unless the
 * host supplies its own. Nothing connects without the tap; "Not now" says where to do it later.
 */
import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { Bold, BoldType } from "../../constants/theme";
import { MILA_CARD } from "../mila/milaSurface";
import { MilaButton, SettledLine, partStyles } from "./parts";
import { useAgentCardHandlers } from "./handlers";
import { serviceGlyph } from "../../lib/agent/cardLogic";
import { usePlatformOAuth } from "../../hooks/use-platform-oauth";
import type { Connection } from "../../hooks/use-connections";
import type { CardOf, ConnectPayloadWithNote } from "../../lib/agent/types";
import { PartnerNote } from "./parts";
import { haptics } from "../../lib/haptics";

export const CONNECT_COPY = {
  access: "What it can see",
  connect: "Connect",
  later: "Not now",
  connected: (service: string) => `${service} connected.`,
  laterLine: "Not now. You can connect any time in Settings.",
  notYet: "Not connected yet. Try again when you're ready.",
} as const;

/** The existing OAuth door, then a fresh read of the connections to see whether it took. */
function useDefaultConnect(connectorId: string) {
  const oauth = usePlatformOAuth(connectorId);
  const qc = useQueryClient();
  return async (): Promise<boolean> => {
    await oauth.connect();
    try {
      const d = await qc.fetchQuery<{ connections: Connection[] }>({ queryKey: ["/api/v1/me/connections"], staleTime: 0 });
      return d.connections.some((c) => c.platform === connectorId && c.status === "active");
    } catch {
      return false;
    }
  };
}

export function ConnectCard({ card }: { card: CardOf<"connect"> }) {
  const p = card.payload as ConnectPayloadWithNote;
  const handlers = useAgentCardHandlers();
  const fallback = useDefaultConnect(p.connectorId);
  const [phase, setPhase] = useState<"open" | "connecting" | "connected" | "later" | "not_yet">("open");

  const onConnect = async () => {
    setPhase("connecting");
    const ok = await (handlers.connect ? handlers.connect(p.connectorId) : fallback()).catch(() => false);
    if (ok) haptics.success();
    // In the onboarding conversation the skill hears that a connect was started (its checkpoint), whatever OAuth said.
    void handlers.act?.([{ type: "connect", connectorId: p.connectorId, response: "started" }]).catch(() => {});
    setPhase(ok ? "connected" : "not_yet");
  };
  const onLater = () => {
    setPhase("later");
    void handlers.act?.([{ type: "connect", connectorId: p.connectorId, response: "declined" }]).catch(() => {});
  };

  return (
    <View style={styles.card} testID="card-connect">
      <View style={styles.head}>
        <View style={styles.glyph}><Feather name={serviceGlyph(p.connectorId) as any} size={20} color={Bold.ink} /></View>
        <View style={styles.flex}>
          <Text style={partStyles.title}>{card.title}</Text>
          <Text style={partStyles.body}>{p.why}</Text>
        </View>
      </View>
      {p.access.length ? (
        <View style={styles.access} accessibilityLabel={`${CONNECT_COPY.access}: ${p.access.join(". ")}`}>
          <Text style={styles.label}>{CONNECT_COPY.access}</Text>
          {p.access.map((a) => (
            <View key={a} style={styles.accessRow}>
              <Feather name="check" size={14} color={Bold.ink} />
              <Text style={styles.accessText}>{a}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {phase === "connected" ? (
        <SettledLine text={CONNECT_COPY.connected(p.service)} testID="connect-done" />
      ) : phase === "later" ? (
        <SettledLine text={CONNECT_COPY.laterLine} icon="clock" testID="connect-later" />
      ) : (
        <>
          {phase === "not_yet" ? <Text style={partStyles.caption} accessibilityLiveRegion="polite">{CONNECT_COPY.notYet}</Text> : null}
          {p.partnerNote ? <PartnerNote text={p.partnerNote} /> : null}
          <View style={partStyles.actions}>
            <MilaButton label={`${CONNECT_COPY.connect} ${p.service}`} accessibilityLabel={`${CONNECT_COPY.connect} ${p.service}`} onPress={() => { void onConnect(); }} loading={phase === "connecting"} flex testID="connect-go" />
            <MilaButton label={CONNECT_COPY.later} tone="soft" onPress={onLater} disabled={phase === "connecting"} testID="connect-later-btn" />
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...MILA_CARD, padding: 16, gap: 14 },
  flex: { flex: 1, gap: 4 },
  head: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  glyph: { width: 44, height: 44, borderRadius: 22, backgroundColor: Bold.ground, alignItems: "center", justifyContent: "center" },
  access: { backgroundColor: Bold.ground, borderRadius: 12, padding: 12, gap: 6 },
  label: { ...BoldType.label, color: Bold.mute },
  accessRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  accessText: { ...BoldType.read, color: Bold.ink, flex: 1 },
});
