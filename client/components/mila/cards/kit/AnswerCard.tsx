/**
 * cards/kit/AnswerCard — a short answer, the image of what it's about, its sources beside the claim (design v2.2
 * "Answer with sources"). Collapsed: a tall card (brand cover + LogoMark, a chart, or atmosphere), the brand's name, a
 * bold headline, one domain chip with the count, ONE full-width soft Save. Expanded (in place): the line, the list (≤ 4
 * rows) or the figures as tiles, every source, Save + Ask Mila. A table never opens inside the card (no nested
 * scroll): "See the table" opens it on a sheet. Follow-ups are frosted rows UNDER the card, not buttons on it.
 */
import React, { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { MilaCardDto } from "../../../../../shared/milaCards";
import { Bold, BoldType } from "../../../../constants/theme";
import { MilaButton } from "../../../agent/parts";
import { useAgentCardHandlers } from "../../../agent/handlers";
import { CARD_LIFT } from "../../softLift";
import { useCardHost, useExpand } from "./host";
import { AskMila, CardBody, CardFrame, CardMedia, Chevron, Receipt, SourceChip, styles } from "./parts";

type Answer = Extract<MilaCardDto, { type: "answer" }>["data"];

export function AnswerCard({ data, initialExpanded = false }: { data: Answer; initialExpanded?: boolean }) {
  const f = data.fields;
  const host = useCardHost();
  const h = useAgentCardHandlers();
  const [open, toggle] = useExpand(data.id, initialExpanded);
  const [saved, setSaved] = useState<string | null>(f.saved ? "Saved." : null);
  const [table, setTable] = useState(false);
  const expanded = host.surface === "chat" && open;
  const save = async () => {
    const r = await host.record({ card: "answer", ref: f.decisionId, outcome: "accepted", action: "saved" });
    if (r != null) setSaved(r || "Saved.");
  };
  const ask = (text: string, action: "asked" | "follow_up") => {
    h.reply?.(text);
    void host.record({ card: "answer", ref: f.decisionId, outcome: "accepted", action });
  };
  const onBody = () => {
    if (host.surface === "screen") { void host.record({ card: "answer", ref: f.decisionId, outcome: "accepted", action: "opened" }); return; }
    if (!open) void host.record({ card: "answer", ref: f.decisionId, outcome: "accepted", action: "opened" });
    toggle();
  };
  const tall = f.media.kind !== "chart" || !!f.brand;
  const more = f.more;
  return (
    <View style={{ gap: 8 }}>
      <CardFrame testID={`card-answer-${expanded ? "expanded" : "collapsed"}`}>
        <CardBody onPress={onBody} label={`${f.headline}, ${expanded ? "collapse" : "see more"}`} expanded={host.surface === "chat" ? expanded : undefined}>
          <CardMedia media={f.media} shape={tall ? "band" : "bandSm"} kindLabel="Answer" faceKey={data.id} glyph="search" />
          <View style={[styles.body, { paddingBottom: 6 }]}>
            {f.brand ? <Text style={styles.meta} numberOfLines={1}>{f.brand.name}</Text> : null}
            <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
              <Text style={[styles.headline, { flex: 1 }]} numberOfLines={expanded ? undefined : 2}>{f.headline}</Text>
              <Chevron open={expanded} />
            </View>
          </View>
        </CardBody>
        <View style={[styles.body, { paddingTop: 0, gap: 8 }]}>
          {expanded ? (
            <>
              <Text style={styles.line}>{f.line}</Text>
              {more?.kind === "list" ? (
                <View style={{ gap: 8 }} testID="card-answer-list">
                  {more.items.map((it, i) => (
                    <View key={i} style={a.li}>
                      <Text style={a.lead}>{it.lead ?? ""}</Text>
                      <Text style={a.liText}>{it.text}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {more?.kind === "stats" ? (
                <View style={[styles.tiles, { flexWrap: "wrap" }]}>
                  {more.items.map((it) => (
                    <View key={it.label} style={[styles.tile, { minWidth: "45%" }]}>
                      <Text style={styles.tileK}>{it.label}</Text>
                      <Text style={styles.tileV}>{it.value}</Text>
                      {it.note ? <Text style={styles.tileD}>{it.note}</Text> : null}
                    </View>
                  ))}
                </View>
              ) : null}
              {more?.kind === "table" ? <MilaButton tone="quiet" label="See the table ›" onPress={() => setTable(true)} testID="card-answer-table" /> : null}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {f.sources.map((s) => <SourceChip key={s.url} label={s.label} url={s.url} site={s.site} />)}
              </View>
            </>
          ) : f.sources[0] ? <SourceChip label={f.sources[0].label} url={f.sources[0].url} site={f.sources[0].site} more={f.sources.length - 1} /> : null}
          {saved ? <Receipt line={saved} /> : expanded ? (
            <View style={styles.acts}>
              <MilaButton tone="soft" label="Save" onPress={() => void save()} testID="card-answer-save" />
              <AskMila onPress={() => ask(`More on this: ${f.headline}`, "asked")} />
            </View>
          ) : (
            <MilaButton tone="soft" label="Save" onPress={() => void save()} style={styles.fullBtn} testID="card-answer-save" />
          )}
        </View>
      </CardFrame>
      {f.followUps.slice(0, expanded ? 1 : 2).map((fu, i) => (
        <Pressable key={fu} onPress={() => ask(fu, "follow_up")} accessibilityRole="button" accessibilityLabel={fu} style={({ pressed }) => [a.fu, pressed && styles.pressed]} testID={`card-answer-follow-${i}`}>
          <Text style={a.fuText} numberOfLines={2}>{fu}</Text>
          <Feather name="chevron-right" size={16} color={Bold.quiet} />
        </Pressable>
      ))}
      {more?.kind === "table" ? (
        <Modal visible={table} transparent animationType="slide" onRequestClose={() => setTable(false)}>
          <Pressable style={{ flex: 1, backgroundColor: Bold.sheetScrim }} onPress={() => setTable(false)} accessibilityLabel="Close" />
          <View style={a.sheet} testID="card-answer-table-sheet">
            <View style={a.tr}>{more.columns.map((c) => <Text key={c} style={[a.td, a.th]}>{c}</Text>)}</View>
            {more.rows.map((r, i) => <View key={i} style={a.tr}>{r.map((c, j) => <Text key={j} style={a.td}>{c}</Text>)}</View>)}
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const a = StyleSheet.create({
  li: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  lead: { ...BoldType.cardMeta, color: Bold.mute, width: 64 },
  liText: { ...BoldType.cardLine, fontSize: 13.5, lineHeight: 19, color: Bold.ink, flex: 1 },
  fu: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, borderRadius: 18, paddingVertical: 11, paddingHorizontal: 16, backgroundColor: "rgba(255,255,255,0.6)", ...CARD_LIFT },
  fuText: { ...BoldType.rowTitle, fontSize: 14.5, color: Bold.ink, flex: 1 },
  sheet: { backgroundColor: Bold.paper, borderTopLeftRadius: Bold.sheetRadius, borderTopRightRadius: Bold.sheetRadius, padding: 20, paddingBottom: 32 },
  tr: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Bold.line },
  td: { ...BoldType.cardLine, flex: 1, paddingVertical: 9, color: Bold.ink },
  th: { ...BoldType.label, color: Bold.mute },
});
