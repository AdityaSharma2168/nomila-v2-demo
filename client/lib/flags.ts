/**
 * flags — client feature flags.
 *
 * Read from EXPO_PUBLIC_* (the convention already used for EXPO_PUBLIC_API_URL and
 * EXPO_PUBLIC_MICROSOFT_CLIENT_ID) so a flag is a build-time env var, not a runtime fetch.
 *
 * Every flag DEFAULTS OFF and must be opted into with the exact string "true". Nothing here is
 * enabled in production by omission — an unset or misspelled value reads as off.
 */

/**
 * THE STUDIO MASTER, CLIENT SIDE (PR 20, docs/probes/ship.md, ADI-S20-GO). Paired with the server's STUDIO_ALL_ON
 * (server/studio/studioFlag.ts), with the same rule: unset — or anything but exactly "true" — changes nothing, and every
 * Studio flag below reads exactly as it did; "true" turns every Studio flag on unless its own variable is exactly
 * "false". It never reaches IDENTITY_CLAIM, which is not Studio's.
 *
 * Each flag still reads its OWN variable by its literal name and passes the VALUE in — Expo inlines
 * `process.env.EXPO_PUBLIC_*` only as a static member access (expo/no-dynamic-env-var), so a helper that took a name and
 * looked it up would read undefined in every built bundle.
 *
 * ⚠️ MUTATIONS (flags.master.test.ts): studioFlag ignoring the master, or treating unset as on without it — the rows
 * "under the master …" / "master unset …" red by name.
 */
export const STUDIO_ALL_ON = process.env.EXPO_PUBLIC_STUDIO_ALL_ON === "true";

/** One Studio flag's value under the master: exactly "true" is on; with the master on, anything but "false" is on. */
export function studioFlag(
  value: string | undefined,
  allOn: boolean = STUDIO_ALL_ON,
): boolean {
  return value === "true" || (allOn && value !== "false");
}

/**
 * The Studio Content Engine surface: the campaign workspace and the create-flow entry points that
 * lead to it. Off in prod for Wave 1 — the tab itself, Pitches and the media library are unaffected
 * and stay live; only the generation surface is gated. Mirrors the server's studioEnabled()
 * (server/studio/config.ts), which reads STUDIO_ENABLED.
 */
export const STUDIO_ENABLED = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_ENABLED,
);

/**
 * THE ROUTING CUTOVER, CLIENT SIDE. Paired with the server's `STUDIO_SERVER_ROUTING`
 * (server/studio/config.ts) — the two halves of one switch, and both default off.
 *
 * OFF: `engineIntentFor` decides between editing a photograph and replacing one by testing her
 * sentence against its verb list, exactly as it does today. That list is why "make the socks blue"
 * replaces the frame instead of recoloring it — the sentence carries no verb it knows.
 *
 * ON: the decision comes from `POST /studio/classify`, which runs the same classifier the server
 * consults before it spends. The verb list stays reachable at this flag for one release so both can
 * be scored against the same golden set, and so the rollback is a config value rather than a
 * revert.
 */
/**
 * Phase A Step 3b — the "Is this you?" step and the athlete selection header. Pairs with the server's ATHLETE_INDEX_CLAIM:
 * with the server flag on, a signup that finds candidates answers 409 `confirmation_required`; a client WITHOUT this flag
 * treats that as a setup failure (no silent create), a client WITH it renders the candidates and lets her decide. Off by
 * default in every build.
 */
export const IDENTITY_CLAIM = process.env.EXPO_PUBLIC_IDENTITY_CLAIM === "true";

export const STUDIO_SERVER_ROUTING = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_SERVER_ROUTING,
);

/**
 * THE INTERPRETER, CLIENT SIDE (the interpreter, I.6; A10). Paired with the server's STUDIO_INTERPRETER
 * (server/studio/config.ts) — both default off, and both must be on.
 *
 * ON: an ask the server's classifier says the preview may interpret (`interpretable`) goes to the preview
 * as an edit of her marked frame, and Make it shows "Here's what we'll do" — the lines of what will run,
 * each tagged your words / our suggestion / required by the brand — with a "Not what I meant" way out.
 * OFF: an ask is exactly today's ask, and nothing on Make it changes.
 *
 * It reads the classifier's answer, so it needs STUDIO_SERVER_ROUTING too: with that off there is no answer,
 * and every sentence routes exactly as it does today.
 */
export const STUDIO_INTERPRETER = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_INTERPRETER,
);

/**
 * CREATE ANYTHING THREADS, CLIENT SIDE (session persistence plan v2 §4). Paired with the server's STUDIO_SESSIONS
 * (server/studio/config.ts) — both default off.
 *
 * ON: send opens Make it as a sheet over the thread, approving lands the result in the thread in place, any image
 * in it can be edited from the chat, and — with the server's half on too — the thread is kept: the door resumes her
 * latest one, and Threads lists them. With the server's half off it all still works, session-only, and nothing is
 * saved or said.
 * OFF: today's flow exactly — Make it and Made it as screens, and nothing kept.
 */
export const STUDIO_SESSIONS = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_SESSIONS,
);

/**
 * Her picks (docs/design/shop-her-picks.md): the My Picks door on Me and its screen. Pairs with the server's SHOP_V1 —
 * the server's routes are the real gate. Off by default in every build.
 */
export const SHOP_V1 = process.env.EXPO_PUBLIC_SHOP_V1 === "true";

/**
 * Bookings v2, her side: the Bookings section of Opportunities, her offers, requests and sessions (and, with the
 * session PR, the call and the after-session screens). Off by default; the server's BOOKINGS_ENABLED + the pilot
 * allowlist gate every route behind them, so even with this on a door appears only for a pilot athlete.
 */
export const BOOKINGS = process.env.EXPO_PUBLIC_BOOKINGS === "true";

/**
 * App layout B: "Your public card" at the top of Me and its screens (Review & publish, Preview as a visitor, Card
 * settings), over /api/v1/me/public-card. Pairs with the server's PUBLIC_CARD: while the server's flag is off its routes
 * answer 404 and the section says publishing opens soon, keeping the deck row. Off: Me shows the existing My Nomi row.
 */
export const PUBLIC_CARD = process.env.EXPO_PUBLIC_PUBLIC_CARD === "true";

/**
 * The Partner door of her public profile, her side (server: PUBLIC_CARD + PARTNER_INTAKE): the "Serious offers" section at
 * the top of the board and her Serious offer switch. The server's flags are the real gate. Off in every build.
 */
export const PARTNER_INTAKE = process.env.EXPO_PUBLIC_PARTNER_INTAKE === "true";

/**
 * "From your brands" on My Picks (the catalog-only Shopify app, docs/design/shop-her-picks.md §12). Pairs with the server's
 * SHOP_SHOPIFY_APP; needs SHOP_V1. Off by default in every build.
 */
export const SHOP_SHOPIFY_APP = SHOP_V1 && process.env.EXPO_PUBLIC_SHOP_SHOPIFY_APP === "true";

/**
 * Opportunities PR 4: the new tab root — the opportunity board (What matters · In motion · Everything else) read from
 * GET /me/opportunities, with name posters for unconfirmed brands. Off by default; the dev preview turns it on.
 */
export const OPPS_BOARD = process.env.EXPO_PUBLIC_OPPS_BOARD === "true";

/**
 * THE AGENT TAB, CLIENT SIDE. Paired with the server's STUDIO_AGENT (server/studio/config.ts
 * `agentEnabled`) — both default off.
 *
 * ON: the Board shows "or let the agent build this for you", which opens the Agent screen: she says
 * what she wants, the server plans it from her own photographs, the screen prices it with the Board's
 * own code, and "Put it on the board" hands the rows over. Nothing spends until the Board's own
 * "Make the board".
 * OFF: no door to it anywhere. The SERVER's 404 is the real gate — this only decides whether the
 * door is drawn, and a build with it on against a server with it off gets "Not found", not a plan.
 *
 * ⚠️ NOT THE RETRY. `STUDIO_AGENT_RETRY` is a separate SERVER variable and has no client half.
 */
export const STUDIO_AGENT = studioFlag(process.env.EXPO_PUBLIC_STUDIO_AGENT);

/**
 * THE BRAND POST THAT PLANS ONTO THE BOARD, CLIENT SIDE (PR 6, 6d). Paired with the server's
 * STUDIO_BRAND_PROFILES (server/studio/config.ts `brandProfilesEnabled`) and STUDIO_AGENT — all default
 * off. Only with this AND `STUDIO_AGENT` on does the brand post's last step plan (ideas, then a plan
 * from her brief) and land her on the Board; a video is the one format the Board makes.
 * OFF: today's flow exactly — brand, what it is for, and "Set it up".
 */
export const STUDIO_BRAND_PROFILES = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_BRAND_PROFILES,
);

/**
 * THE MOMENT DOOR, CLIENT SIDE (PR 7, Lane D/E). Paired with the server's STUDIO_DIRECTION_MOMENTS
 * (server/studio/config.ts `momentSearchEnabled`) — both default off, and separate from
 * STUDIO_BRAND_PROFILES because a moment is one live web search per press. Only with this AND the
 * brand post's two flags on does "Find a moment" appear on the brief step; the server's 404 is the
 * real gate.
 */
export const STUDIO_DIRECTION_MOMENTS = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_DIRECTION_MOMENTS,
);

/**
 * THE EDIT POPOVER ON THE COMPOSE PICKER, CLIENT SIDE (PR 9, Lane 3a). Paired with the server's
 * STUDIO_IMAGE_EDIT_OPS (server/studio/config.ts `imageEditOpsEnabled`) — both default off. Only with
 * this AND `STUDIO_AGENT` on does a selected photo on the Agent screen offer "change anything?" — a
 * system recommendation when her confirmed brief grounds one, and the typed ops by hand. OFF: the picker
 * exactly as before; nothing on the Board or the plan list is touched either way.
 */
export const STUDIO_IMAGE_EDIT = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_IMAGE_EDIT,
);

/**
 * READ THIS CLIP, CLIENT SIDE (PR 9.5, F22 B2). Paired with the server's STUDIO_CLIP_READ
 * (server/studio/enrich/config.ts `clipReadEnabled`) — both default off; the server also needs
 * STUDIO_VIDEO_ENRICH, since a read IS one clip's enrichment on demand. Only with this on does an
 * unread video on the Agent tray or MediaDetail offer "Read this clip · $0.0X" with its five states.
 * OFF: exactly today — the passive "added at the end, as-is" hint, and nothing quoted or spent.
 */
export const STUDIO_CLIP_READ = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_CLIP_READ,
);

/**
 * THE VERDICT CHIP, CLIENT SIDE (PR 11, R-4). Paired with the server's STUDIO_QA_DISPLAY
 * (server/studio/config.ts `qaDisplayEnabled`) — both default off, and the server's 404 is the real
 * gate. On, a generated asset's card and the full-screen viewer show flag-or-pass wording and the
 * cost; an edit's preview shows its cost. Never a score, never a threshold, never an action. OFF:
 * every surface exactly as before; the hook does not even fetch.
 */
export const STUDIO_QA_DISPLAY = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_QA_DISPLAY,
);

/**
 * THE COMPOSER, CLIENT SIDE (PR 15, docs/probes/composer.md). Paired with the server's
 * STUDIO_COMPOSER (server/studio/config.ts `composerEnabled`) — both default off. ON: every join in a
 * Board stitch is chosen by rule with a recorded reason (joinLogic) — her Cut, the beat, the music's
 * beat, the reference reading's rhythm, then today's fade; the planner's slots include composition
 * and action and every value the planner can write; a photo row names the slots it drops; and the
 * Video tab's caption editor offers a $0 suggestion from the Board's own words. OFF: every join, slot
 * and caption exactly as before — the stitch body is byte-identical.
 */
export const STUDIO_COMPOSER = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_COMPOSER,
);

/**
 * LIBRARY FIELDS ON THE PICKER, CLIENT SIDE (PR 12, docs/probes/library-fields.md). Paired with the
 * server's STUDIO_LIBRARY_FIELDS (server/studio/config.ts `libraryFieldsEnabled`) — both default off.
 * ON: every Studio picker tile carries its label (who is in it and the shot; "Not read yet" before the
 * tagger has seen it; "not usable" on a reject), and the list arrives hero-first from the server. OFF:
 * the picker exactly as before; a server that sends the fields is simply not read.
 */
export const STUDIO_LIBRARY_FIELDS = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_LIBRARY_FIELDS,
);

/**
 * THE BRIEF CARRIER, CLIENT SIDE (PR 14, docs/probes/brief-carrier.md). Paired with the server's
 * STUDIO_BRIEF_CARRIER (server/studio/config.ts `briefCarrierEnabled`) — both default off, and the
 * server's 400 on `planId` is the real gate. ON: every clip and bridge request a planned Board makes
 * carries the plan's id, so the server can freeze the brief's feel, constraints and concept onto the
 * clip. OFF: the requests exactly as before; a Board from a plan quotes and runs as it did.
 */
export const STUDIO_BRIEF_CARRIER = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_BRIEF_CARRIER,
);

/**
 * HER IDENTITY PACK, CLIENT SIDE (PR 17, docs/probes/identity-pack.md). Paired with the server's
 * STUDIO_IDENTITY_PACK (server/studio/config.ts `identityPackEnabled`) — both default off, and the
 * server's 404 is the real gate. ON: the pack surface exists, and a likeness generation with fewer
 * than three "You" photos is topped up from her pack at the request boundary (lib/identityPack.ts,
 * inside usePreviewGeneration). OFF: no surface, no profile query, and every request is byte-for-byte
 * the request it was.
 */
export const STUDIO_IDENTITY_PACK = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_IDENTITY_PACK,
);

/**
 * IDENTITY DRIFT ON THE CHIP, CLIENT SIDE (PR 17, R-6). Paired with the server's STUDIO_IDENTITY_DRIFT.
 * ON: a clip's QaChip shows one more observation line when the wire carries one. OFF: the chip is
 * exactly what PR 11 shipped. Needs STUDIO_QA_DISPLAY, since the chip is behind it.
 */
export const STUDIO_IDENTITY_DRIFT = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_IDENTITY_DRIFT,
);

/**
 * THE STYLE SPEC, CLIENT SIDE (PR 18, docs/probes/style-spec.md). Paired with the server's
 * STUDIO_STYLE_SPEC (server/studio/config.ts `styleSpecEnabled`). Both default off, and the server's
 * 400 on the role is the real gate. ON: Create Anything's ＋ offers a Style tile, and the edit sheet
 * offers "Match a look". Both list ONLY references she has already had read, and a picked one travels
 * as `style_reference`, so her photo's look is shaped by the reading and the reference's pixels are
 * never sent. OFF: no tile, no row, and every request is byte-for-byte the request it was.
 */
export const STUDIO_STYLE_SPEC = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_STYLE_SPEC,
);

/**
 * IMAGE OPS ON THE SENTENCE DOOR, CLIENT SIDE (PR 19, docs/probes/image-ops.md). Paired with the server's
 * STUDIO_IMAGE_OPS (server/studio/config.ts `imageOpsEnabled`), which is the real gate: every new answer below exists
 * only when the server sends it. ON, Create Anything:
 *   * keeps her frame on the two new asks (`vague`, `style_reference_missing`), so she sees them, and renders the
 *     vague ask's op chips — each fills her draft, nothing is sent;
 *   * says each new ask in its own words;
 *   * counts her Style tile for the classifier, so "match this look" can find it;
 *   * lets the server's GENERATE win over the old edit-verb list (R-8: "change my pose" is a new picture of her);
 *   * says "This makes a new image" on every generate reached from a marked frame (K-IO12).
 * OFF: every request and every screen is byte-for-byte what it was.
 */
export const STUDIO_IMAGE_OPS = studioFlag(
  process.env.EXPO_PUBLIC_STUDIO_IMAGE_OPS,
);

/**
 * THE AGENT REBUILD, ATHLETE SIDE (agent build plan v2, Week 1). ON: Mila's chat draws the harness's cards (action ·
 * progress · ready · connect · how-i-got-this, plus the proposed onboarding kinds) under her answers; a new athlete meets
 * Mila through the onboarding conversation (name + sport → what I found → early read → connect → check facts → goals →
 * what I can do); the Strategy tab becomes Goals (one screen: goal, how, this week's actions) in place of Goals · Plan; the
 * Studio tab becomes the library of everything made; Me lists what is published. OFF: every one of those exactly as
 * before. Pinned OFF in eas.json for preview and production until the harness and onboarding endpoints land.
 */
export const AGENT_V3 = process.env.EXPO_PUBLIC_AGENT_V3 === "true";

/**
 * MILA STARTS THE CONVERSATION, CLIENT SIDE (design "Mila on watch", 27 Oct 2026). Paired with the server's
 * MILA_PROACTIVE — both default off. On: the Mila tab shows a dot while a message Mila started is unread (the app asks
 * /me/mila/unread when it comes to the front and once a minute while open), and opening a chat marks its Mila-started
 * messages seen. A notification that names a message opens the chat on it whatever this flag says (the server only
 * sends one while MILA_PROACTIVE is on). OFF: no polling, no dot.
 */
export const MILA_PROACTIVE = process.env.EXPO_PUBLIC_MILA_PROACTIVE === "true";

/**
 * THE CAMERA-ROLL INTAKE, CLIENT SIDE (design "Media Intake Plan", option c). Paired with the server's
 * CAMERA_ROLL_INTAKE — both default off, and both must be on. On: "Add from camera roll" reviews videos as well as
 * photos (a small preview of each, made on the phone), shows each one's description and why, can be opened already
 * filtered for a post that needs a clip, and — while the app is open and photo permission is already granted — quietly
 * prepares the next review so Mila can offer it in one tap. Off: "Review my camera roll" is exactly what it was.
 */
export const CAMERA_ROLL_INTAKE = process.env.EXPO_PUBLIC_CAMERA_ROLL_INTAKE === "true";

/**
 * DEALS & BOOKINGS V2, CLIENT SIDE (deals design §5b, §5c, §7, §7b; build contract 12 Oct 2026). Off by default; the
 * preview build turns it on. On: Opportunities gets the Deals | Bookings top tabs and the header search (All deals,
 * All bookings), the Bookings tab's own board and its "not set up yet" state, the deal letter's four-line read with the
 * actions of its type, the closed read-only view, the one reply sheet (look B) and the "Not for me" sheet, and "Your
 * rates" on Me. Pairs with the server's DEALS_READ / DEALS_BOARD_V2 / DEALS_SEARCH / RATES_V1: while those are off the
 * screens fall back (no read → the older letter; search or rates 404 → a plain "not on yet" line). Off: today's screens.
 */
export const OPPS_V2 = process.env.EXPO_PUBLIC_OPPS_V2 === "true";

/**
 * MILA'S DEAL TOOLS, CLIENT SIDE (deals design §6). Paired with the server's AGENT_DEALS_TOOLS — both default off, and
 * both must be on. On (with AGENT_V3): Ask Mila offers deal openers ("What needs me?"), a deal's detail gets "Ask Mila"
 * (the chat opens about THAT deal), and Mila's deal, reply and booking cards draw in the chat. Off: on the new agent Mila
 * offers no deal openers at all (she can't help with deals there yet), and nothing else changes.
 */
export const AGENT_DEALS_TOOLS = process.env.EXPO_PUBLIC_AGENT_DEALS_TOOLS === "true";

/**
 * THE DEV WEB SWITCH (web parity, Oct 2026). Set to "true" ONLY by the dev web build (.github/workflows/deploy-web-dev.yml
 * → https://nomila-dev.web.app). On, and only in a browser: shareable URLs (React Navigation linking), the phone-width
 * column on a wide screen, same-tab connects for every service, the home-screen manifest, and web notifications. Off —
 * every native build and the production web app (app.nomila.co, which Meta's app review may be using) — nothing changes.
 * Read through `webV2On()` so the platform half of the gate is in one place.
 */
export const WEB_V2 = process.env.EXPO_PUBLIC_WEB_V2 === "true";

/** The web half of WEB_V2: the flag on AND running in a browser. Pure, so the gate is testable with either value. */
export function webV2On(platformOs: string, flag: boolean = WEB_V2): boolean {
  return flag && platformOs === "web";
}

/**
 * The Firebase Cloud Messaging web-push public key (Firebase console → Project settings → Cloud Messaging → Web Push
 * certificates). A PUBLIC key, set only for the dev web build. Empty → web notifications are simply off.
 */
export const FIREBASE_VAPID_KEY = process.env.EXPO_PUBLIC_FIREBASE_VAPID_KEY ?? "";

/**
 * HOME V3, CLIENT SIDE (UX flow v3, 19 Oct 2026, "one thing, one place"). Off by default; ONLY the dev/preview build turns
 * it on (eas.json build.preview.env, which the dev web build copies). Production stays off while Meta's app review may be
 * using it. On: the bottom bar is Home · Opportunities · Mila · Studio · Me (Goals leaves the bar and opens from Me as
 * "Your plan"); Home is four pieces (story circles, Mila's line, at most one admin row, one big card) with full-screen
 * stories; Me is her photo, the dark M.I.A. card and a grid of six tiles; the brand colours come back as accents (pink
 * for actions, "new" rings and badges, gold for wins, green for done). Off: every one of those exactly as today.
 */
export const HOME_V3 = process.env.EXPO_PUBLIC_HOME_V3 === "true";
/**
 * The deals-and-bookings tab's name. HOME_V3: "Business" (owner, 20 Oct 2026: it holds offers, booking requests, shop
 * orders and payments; "Your brand is a media business"). Route names stay "Opportunities" so every navigate lands.
 */
export const OPPS_LABEL = HOME_V3 ? "Business" : "Opportunities";

/**
 * MILA CHAT V2, CLIENT SIDE (the approved Mila chat foundation, step 2; docs/design/mila-chat-v2.md). Off by default. ON only
 * in the development profile (dev-client builds) and local Metro runs (`npm run expo:dev`); preview (the owner's phone,
 * dev web) and production pin it "false", because v2 has no voice, ＋ attachments or follow-up chips yet (NOT BUILT). On: the Mila chat surface is the
 * new module (client/components/mila/thread): assistant-ui's React Native primitives drawing the AI SDK v7 stream from
 * POST /api/v1/me/chat/v2 — cards arrive as Mila works, Stop stops the run, and a reply survives a dropped signal. The
 * first-entry (onboarding) chat stays on the old one. Off: exactly as today.
 */
export const MILA_THREAD_V2 = process.env.EXPO_PUBLIC_MILA_THREAD_V2 === "true";

/**
 * MILA CARDS V2 (design "Mila card designs" v2.2, approved 3 Nov 2026; client/components/mila/cards/kit). Off by default.
 * ON only in the development profile and local Metro runs (`npm run expo:dev`), like MILA_THREAD_V2; preview and
 * production pin it "false". On: the chat v2 thread draws Insight, Idea, Turn-on offer, One-time question, Answer and the
 * deal with the card kit (collapsed, expanding in place). Off: exactly as today. The server side is MILA_CARDS_V2.
 */
export const MILA_CARDS_V2 = process.env.EXPO_PUBLIC_MILA_CARDS_V2 === "true";
