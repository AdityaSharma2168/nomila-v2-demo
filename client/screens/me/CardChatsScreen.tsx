// CardChatsScreen — Me › Public card › Chats on your card (public Mila mode, PR 5; design-public-card-v3 §4, look B).
//
// What visitors asked Mila on her public card, and exactly what Mila showed them (her answers after the output gate).
// Visitors are anonymous: no name, email, IP or location is ever kept, so there is nothing about them to show. Chats are
// kept 90 days; she can delete any of them for good.
//
//   list     newest first, 30 at a time ("Show older"): the visitor's first message, the door they came from, messages
//   chat     every message, labelled Visitor / Mila, with the card section Mila answered from and any card Mila showed
//   delete   two taps: "Delete this chat" → "Delete for good"
//
// Self-contained: another track owns Me. This screen is registered on the Me stacks as "CardChats" and opened with
// openCardChats (client/navigation/meNav.ts) from the Me › Public card area.

import React, { useState } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { Button, Card, StackHeader } from "../../components/ui";
import { useCardChat, useCardChats, useDeleteCardChat, type CardChatIntent, type CardChatMessage, type CardChatSummary } from "../../hooks/use-card-chats";
import { Bold, BoldType } from "../../constants/theme";

export const CARD_CHATS_COPY = {
  parent: "Public card",
  title: "Chats on your card",
  lede: "What visitors asked Mila on your public card, and what Mila answered. Visitors are anonymous: no names, emails or locations are kept. Chats are kept for 90 days.",
  empty: "No chats yet. When visitors ask Mila about you on your card, the chats show here.",
  older: "Show older",
  retry: "Retry",
  error: "Couldn't load the chats.",
  back: "All chats",
  visitor: "Visitor",
  mila: "Mila",
  delete: "Delete this chat",
  confirm: "Delete for good",
  keep: "Keep it",
  deleteNote: "This removes the chat for good. It can't be undone.",
  deleteError: "Couldn't delete the chat. Try again.",
} as const;

const DOOR: Record<CardChatIntent, string> = { ask: "Ask Mila", partner: "Partner", book: "Book", shop: "Shop" };

const WIDGET: Record<string, string> = {
  picks: "Mila showed your picks",
  slots: "Mila showed your published times",
  booking_request: "Mila prepared a booking request for the visitor to send",
  partner_request: "Mila prepared a request to work with you for the visitor to start",
};

const when = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
};
const messagesLine = (turns: number) => `${turns} question${turns === 1 ? "" : "s"}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function CardChatsScreen() {
  const [open, setOpen] = useState<string | null>(null);
  return open ? <ChatView id={open} onBack={() => setOpen(null)} /> : <ChatList onOpen={setOpen} />;
}

function ChatList({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useCardChats();
  return (
    <SafeAreaView style={styles.safe}>
      <StackHeader title={CARD_CHATS_COPY.parent} bold />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.title} accessibilityRole="header">{CARD_CHATS_COPY.title}</Text>
        <Text style={styles.lede}>{CARD_CHATS_COPY.lede}</Text>
        {q.isLoading ? <ActivityIndicator style={styles.spin} color={Bold.ink} /> : null}
        {q.isError ? (
          <View style={styles.section}>
            <Text style={styles.caption}>{CARD_CHATS_COPY.error}</Text>
            <Button bold="small" onPress={() => q.refetch()} style={styles.self} testID="chats-retry">{CARD_CHATS_COPY.retry}</Button>
          </View>
        ) : null}
        {!q.isLoading && !q.isError && q.chats.length === 0 ? <Text style={styles.body} testID="chats-empty">{CARD_CHATS_COPY.empty}</Text> : null}
        {q.chats.length ? (
          <Card bold style={styles.listCard}>
            {q.chats.map((c, i) => <ChatRow key={c.id} chat={c} last={i === q.chats.length - 1} onOpen={onOpen} />)}
          </Card>
        ) : null}
        {q.hasNextPage ? (
          <Button bold="secondary" onPress={() => q.fetchNextPage()} disabled={q.isFetchingNextPage} style={styles.self} testID="chats-older">{CARD_CHATS_COPY.older}</Button>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function ChatRow({ chat, last, onOpen }: { chat: CardChatSummary; last: boolean; onOpen: (id: string) => void }) {
  const meta = [DOOR[chat.intent], messagesLine(chat.turns), when(chat.startedAt)].filter(Boolean).join(" · ");
  return (
    <Pressable
      onPress={() => onOpen(chat.id)}
      style={({ pressed }) => [styles.row, !last && styles.rowLine, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${chat.firstMessage ?? "A chat"}. ${meta}`}
      testID={`chat-row-${chat.id}`}
    >
      <Text style={styles.rowTitle} numberOfLines={2}>{chat.firstMessage ? `“${chat.firstMessage}”` : DOOR[chat.intent]}</Text>
      <Text style={styles.rowMeta}>{meta}</Text>
    </Pressable>
  );
}

function ChatView({ id, onBack }: { id: string; onBack: () => void }) {
  const q = useCardChat(id);
  const del = useDeleteCardChat();
  const [confirming, setConfirming] = useState(false);
  const chat = q.data;
  return (
    <SafeAreaView style={styles.safe}>
      <StackHeader title={CARD_CHATS_COPY.back} bold onBack={onBack} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {q.isLoading ? <ActivityIndicator style={styles.spin} color={Bold.ink} /> : null}
        {q.isError ? (
          <View style={styles.section}>
            <Text style={styles.caption}>{CARD_CHATS_COPY.error}</Text>
            <Button bold="small" onPress={() => q.refetch()} style={styles.self} testID="chat-retry">{CARD_CHATS_COPY.retry}</Button>
          </View>
        ) : null}
        {chat ? (
          <>
            <Text style={styles.title} accessibilityRole="header">{DOOR[chat.intent]}</Text>
            <Text style={styles.lede}>{[messagesLine(chat.turns), when(chat.startedAt)].filter(Boolean).join(" · ")}</Text>
            <View style={styles.section}>
              {chat.messages.map((m, i) => <Message key={i} m={m} />)}
            </View>
            {confirming ? (
              <View style={styles.confirm} testID="chat-confirm">
                <Text style={styles.body}>{CARD_CHATS_COPY.deleteNote}</Text>
                <View style={styles.buttons}>
                  <Button bold="primary" disabled={del.isPending} onPress={() => del.mutate(chat.id, { onSuccess: onBack })} testID="chat-delete-confirm">{CARD_CHATS_COPY.confirm}</Button>
                  <Button bold="secondary" disabled={del.isPending} onPress={() => setConfirming(false)} testID="chat-delete-keep">{CARD_CHATS_COPY.keep}</Button>
                </View>
                {del.isError ? <Text style={styles.caption}>{CARD_CHATS_COPY.deleteError}</Text> : null}
              </View>
            ) : (
              <Button bold="secondary" onPress={() => setConfirming(true)} style={styles.self} testID="chat-delete">{CARD_CHATS_COPY.delete}</Button>
            )}
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Message({ m }: { m: CardChatMessage }) {
  const mila = m.from === "mila";
  const notes = [m.chapter && mila ? `From your ${cap(m.chapter)} card` : null, m.widget && mila ? WIDGET[m.widget.type] ?? null : null].filter(Boolean) as string[];
  return (
    <View style={[styles.msg, mila ? styles.msgMila : styles.msgVisitor]} testID={`msg-${m.from}`}>
      <Text style={styles.label}>{mila ? CARD_CHATS_COPY.mila : CARD_CHATS_COPY.visitor}</Text>
      <Text style={styles.body}>{m.text}</Text>
      {notes.map((n) => <Text key={n} style={styles.caption}>{n}</Text>)}
    </View>
  );
}

const styles = StyleSheet.create({
  safe:       { flex: 1, backgroundColor: Bold.paper },
  content:    { paddingHorizontal: Bold.gutter, paddingBottom: 40, gap: 16 },
  title:      { ...BoldType.screenTitleSm, color: Bold.ink },
  lede:       { ...BoldType.lede, color: Bold.mute, marginTop: -8 },
  spin:       { marginTop: 24 },
  section:    { gap: 10 },
  self:       { alignSelf: "flex-start" },
  listCard:   { padding: 0 },
  row:        { paddingVertical: 12, paddingHorizontal: 14, gap: 4, minHeight: 44 },
  rowLine:    { borderBottomWidth: 1, borderBottomColor: Bold.line },
  pressed:    { opacity: 0.7 },
  rowTitle:   { ...BoldType.rowTitle, color: Bold.ink },
  rowMeta:    { ...BoldType.rowMeta, color: Bold.mute },
  body:       { ...BoldType.body, color: Bold.ink2 },
  caption:    { ...BoldType.caption, color: Bold.mute },
  label:      { ...BoldType.label, color: Bold.mute },
  msg:        { padding: 12, gap: 4, borderRadius: Bold.radius.card },
  msgVisitor: { backgroundColor: Bold.ground },
  msgMila:    { backgroundColor: Bold.paper, borderWidth: 1, borderColor: Bold.line },
  confirm:    { gap: 10, padding: 12, backgroundColor: Bold.ground, borderRadius: Bold.radius.control },
  buttons:    { flexDirection: "row", gap: 8, flexWrap: "wrap" },
});
