/**
 * IsThisYouFront — "Is this you?" as the full-bleed photo card (the agent onboarding front; promoted from the #900
 * prototype) over the EXISTING identity-claim flow (EXPO_PUBLIC_IDENTITY_CLAIM; plan §3b): the index found public
 * profiles that may already be this athlete. One profile at a time: "That's me" confirms it (candidate confirmation,
 * never proof: the server links only with a corroboration and otherwise keeps the claim for an operator while the
 * athlete continues on a new profile), "Not me" moves to the next, and after the last nothing is chosen for them.
 *
 * The index record carries no photo, and nobody else's photo may stand for them, so the card is the neutral dark ground
 * until a photo of their own exists.
 */
import React, { useState } from "react";
import { StatusBar, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MeHero, MeHeroLine } from "../../components/me/MeHero";
import { Button, LinkText } from "../../components/ui";
import { Bold, BoldType } from "../../constants/theme";
import type { ClaimCandidate, ClaimPrompt } from "../../lib/auth-context";
import { FRONT_COPY } from "./frontCopy";

/** The public facts under the name: sport and team, then the class year and the place. */
export function claimLines(c: ClaimCandidate | null): { line: string; detail: string } {
  if (!c) return { line: "", detail: "" };
  const line = [c.sport, c.teamOrSchool].filter(Boolean).join(" · ");
  const handles = Object.values(c.knownSocialHandles ?? {}).filter(Boolean).slice(0, 2).map((h) => `@${String(h).replace(/^@/, "")}`);
  const detail = [c.classYear ? `Class of ${c.classYear}` : null, c.cityOrCountry, ...handles].filter(Boolean).join(" · ");
  return { line, detail };
}

export function IsThisYouFront({ prompt, onConfirm, onDismiss }: {
  prompt: ClaimPrompt;
  onConfirm: (claimId: string) => Promise<void>;
  onDismiss: () => Promise<void>;
}) {
  const c = FRONT_COPY.claim;
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const claim = prompt.claims[Math.min(i, prompt.claims.length - 1)];
  const cand = claim?.candidate ?? null;
  const { line, detail } = claimLines(cand);

  const act = async (key: "yes" | "no", fn: () => Promise<void>) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : c.error); } finally { setBusy(null); }
  };
  const notMe = () => {
    if (i < prompt.claims.length - 1) { setI(i + 1); return; }
    void act("no", onDismiss);
  };

  return (
    <View style={styles.root} testID="claim-front">
      <StatusBar barStyle="light-content" />
      <MeHero
        photoUrl={null}
        eyebrow={prompt.claims.length > 1 ? `${c.eyebrow} · ${c.of(i + 1, prompt.claims.length)}` : c.eyebrow}
        title={cand?.fullName ?? null}
        deep
        minHeight={height}
        style={[styles.fill, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        subtitle={(
          <View style={styles.lines}>
            {line ? <MeHeroLine strong>{line}</MeHeroLine> : null}
            {detail ? <MeHeroLine>{detail}</MeHeroLine> : null}
          </View>
        )}
      >
        {cand?.claimability === "none" ? <Text style={styles.note}>{c.taken}</Text> : null}
        <View style={styles.actions}>
          <Button bold="onHero" onPress={() => { if (claim) void act("yes", () => onConfirm(claim.claimId)); }} loading={busy === "yes"} disabled={!!busy} style={styles.yes} testID="claim-yes">{c.yes}</Button>
          <LinkText onPress={() => { if (!busy) notMe(); }} onDark arrow={false} testID="claim-no">{c.no}</LinkText>
        </View>
        {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
        <Text style={styles.note}>{c.note}</Text>
      </MeHero>
    </View>
  );
}

const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: Bold.ink },
  fill:    { flex: 1 },
  lines:   { gap: 2 },
  actions: { flexDirection: "row", alignItems: "center", gap: 18, marginTop: 14 },
  yes:     { paddingHorizontal: 28 },
  note:    { ...BoldType.caption, color: Bold.onDarkMute, marginTop: 10 },
  error:   { ...BoldType.caption, color: Bold.onDark, marginTop: 10 },
});
