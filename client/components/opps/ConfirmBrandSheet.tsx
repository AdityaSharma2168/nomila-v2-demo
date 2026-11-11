// ConfirmBrandSheet — "Confirm this is [brand]" (owner, 7 Oct 2026). Shows the candidate Nomila found — its logo,
// name and site — and asks her to say whether that is the company that wrote. "Yes, that's them" sends the
// candidate's DOMAIN as evidence (the research gate then checks research against it); "Not this one" records the
// rejection so that candidate is never offered again. Nothing else changes, and nothing is sent to the brand.
import React from "react";
import { Modal, View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { LogoMark } from "../ui/LogoMark";
import { Bold, Fonts } from "../../constants/theme";
import type { BrandCandidate } from "../../hooks/use-brand-candidate";
import { useBrandDecision } from "../../hooks/use-brand-candidate";

interface Props {
  brandId: number;
  brandName: string;
  candidate: BrandCandidate;
  onClose: () => void;
}

export function ConfirmBrandSheet({ brandId, brandName, candidate, onClose }: Props) {
  const decide = useBrandDecision(brandId);
  const run = (decision: "confirm" | "not_this") =>
    decide.mutate({ decision, domain: candidate.domain }, { onSuccess: onClose });

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <Pressable style={styles.bg} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <Text style={styles.title}>Is this {brandName}?</Text>
        <Text style={styles.lede}>Nomila found this company. If it’s the one that wrote to you, it can show you what it knows about them.</Text>
        <View style={styles.cand}>
          <LogoMark logoUrl={candidate.logo} domain={candidate.domain} name={candidate.name} size={52} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.candName} numberOfLines={2}>{candidate.name}</Text>
            <Text style={styles.candSite} numberOfLines={1}>{candidate.domain}</Text>
          </View>
        </View>
        {decide.isError ? <Text style={styles.err}>That didn’t save. Try again.</Text> : null}
        <Pressable style={[styles.btn, styles.primary]} onPress={() => run("confirm")} disabled={decide.isPending} accessibilityRole="button">
          {decide.isPending ? <ActivityIndicator color={Bold.onAct} /> : <Text style={styles.primaryT}>Yes, that’s them</Text>}
        </Pressable>
        <Pressable style={styles.btn} onPress={() => run("not_this")} disabled={decide.isPending} accessibilityRole="button">
          <Text style={styles.secondaryT}>Not this one</Text>
        </Pressable>
        <Text style={styles.safety}>Nothing is sent to the brand.</Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bg:         { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet:      { backgroundColor: Bold.paper, padding: Bold.gutter, paddingBottom: 36, gap: 12, borderTopLeftRadius: Bold.sheetRadius, borderTopRightRadius: Bold.sheetRadius },
  handle:     { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: Bold.line },
  title:      { fontFamily: "Outfit_900Black", fontSize: 22, textTransform: "uppercase", color: Bold.ink },
  lede:       { fontFamily: Fonts.body, fontSize: 14, color: Bold.ink2 },
  cand:       { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card, padding: 12 },
  candName:   { fontFamily: Fonts.bodySemiBold, fontSize: 16, color: Bold.ink },
  candSite:   { fontFamily: Fonts.body, fontSize: 13, color: Bold.mute },
  err:        { fontFamily: Fonts.body, fontSize: 13, color: "#B42318" },
  btn:        { height: Bold.button, borderRadius: Bold.radius.pill, borderWidth: 1.5, borderColor: Bold.ink, alignItems: "center", justifyContent: "center" },
  primary:    { backgroundColor: Bold.act, borderColor: Bold.act },
  primaryT:   { fontFamily: "Outfit_800ExtraBold", fontSize: 14, letterSpacing: 1, textTransform: "uppercase", color: Bold.onAct },
  secondaryT: { fontFamily: "Outfit_800ExtraBold", fontSize: 14, letterSpacing: 1, textTransform: "uppercase", color: Bold.ink },
  safety:     { fontFamily: Fonts.body, fontSize: 12, color: Bold.mute, textAlign: "center" },
});
