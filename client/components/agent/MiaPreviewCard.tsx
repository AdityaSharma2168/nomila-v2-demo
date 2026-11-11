/**
 * MiaPreviewCard (agent/1 `mia-preview`, `mia-preview/1`) — the reveal's centrepiece. It is Home's own score block
 * (components/home/HomeBriefing ScoreBlock), fed exactly as Home feeds it: the score of 850, the eight bands from
 * ringBands(preview.assessment), the confidence line from the evaluator's level, and the preliminary tag and line from
 * the preview. Nothing is recomputed. Below it, the preview's sharpen steps: a connect step starts THAT connector; an
 * evidence step is a line; a preliminary read with no connector to suggest offers one general "Connect an account",
 * which asks Mila to help (she answers with the right connect cards).
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { ScoreBlock } from "../home/HomeBriefing";
import { LinkText } from "../ui";
import { Bold, BoldType } from "../../constants/theme";
import { ringBands } from "../../lib/myIntelligenceLogic";
import { sharpenConnectors } from "../../lib/agent/onboardingAdapter";
import { useAgentCardHandlers } from "./handlers";
import type { CardOf } from "../../lib/agent/types";

export const MIA_PREVIEW_COPY = {
  sharpenWith: (service: string) => `Connect ${service} to sharpen`,
  connectAny: "Connect an account",
  connectAnyAsk: "Help me connect an account.",
} as const;

/** The server's note without its own "Preliminary:" lead-in (the header tag says it), capitalised. */
export function plainNote(note: string): string {
  const t = note.replace(/^\s*preliminary\s*[:—–-]\s*/i, "").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : note;
}

export function MiaPreviewCard({ card }: { card: CardOf<"mia-preview"> }) {
  const { connect, reply, startWorkflow } = useAgentCardHandlers();
  const p = card.payload.preview;
  const a = p.assessment;
  const bands = a ? ringBands(a as unknown as Parameters<typeof ringBands>[0]) : [];
  const connectors = sharpenConnectors(p.sharpen);
  const evidence = p.sharpen.filter((s): s is Extract<typeof s, { kind: "evidence" }> => s.kind === "evidence");
  const ask = reply ?? startWorkflow;

  const footer = (
    <View style={styles.footer}>
      {evidence.slice(0, 2).map((e) => <Text key={e.text} style={styles.evidence}>{e.text}</Text>)}
      {connect && connectors.length
        ? connectors.map((c) => (
            <LinkText key={c.connector} onDark onPress={() => { void connect(c.connector); }} testID="mia-sharpen">{MIA_PREVIEW_COPY.sharpenWith(c.service)}</LinkText>
          ))
        : p.preliminary && ask
          ? <LinkText onDark onPress={() => ask(MIA_PREVIEW_COPY.connectAnyAsk)} testID="mia-connect-any">{MIA_PREVIEW_COPY.connectAny}</LinkText>
          : null}
    </View>
  );

  return (
    <ScoreBlock
      testID="card-mia-preview"
      score={p.score}
      early={false}
      // "Preliminary" is said once, by the header tag: one plain line under it, no confidence or label line (the
      // sharpen link below already says what firms it up).
      line={plainNote(card.payload.note)}
      confidence={null}
      bands={bands.length ? bands : undefined}
      preliminary={p.preliminary}
      preliminaryLine={false}
      footer={footer}
      style={styles.block}
    />
  );
}

const styles = StyleSheet.create({
  // Home's block sits full-bleed; in the conversation it sits inside the gutter, so it takes the black block's corner.
  block: { borderRadius: Bold.radius.card },
  footer: { gap: 10 },
  evidence: { ...BoldType.caption, color: Bold.onDarkMute },
});
