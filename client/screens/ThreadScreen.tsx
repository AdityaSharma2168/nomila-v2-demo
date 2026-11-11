import React, { useRef, useState, useCallback } from "react";
import { haptics } from "../lib/haptics";
import {
  View,
  Text,
  FlatList,
  TextInput,
  Pressable,
  StyleSheet,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { BrandLogo } from "../components/BrandLogo";
import { PlatformIcon } from "../components/PlatformIcon";
import { domainFromLogoUrl } from "../lib/brand-logo";
import { useThread, useThreadReply, threadSendErrorMessage, type ThreadMessage } from "../hooks/use-thread";
import { Fonts, Colors, Spacing, BorderRadius, Bold, BoldType } from "../constants/theme";

// ─── Props ────────────────────────────────────────────────────────────────────

interface ThreadScreenProps {
  threadId:  string;
  brandName: string;
  onBack:    () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);

  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (diffDays === 0) return time;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays < 7)  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function platformLabel(platform: string | null): string {
  if (platform === "instagram") return "Instagram DM";
  return "Gmail";
}

// ─── Message bubble ───────────────────────────────────────────────────────────

/** What a footer-only message says instead of its legal notice: the thread's summary, else where the content is. */
export function footerOnlyText(summary: string | null | undefined): string {
  const s = summary?.trim();
  return s ? `${/[.!?]$/.test(s) ? s : `${s}.`} The details are in the attached file.` : "The details are in the attached file.";
}

function MessageBubble({ msg, summary }: { msg: ThreadMessage; summary: string | null }) {
  const files = msg.attachments ?? [];
  const isOut = msg.direction === "outbound";
  // Multi-person brand chains used to all look identical ("the brand"). Surface
  // the real sender so a creative director vs partnership lead is distinguishable.
  const inboundLabel = !isOut
    ? (msg.sender_name?.trim()
        || (msg.sender_email ? msg.sender_email.split("@")[0] : null)
        || "Brand")
    : null;

  return (
    <View style={[styles.bubbleRow, isOut && styles.bubbleRowOut]}>
      {!isOut && (
        <View style={styles.avatarPlaceholder} />
      )}
      <View style={styles.bubbleCol}>
        {inboundLabel && (
          <Text style={styles.senderLabel} numberOfLines={1}>{inboundLabel}</Text>
        )}
        {isOut && (
          <Text style={[styles.senderLabel, styles.senderLabelOut]}>You</Text>
        )}
        <View style={[styles.bubble, isOut ? styles.bubbleOut : styles.bubbleIn]}>
          <Text style={[styles.bubbleText, isOut && styles.bubbleTextOut]}>
            {msg.footer_only ? footerOnlyText(summary) : (msg.body ?? "")}
          </Text>
        </View>
        {files.length > 0 && (
          <View style={styles.fileRow}>
            {files.map((f, i) => (
              <View key={`${f.filename}-${i}`} style={styles.fileChip} accessibilityLabel={`Attached file ${f.filename}`}>
                <Feather name={f.content_type === "application/pdf" ? "file-text" : "paperclip"} size={12} color={Colors.light.textMuted} />
                <Text style={styles.fileName} numberOfLines={1}>{f.filename}</Text>
              </View>
            ))}
          </View>
        )}
        <Text style={[styles.bubbleTime, isOut && styles.bubbleTimeOut]}>
          {formatTime(msg.received_at)}
        </Text>
      </View>
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function ThreadScreen({ threadId, brandName, onBack }: ThreadScreenProps) {
  const { data, isLoading, error } = useThread(threadId);
  const reply  = useThreadReply(threadId, data?.thread.deal_id);
  const [text, setText]   = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const listRef           = useRef<FlatList>(null);

  // Her text stays in the box until the send succeeds; a failed send keeps it and says why (audit D §3.7).
  const handleSend = useCallback(async () => {
    const body = text.trim();
    if (!body || reply.isPending) return;
    setSendError(null);
    try {
      await reply.mutateAsync(body);
      setText((current) => (current.trim() === body ? "" : current));
      listRef.current?.scrollToEnd({ animated: true });
    } catch (err) {
      setSendError(threadSendErrorMessage(err));
    }
  }, [text, reply]);

  const platform = data?.messages.find((m) => m.direction === "inbound")?.platform ?? "gmail";
  const brand    = data?.brand;

  return (
    <SafeAreaView style={styles.safe}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12} style={styles.backBtn}>
          <Feather name="arrow-left" size={20} color={Colors.light.text} />
        </Pressable>

        <View style={styles.headerCenter}>
          <BrandLogo
            brandName={brandName}
            logoUrl={brand?.logo_url ?? null}
            brandDomain={domainFromLogoUrl(brand?.logo_url)}
            size={32}
            borderRadius={8}
          />
          <Text style={styles.headerBrand} numberOfLines={1}>{brandName}</Text>
        </View>

        <View style={styles.platformBadge}>
          <PlatformIcon platform={platform} color={Bold.quiet} size={13} />
          <Text style={styles.platformText}>{platformLabel(platform)}</Text>
        </View>
      </View>

      {/* ── Messages ── */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        {isLoading && (
          <View style={styles.center}>
            <ActivityIndicator color={Colors.light.primary} />
          </View>
        )}

        {!isLoading && error && (
          <View style={styles.center}>
            <Feather name="alert-circle" size={20} color={Colors.light.textMuted} />
            <Text style={styles.errorText}>Could not load thread</Text>
          </View>
        )}

        {/* The mailbox couldn't be read live (disconnected / deleted). The deal is unchanged. */}
        {!isLoading && !error && data?.conversation?.available === false && (
          <View style={styles.center}>
            <Feather name="inbox" size={20} color={Colors.light.textMuted} />
            <Text style={styles.errorText}>{data.conversation.message ?? "Conversation unavailable"}</Text>
          </View>
        )}

        {!isLoading && !error && data?.conversation?.available !== false && (
          <FlatList
            ref={listRef}
            data={data?.messages ?? []}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => <MessageBubble msg={item} summary={data?.thread.summary ?? null} />}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          />
        )}

        {/* ── Reply input ── */}
        {sendError ? (
          <Text style={styles.sendError} accessibilityRole="alert" accessibilityLiveRegion="polite">
            {`Not sent. ${sendError} Your text is still here.`}
          </Text>
        ) : null}
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={(v) => { setText(v); if (sendError) setSendError(null); }}
            accessibilityLabel="Write a reply"
            placeholder="Write a reply…"
            placeholderTextColor={Colors.light.textMuted}
            multiline
            maxLength={2000}
          />
          <Pressable
            style={[styles.sendBtn, (!text.trim() || reply.isPending) && styles.sendBtnDisabled]}
            onPress={() => { haptics.press(); handleSend(); }}
            disabled={!text.trim() || reply.isPending}
            accessibilityRole="button"
            accessibilityLabel="Send reply"
            hitSlop={4}
          >
            {reply.isPending
              ? <ActivityIndicator size="small" color="#fff" />
              : <Feather name="send" size={16} color="#fff" />
            }
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  fileRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  fileChip: {
    flexDirection: "row", alignItems: "center", gap: 6, maxWidth: 240,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    borderWidth: 1, borderColor: Colors.light.borderLight, backgroundColor: Colors.light.card,
  },
  fileName: { fontFamily: Fonts.body, fontSize: 12, color: Colors.light.textMuted, flexShrink: 1 },
  safe:  { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  flex:  { flex: 1 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.sm,
  },
  errorText: {
    fontFamily: Fonts.body,
    fontSize: 14,
    color: Colors.light.textMuted,
  },

  // ── Header ──
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing.lg,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.light.borderLight,
    backgroundColor: Colors.light.card,
    gap: Spacing.sm,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  headerCenter: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    overflow: "hidden",
  },
  headerBrand: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 16,
    color: Colors.light.text,
    flex: 1,
  },
  platformBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.light.backgroundDefault,
    borderRadius: BorderRadius.full,
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexShrink: 0,
  },
  platformText: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 11,
    color: Bold.quiet,
  },

  // ── Messages ──
  listContent: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.sm,
    gap: 4,
  },
  bubbleRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    marginBottom: 12,
  },
  bubbleRowOut: {
    justifyContent: "flex-end",
  },
  avatarPlaceholder: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.light.borderLight,
    flexShrink: 0,
  },
  bubbleCol: {
    maxWidth: "72%",
    gap: 3,
  },
  senderLabel: {
    fontFamily: Fonts.bodyMedium,
    fontSize: 11,
    color: Colors.light.textMuted,
    marginLeft: 4,
    marginBottom: 2,
  },
  senderLabelOut: {
    textAlign: "right",
    marginRight: 4,
    marginLeft: 0,
  },
  bubble: {
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleIn: {
    backgroundColor: Colors.light.card,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderBottomLeftRadius: 4,
  },
  bubbleOut: {
    backgroundColor: Bold.ink,
    borderBottomRightRadius: 4,
  },
  bubbleText: {
    fontFamily: Fonts.body,
    fontSize: 15,
    color: Colors.light.text,
    lineHeight: 22,
  },
  bubbleTextOut: {
    color: "#FFFFFF",
  },
  bubbleTime: {
    fontFamily: Fonts.body,
    fontSize: 11,
    color: Colors.light.textMuted,
    marginLeft: 4,
  },
  bubbleTimeOut: {
    textAlign: "right",
    marginRight: 4,
    marginLeft: 0,
  },

  // ── Input ──
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.xl,
    borderTopWidth: 1,
    borderTopColor: Colors.light.borderLight,
    backgroundColor: Colors.light.card,
  },
  input: {
    flex: 1,
    fontFamily: Fonts.body,
    fontSize: 15,
    color: Colors.light.text,
    backgroundColor: Colors.light.backgroundDefault,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    maxHeight: 120,
    lineHeight: 22,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.light.primary,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  sendError: {
    ...BoldType.caption,
    color: Bold.ink,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    backgroundColor: Colors.light.card,
  },
  sendBtnDisabled: {
    backgroundColor: Colors.light.borderLight,
  },
});
