/**
 * agent/milaCards/prompts.ts — every word the model reads about the card system v2's producers: each tool's
 * description. The words are the design page's, EXACTLY ("Mila card designs" v2.2, approved 3 Nov 2026): its
 * "Model-facing" line (plus CARD_LEAD_IN, the order rule), then its "Use when" and "Don't use when" lists. Registered verbatim in the Prompt Register
 * ("Mila card system v2 producers"); a change here is a change there. The argument descriptions are ours and say only
 * what each field takes.
 */

/**
 * The one line every producer adds after the page's words: the app draws each card at its place in the reply (the
 * stream's order), so the lead-in has to come BEFORE the call for it to sit directly above its card.
 */
export const CARD_LEAD_IN = "Write the card's one-sentence lead-in first, then call this tool: the card shows right under those words.";

const block = (modelFacing: string, use: string[], dont: string[]) =>
  `${modelFacing} ${CARD_LEAD_IN}\n\nUse when:\n${use.map((l) => `- ${l}`).join("\n")}\n\nDon't use when:\n${dont.map((l) => `- ${l}`).join("\n")}`;

export const SHARE_INSIGHT_DESCRIPTION = block(
  "Show one thing that changed in the athlete's own data. Pass the fact ids and a headline of eight words or fewer. The server draws the chart and sources. Do not use it to answer a factual question, for a single deal, or for anything you cannot source.",
  [
    "A real change in their own numbers or record that Mila noticed and they didn't ask about.",
    "They ask for an insight about themselves, what they're missing, or to see it as a card: look up their facts first, then show the strongest one.",
    "It rests on stored facts or this turn's results, with at least one source.",
    "It leads somewhere: a goal, a type of brand, a next step.",
  ],
  [
    "They asked a factual question (how did X do, who, is it legit): use Answer with sources.",
    "It's about one deal or booking: use that card.",
    "There's no number or fact behind it: say it in words.",
    "It was shown in the last 14 days, or it touches a care moment.",
  ],
);

export const IDEAS_SUGGEST_DESCRIPTION = block(
  "Offer post ideas from the athlete's idea bank by their ids (one to five), when they ask what to make or a moment of theirs is close. In your text, mention only the first idea and why it fits. Never invent an idea outside the bank.",
  [
    "They ask what to post, or one of their moments is close and the bank has live ideas.",
    "2–5 live ideas → carousel; 1 → single card.",
  ],
  [
    "They already said what to make: go to Studio.",
    "A care moment, or the pillar is paused after \"Don't suggest\".",
    "It's a brand deliverable: use the Deal card.",
    "Ideas were already shown in this chat today.",
  ],
);

export const OFFER_CAPABILITY_DESCRIPTION = block(
  "Offer one capability from the registry, by key, when the athlete's words or a signal show they'd want it. The server decides whether it may be offered and writes all the words. A yes in words is not a yes: show the card.",
  [
    "They ask for something CAN DO NOW lists as off and offerable: offer it, never say you can do it.",
    "An offer signal fires and the capability is available, not core, and unset or past its cooldown.",
    "Everything it needs is connected.",
    "They say \"yes, turn it on\" in words: the card still appears, because a yes has to be a tap.",
  ],
  [
    "It's core (research, score, deal detection).",
    "It needs an account they haven't connected: Connect card first.",
    "They declined it, it's in cooldown, or another offer appeared in the last 24 h.",
  ],
);

export const ASK_ONCE_DESCRIPTION = block(
  "Ask one question, once, when the same choice comes up again and no rule covers it. Give two to four short answers, each with the rule it saves. Never ask what a rule already answers. Never offer an answer that sends, posts or pays without a tap.",
  [
    "The same kind of choice has come up a second time and no rule covers it.",
    "The answer changes what Mila does from now on.",
  ],
  [
    "A rule or fact already answers it.",
    "An option would make something go out without a tap.",
    "A deal or reply is waiting on them, or a question was already asked in this chat.",
  ],
);

/**
 * ask_once as the model sees it while GAME_DAY_SIGNALS is on (agent/events/config.ts): the rule question plus the typed
 * mode. Off, the model sees ASK_ONCE_DESCRIPTION and no typed argument at all.
 */
export const ASK_ONCE_TYPED_DESCRIPTION = block(
  "Ask one question, once, when the same choice comes up again and no rule covers it. Give two to four short answers, each with the rule it saves. Never ask what a rule already answers. Never offer an answer that sends, posts or pays without a tap. For a result only they know (a score, a time or a place), use typed with the event's F-key instead of answers: their words are saved as a fact about that event.",
  [
    "The same kind of choice has come up a second time and no rule covers it.",
    "The answer changes what Mila does from now on.",
    "An event of theirs has passed and a post about it needs a result only they know (typed).",
  ],
  [
    "A rule or fact already answers it.",
    "An option would make something go out without a tap.",
    "A deal or reply is waiting on them, or a question was already asked in this chat.",
    "The event has not happened yet, or the result is already in their facts.",
  ],
);

export const ANSWER_WITH_SOURCES_DESCRIPTION = block(
  "Answer a factual question with sources: a headline of eight words or fewer and one line. Put figures, a list or a table in 'more'. Every number and link must come from this turn's tool results. Name the brand id when it's about one brand. The server draws its logo.",
  [
    "A factual question whose answer rests on sources (web, their accounts, stored facts).",
    "It's clearer with a figure, list or side-by-side than a paragraph.",
  ],
  [
    "Small talk or opinion with nothing to cite.",
    "Nothing reliable was found: say so in words.",
    "It's about one of their deals, bookings or goals.",
    "The answer would be a retired score or rate.",
  ],
);

/** Every producer's description, by tool name (the Prompt Register entry lists these). */
export const MILA_CARD_TOOL_DESCRIPTIONS = {
  share_insight: SHARE_INSIGHT_DESCRIPTION,
  ideas_suggest: IDEAS_SUGGEST_DESCRIPTION,
  offer_capability: OFFER_CAPABILITY_DESCRIPTION,
  ask_once: ASK_ONCE_DESCRIPTION,
  answer_with_sources: ANSWER_WITH_SOURCES_DESCRIPTION,
} as const;
