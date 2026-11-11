/**
 * cards/kit/DealRowCard — the deal in the shared row shape (design v2.2 "How the existing cards fit"): a real LogoMark
 * tile, whose move it is as the meta, the money as the headline, "brand · type" under it. Expanded (chat): the status
 * chip and the rest of the read ("Nothing to flag" …), "Draft a reply" (raspberry: it waits on them) and "Open ›". On a
 * screen, or in a list (DealsListCard, All deals — decision 15: no buttons there), the row opens the deal.
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { MilaCardDto } from "../../../../../shared/milaCards";
import { Bold, BoldType } from "../../../../constants/theme";
import { MilaButton } from "../../../agent/parts";
import { useAgentCardHandlers } from "../../../agent/handlers";
import { LogoMark } from "../../../ui/LogoMark";
import { useCardHost, useExpand } from "./host";
import { CardBody, CardFrame, Chevron, styles } from "./parts";

type Deal = Extract<MilaCardDto, { type: "deal" }>["data"];
type Brand = Deal["fields"]["brand"];

/** One row: the logo tile, a meta line, the headline, a sub line. Shared with the deals list and All deals. */
export function DealRow({ brand, meta, headline, sub, chevron = "right", open }: { brand: Brand; meta: string; headline: string; sub?: string | null; chevron?: "right" | "toggle"; open?: boolean }) {
  return (
    <View style={styles.row}>
      <View style={d.tile}><LogoMark logoUrl={brand.logoUrl} domain={brand.domain} name={brand.name} size={44} /></View>
      <View style={styles.rowBody}>
        <Text style={styles.meta} numberOfLines={1}>{meta}</Text>
        <Text style={styles.headline} numberOfLines={2}>{headline}</Text>
        {sub ? <Text style={styles.meta} numberOfLines={1}>{sub}</Text> : null}
      </View>
      {chevron === "toggle" ? <Chevron open={!!open} /> : <Text style={d.chev}>›</Text>}
    </View>
  );
}

export function DealRowCard({ data, initialExpanded = false }: { data: Deal; initialExpanded?: boolean }) {
  const f = data.fields;
  const host = useCardHost();
  const h = useAgentCardHandlers();
  const [open, toggle] = useExpand(data.id, initialExpanded);
  const openDeal = () => h.openLink?.({ screen: "deal", id: f.opportunityId } as never);
  const expanded = host.surface === "chat" && open;
  const [money, ...rest] = f.moneyLine.split(" — ");
  return (
    <CardFrame testID={`card-deal-${expanded ? "expanded" : "collapsed"}`}>
      <CardBody onPress={host.surface === "screen" ? openDeal : toggle} label={`${f.brand.name}, ${money}`} expanded={host.surface === "chat" ? expanded : undefined}>
        <DealRow brand={f.brand} meta={f.moveLabel} headline={money} sub={[f.brand.name, f.typeLabel].filter(Boolean).join(" · ")} chevron={host.surface === "chat" ? "toggle" : "right"} open={expanded} />
      </CardBody>
      {expanded ? (
        <View style={[styles.body, { paddingTop: 0 }]}>
          {rest.length ? <Text style={styles.line}>{rest.join(" — ").replace(/^./, (c) => c.toUpperCase())}.</Text> : null}
          <View style={d.chips}>{f.chips.map((c) => <View key={c} style={d.chip}><Text style={d.chipText}>{c}</Text></View>)}</View>
          <View style={styles.acts}>
            {f.action && !f.closed ? <MilaButton tone="primary" label={f.action.label} onPress={() => h.reply?.(f.action!.message)} testID="card-deal-action" /> : null}
            <MilaButton tone="quiet" label="Open ›" onPress={openDeal} testID="card-deal-open" />
          </View>
        </View>
      ) : null}
    </CardFrame>
  );
}

type DealsList = Extract<MilaCardDto, { type: "deals-list" }>["data"];
export function DealsListCard({ data }: { data: DealsList }) {
  const h = useAgentCardHandlers();
  return (
    <CardFrame testID="card-deals-list">
      {data.fields.items.map((it, i) => (
        <View key={it.opportunityId} style={i > 0 ? d.sep : null}>
          <CardBody onPress={() => h.openLink?.({ screen: "deal", id: it.opportunityId } as never)} label={`${it.brand.name}, ${it.moneyLine}`}>
            <DealRow brand={it.brand} meta={it.stage} headline={`${it.brand.name} · ${it.moneyLine}`} sub={[it.typeLabel, it.lastActivity].filter(Boolean).join(" · ")} />
          </CardBody>
        </View>
      ))}
    </CardFrame>
  );
}

const d = StyleSheet.create({
  tile: { width: 58, height: 70, borderRadius: 10, backgroundColor: Bold.ground, alignItems: "center", justifyContent: "center" },
  chev: { ...BoldType.h4, color: Bold.quiet },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { borderRadius: 999, backgroundColor: Bold.ground, paddingVertical: 4, paddingHorizontal: 9 },
  chipText: { ...BoldType.cardMeta, fontWeight: "600", color: Bold.ink2 },
  sep: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Bold.line },
});
