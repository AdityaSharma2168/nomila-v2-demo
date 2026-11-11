import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { BrandLogo } from "../BrandLogo";
import { DealActionSheet } from "../deals/DealActionSheet";
import type { DealItem, DealSource } from "../deals/DealCard";
import { useReplyAction } from "./useReplyAction";
import { useDealDraft } from "../../hooks/use-deal-draft";
import { haptics } from "../../lib/haptics";
import { Colors, Fonts, Spacing, BorderRadius } from "../../constants/theme";
import type { ReplyActionWidgetData } from "../../hooks/use-mila-chat";
import { MILA_CARD } from "./milaSurface";

// Inline reply card for a draft_reply result. It shows the drafted reply and, when
// sendable, a Send gate that opens the REUSED DealActionSheet (seeded with the draft —
// never generated on device). DealActionSheet is a full-screen Modal, so it is presented
// on a deliberate tap, not mounted into scrollback. Every action is bound to THIS
// widget's own ids (see useReplyAction), so an old card can only ever touch its own thread.

const DEAL_SOURCES: DealSource[] = [
  "gmail",
  "instagram",
  "tiktok",
  "twitter",
  "outlook",
];
function platformToSource(platform: string): DealSource {
  return (DEAL_SOURCES as string[]).includes(platform)
    ? (platform as DealSource)
    : "gmail";
}

const PLATFORM_LABEL: Record<string, string> = {
  gmail: "Gmail",
  instagram: "Instagram",
  outlook: "Outlook",
};
function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform] ?? "your inbox";
}

// draft_reply intent → the sheet's mode (which drives its intent chip set).
function intentToMode(
  intent: ReplyActionWidgetData["params"]["replyIntent"],
): "accept" | "negotiate" | "terms" {
  if (intent === "negotiate") return "negotiate";
  if (intent === "request_terms") return "terms";
  return "accept";
}

export function MilaReplyWidget({ data }: { data: ReplyActionWidgetData }) {
  const { status, error, send } = useReplyAction(data);
  const [sheetOpen, setSheetOpen] = useState(false);

  // ── Voice-opened card: the body is generated HERE ──────────────────────────
  // `needsDraft` means the card arrived before its draft existed, because the
  // voice path deliberately does not draft — see server/voice/draftIntentRoute.
  // Generating on this side is what keeps brand-derived prose out of the worker,
  // the model and the data channel: it is fetched over the athlete's OWN
  // authenticated session, through the same endpoint and hook the deal screen
  // already uses, and it goes nowhere else.
  //
  // The hook is called unconditionally (hooks rules) and simply idles when the
  // card already carries its draft.
  const {
    draft: fetchedDraft,
    streaming,
    generated,
    error: draftError,
    generate,
  } = useDealDraft(data.dealId);

  /**
   * In-flight marker, synchronous so two calls in one tick can't both start.
   * `streaming` tracks the same thing but only after a state commit.
   */
  const inFlightRef = useRef(false);
  const attemptsRef = useRef(0);

  /**
   * How many times a LIVE card may generate by itself before it stops trying.
   *
   * More than one because the first attempt can die to a race rather than a real
   * failure (see the effect). Bounded because each attempt is a full Vertex
   * stream against a 6/minute limit — an unbounded retry would turn one flaky
   * card into a rate-limit outage. Past the cap the manual button remains, which
   * is a person deciding to spend rather than a component deciding for them.
   */
  const MAX_AUTO_ATTEMPTS = 2;

  const startDraft = useCallback(() => {
    // The ONLY guard is "something is already running". Deliberately not "we
    // asked once": an attempt that was aborted mid-stream asked, produced
    // nothing usable, and must be allowed to ask again.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    attemptsRef.current += 1;
    void generate({
      reply_intent: data.params.replyIntent,
      style: data.params.style,
      voice: data.params.voice,
      selected_terms: data.params.selectedTerms,
      include_media_kit: data.params.includeMediaKit,
    }).finally(() => {
      inFlightRef.current = false;
    });
  }, [data.params, generate]);

  useEffect(() => {
    // `autoDraft`, NOT `needsDraft`. needsDraft is durable and stays true on a
    // reloaded card, so keying auto-generation off it made every historical card
    // regenerate on every reopen — a burst of Vertex streams and a 429, for
    // drafts nobody requested. Only a card that arrived live this session fires
    // by itself; a rehydrated one waits for the button below.
    if (!data.autoDraft) return;

    // Completion, not request. The card is appended while Mila is still
    // speaking, and the transcript storm re-renders the list ~46 times over
    // ~13s; if this widget is remounted in that window the hook's unmount
    // cleanup aborts the in-flight fetch. An AbortError sets NO error state
    // (use-deal-draft.ts:120-124), so the old "we already asked" guard left the
    // card frozen on the deterministic greeting — silently, permanently, and
    // only sometimes. Re-running while `generated` is false is what makes that
    // recoverable.
    if (generated || streaming || inFlightRef.current) return;
    if (attemptsRef.current >= MAX_AUTO_ATTEMPTS) return;

    if (__DEV__ && attemptsRef.current > 0) {
      // The abort is invisible by design upstream; say so here rather than let a
      // retry look like a first attempt.
      console.warn(
        "[draft] previous attempt ended without completing (likely aborted) — retrying",
        { dealId: data.dealId, attempt: attemptsRef.current + 1 },
      );
    }
    startDraft();
  }, [data.autoDraft, data.dealId, generated, streaming, startDraft]);

  // The card's own copy wins when it has some (text path); otherwise whatever
  // this client generated. Everything below reads this, never data.draft.
  const draft = data.draft ?? (fetchedDraft || null);

  // ── Sent: terminal state, so a scrollback re-tap can't re-send ──
  if (status === "sent") {
    return (
      <View style={[styles.card, styles.sentCard]}>
        <View style={styles.iconCircleGreen}>
          <Feather name="check" size={14} color="#fff" />
        </View>
        <Text style={styles.sentText}>Reply sent to {data.brandName}</Text>
      </View>
    );
  }

  // ── Generating: the card is here, the body is on its way ──
  // Shown only for a voice-opened card. It is deliberately a real card rather
  // than a spinner in empty space: Mila has already said it is on screen, so
  // something recognisable has to be there when the athlete looks.
  // Gated on `generated`, NOT on `!draft`. A stream aborted after the greeting
  // leaves a real but PARTIAL draft, and the old `!draft` test let that fall
  // through and render as if it were the finished email — "Hi Amy," with a
  // Review & Send button under it. Until the stream says done, this card has no
  // body worth showing.
  if (data.needsDraft && !generated && !data.refusal && !draftError) {
    const working = streaming || inFlightRef.current;
    return (
      <View style={styles.card}>
        <View style={styles.header}>
          <BrandLogo
            brandName={data.brandName}
            brandDomain={null}
            size={32}
            borderRadius={9}
          />
          <View style={styles.headerText}>
            <Text style={styles.title}>Draft reply</Text>
            <Text style={styles.brandName}>{data.brandName}</Text>
          </View>
        </View>
        {working ? (
          <View style={styles.refusalRow}>
            <Feather
              name="edit-3"
              size={13}
              color={Colors.light.textSecondary}
            />
            <Text style={styles.refusalText}>
              {streaming ? "Writing your draft…" : "Preparing your draft…"}
            </Text>
          </View>
        ) : (
          // Two ways to land here, one button:
          //  - rehydrated from history, never generated — writing costs a model
          //    call, so it waits for a person rather than firing on a scroll;
          //  - a live card whose attempts were aborted mid-stream and gave up at
          //    the cap. Without this that card is permanently dead, which is
          //    exactly the failure this change exists to remove.
          // Manual taps are NOT capped: past the auto limit, a person asking is
          // a decision, not a loop.
          <Pressable
            style={styles.reviewBtn}
            onPress={() => {
              haptics.press();
              startDraft();
            }}
          >
            <Feather name="edit-3" size={14} color={Colors.light.buttonText} />
            <Text style={styles.reviewBtnText}>
              {attemptsRef.current > 0 ? "Try again" : "Write draft"}
            </Text>
          </Pressable>
        )}
      </View>
    );
  }

  // ── Generation failed: honest, no Send, no invented cause ──
  if (data.needsDraft && !draft && draftError) {
    return (
      <View style={styles.card}>
        <View style={styles.header}>
          <BrandLogo
            brandName={data.brandName}
            brandDomain={null}
            size={32}
            borderRadius={9}
          />
          <Text style={styles.title}>Draft reply</Text>
        </View>
        <View style={styles.refusalRow}>
          <Feather
            name="alert-circle"
            size={13}
            color={Colors.light.textSecondary}
          />
          <Text style={styles.refusalText}>
            Couldn&apos;t write that draft just now. Open the deal to try again.
          </Text>
        </View>
      </View>
    );
  }

  // ── Leak-lint refusal: plain message, no editable box, no Send ──
  if (!draft && data.refusal) {
    return (
      <View style={styles.card}>
        <View style={styles.header}>
          <BrandLogo
            brandName={data.brandName}
            brandDomain={null}
            size={32}
            borderRadius={9}
          />
          <Text style={styles.title}>Draft reply</Text>
        </View>
        <View style={styles.refusalRow}>
          <Feather
            name="alert-circle"
            size={13}
            color={Colors.light.textSecondary}
          />
          <Text style={styles.refusalText}>{data.refusal}</Text>
        </View>
      </View>
    );
  }

  // Nothing to render (text path: buildWidget drops empty results).
  if (!draft) return null;

  const deal: DealItem = {
    id: data.dealId,
    brandName: data.brandName,
    brandDomain: null,
    category: "PAID",
    status: "detected",
    verdict: "fair",
    source: platformToSource(data.platform),
    sourceType: data.platform === "instagram" ? "DM" : "Email",
    score: 5,
    timeAgo: "",
    aiSummary: "",
  };

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <BrandLogo
          brandName={data.brandName}
          brandDomain={null}
          size={32}
          borderRadius={9}
        />
        <View style={styles.headerText}>
          <Text style={styles.title}>Draft reply</Text>
          <Text style={styles.brandName}>{data.brandName}</Text>
        </View>
      </View>

      {/* Draft preview — the athlete reads it here, edits + sends in the sheet. */}
      <Text style={styles.preview} numberOfLines={4}>
        {draft}
      </Text>

      {data.sendable ? (
        <>
          <Pressable
            style={styles.reviewBtn}
            onPress={() => {
              haptics.press();
              setSheetOpen(true);
            }}
          >
            <Feather name="send" size={14} color={Colors.light.buttonText} />
            <Text style={styles.reviewBtnText}>Review &amp; Send</Text>
          </Pressable>
          {status === "error" && !!error && (
            <Text style={styles.errorText}>{error}</Text>
          )}
        </>
      ) : (
        // Non-sendable (Outlook / no thread): the draft is here to copy, but there's
        // no in-app send path — never show a Send button that would 400.
        <View style={styles.manualRow}>
          <Feather
            name="external-link"
            size={12}
            color={Colors.light.textSecondary}
          />
          <Text style={styles.manualText}>
            No in-app send here — reply to {data.brandName} in{" "}
            {platformLabel(data.platform)}.
          </Text>
        </View>
      )}

      {/* The REUSED sheet, presented on tap, seeded with the draft (no on-device generate). */}
      {sheetOpen && (
        <DealActionSheet
          deal={deal}
          mode={intentToMode(data.params.replyIntent)}
          seededDraft={draft}
          disableGenerate
          initialParams={{
            replyIntent: data.params.replyIntent,
            style: data.params.style,
            voice: data.params.voice,
            includeMediaKit: data.params.includeMediaKit,
          }}
          onClose={() => setSheetOpen(false)}
          onSend={async (body: string) => {
            const ok = await send(body);
            if (ok) setSheetOpen(false); // keep the sheet open on failure so the draft isn't lost
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // A light Mila card with the soft lift, no border (milaSurface).
  card: {
    ...MILA_CARD,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  sentCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  iconCircleGreen: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#3BA55C",
    alignItems: "center",
    justifyContent: "center",
  },
  sentText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 14,
    color: Colors.light.text,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 13,
    color: Colors.light.text,
  },
  brandName: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.textSecondary,
  },
  preview: {
    fontFamily: Fonts.body,
    fontSize: 13,
    lineHeight: 19,
    color: Colors.light.textSecondary,
  },
  reviewBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    minWidth: 120,
    height: 44,
    borderRadius: BorderRadius.full,
    backgroundColor: Colors.light.primary,
  },
  reviewBtnText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 14,
    color: Colors.light.buttonText,
  },
  errorText: {
    fontFamily: Fonts.body,
    fontSize: 12,
    color: "#C0453B",
    textAlign: "center",
  },
  manualRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  manualText: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 12,
    color: Colors.light.textSecondary,
  },
  refusalRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
  },
  refusalText: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 13,
    lineHeight: 19,
    color: Colors.light.textSecondary,
  },
});
