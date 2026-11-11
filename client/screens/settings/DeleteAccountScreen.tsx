/**
 * DeleteAccountScreen — Settings › Account › Delete account (mockup 3a–3f, owner-approved 5 Nov 2026).
 *
 *   3a  a pushed screen (StackHeader "‹ SETTINGS"): what gets erased, the connected accounts, what is kept, and a way
 *       to download the data first. Red Continue at the foot.
 *   3b  the confirm sheet: type DELETE (any case). Signed in with Apple (iOS): Apple confirms it's them next, and the
 *       fresh code goes with the request so the server can revoke the Sign in with Apple grant.
 *   3c  sending: the red button spins; nothing can be tapped.
 *   3d  202: full screen, no shell, "Your account is closed" with the receipt reference. Done signs out.
 *   3e  409: a payment is held; "See the payment" opens the deal.
 *   3f  anything else: nothing happened; Try again is safe (the request is idempotent).
 *
 * No grace period (as built): the account closes the moment they confirm, so the copy says it can't be undone.
 * Server: DELETE /api/v1/me/account (server/routes/account.ts).
 */
import React, { useEffect, useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { Sheet, StackHeader, Button } from "../../components/ui";
import { DangerButton, SoftButton } from "../../components/settings/accountButtons";
import { ExportDataSheet, accountSheetStyles as s } from "../../components/settings/ExportDataSheet";
import { AccountResultScreen } from "../AccountDeletingScreen";
import { useAuth } from "../../lib/auth-context";
import { confirmWithApple, deleteMyAccount, needsAppleConfirm, shortReference } from "../../lib/account-api";
import { reportAccountDeleting, silenceAccountDeleting } from "../../lib/account-deleting";
import { Bold, BoldType } from "../../constants/theme";

export const DELETE_COPY = {
  back: "Settings",
  title: "Delete your account",
  lede: "This closes your Nomila account right away and erases your data.",
  ledeStrong: "You can't undo it",
  ledeEnd: ", and there is no waiting period.",
  erasedLabel: "What gets erased",
  erased: [
    "Your profile, About you, goals and your public card",
    "Deals, opportunities, drafts and bookings",
    "Chats with Mila, voice and text",
    "Your photos, videos, contracts and Studio work",
    "Your sign-in, so you can't log back in with it",
  ],
  connectedLabel: "Your connected accounts",
  connected: [
    ["Gmail and YouTube:", " we cancel Nomila's access with Google."],
    ["Outlook:", " we stop listening for new mail and delete our key."],
    ["Instagram and TikTok:", " we disconnect and delete our key."],
  ] as const,
  connectedNote: "Your Google, Microsoft, Instagram and TikTok accounts themselves are not touched.",
  keptLabel: "What we have to keep",
  kept: [
    ["A record of money that moved:", " amount, date and the Stripe reference, with nothing that names you. We keep it for tax and accounting."],
    ["Backups", " still hold a copy for up to 7 days, then it's gone."],
  ] as const,
  copyFirst: "Want a copy first? ",
  copyLink: "Download your data",
  copyEnd: " before you delete.",
  continue: "Continue",
  confirmEyebrow: "Last step",
  confirmValue: "Type DELETE to close your account",
  confirmLine: "Your account closes as soon as you tap. You'll be signed out on this phone.",
  confirmApple: "Next, Apple asks you to confirm it's you.",
  appleCancelled: "You stopped at Apple's check, so nothing was deleted. Try again when you're ready.",
  confirmButton: "Delete my account",
  keep: "Keep my account",
  blockedTitle: "We can't delete your account yet",
  blocked1: "A payment for one of your deals is still being held. It has to be released or refunded first, or the money could get stuck.",
  blocked2: "Nothing has been deleted. Once the payment is settled, come back here and delete in one step.",
  seePayment: "See the payment",
  close: "Close",
  errorTitle: "That didn't go through",
  errorLine: "We couldn't reach Nomila, so your account is still open and nothing was deleted. Try again in a moment.",
  retry: "Try again",
  doneTitle: "Your account is closed",
  doneLine: "We've disconnected your accounts and started erasing your data. It will be fully gone within 24 hours, and we'll email you when it's done. Backups clear within 7 days.",
  doneRef: (ref: string) => `Reference: ${ref}. Quote it if you ever need to ask us about this deletion.`,
  done: "Done",
} as const;

/** The confirm word, typed in any case. */
export const isConfirmWord = (typed: string): boolean => typed.trim().toLowerCase() === "delete";

type Step =
  | { kind: "read" }
  | { kind: "confirm"; note?: string }
  | { kind: "sending" }
  | { kind: "blocked"; dealId: string | null }
  | { kind: "error" }
  | { kind: "closed"; receiptId: string };

export function DeleteAccountScreen() {
  const c = DELETE_COPY;
  const navigation = useNavigation<any>();
  const { leaveDeletedAccount } = useAuth();
  const [step, setStep] = useState<Step>({ kind: "read" });
  const [typed, setTyped] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [apple, setApple] = useState(false);
  useEffect(() => {
    let live = true;
    needsAppleConfirm().then((v) => { if (live) setApple(v); }).catch(() => {});
    return () => { live = false; };
  }, []);

  async function send() {
    if (!isConfirmWord(typed) || step.kind === "sending") return;
    // Sending from the first tap: a second tap while Apple's prompt is up must not start another one.
    setStep({ kind: "sending" });
    let code: string | null = null;
    if (apple) {
      const r = await confirmWithApple();
      // Cancelled: they chose not to go on, so nothing is sent. Apple failing (no Apple ID on the device, no network
      // to Apple) never blocks the delete: it goes ahead without a code and the Apple grant is simply not revoked.
      if ("cancelled" in r) { setStep({ kind: "confirm", note: c.appleCancelled }); return; }
      if ("code" in r) code = r.code;
    }
    // Everything else this phone asks from here on is refused (410): this screen says what happened, not that one.
    silenceAccountDeleting(true);
    const out = await deleteMyAccount(code);
    if (out.kind === "closed") { setStep({ kind: "closed", receiptId: out.receiptId }); return; }
    silenceAccountDeleting(false);
    if (out.kind === "deleting") { reportAccountDeleting(); return; }
    if (out.kind === "blocked") { setStep({ kind: "blocked", dealId: out.dealId }); return; }
    setStep({ kind: "error" });
  }

  function seePayment(dealId: string) {
    setStep({ kind: "read" });
    navigation.navigate("Opportunities", { screen: "DealDetail", params: { dealId } });
  }

  const closeSheet = () => setStep({ kind: "read" });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]} testID="delete-account">
      <StackHeader title={c.back} bold />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole="header">{c.title}</Text>
        <Text style={s.body}>{c.lede} <Text style={styles.strong}>{c.ledeStrong}</Text>{c.ledeEnd}</Text>

        <Text style={s.label}>{c.erasedLabel}</Text>
        <View style={s.list}>
          {c.erased.map((line, i) => (
            <View key={line} style={[s.li, i > 0 && s.liLine]}><View style={s.dot} /><Text style={s.liText}>{line}</Text></View>
          ))}
        </View>

        <Text style={s.label}>{c.connectedLabel}</Text>
        <View style={s.list}>
          {c.connected.map(([b, rest], i) => (
            <View key={b} style={[s.li, i > 0 && s.liLine]}><View style={s.dot} /><Text style={s.liText}><Text style={s.liBold}>{b}</Text>{rest}</Text></View>
          ))}
        </View>
        <Text style={styles.small}>{c.connectedNote}</Text>

        <Text style={s.label}>{c.keptLabel}</Text>
        <View style={s.list}>
          {c.kept.map(([b, rest], i) => (
            <View key={b} style={[s.li, i > 0 && s.liLine]}><View style={[s.dot, s.dotQuiet]} /><Text style={s.liText}><Text style={s.liBold}>{b}</Text>{rest}</Text></View>
          ))}
        </View>

        <View style={styles.note}>
          <Text style={styles.noteText}>
            {c.copyFirst}
            <Text style={styles.noteLink} onPress={() => setExportOpen(true)} accessibilityRole="link" testID="delete-download-first">{c.copyLink}</Text>
            {c.copyEnd}
          </Text>
        </View>
      </ScrollView>
      <View style={styles.foot}>
        <DangerButton onPress={() => { setTyped(""); setStep({ kind: "confirm" }); }} testID="delete-continue">{c.continue}</DangerButton>
      </View>

      {/* ONE Sheet for confirm · sending · blocked · error: swapping two Modals at once freezes react-native-web (their
          focus traps fight), so the head and body change inside the same Sheet instead. */}
      {(step.kind === "confirm" || step.kind === "sending" || step.kind === "blocked" || step.kind === "error") && (
        <Sheet
          onClose={() => { if (step.kind !== "sending") closeSheet(); }}
          {...(step.kind === "blocked" ? { title: c.blockedTitle } : step.kind === "error" ? { title: c.errorTitle } : { eyebrow: c.confirmEyebrow, value: c.confirmValue })}
          keyboard
        >
          {step.kind === "blocked" ? (
            <View testID="delete-blocked">
              <Text style={s.body}>{c.blocked1}</Text>
              <Text style={s.body}>{c.blocked2}</Text>
              {step.dealId ? <Button bold="primary" onPress={() => seePayment(step.dealId!)} style={s.btn} testID="delete-see-payment">{c.seePayment}</Button> : null}
              <SoftButton onPress={closeSheet} testID="delete-blocked-close">{c.close}</SoftButton>
            </View>
          ) : step.kind === "error" ? (
            <View testID="delete-error">
              <Text style={s.body}>{c.errorLine}</Text>
              <DangerButton onPress={() => setStep({ kind: "confirm" })} testID="delete-retry">{c.retry}</DangerButton>
              <SoftButton onPress={closeSheet} testID="delete-error-close">{c.close}</SoftButton>
            </View>
          ) : (
            <View testID="delete-confirm-sheet">
              <Text style={s.body}>{c.confirmLine}{apple ? ` ${c.confirmApple}` : ""}</Text>
              {step.kind === "confirm" && step.note ? <View style={s.warn}><Text style={s.warnText}>{step.note}</Text></View> : null}
              <TextInput
                value={typed}
                onChangeText={setTyped}
                placeholder="DELETE"
                placeholderTextColor={Bold.quiet}
                autoCapitalize="characters"
                autoCorrect={false}
                autoFocus
                editable={step.kind !== "sending"}
                style={[styles.input, isConfirmWord(typed) && styles.inputOn]}
                accessibilityLabel="Type DELETE to confirm"
                testID="delete-input"
              />
              <DangerButton onPress={() => { void send(); }} disabled={!isConfirmWord(typed)} loading={step.kind === "sending"} testID="delete-confirm">{c.confirmButton}</DangerButton>
              <SoftButton onPress={closeSheet} disabled={step.kind === "sending"} testID="delete-keep">{c.keep}</SoftButton>
            </View>
          )}
        </Sheet>
      )}

      {step.kind === "closed" && (
        <Modal visible animationType="fade" statusBarTranslucent onRequestClose={() => { void leaveDeletedAccount(); }}>
          <AccountResultScreen
            icon="check"
            title={c.doneTitle}
            body={c.doneLine}
            meta={c.doneRef(shortReference(step.receiptId))}
            action={c.done}
            onAction={() => { void leaveDeletedAccount(); }}
            testID="delete-closed"
          />
        </Modal>
      )}

      {exportOpen && <ExportDataSheet onClose={() => setExportOpen(false)} />}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:     { flex: 1, backgroundColor: Bold.paper },
  scroll:   { flex: 1 },
  content:  { paddingHorizontal: Bold.gutter, paddingBottom: 24 },
  title:    { ...BoldType.screenTitleSm, color: Bold.ink, marginTop: 4, marginBottom: 8 },
  strong:   { fontFamily: BoldType.rowTitle.fontFamily, fontWeight: BoldType.rowTitle.fontWeight, color: Bold.ink },
  small:    { ...BoldType.caption, color: Bold.mute, marginTop: 6 },
  note:     { backgroundColor: Bold.ground, borderRadius: Bold.radius.card, paddingHorizontal: 14, paddingVertical: 12, marginTop: 16 },
  noteText: { ...BoldType.rowMeta, color: Bold.ink2 },
  noteLink: { fontFamily: BoldType.link.fontFamily, fontWeight: BoldType.link.fontWeight, color: Bold.ink, textDecorationLine: "underline" },
  foot:     { paddingHorizontal: Bold.gutter, paddingTop: 0, paddingBottom: 20, borderTopWidth: 1, borderTopColor: Bold.line, backgroundColor: Bold.paper },
  input:    { height: Bold.button, borderRadius: Bold.radius.pill, borderWidth: 1, borderColor: Bold.line, paddingHorizontal: 18, marginTop: 12, ...BoldType.rowTitle, letterSpacing: 1.2, color: Bold.ink },
  inputOn:  { borderWidth: 1.5, borderColor: Bold.ink },
});
