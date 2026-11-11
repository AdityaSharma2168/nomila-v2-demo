/**
 * PublishPill — "Post to Instagram", on a finished stitch. Stitch → watch → post, right there.
 *
 * What it says and when it may send is NOT decided here: screens/studio/publishLogic.ts is the
 * state machine and the copy, and it is tested without React. This file holds a step, a draft
 * caption and the id of the job she started, and renders what that file returns.
 *
 * ─── NEVER ONE TAP ──────────────────────────────────────────────────────────────────────────────
 *
 * The pill opens a caption box. "Continue" opens a confirm step that NAMES THE ACCOUNT — "This
 * posts to @handle now." Only the button on that step calls the server, and it can only be reached
 * through `nextStep(step, "confirm")` from "confirming". Three presses, one of them on a sentence
 * with her handle in it, before anything public happens.
 *
 * ─── DRAWS NOTHING UNLESS THE SERVER SAYS SO ────────────────────────────────────────────────────
 *
 * STUDIO_PUBLISH_MODE=off, an older server, the Studio flag off: all of them arrive as "no pill".
 * There is no client flag to forget to flip.
 *
 * DESIGN.md: buttons are pills (radius full), min width 120, 44pt touch target; the input is cream
 * with a pink focus border and 16px type (iOS zooms anything smaller); no blur; Feather icons;
 * fontWeight always paired with an Outfit family.
 */
import { useCallback, useRef, useState } from "react";
import { Linking, StyleSheet, Text, TextInput, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { BorderRadius, Colors, Fonts, Spacing } from "../../constants/theme";
import { HapticPressable } from "../HapticPressable";
import { usePlatformOAuth } from "../../hooks/use-platform-oauth";
import {
  usePublishJob,
  usePublishOptions,
  useQueuePublish,
} from "../../hooks/use-studio-publish";
import {
  DEFAULT_CAPTION_MAX,
  captionState,
  confirmView,
  nextStep,
  pillView,
  toPublishBody,
  type PublishAction,
  type PublishStep,
} from "../../screens/studio/publishLogic";

export function PublishPill({ assetId }: { assetId: string }) {
  const options = usePublishOptions(assetId);
  const queue = useQueuePublish(assetId);
  const oauth = usePlatformOAuth("instagram");

  const [step, setStep] = useState<PublishStep>("idle");
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [publishId, setPublishId] = useState<string | null>(null);
  const watched = usePublishJob(publishId);
  const sending = useRef(false);

  const go = useCallback(
    (action: PublishAction) => setStep((s) => nextStep(s, action)),
    [],
  );

  const answer = options.data;
  // The job she just started, else the last one the server remembers for this video.
  const job =
    watched.data ??
    (answer && answer !== "unavailable" ? (answer.latest ?? null) : null);
  const pill = pillView(answer, job);

  const onConfirm = useCallback(async () => {
    if (!answer || answer === "unavailable") return;
    // ⚠️  The ONLY call to the server that can lead to a post. Reached only from "confirming":
    // nextStep refuses `confirm` from any other step, and this bails unless it moved.
    if (nextStep(step, "confirm") !== "sending") return;
    // STATE IS TOO SLOW TO BE THE LOCK. Three presses inside one render all read the same `step`
    // and all pass the line above — a test sent three requests before this ref existed. (The
    // server would still have made ONE job of them: uq_studio_publish_jobs_live. That is its
    // job, not an excuse.) A ref is written synchronously, so the second press sees it.
    if (sending.current) return;
    sending.current = true;
    setStep("sending");
    try {
      const out = await queue.mutateAsync(
        toPublishBody(assetId, draft, confirmView(answer, job).approve),
      );
      setPublishId(out.publishId);
    } catch {
      // The refusal is on `queue.error`, in the server's words. Nothing was queued.
    } finally {
      sending.current = false;
      setStep((s) => nextStep(s, "sent"));
    }
  }, [answer, step, queue, assetId, draft, job]);

  if (pill.kind === "hidden" || !answer || answer === "unavailable")
    return null;

  const max = answer.limits?.captionMaxChars ?? DEFAULT_CAPTION_MAX;
  const caption = captionState(draft, max);
  const confirm = confirmView(answer, job);

  return (
    <View style={styles.box} testID="publish">
      {step === "idle" ? (
        <>
          {pill.label && pill.kind !== "posting" ? (
            <HapticPressable
              testID="publish-pill"
              style={[
                styles.pill,
                pill.kind === "post" ? styles.primary : styles.secondary,
              ]}
              accessibilityRole="button"
              accessibilityLabel={pill.label}
              onPress={() => {
                if (pill.permalink) void Linking.openURL(pill.permalink);
                else if (pill.kind === "reconnect" || pill.kind === "connect")
                  void oauth.connect().then(() => options.refetch());
                else if (pill.canOpen) go("open");
              }}
            >
              <Feather
                name={
                  pill.permalink
                    ? "external-link"
                    : pill.kind === "post" || pill.kind === "done"
                      ? "instagram"
                      : "link"
                }
                size={15}
                color={
                  pill.kind === "post"
                    ? Colors.light.buttonText
                    : Colors.light.text
                }
              />
              <Text
                style={[
                  styles.pillTxt,
                  pill.kind !== "post" && styles.pillTxtDark,
                ]}
              >
                {pill.label}
              </Text>
            </HapticPressable>
          ) : null}
          {pill.kind === "posting" ? (
            <View
              style={[styles.pill, styles.secondary, styles.off]}
              testID="publish-posting"
              accessibilityRole="progressbar"
              accessibilityLabel="Posting to Instagram"
            >
              <Feather
                name="upload-cloud"
                size={15}
                color={Colors.light.text}
              />
              <Text style={[styles.pillTxt, styles.pillTxtDark]}>
                {pill.label}
              </Text>
            </View>
          ) : null}
          {pill.note ? (
            <Text style={styles.note} testID="publish-note">
              {pill.note}
            </Text>
          ) : null}
          {/* The server's refusal of the request itself, in its own words. Nothing was queued. */}
          {queue.error ? (
            <Text style={styles.refusal} testID="publish-refusal">
              {queue.error.message}
            </Text>
          ) : null}
        </>
      ) : null}

      {step === "composing" ? (
        <>
          <Text style={styles.h}>Caption</Text>
          <TextInput
            testID="publish-caption"
            style={[
              styles.input,
              focused && styles.inputFocused,
              caption.over && styles.inputError,
            ]}
            value={draft}
            onChangeText={setDraft}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Say something about it"
            placeholderTextColor={Colors.light.textMuted}
            multiline
            keyboardType="default"
            autoCapitalize="sentences"
            autoCorrect
            accessibilityLabel="Caption for Instagram"
          />
          <Text style={[styles.quiet, caption.over && styles.quietError]}>
            {caption.counter}
          </Text>
          <View style={styles.row}>
            <HapticPressable
              testID="publish-cancel"
              style={[styles.pill, styles.secondary]}
              accessibilityRole="button"
              onPress={() => go("cancel")}
            >
              <Text style={[styles.pillTxt, styles.pillTxtDark]}>Cancel</Text>
            </HapticPressable>
            <HapticPressable
              testID="publish-review"
              style={[styles.pill, styles.primary, caption.over && styles.off]}
              accessibilityRole="button"
              disabled={caption.over}
              onPress={() => go("review")}
            >
              <Text style={styles.pillTxt}>Continue</Text>
            </HapticPressable>
          </View>
        </>
      ) : null}

      {step === "confirming" || step === "sending" ? (
        <>
          <Text style={styles.confirm} testID="publish-sentence">
            {confirm.sentence}
          </Text>
          {draft.trim() ? (
            <Text style={styles.quote} numberOfLines={4}>
              {draft.trim()}
            </Text>
          ) : (
            <Text style={styles.quiet}>No caption.</Text>
          )}
          {confirm.warning ? (
            <View style={styles.warn}>
              <Feather
                name="alert-triangle"
                size={14}
                color={Colors.light.text}
              />
              <Text style={styles.warnTxt} testID="publish-warning">
                {confirm.warning}
              </Text>
            </View>
          ) : null}
          <View style={styles.row}>
            <HapticPressable
              testID="publish-back"
              style={[
                styles.pill,
                styles.secondary,
                step === "sending" && styles.off,
              ]}
              accessibilityRole="button"
              disabled={step === "sending"}
              onPress={() => go("back")}
            >
              <Text style={[styles.pillTxt, styles.pillTxtDark]}>Back</Text>
            </HapticPressable>
            <HapticPressable
              testID="publish-confirm"
              haptic="press"
              style={[
                styles.pill,
                styles.primary,
                step === "sending" && styles.off,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`${confirm.button}. ${confirm.sentence}`}
              disabled={step === "sending"}
              onPress={() => void onConfirm()}
            >
              <Text style={styles.pillTxt}>
                {step === "sending" ? "Posting…" : confirm.button}
              </Text>
            </HapticPressable>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: Spacing.sm, gap: Spacing.xs },
  row: { flexDirection: "row", gap: Spacing.xs, marginTop: Spacing.xs },
  pill: {
    flex: 1,
    minWidth: 120,
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.xs,
    paddingHorizontal: Spacing.md,
    borderRadius: BorderRadius.full,
  },
  primary: { backgroundColor: Colors.light.primary },
  secondary: { backgroundColor: Colors.light.backgroundSecondary },
  off: { opacity: 0.45 },
  pillTxt: {
    fontFamily: Fonts.bodyMedium,
    fontWeight: "600",
    fontSize: 14,
    color: Colors.light.buttonText,
  },
  pillTxtDark: { color: Colors.light.text },
  h: {
    fontFamily: Fonts.headingSemiBold,
    fontWeight: "600",
    fontSize: 13,
    color: Colors.light.text,
  },
  input: {
    minHeight: 96,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: BorderRadius.md,
    borderWidth: 1.5,
    borderColor: "transparent",
    backgroundColor: Colors.light.backgroundSecondary,
    fontFamily: Fonts.body,
    // 16, not the builder's 14: iOS zooms the page on focus for anything smaller.
    fontSize: 16,
    color: Colors.light.text,
    textAlignVertical: "top",
  },
  inputFocused: { borderColor: Colors.light.primary },
  inputError: { borderColor: Colors.light.error },
  quiet: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.textMuted,
  },
  quietError: { color: Colors.light.error },
  note: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.textSecondary,
  },
  refusal: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.textSecondary,
  },
  confirm: {
    fontFamily: Fonts.headingSemiBold,
    fontWeight: "600",
    fontSize: 15,
    color: Colors.light.text,
  },
  quote: {
    fontFamily: Fonts.body,
    fontSize: 14,
    color: Colors.light.textSecondary,
  },
  warn: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing.xs,
    padding: Spacing.sm,
    borderRadius: BorderRadius.xs,
    backgroundColor: Colors.light.backgroundSecondary,
  },
  warnTxt: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.text,
  },
});
