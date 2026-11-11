// WS2 · DecisionSheet — the "deciding" surface.
//
// Opens over the Brief (the athlete never leaves the queue). Position-FIRST: Mila's
// composed stance leads; evidence (why / red flags) is one tap down; the plan is the
// negotiate terms as steps. The primary CTA is Mila's plan — when that plan is to
// negotiate, it opens the NegotiateComposer (the per-deal rate-override surface);
// otherwise it hands off to the existing composer. Either way it's co-pilot: preview
// before anything sends.
//
// A plain RN Modal bottom sheet — no new sheet dependency; matches the app's other
// modal surfaces.

import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet, Modal, ScrollView } from "react-native";
import { Feather } from "@expo/vector-icons";
import { BrandLogo } from "../../BrandLogo";
import type { DealItem } from "../DealCard";
import { NegotiateComposer } from "./NegotiateComposer";
import { Fonts, Colors, Spacing, BorderRadius } from "../../../constants/theme";

interface DecisionSheetProps {
  deal:        DealItem | null;
  onClose:     () => void;
  onPrimary:   (deal: DealItem) => void;  // approve Mila's plan → existing composer
  onViewThread:(deal: DealItem) => void;
}

export function DecisionSheet({ deal, onClose, onPrimary, onViewThread }: DecisionSheetProps) {
  const [showWhy, setShowWhy]         = useState(false);
  const [negotiating, setNegotiating] = useState(false);  // NegotiateComposer open

  if (!deal) return null;

  const line     = deal.voice?.line ?? deal.aiSummary ?? "";
  const primary  = deal.voice?.primaryActionLabel ?? "Take a look";
  const terms    = (deal.negotiateTerms ?? []).filter((t) => typeof t === "string" && t.trim());
  const reasons  = (deal.reasons ?? []).filter(Boolean);
  const redFlags = (deal.redFlags ?? []).filter(Boolean);

  // When Mila's plan IS to negotiate, the primary CTA opens the rate-override
  // composer instead of the generic composer. The composer is also reachable as an
  // override for any other recommendation (the athlete can always counter).
  const isNegotiate = deal.recommendation === "negotiate";

  return (
   <>
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.grab} />

        {/* Header */}
        <View style={styles.header}>
          <BrandLogo brandName={deal.brandName} brandDomain={deal.brandDomain} size={30} borderRadius={8} />
          <Text style={styles.headerText} numberOfLines={1}>
            {deal.brandName}
            {deal.awaitingResponseFrom === "athlete" ? " · your move" : ""}
          </Text>
          <Pressable hitSlop={8} onPress={onClose}>
            <Feather name="x" size={20} color={Colors.light.textMuted} />
          </Pressable>
        </View>

        <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
          {/* My position — recoCard treatment */}
          <View style={styles.position}>
            <Text style={styles.posLabel}>MY POSITION</Text>
            <Text style={styles.posLine}>{line}</Text>
          </View>

          {/* Disclosure ladder */}
          {(reasons.length > 0 || redFlags.length > 0) && (
            <Pressable style={styles.ladderRow} onPress={() => setShowWhy((v) => !v)} hitSlop={6}>
              <Text style={styles.ladderText}>Why Mila says this</Text>
              <Feather name={showWhy ? "chevron-up" : "chevron-down"} size={16} color={Colors.light.textMuted} />
            </Pressable>
          )}
          {showWhy && (
            <View style={styles.why}>
              {redFlags.map((f, i) => (
                <Text key={`f${i}`} style={styles.flag}>⚠ {f}</Text>
              ))}
              {reasons.slice(0, 4).map((r, i) => (
                <Text key={`r${i}`} style={styles.reason}>• {r}</Text>
              ))}
            </View>
          )}

          {/* The plan — negotiate terms as steps */}
          {terms.length > 0 && (
            <View style={styles.plan}>
              <Text style={styles.posLabel}>THE PLAN</Text>
              {terms.slice(0, 4).map((t, i) => (
                <Text key={i} style={styles.step}>{i + 1}. {t}</Text>
              ))}
            </View>
          )}
        </ScrollView>

        {/* Actions */}
        <View style={styles.actions}>
          <Pressable
            style={[styles.btn, styles.btnPrimary]}
            onPress={() => (isNegotiate ? setNegotiating(true) : onPrimary(deal))}
          >
            <Text style={styles.btnPrimaryText} numberOfLines={1}>{primary}</Text>
          </Pressable>
          {!!deal.threadId && (
            <Pressable style={styles.btn} onPress={() => onViewThread(deal)}>
              <Text style={styles.btnText}>See thread{deal.messageCount ? ` (${deal.messageCount})` : ""}</Text>
            </Pressable>
          )}
        </View>

        {/* Override path — negotiate the rate even when Mila's plan isn't a counter */}
        {!isNegotiate && (
          <Pressable style={styles.negotiateLink} onPress={() => setNegotiating(true)} hitSlop={6}>
            <Feather name="trending-up" size={14} color={Colors.light.primary} />
            <Text style={styles.negotiateLinkText}>Negotiate the rate instead</Text>
          </Pressable>
        )}
      </View>
    </Modal>

    {/* The per-deal rate-override composer (co-pilot: nothing sends without review). */}
    <NegotiateComposer
      deal={deal}
      visible={negotiating}
      onClose={() => setNegotiating(false)}
      onSent={() => { setNegotiating(false); onClose(); }}
    />
   </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(26,26,26,0.28)" },
  sheet: {
    position: "absolute", left: 0, right: 0, bottom: 0,
    maxHeight: "82%",
    backgroundColor: Colors.light.card,
    borderTopLeftRadius: BorderRadius.md, borderTopRightRadius: BorderRadius.md,
    paddingBottom: Spacing.xl,
  },
  grab: { width: 36, height: 4, borderRadius: 2, backgroundColor: "#DDD6CE", alignSelf: "center", marginTop: 10, marginBottom: 8 },
  header: {
    flexDirection: "row", alignItems: "center", gap: Spacing.sm,
    paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.light.borderLight,
  },
  headerText: { flex: 1, fontFamily: Fonts.bodySemiBold, fontSize: 14, color: Colors.light.text },
  scroll: { paddingHorizontal: Spacing.lg },
  position: {
    backgroundColor: "#FFF8FC", borderLeftWidth: 3, borderLeftColor: Colors.light.primary,
    borderRadius: BorderRadius.xs, padding: 12, marginTop: Spacing.md,
  },
  posLabel: { fontFamily: Fonts.bodySemiBold, fontSize: 9.5, letterSpacing: 1.2, color: Colors.light.primary },
  posLine: { fontFamily: Fonts.body, fontSize: 15, lineHeight: 21, color: Colors.light.text, marginTop: 7 },
  ladderRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingVertical: 11, marginTop: Spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.light.borderLight,
  },
  ladderText: { fontFamily: Fonts.bodyMedium, fontSize: 13, color: Colors.light.textSecondary },
  why: { paddingVertical: Spacing.sm, gap: 6 },
  flag: { fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 18, color: "#7A5A00" },
  reason: { fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 18, color: Colors.light.textSecondary },
  plan: { marginTop: Spacing.md },
  step: { fontFamily: Fonts.body, fontSize: 13, lineHeight: 20, color: Colors.light.textSecondary, marginTop: 4 },
  actions: {
    flexDirection: "row", gap: Spacing.sm,
    paddingHorizontal: Spacing.lg, paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.light.borderLight,
  },
  btn: {
    paddingHorizontal: 16, paddingVertical: 12, borderRadius: BorderRadius.full,
    borderWidth: 1, borderColor: Colors.light.border, backgroundColor: Colors.light.card,
    alignItems: "center", justifyContent: "center",
  },
  btnPrimary: { flex: 1, backgroundColor: Colors.light.primary, borderColor: Colors.light.primary },
  btnPrimaryText: { fontFamily: Fonts.bodySemiBold, fontSize: 14, color: "#fff" },
  btnText: { fontFamily: Fonts.bodySemiBold, fontSize: 13, color: Colors.light.textSecondary },
  negotiateLink: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    paddingTop: Spacing.md, paddingHorizontal: Spacing.lg,
  },
  negotiateLinkText: { fontFamily: Fonts.bodySemiBold, fontSize: 13, color: Colors.light.primary },
});
