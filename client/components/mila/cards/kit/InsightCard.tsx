/**
 * cards/kit/InsightCard — one thing that changed in their own data (design v2.2 "Insight"; grows the onboarding insight
 * card, decision 10). Collapsed = Home v3's compact briefing card: a 58×70 chart tile on the left, "Insight · <source>",
 * a bold headline in 2 lines, and the frosted Ask Mila. Expanded (in place, chat) = the chart band with its big number,
 * the line, up to 3 figures as tiles, the source chip, Ask Mila + "My Intelligence ›". No raspberry: nothing waits on
 * them. On an app screen the body opens My Intelligence instead.
 */
import React, { useState } from "react";
import { Text, View } from "react-native";
import type { MilaCardDto } from "../../../../../shared/milaCards";
import { MilaButton } from "../../../agent/parts";
import { useAgentCardHandlers } from "../../../agent/handlers";
import { useCardHost, useExpand, useSeen } from "./host";
import { AskMila, CardBody, CardFrame, CardMedia, Chevron, Receipt, SourceChip, styles } from "./parts";

type Insight = Extract<MilaCardDto, { type: "insight" }>["data"];

export function InsightCard({ data, initialExpanded = false }: { data: Insight; initialExpanded?: boolean }) {
  const f = data.fields;
  const host = useCardHost();
  const h = useAgentCardHandlers();
  const [open, toggle] = useExpand(data.id, initialExpanded);
  const [receipt, setReceipt] = useState<string | null>(null);
  useSeen("insight", f.decisionId);
  const site = f.sources[0]?.site ?? f.sources[0]?.label ?? null;
  const ask = async () => {
    h.reply?.(f.ask);
    const r = await host.record({ card: "insight", ref: f.decisionId, outcome: "accepted", action: "asked" });
    if (r != null) setReceipt(r || "Asked Mila.");
  };
  const openDetail = () => {
    if (f.seeMore) h.openLink?.(f.seeMore.target as never, f.seeMore as never);
    void host.record({ card: "insight", ref: f.decisionId, outcome: "accepted", action: "opened" });
  };
  const onBody = host.surface === "screen" ? openDetail : toggle;
  const expanded = host.surface === "chat" && open;

  return (
    <CardFrame testID={`card-insight-${expanded ? "expanded" : "collapsed"}`}>
      {expanded ? (
        <>
          <CardBody onPress={onBody} label={`${f.headline}, collapse`} expanded>
            <CardMedia media={f.media} shape="band" kindLabel="Insight" faceKey={data.id} glyph="trending-up" />
          </CardBody>
          <View style={styles.body}>
            <CardBody onPress={onBody} label={`${f.headline}, collapse`} expanded>
              <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
                <Text style={[styles.headline, { flex: 1 }]}>{f.headline}</Text>
                <Chevron open />
              </View>
            </CardBody>
            <Text style={styles.line}>{f.line}</Text>
            {f.more.evidence.length ? (
              <View style={styles.tiles}>
                {f.more.evidence.slice(0, 2).map((e) => (
                  <View key={e.label} style={styles.tile}>
                    <Text style={styles.tileK}>{e.label}</Text>
                    <Text style={styles.tileV}>{e.value}</Text>
                    {e.note ? <Text style={styles.tileD}>{e.note}</Text> : null}
                  </View>
                ))}
              </View>
            ) : null}
            {f.sources[0] ? <SourceChip label={f.sources[0].label} url={f.sources[0].url} site={f.sources[0].site} more={f.sources.length - 1} /> : null}
            {receipt != null ? <Receipt line={receipt} /> : (
              <View style={styles.acts}>
                <AskMila onPress={ask} />
                {f.seeMore ? <MilaButton tone="quiet" label={`${f.seeMore.label} ›`} onPress={openDetail} testID="card-insight-open" /> : null}
              </View>
            )}
          </View>
        </>
      ) : (
        <View>
          <CardBody onPress={onBody} label={host.surface === "screen" ? `${f.headline}, open` : `${f.headline}, see more`} expanded={host.surface === "chat" ? false : undefined} style={styles.row}>
            <CardMedia media={f.media} shape="tile" faceKey={data.id} glyph="trending-up" />
            <View style={styles.rowBody}>
              <Text style={styles.meta} numberOfLines={1}>Insight{site ? ` · ${site}` : ""}</Text>
              <Text style={styles.headline} numberOfLines={2}>{f.headline}</Text>
            </View>
            {/* On a screen the tap opens My Intelligence: no expand chevron there. */}
            {host.surface === "chat" ? <Chevron open={false} /> : null}
          </CardBody>
          <View style={{ paddingHorizontal: 14, paddingBottom: 14 }}>
            {receipt != null ? <Receipt line={receipt} /> : <View style={[styles.acts, { marginTop: 0 }]}><AskMila onPress={ask} /></View>}
          </View>
        </View>
      )}
    </CardFrame>
  );
}
