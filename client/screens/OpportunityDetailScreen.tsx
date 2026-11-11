// OpportunityDetailScreen — a card's detail (Opportunities PR 4, detail slice, approved 7 Oct 2026; behind
// EXPO_PUBLIC_OPPS_BOARD). The brand deck on top, Nomila's letter below:
//
//   What's new · date → what they asked → why it's here (sources) → not known yet → Nomila's take →
//   ONE primary action (secondaries subordinate) → the draft → supporting rows → Conversation (read live)
//
// Every line is a derived field from GET /me/opportunities/:id. No stored email text: the email opens only from
// Conversation, read live from her inbox. Sending goes through the governed propose → approve path; nothing goes out
// without her tap, and sending never changes the deal's status by itself. "Looks signed — confirm?" changes state
// only on her Yes (POST /opportunities/:id/signed: the deal shows Signed, the engagement closes as won, a receipt
// with Undo). After it, Nomila OFFERS to read the signed PDF into the terms — reading is her tap, never automatic.
import React, { useCallback, useMemo, useState } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Alert, Linking, SafeAreaView, StatusBar } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { Bold, BoldType, Fonts } from "../constants/theme";
import { useOpportunityDetail, opportunityDetailKey, type OpportunityDetail } from "../hooks/use-opportunity-detail";
import { OPPORTUNITY_BOARD_KEY } from "../hooks/use-opportunity-board";
import { useDeals } from "../hooks/use-deals";
import { apiRequest } from "../lib/query-client";
import { proposeAndApproveReply, sendErrorMessage } from "../hooks/use-pending-actions";
import { DealActionSheet } from "../components/deals/DealActionSheet";
import { AddContractSheet } from "../components/deals/AddContractSheet";
import { BrandSections, timelineTitle } from "../components/opps/BrandSections";
import { useBrandPage, brandPageKey, type BrandSection } from "../hooks/use-brand-page";
import { fetchAttachmentUrl } from "../hooks/use-deal-attachments";
import { OppDeck, OPPS_PARENT } from "../components/opps/OppDeck";
import { actionEmphasis, kindChip, moveChip, reasonSource } from "../components/opps/oppBoardLogic";
import { StackHeader } from "../components/ui/StackHeader";
import { usePullRefresh, pullRefresh } from "../components/ui/PullRefresh";
import { haptics } from "../lib/haptics";
import { OPPS_V2 } from "../lib/flags";
import { DealReadBlock } from "../components/deals/DealReadBlock";
import { ReplySheet } from "../components/deals/ReplySheet";
import { NotForMeSheet } from "../components/deals/NotForMeSheet";
import { closedLine, letterActions, type LetterAction } from "../components/deals/dealLetterLogic";
import { openRates } from "../navigation/meNav";
import { useNavigation } from "@react-navigation/native";
import type { ReplyIntent } from "../../shared/deals";
import { AskMilaAboutDeal, askMilaAboutDealEnabled } from "../components/mila/AskMilaAboutDeal";

interface Props {
  opportunityId: string;
  onBack: () => void;
  onOpenThread: (threadId: string, brandName: string) => void;
}

const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null;

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.block}>
      <Text style={styles.h4}>{title}</Text>
      {children}
    </View>
  );
}

function Chip({ text, kind }: { text: string; kind: "dark" | "line" | "blue" | "dashed" }) {
  return (
    <View style={[styles.chip, kind === "dark" && styles.chipDark, kind === "blue" && styles.chipBlue, kind === "dashed" && styles.chipDashed]}>
      <Text style={[styles.chipT, (kind === "dark" || kind === "blue") && { color: Bold.onDark }]}>{text}</Text>
    </View>
  );
}

export function OpportunityDetailScreen({ opportunityId, onBack, onOpenThread }: Props) {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useOpportunityDetail(opportunityId);
  const { deals, refetch: refetchDeals } = useDeals("active");
  // The brand page: every deal with this brand. More than one → one section per deal; one → the letter as before.
  const { data: brandPage, refetch: refetchBrandPage } = useBrandPage(opportunityId);
  const [sheetDealId, setSheetDealId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<null | "terms" | "negotiate" | "accept">(null);
  const [busy, setBusy] = useState(false);
  const [signedDismissed, setSignedDismissed] = useState(false);
  const [readDismissed, setReadDismissed] = useState(false);
  const [reading, setReading] = useState<null | { dealId: string; messageId: string; index: number }>(null);
  // OPPS_V2: the one reply sheet (opened on a chip of the deal's type) and the Not-for-me sheet.
  const [reply, setReply] = useState<ReplyIntent | null>(null);
  const [notForMe, setNotForMe] = useState(false);
  const nav = useNavigation<any>();

  const deal = useMemo(() => deals.find((d) => d.id === (sheetDealId ?? data?.lead_deal_id)) ?? null, [deals, sheetDealId, data?.lead_deal_id]);
  // Swipe down: this opportunity's letter again, the brand page's sections, and the deals list their actions read.
  const pull = usePullRefresh(() => Promise.all([refetch(), refetchBrandPage?.(), refetchDeals?.()]));

  const refresh = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: [OPPORTUNITY_BOARD_KEY] }),
      qc.invalidateQueries({ queryKey: [opportunityDetailKey(opportunityId)] }),
      qc.invalidateQueries({ queryKey: [brandPageKey(opportunityId)] }),
    ]);
  }, [qc, opportunityId]);

  const decline = useCallback(async (d: OpportunityDetail) => {
    if (!d.lead_deal_id) return;
    Alert.alert("Decline this?", "It closes with a receipt. Nothing is sent to them.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Decline", style: "destructive", onPress: async () => {
          setBusy(true);
          try {
            await apiRequest("PATCH", `/api/v1/me/deals/${d.lead_deal_id}`, { status: "rejected" });
            haptics.success();
            await refresh();
            onBack();
          } catch (err) {
            Alert.alert("Couldn’t decline", err instanceof Error ? err.message : String(err));
          } finally { setBusy(false); }
        },
      },
    ]);
  }, [refresh, onBack]);

  const confirmSigned = useCallback(async (d: OpportunityDetail) => {
    if (!d.signed_target_deal_id) return;
    setBusy(true);
    try {
      // Her tap is the governed event: only now is the deal Signed and the engagement closed as won.
      await apiRequest("POST", `/api/v1/me/opportunities/${opportunityId}/signed`, { deal_id: d.signed_target_deal_id });
      haptics.success();
      await Promise.all([refresh(), qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").startsWith("/api/v1/me/deals") })]);
    } catch (err) {
      Alert.alert("Couldn’t save", err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }, [refresh, opportunityId, qc]);

  // ── brand-page sections (several deals with this brand) ──
  const confirmSection = async (s: BrandSection) => {
    setBusy(true);
    try {
      await apiRequest("POST", `/api/v1/me/opportunities/${s.opportunity_id}/signed`, { deal_id: s.deal_id });
      haptics.success();
      await Promise.all([refresh(), qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").startsWith("/api/v1/me/deals") })]);
    } catch (err) {
      Alert.alert("Couldn’t save", err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  const openFile = async (s: BrandSection, f: { message_id: string; index: number }) => {
    try {
      await Linking.openURL(await fetchAttachmentUrl(s.deal_id, { messageId: f.message_id, index: f.index }));
    } catch (err) {
      Alert.alert("Couldn’t open the file", err instanceof Error ? err.message : String(err));
    }
  };
  const declineSection = (s: BrandSection) => {
    Alert.alert("Decline this?", "It closes with a receipt. Nothing is sent to them.", [
      { text: "Cancel", style: "cancel" },
      { text: "Decline", style: "destructive", onPress: async () => {
        setBusy(true);
        try { await apiRequest("PATCH", `/api/v1/me/deals/${s.deal_id}`, { status: "rejected" }); haptics.success(); await refresh(); }
        catch (err) { Alert.alert("Couldn’t decline", err instanceof Error ? err.message : String(err)); }
        finally { setBusy(false); }
      } },
    ]);
  };
  // "This is a separate deal" (D7): her tap, confirmed, receipted with Undo in The Week.
  const splitSection = (s: BrandSection, chainId?: string) => {
    Alert.alert("Make this its own deal?", chainId
      ? "These emails move to their own deal with its own status. You can undo it from The Week."
      : "This deal moves out of this engagement into its own. You can undo it from The Week.", [
      { text: "Cancel", style: "cancel" },
      { text: "Separate it", onPress: async () => {
        setBusy(true);
        try {
          await apiRequest("POST", `/api/v1/me/deals/${s.deal_id}/split`, chainId ? { chain: chainId } : {});
          haptics.success();
          await Promise.all([refresh(), qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").startsWith("/api/v1/me/deals") })]);
        } catch (err) {
          Alert.alert("Couldn’t separate it", err instanceof Error ? err.message : String(err));
        } finally { setBusy(false); }
      } },
    ]);
  };
  const runSectionPrimary = (s: BrandSection) => {
    haptics.tap();
    if (s.primary.action === "decline") return declineSection(s);
    const sectionDeal = deals.find((d) => d.id === s.deal_id);
    if (s.primary.action === "open_thread" || !sectionDeal) {
      if (s.conversation) onOpenThread(s.conversation.thread_id, brandPage?.brand.name ?? "");
      return;
    }
    setSheetDealId(s.deal_id);
    setSheet(s.primary.action === "ask_for_terms" ? "terms" : s.primary.action === "counter" ? "negotiate" : "accept");
  };

  // Every state is a pushed screen: the root is a SafeAreaView (the bar sits below the status bar, never under it) and
  // ‹ OPPORTUNITIES is the shared StackHeader — on the deck once it has loaded, on white before.
  if (isLoading) {
    return (
      <SafeAreaView style={styles.root}>
        <StackHeader title={OPPS_PARENT} bold onBack={onBack} />
        <View style={styles.center}><ActivityIndicator color={Bold.ink} /></View>
      </SafeAreaView>
    );
  }
  if (error || !data) {
    return (
      <SafeAreaView style={styles.root}>
        <StackHeader title={OPPS_PARENT} bold onBack={onBack} />
        <View style={styles.center}>
          <Text style={styles.muted}>Couldn’t load this opportunity.</Text>
          <Pressable onPress={() => refetch()} hitSlop={8}><Text style={styles.link}>Try again</Text></Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const { item } = data;
  const kc = kindChip(item);
  const mc = moveChip(item);
  const showNew = !!item.whats_new && item.message_count > 1;
  const meta = [item.started_at ? `Started ${fmtDate(item.started_at)}` : fmtDate(item.last_activity_at), item.via ? `via ${item.via}` : item.channel === "agency" ? "via an agency" : null,
    `${item.message_count} message${item.message_count === 1 ? "" : "s"}`].filter(Boolean).join(" · ");

  const runPrimary = () => {
    haptics.tap();
    // The draft sheet needs the deal row; if it isn't in the live list, answer from the thread instead.
    if (data.primary.action !== "decline" && !deal) {
      if (data.lead_thread_id) onOpenThread(data.lead_thread_id, item.brand.name);
      return;
    }
    setSheetDealId(null);
    switch (data.primary.action) {
      case "decline":       return decline(data);
      case "ask_for_terms": return setSheet("terms");
      case "counter":       return setSheet("negotiate");
      default:              return setSheet("accept");
    }
  };
  const runSecondary = (a: OpportunityDetail["secondary"][number]["action"]) => {
    if (a === "decline") return decline(data);
    if (a === "verify" && data.lead_thread_id) return onOpenThread(data.lead_thread_id, item.brand.name); // she writes the verify reply herself
    // "open_deal" (an older server's "Deal details") is not offered: there is one detail screen, this one.
  };
  // One primary on the screen: while "Looks signed — confirm?" is up, "Yes, it’s signed" is it and the action steps down.
  const emphasis = actionEmphasis(data.looks_signed, signedDismissed);
  const secondaries = data.secondary.filter((s) => (s.action as string) !== "open_deal");
  // OPPS_V2 (deals design §7): the four-line read replaces "Why it's here" and "Nomila's take"; the actions are the
  // deal TYPE's own; a closed deal is history with no action. Each falls back to today's letter when the server
  // hasn't sent it yet (DEALS_READ / DEALS_BOARD_V2 off).
  const readOnly = OPPS_V2 && !!data.read_only;
  const v2Read = OPPS_V2 ? data.read ?? null : null;
  const v2Actions = OPPS_V2 && !readOnly && data.lead_deal_id && (item.actions?.length ?? 0) > 0 ? letterActions(item) : null;
  const openReply = (a: LetterAction) => { haptics.tap(); setReply(a.intent); };

  return (
    <SafeAreaView style={styles.root} testID="opportunity-detail">
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={{ paddingBottom: 48 }} refreshControl={pullRefresh(pull)}>
        <OppDeck detail={data} onBack={onBack} />
        {brandPage && brandPage.sections.length > 1 ? (
          <View style={styles.letter}>
            <BrandSections
              page={brandPage}
              busy={busy}
              onPrimary={runSectionPrimary}
              onConfirmSigned={confirmSection}
              onReadContract={(s) => s.contract_candidate && setReading({ dealId: s.deal_id, messageId: s.contract_candidate.message_id, index: s.contract_candidate.index })}
              onOpenThread={(t) => onOpenThread(t, brandPage.brand.name)}
              onOpenFile={openFile}
              onSplit={splitSection}
            />
            <Text style={styles.safety}>Nothing goes out until you tap Send.</Text>
          </View>
        ) : (
        <View style={styles.letter}>
          <Text style={styles.meta}>{meta}</Text>

          {showNew ? (
            <View style={styles.newBlock}>
              <View style={styles.newHead}><View style={styles.newDot} /><Text style={styles.h4}>What’s new · {fmtDate(item.whats_new!.at) ?? ""}</Text></View>
              <Text style={styles.body}>{item.whats_new!.text}</Text>
            </View>
          ) : null}

          {!readOnly && data.looks_signed && !signedDismissed ? (
            <View style={styles.signed}>
              <View style={styles.signedHead}><Feather name="file-text" size={15} color={Bold.ink} /><Text style={styles.signedT}>Looks signed — confirm?</Text></View>
              <Text style={styles.body}>{signedWhy(data)} Nothing changes until you confirm.</Text>
              <View style={styles.pair}>
                <Pressable style={[styles.smallBtn, styles.smallBtnDark]} onPress={() => confirmSigned(data)} disabled={busy}><Text style={styles.smallBtnDarkT}>Yes, it’s signed</Text></Pressable>
                <Pressable style={styles.smallBtn} onPress={() => setSignedDismissed(true)}><Text style={styles.smallBtnT}>Not yet</Text></Pressable>
              </View>
            </View>
          ) : null}

          {!readOnly && data.signed && !data.has_contract && data.contract_candidate && !readDismissed ? (
            <View style={styles.signed}>
              <View style={styles.signedHead}><Feather name="file-text" size={15} color={Bold.ink} /><Text style={styles.signedT}>Read the signed contract into your terms?</Text></View>
              <Text style={styles.body}>{`${data.contract_candidate.filename}. Nomila reads it and you check every figure before anything is saved.`}</Text>
              <View style={styles.pair}>
                <Pressable style={[styles.smallBtn, styles.smallBtnDark]} disabled={busy} accessibilityRole="button"
                  onPress={() => setReading({ dealId: data.signed!.deal_id, messageId: data.contract_candidate!.message_id, index: data.contract_candidate!.index })}>
                  <Text style={styles.smallBtnDarkT}>Read it</Text>
                </Pressable>
                <Pressable style={styles.smallBtn} onPress={() => setReadDismissed(true)} accessibilityRole="button"><Text style={styles.smallBtnT}>Later</Text></Pressable>
              </View>
            </View>
          ) : null}

          {data.terms && item.stage ? <Text style={styles.terms}>{data.terms}</Text> : null}
          <View style={styles.chips}>
            {item.stage ? <Chip text={item.stage} kind="dark" /> : kc ? <Chip text={kc.text} kind={kc.dark ? "dark" : item.qualification === "verify_first" ? "dashed" : "line"} /> : null}
            {item.via ? <Chip text={`via ${item.via}`} kind="line" /> : null}
            {item.pitched_by_you ? <Chip text="Pitched by you" kind="line" /> : null}
            {mc ? <Chip text={mc.text} kind={mc.overdue ? "blue" : "line"} /> : null}
          </View>
          {item.qualification === "verify_first" ? (
            <View style={styles.hold}><Feather name="lock" size={14} color="#8A5A00" /><Text style={styles.holdT}>Held at the bottom of Explore all. Never filed by itself; never ranked above a real opportunity.</Text></View>
          ) : null}

          {data.ask ? <Block title="What they asked"><Text style={styles.what}>{data.ask}</Text></Block> : null}

          {v2Read ? (
            <DealReadBlock read={v2Read} item={item} onMoney={() => openRates(nav)} />
          ) : null}

          {!v2Read && data.reasons.length ? (
            <Block title={item.qualification === "verify_first" ? "What doesn’t add up" : "Why it’s here"}>
              {data.reasons.map((r, k) => {
                // Where it came from, in her words; nothing when the server only had a pipeline name.
                const source = reasonSource(r.source);
                return (
                  <View key={k} style={styles.reason}>
                    <Feather name="check" size={14} color={Bold.ink} style={{ marginTop: 2 }} />
                    <View style={{ flex: 1 }}><Text style={styles.body}>{r.text}</Text>{source ? <Text style={styles.caption}>{source}</Text> : null}</View>
                  </View>
                );
              })}
            </Block>
          ) : null}

          {data.unknowns.length ? (
            <View style={styles.block}>
              <Text style={styles.eyebrow}>Not known yet</Text>
              <View style={styles.chips}>{data.unknowns.map((u) => <Chip key={u} text={u} kind="dashed" />)}</View>
            </View>
          ) : null}

          {!v2Read ? <Block title="Nomila’s take"><Text style={styles.body}>{data.take}</Text></Block> : null}

          {readOnly ? (
            <View style={styles.closedRow} testID="detail-closed">
              <Chip text={closedLine(data.closed)} kind="dark" />
              <Text style={styles.caption}>Closed. Here for your records: nothing to do.</Text>
            </View>
          ) : v2Actions ? (
            <View style={styles.v2Actions} testID="detail-actions-v2">
              {v2Actions.primary ? (
                <Pressable style={emphasis === "primary" ? styles.primary : styles.demoted} onPress={() => openReply(v2Actions.primary!)} disabled={busy} accessibilityRole="button" testID="detail-action">
                  <Text style={emphasis === "primary" ? styles.primaryT : styles.demotedT}>{v2Actions.primary.label}</Text>
                </Pressable>
              ) : null}
              {v2Actions.secondary ? (
                <Pressable style={styles.demoted} onPress={() => openReply(v2Actions.secondary!)} disabled={busy} accessibilityRole="button" testID="detail-action-secondary">
                  <Text style={styles.demotedT}>{v2Actions.secondary.label}</Text>
                </Pressable>
              ) : null}
              <View style={styles.secondaries}>
                {v2Actions.link ? (
                  <Pressable onPress={() => openReply(v2Actions.link!)} hitSlop={12} disabled={busy} accessibilityRole="button" testID="detail-link">
                    <Text style={styles.linkAction}>{v2Actions.link.label}</Text>
                  </Pressable>
                ) : null}
                {v2Actions.notForMe ? (
                  <Pressable onPress={() => { haptics.tap(); setNotForMe(true); }} hitSlop={12} disabled={busy} accessibilityRole="button" testID="detail-not-for-me">
                    <Text style={styles.linkAction}>Not for me</Text>
                  </Pressable>
                ) : null}
                {/* Ask Mila about THIS deal (AGENT_V3 + AGENT_DEALS_TOOLS; draws nothing otherwise). */}
                <AskMilaAboutDeal opportunityId={opportunityId} brandName={item.brand.name} textStyle={styles.linkAction} />
              </View>
              <Text style={styles.safety}>Nothing goes out until you tap Send.</Text>
            </View>
          ) : (
          <>
          {/* ONE primary action; secondaries visually subordinate. */}
          <Pressable style={emphasis === "primary" ? styles.primary : styles.demoted} onPress={runPrimary} disabled={busy} accessibilityRole="button" testID="detail-action">
            <Text style={emphasis === "primary" ? styles.primaryT : styles.demotedT}>{data.primary.label}</Text>
          </Pressable>
          {secondaries.length || askMilaAboutDealEnabled() ? (
            <View style={styles.secondaries}>
              {secondaries.map((s) => (
                <Pressable key={s.action} onPress={() => runSecondary(s.action)} hitSlop={8} disabled={busy} accessibilityRole="button" style={styles.secondaryPill}>
                  <Text style={styles.secondaryPillT}>{s.label}</Text>
                </Pressable>
              ))}
              {/* Ask Mila about THIS deal (AGENT_V3 + AGENT_DEALS_TOOLS; draws nothing otherwise). */}
              <AskMilaAboutDeal opportunityId={opportunityId} brandName={data.item.brand.name} textStyle={styles.secondaryT} />
            </View>
          ) : null}
          <Text style={styles.safety}>Nothing goes out until you tap Send.</Text>
          </>
          )}

          {!readOnly && !v2Actions && data.draft && data.primary.action !== "decline" ? (
            <View style={styles.draft}>
              <View style={styles.draftHead}><Text style={styles.eyebrow}>Nomila’s draft</Text><Text style={styles.caption}>editable</Text></View>
              <Text style={styles.draftT}>{data.draft}</Text>
            </View>
          ) : null}

          {brandPage?.sections[0]?.paperwork.length ? (
            <View style={styles.block}>
              <Text style={styles.eyebrow}>{timelineTitle(brandPage.sections[0].paperwork)}</Text>
              {brandPage.sections[0].paperwork.map((r) => (
                <View key={r.thread_id} style={{ gap: 2 }}>
                  <Text style={styles.rowT}>{`${r.label} · ${fmtDate(r.at) ?? ""}`}</Text>
                  {r.files.map((f) => (
                    <Pressable key={`${f.message_id}-${f.index}`} onPress={() => openFile(brandPage.sections[0], f)} hitSlop={6} accessibilityRole="link">
                      <Text style={styles.link} numberOfLines={1}>{f.filename}</Text>
                    </Pressable>
                  ))}
                </View>
              ))}
            </View>
          ) : null}

          {brandPage?.sections[0]?.conversation?.chains.filter((c) => !c.main).map((c) => (
            <View key={c.chain_id} style={{ gap: 4 }}>
              <Text style={styles.caption}>
                {`Another email chain folded in · ${c.message_count} message${c.message_count === 1 ? "" : "s"} from ${fmtDate(c.first_at) ?? "—"}${c.first_direction === "outbound" ? " · you wrote first" : ""}`}
              </Text>
              <Pressable onPress={() => splitSection(brandPage.sections[0], c.chain_id)} hitSlop={6} accessibilityRole="button">
                <Text style={styles.link}>This is a separate deal</Text>
              </Pressable>
            </View>
          ))}

          {data.lead_thread_id ? (
            <Pressable style={styles.row} onPress={() => onOpenThread(data.lead_thread_id!, item.brand.name)} accessibilityRole="button">
              <Feather name="message-circle" size={18} color={Bold.ink2} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowT}>Conversation</Text>
                <Text style={styles.caption}>{`${item.message_count} message${item.message_count === 1 ? "" : "s"} · last ${fmtDate(item.last_activity_at) ?? "—"} · read live from your inbox`}</Text>
              </View>
              <Feather name="chevron-right" size={18} color={Bold.quiet} />
            </Pressable>
          ) : null}
        </View>
        )}
      </ScrollView>

      {reading ? (
        <AddContractSheet
          visible
          dealId={reading.dealId}
          attachment={{ messageId: reading.messageId, index: reading.index }}
          onClose={() => setReading(null)}
          onCreated={() => { setReading(null); void refresh(); }}
        />
      ) : null}

      {OPPS_V2 && reply && data.lead_deal_id ? (
        <ReplySheet
          dealId={data.lead_deal_id}
          threadId={data.lead_thread_id}
          brandName={item.brand.name}
          dealType={item.dealType}
          actions={item.actions ?? []}
          terms={item.terms}
          initialIntent={reply}
          seededDraft={data.draft}
          onClose={() => setReply(null)}
          onSent={() => { void refresh(); }}
        />
      ) : null}

      {OPPS_V2 && notForMe && data.lead_deal_id ? (
        <NotForMeSheet
          dealId={data.lead_deal_id}
          threadId={data.lead_thread_id}
          brandName={item.brand.name}
          onClose={() => setNotForMe(false)}
          onClosed={(undone) => { void refresh(); if (!undone) onBack(); }}
        />
      ) : null}

      {sheet && deal ? (
        <DealActionSheet
          deal={deal}
          mode={sheet}
          onClose={() => setSheet(null)}
          {...(data.draft ? { seededDraft: data.draft, disableGenerate: true } : {})}
          onSend={async (body: string) => {
            try {
              if (!deal.threadId) throw new Error("This opportunity has no email thread to reply on.");
              // Governed: propose a send_reply on the visible body, then approve it. Sending never changes status.
              await proposeAndApproveReply({ dealId: deal.id, threadId: deal.threadId, body });
            } catch (err: any) {
              Alert.alert("Couldn’t send reply", sendErrorMessage(err));
              return; // keep the sheet open so the draft isn't lost
            }
            setSheet(null);
            await refresh();
          }}
        />
      ) : null}
    </SafeAreaView>
  );
}

/** Why the prompt is showing, in plain words, from the evidence kinds (never email text). */
export function signedWhy(d: Pick<OpportunityDetail, "signed_evidence">): string {
  const kinds = new Set(d.signed_evidence.map((e) => e.kind));
  if (kinds.has("paperwork") || kinds.has("legacy_esign")) return "An e-signature email says every party has signed.";
  if (kinds.has("attachment")) return "A signed copy of the agreement arrived by email.";
  return "The conversation reads like a signed agreement.";
}

const styles = StyleSheet.create({
  root:        { flex: 1, backgroundColor: Bold.paper },
  center:      { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  muted:       { fontFamily: Fonts.body, fontSize: 14, color: Bold.mute },
  link:        { fontFamily: Fonts.bodySemiBold, fontSize: 14, color: Bold.blue },
  letter:      { marginTop: -Bold.deck.overlap, backgroundColor: Bold.paper, borderTopLeftRadius: 10, borderTopRightRadius: 10, paddingHorizontal: Bold.gutter, paddingTop: 16, gap: 16 },
  meta:        { fontFamily: Fonts.body, fontSize: 12, color: Bold.mute },
  newBlock:    { borderLeftWidth: 3, borderLeftColor: Bold.ink, paddingLeft: 10, gap: 4 },
  newHead:     { flexDirection: "row", alignItems: "center", gap: 7 },
  newDot:      { width: 7, height: 7, borderRadius: 4, backgroundColor: Bold.blue },
  signed:      { borderWidth: 1.5, borderColor: Bold.ink, borderRadius: Bold.radius.card, padding: 12, gap: 8 },
  signedHead:  { flexDirection: "row", alignItems: "center", gap: 8 },
  signedT:     { fontFamily: Fonts.bodyBold, fontSize: 15, color: Bold.ink },
  pair:        { flexDirection: "row", gap: 8 },
  smallBtn:    { flex: 1, height: Bold.buttonSmall, borderRadius: Bold.radius.pill, borderWidth: 1.5, borderColor: Bold.ink, alignItems: "center", justifyContent: "center" },
  smallBtnDark:{ backgroundColor: Bold.act, borderColor: Bold.act },
  smallBtnT:   { fontFamily: "Outfit_800ExtraBold", fontSize: 12, letterSpacing: 0.9, textTransform: "uppercase", color: Bold.ink },
  smallBtnDarkT:{ fontFamily: "Outfit_800ExtraBold", fontSize: 12, letterSpacing: 0.9, textTransform: "uppercase", color: Bold.onAct },
  terms:       { fontFamily: "Outfit_900Black", fontSize: 20, lineHeight: 23, color: Bold.ink },
  chips:       { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip:        { borderWidth: 1.5, borderColor: Bold.ink, borderRadius: Bold.radius.chip, paddingHorizontal: 7, paddingVertical: 4 },
  chipDark:    { backgroundColor: Bold.ink },
  chipBlue:    { backgroundColor: Bold.blue, borderColor: Bold.blue },
  chipDashed:  { borderStyle: "dashed", borderColor: Bold.quiet },
  chipT:       { fontFamily: "Outfit_900Black", fontSize: 10, letterSpacing: 0.8, textTransform: "uppercase", color: Bold.ink },
  hold:        { flexDirection: "row", gap: 8, borderWidth: 1.5, borderStyle: "dashed", borderColor: "#8A5A00", borderRadius: Bold.radius.card, padding: 10 },
  holdT:       { flex: 1, fontFamily: Fonts.bodySemiBold, fontSize: 13, color: "#8A5A00" },
  block:       { gap: 6 },
  h4:          { fontFamily: Fonts.bodyBold, fontSize: 16, color: Bold.ink },
  eyebrow:     { fontFamily: "Outfit_900Black", fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", color: Bold.mute },
  what:        { fontFamily: Fonts.bodyMedium, fontSize: 16, lineHeight: 22, color: Bold.ink },
  body:        { fontFamily: Fonts.body, fontSize: 15, lineHeight: 21, color: Bold.ink },
  caption:     { fontFamily: Fonts.body, fontSize: 12, color: Bold.mute },
  reason:      { flexDirection: "row", gap: 8 },
  primary:     { height: Bold.button, borderRadius: Bold.radius.pill, backgroundColor: Bold.act, alignItems: "center", justifyContent: "center" },
  primaryT:    { fontFamily: "Outfit_900Black", fontSize: 15, letterSpacing: 1, textTransform: "uppercase", color: Bold.onAct },
  // DESIGN.md §11 Button "secondary": white, 2px black line — the action while "Yes, it’s signed" is the primary.
  demoted:     { height: Bold.button, borderRadius: Bold.radius.pill, borderWidth: 2, borderColor: Bold.ink, backgroundColor: Bold.paper, alignItems: "center", justifyContent: "center" },
  demotedT:    { fontFamily: "Outfit_900Black", fontSize: 15, letterSpacing: 1, textTransform: "uppercase", color: Bold.ink },
  secondaries: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: 12, marginTop: -4 },
  // A secondary action: the soft grey pill (the one look), never a second raspberry.
  secondaryPill: { height: Bold.buttonSmall, paddingHorizontal: 16, borderRadius: Bold.radius.pill, backgroundColor: Bold.ground, alignItems: "center", justifyContent: "center" },
  secondaryPillT: { fontFamily: "Outfit_800ExtraBold", fontSize: 12, letterSpacing: 0.9, textTransform: "uppercase", color: Bold.ink },
  secondaryT:  { fontFamily: Fonts.bodySemiBold, fontSize: 14, color: Bold.ink2, textDecorationLine: "underline" },
  // OPPS_V2: the type's actions — the primary, an outlined secondary, then blue links (DESIGN.md §11 Button "link").
  v2Actions:   { gap: 10 },
  linkAction:  { ...BoldType.link, color: Bold.blue },
  closedRow:   { gap: 6 },
  safety:      { fontFamily: Fonts.body, fontSize: 12, color: Bold.mute, textAlign: "center", marginTop: -6 },
  draft:       { backgroundColor: Bold.ground, borderRadius: Bold.radius.card, padding: 12, gap: 8 },
  draftHead:   { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  draftT:      { fontFamily: Fonts.body, fontSize: 15, lineHeight: 21, color: Bold.ink },
  row:         { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.card, padding: 12 },
  rowT:        { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: Bold.ink },
});
