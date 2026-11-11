// Brand › Deck — the whole Nomi Card deck at full width on the hero ground, then the actions a
// brand-facing deck needs (Share, Tailor to a brand, Edit) and the read: who opened it.
// Signals is a door off this screen. On the kit: Button onHero / ghost, IconButton, a flat Row.

import React, { useMemo, useState } from "react";
import { View, Text, StyleSheet, Modal, useWindowDimensions } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { BrandStackParamList } from "../../navigation/MainTabNavigator";
import { useAuth } from "../../lib/auth-context";
import { useAthleteCard, useShares } from "../../hooks/use-card";
import { CardDeck } from "../../components/card-native/CardDeck";
import { DECK_LOOK_LABEL, resolveDeckLook } from "../../../shared/deckLooks";
import { CardEditorScreen } from "../CardEditorScreen";
import { ShareSheet } from "../../components/card/ShareSheet";
import { BrandStackShell } from "./BrandStackShell";
import { Button, IconButton, Row } from "../../components/ui";
import { Colors, Fonts, Spacing, BorderRadius } from "../../constants/theme";
import { formatAgo } from "../../lib/recordLogic";

const C = Colors.light;
type NavProp = NativeStackNavigationProp<BrandStackParamList, "Deck">;

export function DeckScreen() {
  const navigation  = useNavigation<NavProp>();
  const { athlete } = useAuth();
  const athleteId   = athlete?.id;
  const { kit }     = useAthleteCard(athleteId);
  const { shares, totalOpens } = useShares(athleteId);
  const { width }   = useWindowDimensions();

  const [index, setIndex]         = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [editOpen, setEditOpen]   = useState(false);
  const [tailor, setTailor]       = useState(false);

  const look  = resolveDeckLook(kit?.tokens?.theme);
  const count = kit?.deck?.length || kit?.cards?.length || 0;
  const athleteName = [athlete?.firstName, athlete?.lastName].filter(Boolean).join(" ") || null;

  const lastOpened = useMemo(
    () => shares.map((s) => s.lastOpened).filter(Boolean).sort().slice(-1)[0] ?? null,
    [shares],
  );
  const reading = shares.filter((s) => s.opens > 0).length;

  // 9:16 card, full width less the gutters.
  const deckW = width - Spacing.xl * 2;
  const deckH = Math.round(deckW * 16 / 9);

  return (
    <BrandStackShell
      title="Deck"
      dark
      right={<IconButton onHero onPress={() => setEditOpen(true)} accessibilityLabel="Edit deck" style={styles.editBtn}><Feather name="edit-2" size={16} color={C.onHero} /></IconButton>}
    >
      <View style={[styles.deckSlot, { width: deckW, height: deckH }]}>
        <CardDeck athleteId={athleteId} activeIndex={index} onIndexChange={setIndex} showProgress={false} onShare={() => setShareOpen(true)} theme={look} />
      </View>

      {count > 1 && (
        <View style={styles.dots} accessibilityLabel={`Card ${index + 1} of ${count}`}>
          {Array.from({ length: count }).map((_, i) => (
            <View key={i} style={[styles.dot, i === index && styles.dotOn]} />
          ))}
        </View>
      )}

      <Text style={styles.lookLine}>{DECK_LOOK_LABEL[look]} look · {count} card{count === 1 ? "" : "s"}</Text>

      <View style={styles.actions}>
        <Button onHero icon={<Feather name="send" size={16} color={Colors.dark.backgroundRoot} />} onPress={() => { setTailor(false); setShareOpen(true); }} style={{ flex: 1 }}>Share</Button>
        <Button ghost icon={<Feather name="target" size={16} color={C.onHero} />} onPress={() => { setTailor(true); setShareOpen(true); }} style={styles.tailor}>Tailor to a brand</Button>
      </View>

      {/* Who opened it — the read, folded in from Signals */}
      <View style={styles.signals}>
        <Row
          leading={<View style={styles.signalsIcon}><Feather name="bar-chart-2" size={16} color={C.onHero} /></View>}
          onPress={() => navigation.navigate("Signals")}
          last
        >
          <Text style={styles.signalsTitle}>Who opened it</Text>
          <Text style={styles.signalsSub}>
            {totalOpens > 0
              ? `${totalOpens} open${totalOpens === 1 ? "" : "s"} across ${reading} share${reading === 1 ? "" : "s"}${lastOpened ? ` · last ${formatAgo(lastOpened)}` : ""}`
              : shares.length > 0 ? `${shares.length} share${shares.length === 1 ? "" : "s"} sent · no opens yet` : "Share it and the reads show up here"}
          </Text>
        </Row>
      </View>

      {editOpen && (
        <Modal transparent statusBarTranslucent animationType="slide" visible onRequestClose={() => setEditOpen(false)}>
          <CardEditorScreen title="Edit your deck" onBack={() => setEditOpen(false)} onPublishSuccess={() => setEditOpen(false)} />
        </Modal>
      )}

      {shareOpen && (
        <ShareSheet
          athleteId={athleteId}
          athleteName={athleteName}
          lookLabel={DECK_LOOK_LABEL[look]}
          initialBrand={tailor ? {} : undefined}
          onClose={() => setShareOpen(false)}
          onViewSignals={() => { setShareOpen(false); navigation.navigate("Signals"); }}
        />
      )}
    </BrandStackShell>
  );
}

const ON_HERO_LINE = "rgba(243,238,228,0.3)";
const ON_HERO_FILL = "rgba(243,238,228,0.08)";

const styles = StyleSheet.create({
  editBtn:      { width: 32, height: 32, borderRadius: 16 },
  deckSlot:     { alignSelf: "center", marginTop: Spacing.sm, borderRadius: BorderRadius.md, overflow: "hidden" },
  dots:         { flexDirection: "row", justifyContent: "center", gap: 6, marginTop: Spacing.md },
  dot:          { width: 6, height: 6, borderRadius: 3, backgroundColor: ON_HERO_LINE },
  dotOn:        { backgroundColor: C.onHero, width: 18 },
  lookLine:     { fontFamily: Fonts.body, fontSize: 12, color: Colors.dark.textQuiet, textAlign: "center", marginTop: Spacing.sm },
  actions:      { flexDirection: "row", gap: Spacing.sm, marginHorizontal: Spacing.xl, marginTop: Spacing.lg },
  tailor:       { flex: 1.3, borderColor: ON_HERO_LINE },
  signals:      { marginHorizontal: Spacing.xl, marginTop: Spacing.lg, borderRadius: BorderRadius.md, backgroundColor: ON_HERO_FILL, overflow: "hidden" },
  signalsIcon:  { width: 34, height: 34, borderRadius: 10, backgroundColor: ON_HERO_FILL, alignItems: "center", justifyContent: "center" },
  signalsTitle: { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: C.onHero },
  signalsSub:   { fontFamily: Fonts.body, fontSize: 12, color: Colors.dark.textQuiet, marginTop: 1 },
});
