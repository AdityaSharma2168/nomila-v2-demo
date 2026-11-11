/**
 * GoalCards — the Goals tab's cards (AGENT_V3 + the server's AGENT_PLAN), promoted from the approved prototype
 * (draft PR #900, client/screens/prototypes/GoalsTabScreen + Atmosphere), drawn over GET /me/agent/goals.
 *
 *   FullGoalCard      the open goal: "Goal 1 of 3" over the 2px rule (category at the right), the image band with the
 *                     category and horizon chips, the goal line (quoted only when the wording is hers), the game plan,
 *                     this week's actions (each with its one button), and Change · Set aside · Drop at the foot
 *   CompactGoalCard   a folded goal: image, goal line, horizon chip, the next action. A tap ANYWHERE opens it
 *   ActionRow         one action: its mark (a platform's or a brand's logo through LogoMark), the title, "Before <event>
 *                     on <date>", the button. The whole row opens the item; the button does the same
 *   PostActionRow     a post action with its idea (design "Goals tab post details + plan ready", 12 Oct 2026): format ·
 *                     moment (else pillar), the opening line, one button into the kit (Build it when there is none) and
 *                     the kit's state. A tap anywhere else opens the idea in place (what it shows, the caption's angle,
 *                     what to leave out, what media it needs, why now, Open post kit); one open at a time. The owner
 *                     made post rows the exception to "the whole row opens the item" (12 Oct). A post with no idea on
 *                     file (written before plan 1.3.0) keeps ActionRow
 *   RecommendedCard   the rail's card: image, chips (category, horizon, and "Once" or what repeats it), goal, why; Keep /
 *                     Not now keep their own targets; a tap elsewhere opens the game plan and the actions held for it in
 *                     place (each with its opening line or title and when; read only until the goal is kept)
 *   GoalEditor        the words and the horizon (This month · This quarter · This year), for Add a goal and Change
 *   SetAsideRow       a set-aside goal with Bring back
 *
 * DESIGN.md §11 "The whole card is the target": a card opens or expands on a tap anywhere; distinct buttons (the action's
 * button, Keep, Not now, Bring back) keep their own targets. Upside / risk never appears here.
 */
import React, { useEffect, useState } from "react";
import { View, Text, Pressable, TextInput, StyleSheet, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { GoalVisual } from "../strategy/GoalVisual";
import { Button, Card, Chip, Eyebrow, IconTile, LinkText, LogoMark, RuledHead } from "../ui";
import { Photo } from "../ui/Photo";
import { Bold, BoldType } from "../../constants/theme";
import { goalText } from "../../lib/strategyLogic";
import {
  actionMarkOf, actionMeta, categoryLabel, categoryOf, eventDateWords, HORIZON_CHOICES, horizonLabel, kitMediaLine, POST_ROW_COPY, postButton,
  postEyebrow, postHookLine, postRowStallAt, postRowState, postStatus, repeatsLabel, type GoalImage, type PostRowState,
} from "../../lib/agent/goalsLogic";
import { usePostKit } from "../../lib/agent/hooks";
import { isVideoFormat, previewStateOf } from "../postKit/preview";
import type { GoalActionView, GoalsPlanningView, GoalView, RecommendedGoalView } from "../../../shared/plan";
import type { PostFormat } from "../../../shared/postKit";
import type { GoalHorizon } from "../../../shared/agent";

export const GOAL_CARD_COPY = {
  gamePlan: "Game plan",
  thisWeek: "This week",
  next: "Next",
  nothingThisWeek: "Nothing to do this week.",
  goalN: (i: number, n: number) => `Goal ${i} of ${n}`,
  keep: "Keep",
  notNow: "Not now",
  done: "Done",
  change: "Change",
  setAside: "Set aside",
  drop: "Drop",
  bringBack: "Bring back",
  save: "Save",
  cancel: "Cancel",
  wordsLabel: "Your goal, in your words",
  wordsPlaceholder: "What do you want?",
  byWhen: "By when?",
} as const;

const REC_CARD_W = 236;

/** An action's leading mark: the platform's or the brand's logo (the brand-logo chain, initials last), or nothing. */
export function ActionMark({ a }: { a: GoalActionView }) {
  const m = actionMarkOf(a);
  if (!m) return null;
  if ("platform" in m) return <LogoMark bold platform={m.platform} name={m.platform} size={36} testID={`action-mark-${a.id}`} />;
  return <LogoMark bold name={m.brand} size={36} testID={`action-mark-${a.id}`} />;
}

/** One action: the whole row opens it (DESIGN.md §11); its one button does the same. A done action is a quiet line. */
/** `main`: the goal's next action, whose button is the card's ONE raspberry action; the rest stay outlined. */
export function ActionRow({ a, label, last, main, onOpen }: { a: GoalActionView; label?: string; last?: boolean; main?: boolean; onOpen: (a: GoalActionView) => void }) {
  const meta = actionMeta(a);
  const done = a.state === "done";
  const body = (
    <>
      <ActionMark a={a} />
      <View style={styles.actionText}>
        {label ? <Eyebrow>{label}</Eyebrow> : null}
        <Text style={[styles.actionTitle, done && styles.actionDone]}>{a.title}</Text>
        {meta ? <Text style={styles.actionMeta}>{meta}</Text> : null}
      </View>
      {done ? null : <Button bold={main ? "smallAct" : "small"} onPress={() => onOpen(a)} accessibilityLabel={`${a.buttonLabel}: ${a.title}`} testID={`goal-action-button-${a.id}`}>{a.buttonLabel}</Button>}
    </>
  );
  if (done) return <View style={[styles.action, last && styles.actionLast]} testID={`goal-action-${a.id}`}>{body}</View>;
  return (
    <Pressable onPress={() => onOpen(a)} accessibilityRole="button" accessibilityLabel={[a.title, meta].filter(Boolean).join(". ")} style={({ pressed }) => [styles.action, last && styles.actionLast, pressed && styles.rowPressed]} testID={`goal-action-${a.id}`}>
      {body}
    </Pressable>
  );
}

/** What the post rows on a goal card share: the plan run in progress, which one is open, and where its buttons go. */
export interface PostRowHandlers {
  planning: GoalsPlanningView | null;
  /** The one post opened in place on the screen, if any. */
  openId: string | null;
  /** The post whose "Build it" is in flight. */
  buildingId: string | null;
  toggle: (a: GoalActionView) => void;
  openKit: (a: GoalActionView) => void;
  build: (a: GoalActionView) => void;
  talk: (a: GoalActionView) => void;
  /**
   * DESIGN.md §9: at most two faces on a screen. The opened post's kit picture may show her, so it is drawn only while
   * the screen has room (the goal cards' own photos of her count first).
   */
  thumbAllowed: boolean;
}

type FeatherName = React.ComponentProps<typeof Feather>["name"];
const FORMAT_ICON: Record<PostFormat, FeatherName> = { reel: "film", carousel: "copy", story: "disc", feed: "image" };

/** postRowState, kept current: a preparing row turns to "Preview didn't come out" at its stall deadline. */
function usePostRowState(a: GoalActionView, planning: GoalsPlanningView | null): PostRowState {
  const [, tick] = useState(0);
  const stallAt = postRowStallAt(a);
  useEffect(() => {
    if (stallAt === null) return;
    const left = stallAt - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), left + 50);
    return () => clearTimeout(t);
  }, [stallAt]);
  return postRowState(a, planning);
}

function PostStatusLine({ a, state }: { a: GoalActionView; state: PostRowState }) {
  const st = postStatus(a, state);
  return (
    <View style={styles.postStatus} testID={`goal-post-status-${a.id}`}>
      {st.spinner ? <ActivityIndicator size="small" color={Bold.mute} style={styles.postSpinner} /> : null}
      <Text style={styles.actionMeta}>
        <Text style={st.waiting ? styles.postWaiting : undefined}>{st.text}</Text>
        {st.date ? ` · ${st.date}` : ""}
      </Text>
    </View>
  );
}

/**
 * A post action as its idea: format · moment (else pillar), the opening line, its kit's button and state. A tap anywhere
 * else opens the idea in place; the button keeps its own target (the kit, or Build it: a tap, nothing goes out).
 */
export function PostActionRow({ a, last, h, label, main }: { a: GoalActionView; last?: boolean; h: PostRowHandlers; label?: string; main?: boolean }) {
  const state = usePostRowState(a, h.planning);
  const done = state === "done";
  const open = !done && h.openId === a.id;
  const button = postButton(state);
  const building = h.buildingId === a.id;
  const eyebrow = postEyebrow(a);
  const hook = postHookLine(a.post!.hook);
  const press = () => (button?.build ? h.build(a) : h.openKit(a));
  const head = (
    <>
      <IconTile icon={FORMAT_ICON[a.post!.format] ?? "image"} bold="grey" size={36} testID={`goal-post-format-${a.id}`} />
      <View style={styles.postText}>
        {label ? <Eyebrow>{label}</Eyebrow> : null}
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <Text style={[styles.actionTitle, done && styles.actionDone]}>{hook}</Text>
        {open || !button ? <PostStatusLine a={a} state={state} /> : (
          <View style={styles.postFoot}>
            <Button bold={main ? "smallAct" : "small"} onPress={press} disabled={button.disabled} loading={building} accessibilityLabel={`${button.label}: ${a.post!.hook}`} testID={`goal-post-button-${a.id}`}>{button.label}</Button>
            <PostStatusLine a={a} state={state} />
          </View>
        )}
      </View>
      {done ? null : <Feather name={open ? "chevron-up" : "chevron-down"} size={16} color={open ? Bold.ink : Bold.quiet} style={styles.postChevron} />}
    </>
  );
  return (
    <View style={[styles.post, (last || open) && styles.actionLast]} testID={`goal-post-${a.id}`}>
      {done ? <View style={styles.postHead}>{head}</View> : (
        <Pressable onPress={() => h.toggle(a)} accessibilityRole="button" accessibilityState={{ expanded: open }}
          accessibilityLabel={[label, eyebrow, a.post!.hook, postStatus(a, state).text].filter(Boolean).join(". ")}
          // The row's own button (Open kit / Build it) as an action on the row, so a screen reader reaches it without
          // leaving the row; "activate" opens or closes the idea in place.
          accessibilityActions={button && !button.disabled ? [{ name: "activate" }, { name: "kit", label: button.label }] : [{ name: "activate" }]}
          onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === "kit") press(); else h.toggle(a); }}
          style={({ pressed }) => [styles.postHead, pressed && styles.rowPressed]} testID={`goal-post-toggle-${a.id}`}>
          {head}
        </Pressable>
      )}
      {open ? <PostDetail a={a} state={state} building={building} onPress={press} onTalk={() => h.talk(a)} last={last} thumb={h.thumbAllowed} /> : null}
    </View>
  );
}

/** The opened post: its picture (only here: at most one on the screen), the idea in sections, then the kit's button. */
function PostDetail({ a, state, building, onPress, onTalk, last, thumb }: { a: GoalActionView; state: PostRowState; building: boolean; onPress: () => void; onTalk: () => void; last?: boolean; thumb: boolean }) {
  const post = a.post!;
  const button = postButton(state);
  const sections = ([
    [POST_ROW_COPY.shows, post.show], [POST_ROW_COPY.caption, post.captionAngle], [POST_ROW_COPY.avoid, post.avoid],
    [POST_ROW_COPY.need, post.mediaNeeds], [POST_ROW_COPY.whyNow, a.why],
  ] as Array<[string, string]>).filter(([, t]) => !!t?.trim());
  const pillar = a.pillar?.name?.trim();
  return (
    <View style={[styles.postDetail, last && styles.actionLast]} testID={`goal-post-detail-${a.id}`}>
      {thumb && a.kit && a.kit.assets > 0 ? <KitThumb id={a.id} format={post.format} /> : null}
      {sections.map(([label, text]) => (
        <View key={label} style={styles.postSection}>
          <Eyebrow>{label}</Eyebrow>
          <Text style={styles.postBody}>{text}</Text>
        </View>
      ))}
      {pillar || a.event ? (
        <View style={styles.chips}>
          {pillar ? <Chip bold="line">{pillar}</Chip> : null}
          {a.event ? <Chip bold="line">{`${a.event.label} · ${eventDateWords(a.event.date, a.event.precision)}`}</Chip> : null}
        </View>
      ) : null}
      {button ? (
        <Button bold="primary" onPress={onPress} disabled={button.disabled} loading={building} testID={`goal-post-open-${a.id}`}
          icon={button.build ? undefined : <Feather name="arrow-right" size={14} color={Bold.onDark} />}>
          {button.build ? POST_ROW_COPY.build : POST_ROW_COPY.openPostKit}
        </Button>
      ) : null}
      <LinkText arrow={false} onPress={onTalk} testID={`goal-post-talk-${a.id}`}>{POST_ROW_COPY.talk}</LinkText>
    </View>
  );
}

/**
 * The opened post's picture: the preview's cover when it is ready, else the first asset the kit picked. Read through the
 * kit's own query (AGENT_KEYS.postKit), so the kit screen then opens at once.
 */
function KitThumb({ id, format }: { id: string; format: PostFormat }) {
  const q = usePostKit(id);
  const kit = q.data ?? null;
  if (!kit) return null;
  const ready = previewStateOf(kit) === "ready";
  const first = kit.media.find((m) => m.inKit && m.available);
  const uri = (ready ? kit.preview?.coverUrl : null) ?? first?.thumbUrl ?? null;
  const line = kitMediaLine(kit.media);
  if (!uri && !line) return null;
  return (
    <View style={styles.thumbRow} testID={`goal-post-thumb-${id}`}>
      <View style={styles.thumb}>
        {uri ? <Photo uri={uri} cacheKey={ready ? `${id}:cover` : first?.assetId ?? null} style={StyleSheet.absoluteFill} /> : null}
        {isVideoFormat(format) ? <Feather name="play" size={20} color={Bold.onDark} /> : null}
      </View>
      <View style={styles.postSection}>
        <Eyebrow>{ready ? POST_ROW_COPY.yourPreview : POST_ROW_COPY.yourKit}</Eyebrow>
        {line ? <Text style={styles.actionMeta}>{line}</Text> : null}
      </View>
    </View>
  );
}

function Chips({ domain, horizon, repeats }: { domain: string | null; horizon: string | null; repeats?: string | null }) {
  const cat = categoryLabel(domain);
  return (
    <View style={styles.chips}>
      {cat ? <Chip bold="light">{cat}</Chip> : null}
      {horizon ? <Chip bold="line">{horizon}</Chip> : null}
      {repeats ? <Chip bold="line">{repeats}</Chip> : null}
    </View>
  );
}

/** One action held for a recommendation: its opening line (a post) or title, and when. Read only until it is kept. */
function HeldActionRow({ a }: { a: GoalActionView }) {
  const meta = actionMeta(a);
  return (
    <View style={styles.heldRow} testID={`goal-recommended-action-${a.id}`}>
      <Text style={styles.recPlanText}>{a.post ? postHookLine(a.post.hook) : a.title}</Text>
      {meta ? <Text style={styles.actionMeta}>{meta}</Text> : null}
    </View>
  );
}

const lineOf = (g: Pick<GoalView, "text" | "inYourWords">) => goalText({ text: g.text, quoted: g.inYourWords });

/** The open goal, in full. */
export function FullGoalCard({ g, index, total, img, onAction, posts, onChange, onSetAside, onDrop, busy }: {
  g: GoalView; index: number; total: number; img: GoalImage;
  onAction: (a: GoalActionView) => void; posts: PostRowHandlers; onChange: () => void; onSetAside: () => void; onDrop: () => void; busy?: boolean;
}) {
  const horizon = horizonLabel(g.horizon);
  // The open goal's ONE raspberry action: its next undone one.
  const mainId = g.actions.find((a) => a.state !== "done")?.id;
  return (
    <Card bold style={styles.card} testID={`goal-card-${g.id}`}>
      <RuledHead title={GOAL_CARD_COPY.goalN(index + 1, total)} right={<Text style={styles.headDomain}>{categoryLabel(g.domain)}</Text>} style={styles.cardHead} />
      <View>
        <GoalVisual imagery={img.imagery} domain={categoryOf(g.domain) ?? ""} height={150} card style={styles.visual}><Chips domain={g.domain} horizon={horizon} /></GoalVisual>
      </View>
      <Text style={styles.goalText} accessibilityRole="header">{lineOf(g)}</Text>
      {g.plan ? (
        <View style={styles.plan}>
          <Eyebrow>{GOAL_CARD_COPY.gamePlan}</Eyebrow>
          <Text style={styles.planText}>{g.plan}</Text>
        </View>
      ) : null}
      <View style={styles.week}>
        <Eyebrow style={styles.weekHead}>{GOAL_CARD_COPY.thisWeek}</Eyebrow>
        {g.actions.length
          ? g.actions.map((a, i) => (a.post
            ? <PostActionRow key={a.id} a={a} last={i === g.actions.length - 1} h={posts} main={a.id === mainId} />
            : <ActionRow key={a.id} a={a} last={i === g.actions.length - 1} main={a.id === mainId} onOpen={onAction} />))
          : <Text style={styles.nothing}>{GOAL_CARD_COPY.nothingThisWeek}</Text>}
      </View>
      <View style={styles.manage}>
        <QuietLink label={GOAL_CARD_COPY.change} onPress={onChange} disabled={busy} testID={`goal-change-${g.id}`} />
        <QuietLink label={GOAL_CARD_COPY.setAside} onPress={onSetAside} disabled={busy} testID={`goal-set-aside-${g.id}`} />
        <QuietLink label={GOAL_CARD_COPY.drop} onPress={onDrop} disabled={busy} testID={`goal-drop-${g.id}`} />
      </View>
    </Card>
  );
}

function QuietLink({ label, onPress, disabled, testID }: { label: string; onPress: () => void; disabled?: boolean; testID?: string }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} hitSlop={8} testID={testID}>
      <Text style={styles.quietLink}>{label}</Text>
    </Pressable>
  );
}

/** A goal folded: an image, the goal line, the horizon chip and the next action; a tap anywhere opens it. */
export function CompactGoalCard({ g, index, total, img, onExpand, onAction, posts }: {
  g: GoalView; index: number; total: number; img: GoalImage; onExpand: () => void; onAction: (a: GoalActionView) => void; posts: PostRowHandlers;
}) {
  const horizon = horizonLabel(g.horizon);
  const next = g.actions.find((a) => a.state !== "done") ?? g.actions[0];
  return (
    <Pressable onPress={onExpand} accessibilityRole="button" accessibilityState={{ expanded: false }} accessibilityLabel={`${GOAL_CARD_COPY.goalN(index + 1, total)}. ${g.text}`} testID={`goal-toggle-${g.id}`} style={({ pressed }) => [pressed && styles.pressed]}>
      <Card bold style={styles.compact} testID={`goal-card-${g.id}`}>
        <RuledHead title={GOAL_CARD_COPY.goalN(index + 1, total)} right={<Feather name="chevron-down" size={16} color={Bold.quiet} />} style={styles.cardHead} />
        <View style={styles.compactRow}>
          <View style={styles.compactImg}>
            <GoalVisual imagery={img.imagery} domain={categoryOf(g.domain) ?? ""} height={72} card style={styles.visual} />
          </View>
          <View style={styles.compactText}>
            <Text style={styles.compactGoal} numberOfLines={2}>{lineOf(g)}</Text>
            {horizon ? <View style={styles.chipRow}><Chip bold="line">{horizon}</Chip></View> : null}
          </View>
        </View>
        {next
          ? <View style={styles.compactNext}>{next.post
            // A folded goal's post is never opened here: a tap opens the goal with this post open.
            ? <PostActionRow a={next} label={GOAL_CARD_COPY.next} last h={{ ...posts, openId: null, toggle: (a) => { onExpand(); posts.toggle(a); } }} />
            : <ActionRow a={next} label={GOAL_CARD_COPY.next} last onOpen={onAction} />}</View>
          : <Text style={[styles.nothing, styles.compactNothing]}>{GOAL_CARD_COPY.nothingThisWeek}</Text>}
      </Card>
    </Pressable>
  );
}

/** A recommended goal on the rail. Keep / Not now are its own buttons; a tap elsewhere opens its game plan in place. */
export function RecommendedCard({ r, img, open, onToggle, onKeep, onSkip, busy }: {
  r: RecommendedGoalView; img: GoalImage; open: boolean; onToggle: () => void; onKeep: () => void; onSkip: () => void; busy?: boolean;
}) {
  return (
    <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={r.goal} style={({ pressed }) => [pressed && styles.pressed]} testID={`goal-recommended-open-${r.decisionId}`}>
      <Card bold style={styles.recCard} testID={`goal-recommended-${r.decisionId}`}>
        <View>
          <GoalVisual imagery={img.imagery} domain={categoryOf(r.domain) ?? ""} height={110} card style={styles.visual}>
            <Chips domain={r.domain} horizon={horizonLabel(r.horizon)} repeats={repeatsLabel(r.repeats)} />
          </GoalVisual>
        </View>
        <View style={styles.recBody}>
          <Text style={styles.recText}>{r.goal}</Text>
          {r.why ? <Text style={styles.recWhy}>{r.why}</Text> : null}
          {open && r.gamePlan ? (
            <View style={styles.recPlan} testID={`goal-recommended-plan-${r.decisionId}`}>
              <Eyebrow>{GOAL_CARD_COPY.gamePlan}</Eyebrow>
              <Text style={styles.recPlanText}>{r.gamePlan}</Text>
            </View>
          ) : null}
          {open && r.actions.length ? (
            <View style={styles.recPlan} testID={`goal-recommended-actions-${r.decisionId}`}>
              <Eyebrow>{GOAL_CARD_COPY.thisWeek}</Eyebrow>
              {r.actions.map((a) => <HeldActionRow key={a.id} a={a} />)}
            </View>
          ) : null}
          <View style={styles.recActions}>
            <Button bold="small" onPress={onKeep} disabled={busy} testID={`goal-keep-${r.decisionId}`}>{GOAL_CARD_COPY.keep}</Button>
            <Pressable onPress={onSkip} disabled={busy} accessibilityRole="button" hitSlop={8} testID={`goal-skip-${r.decisionId}`}><Text style={styles.notNow}>{GOAL_CARD_COPY.notNow}</Text></Pressable>
          </View>
        </View>
      </Card>
    </Pressable>
  );
}

/** The words and the horizon: Add a goal and Change. */
export function GoalEditor({ initialText = "", initialHorizon = null, onSave, onCancel, busy, testID }: {
  initialText?: string; initialHorizon?: GoalHorizon | null; onSave: (text: string, horizon: GoalHorizon | null) => void; onCancel: () => void; busy?: boolean; testID?: string;
}) {
  const [text, setText] = useState(initialText);
  const [horizon, setHorizon] = useState<GoalHorizon | null>(initialHorizon);
  const ok = text.trim().length > 0;
  return (
    <Card bold style={styles.editor} testID={testID ?? "goal-editor"}>
      <Eyebrow>{GOAL_CARD_COPY.wordsLabel}</Eyebrow>
      <TextInput value={text} onChangeText={setText} placeholder={GOAL_CARD_COPY.wordsPlaceholder} placeholderTextColor={Bold.quiet} multiline maxLength={300} style={styles.input} accessibilityLabel={GOAL_CARD_COPY.wordsLabel} testID="goal-editor-text" />
      <Eyebrow>{GOAL_CARD_COPY.byWhen}</Eyebrow>
      <View style={styles.choices}>
        {HORIZON_CHOICES.map((h) => {
          const on = horizon === h;
          return (
            <Pressable key={h} onPress={() => setHorizon(on ? null : h)} accessibilityRole="button" accessibilityState={{ selected: on }} style={[styles.choice, on && styles.choiceOn]} testID={`goal-editor-horizon-${h}`}>
              <Text style={[styles.choiceText, on && styles.choiceTextOn]}>{horizonLabel(h)}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.editorActions}>
        <Button bold="small" onPress={() => onSave(text.trim(), horizon)} disabled={!ok || busy} testID="goal-editor-save">{GOAL_CARD_COPY.save}</Button>
        <QuietLink label={GOAL_CARD_COPY.cancel} onPress={onCancel} testID="goal-editor-cancel" />
      </View>
    </Card>
  );
}

export function SetAsideRow({ g, last, onBringBack, busy }: { g: GoalView; last: boolean; onBringBack: () => void; busy?: boolean }) {
  const horizon = horizonLabel(g.horizon);
  return (
    <View style={[styles.setAside, last && styles.actionLast]} testID={`goal-set-aside-row-${g.id}`}>
      <View style={styles.actionText}>
        <Text style={styles.actionTitle}>{lineOf(g)}</Text>
        {horizon ? <Text style={styles.actionMeta}>{horizon}</Text> : null}
      </View>
      <Button bold="small" onPress={onBringBack} disabled={busy} testID={`goal-bring-back-${g.id}`}>{GOAL_CARD_COPY.bringBack}</Button>
    </View>
  );
}

export const GOAL_REC_CARD_W = REC_CARD_W;

const styles = StyleSheet.create({
  card:          { marginHorizontal: Bold.gutter, marginTop: 28, borderColor: Bold.quiet },
  compact:       { marginHorizontal: Bold.gutter, marginTop: 16, borderColor: Bold.quiet },
  cardHead:      { marginHorizontal: 14, marginTop: 12, marginBottom: 10 },
  headDomain:    { ...BoldType.caption, color: Bold.mute },
  visual:        { borderRadius: 0 },
  chips:         { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chipRow:       { flexDirection: "row" },
  goalText:      { ...BoldType.goal, color: Bold.ink, paddingHorizontal: 14, paddingTop: 12 },
  plan:          { paddingHorizontal: 14, paddingTop: 10, gap: 4 },
  planText:      { ...BoldType.body, color: Bold.ink2 },
  week:          { marginTop: 12, borderTopWidth: 1, borderTopColor: Bold.line },
  weekHead:      { paddingHorizontal: 14, paddingTop: 12 },
  action:        { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Bold.line },
  actionLast:    { borderBottomWidth: 0 },
  actionText:    { flex: 1, minWidth: 0, gap: 2 },
  actionTitle:   { ...BoldType.rowTitle, color: Bold.ink },
  actionDone:    { color: Bold.mute, textDecorationLine: "line-through" },
  actionMeta:    { ...BoldType.caption, color: Bold.mute },
  nothing:       { ...BoldType.rowMeta, color: Bold.mute, paddingHorizontal: 14, paddingTop: 6, paddingBottom: 14 },
  compactNothing: { paddingTop: 12 },
  manage:        { flexDirection: "row", gap: 20, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1, borderTopColor: Bold.line },
  quietLink:     { ...BoldType.buttonSmall, color: Bold.mute },
  compactRow:    { flexDirection: "row", gap: 12, paddingHorizontal: 14, alignItems: "flex-start" },
  compactImg:    { width: 96, height: 72, borderRadius: Bold.radius.control, overflow: "hidden" },
  compactText:   { flex: 1, minWidth: 0, gap: 6 },
  compactGoal:   { ...BoldType.goalSm, color: Bold.ink },
  compactNext:   { marginTop: 10, borderTopWidth: 1, borderTopColor: Bold.line },
  recCard:       { width: REC_CARD_W },
  recBody:       { padding: 14, gap: 6 },
  recText:       { ...BoldType.goalSm, color: Bold.ink },
  recWhy:        { ...BoldType.caption, color: Bold.mute },
  recPlan:       { gap: 4, marginTop: 4 },
  recPlanText:   { ...BoldType.caption, color: Bold.ink2 },
  heldRow:       { gap: 2, paddingVertical: 4 },
  recActions:    { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 6 },
  notNow:        { ...BoldType.buttonSmall, color: Bold.mute },
  editor:        { marginHorizontal: Bold.gutter, marginTop: 14, padding: 14, gap: 10 },
  input:         { minHeight: 48, borderWidth: 1, borderColor: Bold.line, borderRadius: Bold.radius.control, padding: 12, ...BoldType.body, color: Bold.ink, textAlignVertical: "top", backgroundColor: Bold.paper },
  choices:       { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice:        { height: 36, paddingHorizontal: 14, borderRadius: Bold.radius.control, borderWidth: 1.5, borderColor: Bold.ink, alignItems: "center", justifyContent: "center", backgroundColor: Bold.paper },
  choiceOn:      { backgroundColor: Bold.ink },
  choiceText:    { ...BoldType.button, color: Bold.ink },
  choiceTextOn:  { color: Bold.onDark },
  editorActions: { flexDirection: "row", alignItems: "center", gap: 20, marginTop: 4 },
  setAside:      { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Bold.line },
  pressed:       { transform: [{ scale: Bold.pressScale }] },
  rowPressed:    { backgroundColor: Bold.ground },
  post:          { borderBottomWidth: 1, borderBottomColor: Bold.line },
  postHead:      { flexDirection: "row", alignItems: "flex-start", gap: 12, padding: 14 },
  postText:      { flex: 1, minWidth: 0, gap: 4 },
  postFoot:      { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 },
  postStatus:    { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
  postSpinner:   { width: 14, height: 14, transform: [{ scale: 0.7 }] },
  // "Kit ready": blue (it waits on her), the caption's size at the row title's weight.
  postWaiting:   { color: Bold.blue, fontFamily: BoldType.rowTitle.fontFamily, fontWeight: BoldType.rowTitle.fontWeight },
  postChevron:   { marginTop: 2 },
  postDetail:    { paddingLeft: 62, paddingRight: 14, paddingTop: 4, paddingBottom: 16, gap: 12, borderBottomWidth: 1, borderBottomColor: Bold.line },
  postSection:   { flex: 1, gap: 3 },
  postBody:      { ...BoldType.body, color: Bold.ink2 },
  thumbRow:      { flexDirection: "row", alignItems: "center", gap: 12 },
  thumb:         { width: 66, height: 88, borderRadius: Bold.radius.control, overflow: "hidden", backgroundColor: Bold.heroBlank, alignItems: "center", justifyContent: "center" },
});
