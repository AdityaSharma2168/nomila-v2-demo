// use-card-chats — "Chats on your card": what visitors asked Mila on her public card (public Mila mode, PR 5).
//
//   GET    /api/v1/me/public-card/chats?before=   → useCardChats()       her chats, newest first, 30 a page
//   GET    /api/v1/me/public-card/chats/:id       → useCardChat(id)      one chat, every message as shown
//   DELETE /api/v1/me/public-card/chats/:id       → useDeleteCardChat()  gone for good
//
// Every route answers only for the signed-in athlete; nothing here sends an athlete id.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/query-client";

export const CARD_CHATS_KEY = ["me", "public-card", "chats"] as const;

export type CardChatIntent = "ask" | "partner" | "book" | "shop";

export interface CardChatSummary {
  id: string;
  intent: CardChatIntent;
  startedAt: string;
  lastTurnAt: string;
  turns: number;
  status: "open" | "ended";
  firstMessage: string | null;
}

export interface CardChatMessage {
  from: "visitor" | "mila";
  text: string;
  chapter: string | null;
  widget: { type: string } | null;
  at: string;
}

export interface CardChat extends CardChatSummary {
  messages: CardChatMessage[];
}

async function json<T>(method: string, route: string): Promise<T> {
  const res = await apiRequest(method, route);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export function useCardChats() {
  const q = useInfiniteQuery({
    queryKey: CARD_CHATS_KEY,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      json<{ chats: CardChatSummary[]; next: string | null }>("GET", `/api/v1/me/public-card/chats${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => last.next,
  });
  return { ...q, chats: q.data?.pages.flatMap((p) => p.chats) ?? [] };
}

export function useCardChat(id: string | null) {
  return useQuery({
    queryKey: [...CARD_CHATS_KEY, id],
    enabled: !!id,
    queryFn: () => json<{ chat: CardChat }>("GET", `/api/v1/me/public-card/chats/${encodeURIComponent(id!)}`).then((r) => r.chat),
  });
}

export function useDeleteCardChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => json<void>("DELETE", `/api/v1/me/public-card/chats/${encodeURIComponent(id)}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: CARD_CHATS_KEY }); },
  });
}
