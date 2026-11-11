/**
 * cards/kit/host — what the card kit needs from where it is drawn (design "Mila card designs" v2.2, decision 1):
 *
 *   surface    "chat": a tap on a card's body expands it in place (one open at a time); "screen": the same tap opens
 *              the card's detail screen. The primary button always acts directly.
 *   record     POST /api/v1/me/mila/cards/outcome (what the tap was: accepted / edited / not now / never / seen);
 *              answers the receipt line, or null when it could not be saved (the card stays live).
 *   expand     the accordion: which card is open (one at a time).
 *   faces      decision 13: at most MAX_FACES_PER_SCREEN faces across the visible cards; a later face-led card draws
 *              its fallback instead.
 *
 * Taps that leave the card (send words as their message, put words in the composer, open a screen) go through the
 * existing AgentCardHandlers (components/agent/handlers), so a card never knows a route name.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { MAX_FACES_PER_SCREEN } from "../../../../../shared/milaCards";
import { apiRequest, queryClient } from "../../../../lib/query-client";
import { logger } from "../../../../lib/logger";

export type CardSurface = "chat" | "screen";
export type CardOutcomeCard = "insight" | "idea" | "turn-on" | "once" | "answer";
export interface CardOutcome {
  card: CardOutcomeCard;
  ref: string;
  outcome: "accepted" | "edited" | "not_now" | "never" | "seen";
  action?: "asked" | "opened" | "saved" | "follow_up" | "idea_used" | "enabled" | "rule";
  choice?: number;
  /** Turn-on: the consent version the connect sheet showed (the server records a Turn on only with it). */
  consentVersion?: string;
}
export type RecordOutcome = (o: CardOutcome) => Promise<string | null>;

/** The real recorder: the server's receipt line, or null when the tap was not saved. */
export const recordOutcomeOverApi: RecordOutcome = async (o) => {
  try {
    const res = await apiRequest("POST", "/api/v1/me/mila/cards/outcome", o);
    const body = (await res.json().catch(() => ({}))) as { receipt?: unknown };
    // A Turn-on answered in chat (on, not now, never) changes what Me › What Mila can do shows: read it again there.
    if (o.card === "turn-on") queryClient?.invalidateQueries({ queryKey: ["/api/v1/me/mila/capabilities"] }).catch(() => undefined);
    return typeof body.receipt === "string" ? body.receipt : "";
  } catch (err) {
    logger.warn(`[mila] card tap not saved: ${o.card} ${o.outcome} (${String(err)})`);
    return null;
  }
};

interface Host {
  surface: CardSurface;
  record: RecordOutcome;
  openId: string | null;
  setOpenId: (id: string | null) => void;
  faceKeys: string[];
  registerFace: (key: string, on: boolean) => void;
}

const HostCtx = createContext<Host | null>(null);

export function CardKitHost({ surface, record = recordOutcomeOverApi, children }: { surface: CardSurface; record?: RecordOutcome; children: React.ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [faceKeys, setFaceKeys] = useState<string[]>([]);
  const registerFace = useCallback((key: string, on: boolean) => {
    setFaceKeys((ks) => (on ? (ks.includes(key) ? ks : [...ks, key]) : ks.filter((k) => k !== key)));
  }, []);
  const value = useMemo(() => ({ surface, record, openId, setOpenId, faceKeys, registerFace }), [surface, record, openId, faceKeys, registerFace]);
  return <HostCtx.Provider value={value}>{children}</HostCtx.Provider>;
}

/** Outside a host (a stray card): chat behaviour, its own accordion, the real recorder, no face count. */
const FALLBACK: Host = { surface: "chat", record: recordOutcomeOverApi, openId: null, setOpenId: () => {}, faceKeys: [], registerFace: () => {} };

export function useCardHost(): Host {
  return useContext(HostCtx) ?? FALLBACK;
}

/** One card's open state in the accordion. `initial` opens it (the gallery's expanded pages). */
export function useExpand(id: string, initial = false): [boolean, () => void] {
  const host = useContext(HostCtx);
  const [own, setOwn] = useState(initial);
  const did = useRef(false);
  useEffect(() => {
    if (initial && host && !did.current) { did.current = true; host.setOpenId(id); }
  }, [initial, host, id]);
  if (!host) return [own, () => setOwn((v) => !v)];
  return [host.openId === id, () => host.setOpenId(host.openId === id ? null : id)];
}

/** Whether this card may show its face-led image (decision 13). A face-free image is always allowed. */
export function useFaceAllowed(key: string, hasFace: boolean): boolean {
  const host = useContext(HostCtx);
  const register = host?.registerFace;
  useEffect(() => {
    if (!register || !hasFace) return;
    register(key, true);
    return () => register(key, false);
  }, [register, key, hasFace]);
  if (!hasFace || !host) return true;
  const i = host.faceKeys.indexOf(key);
  return i >= 0 && i < MAX_FACES_PER_SCREEN;
}

/** Record "seen" once per card mount (the 7-day ignored rule counts only what was seen). */
export function useSeen(card: CardOutcomeCard, ref: string | null | undefined, when = true) {
  const { record } = useCardHost();
  const sent = useRef(false);
  useEffect(() => {
    if (!ref || !when || sent.current) return;
    sent.current = true;
    void record({ card, ref, outcome: "seen" });
  }, [record, card, ref, when]);
}
