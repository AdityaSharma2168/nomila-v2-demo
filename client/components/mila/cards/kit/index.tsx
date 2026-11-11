/**
 * cards/kit — the card system v2 (design "Mila card designs" v2.2, approved 3 Nov 2026; EXPO_PUBLIC_MILA_CARDS_V2).
 * One component per card type, each with two densities: collapsed (the app screen's card) and expanded (the details).
 * `KitCard` draws a checked DTO with its kit view, or answers null when the type has none (the caller then draws the
 * existing card). Knows nothing about the chat library: it takes a plain DTO.
 */
import React from "react";
import type { MilaCardDto } from "../../../../../shared/milaCards";
import { AnswerCard } from "./AnswerCard";
import { DealRowCard, DealsListCard } from "./DealRowCard";
import { IdeasCard } from "./IdeasCard";
import { InsightCard } from "./InsightCard";
import { OnceQuestion } from "./OnceQuestion";
import { TurnOnCard } from "./TurnOnCard";

export { CardKitHost, recordOutcomeOverApi, type CardOutcome, type CardSurface, type RecordOutcome } from "./host";
export { AnswerCard, DealRowCard, DealsListCard, IdeasCard, InsightCard, OnceQuestion, TurnOnCard };
export { DealRow } from "./DealRowCard";
export { ConnectSheet } from "./TurnOnCard";

/** Whether the kit draws this DTO (an old-style quick question without `once` stays on today's card). */
export function hasKitView(dto: MilaCardDto): boolean {
  if (dto.type === "quick-question") return !!dto.data.fields.once;
  return dto.type === "insight" || dto.type === "ideas" || dto.type === "turn-on" || dto.type === "answer" || dto.type === "deal" || dto.type === "deals-list";
}

export function KitCard({ dto, initialExpanded = false }: { dto: MilaCardDto; initialExpanded?: boolean }) {
  switch (dto.type) {
    case "insight": return <InsightCard data={dto.data} initialExpanded={initialExpanded} />;
    case "ideas": return <IdeasCard data={dto.data} initialExpanded={initialExpanded} />;
    case "turn-on": return <TurnOnCard data={dto.data} initialSheet={initialExpanded} />;
    case "answer": return <AnswerCard data={dto.data} initialExpanded={initialExpanded} />;
    case "deal": return <DealRowCard data={dto.data} initialExpanded={initialExpanded} />;
    case "deals-list": return <DealsListCard data={dto.data} />;
    case "quick-question": return dto.data.fields.once ? <OnceQuestion data={dto.data} initialExpanded={initialExpanded} /> : null;
    default: return null;
  }
}
