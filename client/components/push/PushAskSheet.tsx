/**
 * PushAskSheet — Nomila asks first, in its own words, before the phone's system dialog (lib/push askForPushOnce). Shown
 * once per phone, after her first plan or her first deal, never on a cold launch. "Turn on" opens the phone's dialog;
 * "Not now" closes it and nothing is asked again by us (Settings › Notifications says how to turn them on later).
 * Mounted once, with the tabs. The one bottom sheet (ui/Sheet) and look-B buttons (DESIGN.md §11).
 */
import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Button, Sheet } from "../ui";
import { Bold, BoldType } from "../../constants/theme";
import { acceptPushAsk, pushAskHint, setPushAskHost, type AskReason } from "../../lib/push";

export const PUSH_ASK_COPY = {
  title: "Hear from Mila when it matters",
  lead: {
    first_plan: "Your plan is ready.",
    first_deal: "A brand is talking to you.",
  } satisfies Record<AskReason, string>,
  body: "Nomila can tell your phone when your plan is ready, a brand replies, or something waits on your tap. Nothing is ever sent for you, and you choose what you get in Settings.",
  yes: "Turn on",
  no: "Not now",
  // The dev web build on an iPhone/iPad Safari tab (lib/webPush "needs_home_screen"): web notifications need the site on
  // the Home Screen first, so the sheet says how instead of asking.
  homeScreenHint: "To get notifications on iPhone, add Nomila to your Home Screen: tap Share, then Add to Home Screen.",
  gotIt: "Got it",
} as const;

export function PushAskSheet() {
  const [reason, setReason] = useState<AskReason | null>(null);
  useEffect(() => { setPushAskHost(setReason); return () => setPushAskHost(null); }, []);
  if (!reason) return null;
  const close = () => setReason(null);
  if (pushAskHint() === "home_screen") {
    return (
      <Sheet onClose={close} title={PUSH_ASK_COPY.title}>
        <View style={styles.body} testID="push-ask-sheet">
          <Text style={styles.lead}>{PUSH_ASK_COPY.lead[reason]}</Text>
          <Text style={styles.text} testID="push-ask-home-screen">{PUSH_ASK_COPY.homeScreenHint}</Text>
          <Button bold="primary" onPress={close} testID="push-ask-got-it">{PUSH_ASK_COPY.gotIt}</Button>
        </View>
      </Sheet>
    );
  }
  return (
    <Sheet onClose={close} title={PUSH_ASK_COPY.title}>
      <View style={styles.body} testID="push-ask-sheet">
        <Text style={styles.lead}>{PUSH_ASK_COPY.lead[reason]}</Text>
        <Text style={styles.text}>{PUSH_ASK_COPY.body}</Text>
        <Button bold="primary" onPress={() => { close(); void acceptPushAsk(); }} testID="push-ask-yes">{PUSH_ASK_COPY.yes}</Button>
        <Button bold="secondary" onPress={close} testID="push-ask-no">{PUSH_ASK_COPY.no}</Button>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: 12, paddingTop: 8 },
  lead: { ...BoldType.h4, color: Bold.ink },
  text: { ...BoldType.body, color: Bold.ink2, marginBottom: 4 },
});
