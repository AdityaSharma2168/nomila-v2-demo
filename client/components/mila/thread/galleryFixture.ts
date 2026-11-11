/**
 * thread/galleryFixture — DEV ONLY (the agent gallery, /agent-gallery?s=thread-v2-*): chat v2 on a scripted server.
 * The REAL transport and parser (createMilaApi) read an AI SDK v7 SSE byte stream made here from the server's part
 * shapes, so the gallery shows exactly what the app draws for a live turn. No network, no sign-in.
 */
import { toMilaCardDto } from "../../../../shared/milaCards";
import { ACTION_CARD } from "../../../lib/agent/fixtures";
import { DEAL_CARD_YOURS } from "../../../lib/agent/dealFixtures";
import { useEffect, useRef, useState } from "react";
import type { TranscriptUpdate, UseMilaVoice } from "../useMilaVoice";
import { createMilaApi, type MilaApi } from "./api";
import { KIT_FIXTURES } from "../cards/kit/fixtures";

type Part = Record<string, unknown>;
type Step = { part?: Part; waitMs?: number };

const card = (c: unknown): Part => {
  const r = toMilaCardDto(c);
  return r.ok ? { type: "data-mila-card", id: r.dto.data.id, data: r.dto } : {};
};
const text = (s: string, every = 120, id = "t1"): Step[] =>
  s.split(/(?<= )/).map((w) => ({ part: { type: "text-delta", id, delta: w }, waitMs: every }));
/** One text segment of its own (start, words, end), as the server sends each run of words between two tool calls. */
const segment = (id: string, s: string, every = 10): Step[] => [
  { part: { type: "text-start", id } }, ...text(s, every, id), { part: { type: "text-end", id } },
];

function turn(runId: string, body: Step[], end: "done" | "hold"): Step[] {
  return [
    { part: { type: "start", messageId: runId, messageMetadata: { runId } } },
    { part: { type: "data-mila-status", id: "status", data: { label: "Thinking…", phase: "thinking" } }, waitMs: 500 },
    ...body,
    ...(end === "done"
      ? [{ part: { type: "text-end", id: "t1" } }, { part: { type: "data-mila-done", data: { runId, status: "completed", stopReason: null, messageIds: [] } } }, { part: { type: "finish", finishReason: "stop" } }]
      : [{ waitMs: 10 * 60_000 }]),
  ];
}

export type GalleryScript = "answer" | "midstream" | "cards" | "failed" | "followups" | "cards-v2";

const dtoPart = (d: { data: { id: string } }): Part => ({ type: "data-mila-card", id: d.data.id, data: d });

function script(kind: GalleryScript): Step[] {
  if (kind === "failed") {
    // The server's error part (one fixed sentence) and a failed done: the app shows the error and offers Retry.
    return [
      { part: { type: "start", messageId: "run-g3", messageMetadata: { runId: "run-g3" } } },
      { part: { type: "text-start", id: "t1" } },
      ...text("Let me look at your deals and ", 60),
      { part: { type: "error", errorText: "Mila is unavailable right now — try again in a moment." } },
      { part: { type: "data-mila-done", data: { runId: "run-g3", status: "failed", stopReason: "error", messageIds: [] } } },
      { part: { type: "finish", finishReason: "error" } },
    ];
  }
  if (kind === "midstream") {
    return turn("run-g1", [
      { part: { type: "data-mila-status", id: "status", data: { label: "Looking at your deals…", phase: "tool" } }, waitMs: 4000 },
      { part: { type: "text-start", id: "t1" } },
      ...text("Two deals need you this week. Northpeak wants two Reels by Friday, and "),
    ], "hold");
  }
  if (kind === "cards-v2") {
    // The card system v2 (EXPO_PUBLIC_MILA_CARDS_V2): each one-sentence lead-in, then its card, in the order the model
    // made them. As the server does it (engine/mastra/chatV2Stream: a tool call closes the text), every run of words is
    // its own text part, so each lead-in is drawn directly above its card, not glued to the others.
    return [
      { part: { type: "start", messageId: "run-g4", messageMetadata: { runId: "run-g4" } } },
      { part: { type: "data-mila-status", id: "status", data: { label: "Thinking…", phase: "thinking" } }, waitMs: 300 },
      ...segment("t1", "Something's changed in your reels."),
      { part: dtoPart(KIT_FIXTURES.insight), waitMs: 100 },
      ...segment("t2", "Your home opener is Saturday. Here's one I'd make."),
      { part: dtoPart(KIT_FIXTURES.ideas), waitMs: 100 },
      ...segment("t3", "I can help with that."),
      { part: dtoPart(KIT_FIXTURES["turn-on"]), waitMs: 100 },
      ...segment("t4", "Here's what I found."),
      { part: dtoPart(KIT_FIXTURES.answer), waitMs: 100 },
      ...segment("t5", "One quick question."),
      { part: dtoPart(KIT_FIXTURES.once), waitMs: 100 },
      ...segment("t6", "And Northpeak is waiting on you."),
      { part: dtoPart(KIT_FIXTURES.deal), waitMs: 100 },
      { part: { type: "data-mila-done", data: { runId: "run-g4", status: "completed", stopReason: null, messageIds: [] } } },
      { part: { type: "finish", finishReason: "stop" } },
    ];
  }
  if (kind === "cards") {
    return turn("run-g2", [
      { part: { type: "data-mila-status", id: "status", data: { label: "Looking at your deals…", phase: "tool" } }, waitMs: 500 },
      { part: card(DEAL_CARD_YOURS), waitMs: 400 },
      { part: { type: "data-mila-status", id: "status", data: { label: "Drafting your reply…", phase: "tool" } }, waitMs: 500 },
      { part: card(ACTION_CARD), waitMs: 300 },
      { part: { type: "text-start", id: "t1" } },
      ...text("I drafted a reply to Northpeak. Tap Send when it looks right — nothing goes out until you do.", 30),
    ], "done");
  }
  return turn("run-g0", [{ part: { type: "text-start", id: "t1" } }, ...text("Deals, posts, your page and your money. Ask me anything.", 30)], "done");
}

const LONG: Array<{ role: "user" | "assistant"; content: string }> = Array.from({ length: 30 }, (_, i) =>
  i % 2 === 0
    ? { role: "user" as const, content: `Question ${i / 2 + 1}: what should I do about the ${["Northpeak", "Trailmark", "Summit"][i % 3]} deal?` }
    : { role: "assistant" as const, content: `Answer ${(i + 1) / 2}. Here is what I would do next, and why it matters for your goals this season. The newest is at the bottom.` });

/** A saved chat whose newest answer carries nav chips (a saved row's app_actions), as today's chat draws them. */
const FOLLOWUPS: Array<Record<string, unknown>> = [
  { role: "user", content: "What should I do next with Northpeak?" },
  {
    role: "assistant",
    content: "Northpeak wants two Reels by Friday. Their brief and the contract are in the deal, and your reply is drafted.",
    app_actions: [
      { label: "Open the deal", target: { screen: "deals" } },
      { label: "Your rates", target: { screen: "rates" } },
      { label: "Add the contract", target: { screen: "add_contract", requestId: "req-g1" } },
    ],
  },
];

/** A soft cream-and-ink picture (a small JPEG, inline: no network), standing in for a camera-roll photo. */
export const GALLERY_PHOTO_URI = "data:image/jpeg;base64,/9j/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCACgAKADASIAAhEBAxEB/8QAGwABAAMBAQEBAAAAAAAAAAAAAAECBQYEAwf/xAA0EAEBAAIBAgIFCgYDAAAAAAABAAIDBAURITFBUVJx4RIVIjJCYWSBkaMGE6KxwdEWofD/xAAYAQEBAQEBAAAAAAAAAAAAAAABAAMCBP/EABwRAQEBAAIDAQAAAAAAAAAAAAABAhESAyExUf/aAAwDAQACEQMRAD8A/SlqrFovM3KqxaFgi1Vi0LRFolVYQtCxaq0RaqxaIJQsWqtIWhYtVYItEoWCLVWLVWi26qxaFtGItVYtC0RaJVWELQsWqtEWqsWiCULFqrSFoWLVWCLRKFgi1Vi1Voi0ShaTaWqsWhbRkLRKqwhaFi1Voi1Vi334vFy5OXs4HnlX1fHwBXsCv3X1x4XJzO5qy/PwtjTo16Me2vEPv9LfS76fri7/ABhZ8Lk4nd05fl43myHF7Iiehumvlv42rkY9tmA+p9JFx+Kb/XOLRenm8LPiZd/ra3yyvKtnZw1nsWqsWqsOhaJQtIWqsWhYLaWiVVtGItCxaq0RaqxaIK+rW7duOvHzye1ua9eOrWYYnYLN6Xh8rfnn7OP97VtMT1yy3ffBJLtwSSkpt1YbtWWvM745FzO/Vlo3Z6svPF7XU2H1vWY8jDYfbx7P5XG565aeO++GatEoWxbi1Vi0LBFqrFogtpaFi1VtWItVYtEEoWLVWk0ukP0tp9x/m07C6fuNPLx7vbHL6Lbtrj4y3PZJLpwSSkWN17I+Vox9IZP9rZub6ryDfzcvkvfHD6J/733G76aeOe3jWqsWhbB6BaqxaIJVWLQtJtLVWLRaMihYtVaQtCxaqwTvbPT+cb8DVse2w8u/2rFo7o9x7JMvAueXVSxOP1jZrDHdj/MPX5N7cescPI8c8sPfi/4tZqVlcWPdLwZ9Y4eJ4ZZZ+7H/AHeDldb27Bx0Y/yz2vN+FXcimLXt6p1E4+t06su+3I8e32T/AHc8tKqqvdfXVWx1rmt856wWqsWi4dlVYtC0haqxaFgtqhYtVbViLQsWqsEWiWv03g44YG/ad83xxH0Eyc0W8R49PS+TuDJDXi+15/pej5jfTyP6Pja0tekZd6yPmL8T/R8aPmH8T+38bYldMrvpj/MH4r9v40f8f/Fft/G2ZXTK76Yr/D728OV+38bx8no/L0DliG3E9jz/AEumkXEM8mnEtVboes9Mx2a8uTpx7bMfHMPtHr99zq2Gp1rfOpqci1Vi0LcuxasoWi2loWLVW0Yi0ShYL68XWbuVr1vk5ePuukue6dkY9Q1L60/6uitsfGPk+kku2ZJKRJKRJKSLjefpOPzt2o8scnt7vRdnch1nMy6rvT1h+gFl5fjbxfXiWrKFsHpFoWLVWE2lolC2jIWqsWqtFbHNwzxzxezi9y6fjb8eTox24ek8T1PquVvRw+ds4Wzvj9LB+ti+m6zrhxvPMdPLycfqXF5Adthhl7Ofg3qETuPe3l5YWWJklAklIlCgd17F4+V1bh8XF+VtM8vZwe7Vsn0yW/H25fKw4fGz3Z+WJ4HrfQXFbNmWzZlsye+WSq/ferqHUtvUNvfP6OGP1cDyPjeJbzb12r1ePHWC0LFqrZtBaFi1aLbWqsWqtoyFolC0haqxaFgi1Vi0QSqsWhaQtVYtCwRasoWiLQsWqsIWhYtWiULFqrBf/9k=";

type VoiceMode = "off" | "idle" | "live";
type VoiceOpts = { conversationId?: string | null; onTranscript?: (u: TranscriptUpdate) => void };

/** The gallery's voice session (the app's needs a signed-in athlete): unavailable, ready (the mic), or live with a
 *  spoken exchange shown the way the real session's transcripts land. */
function galleryVoice(mode: VoiceMode) {
  return function useGalleryVoice(opts: VoiceOpts): UseMilaVoice {
    const live = mode === "live";
    const [state, setState] = useState<UseMilaVoice["state"]>(live ? "listening" : "idle");
    const sent = useRef(false);
    useEffect(() => {
      if (!live || sent.current) return;
      sent.current = true;
      const lines: Array<[number, TranscriptUpdate]> = [
        [400, { streamId: "g-u1", role: "user", text: "Which deal should I answer first?", done: true }],
        [1200, { streamId: "g-m1", role: "assistant", text: "Northpeak. They want two Reels by Friday, and your reply is drafted.", done: true }],
        [1800, { streamId: "g-u2", role: "user", text: "Read me the draft", done: false }],
      ];
      const timers = lines.map(([ms, u]) => setTimeout(() => { opts.onTranscript?.(u); if (u.role === "assistant") setState("speaking"); else setState("listening"); }, ms));
      return () => timers.forEach(clearTimeout);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return { state, error: null, notice: null, supported: mode !== "off", toggle: () => {}, active: live, justEnded: false };
  };
}

/** Everything a gallery page hands the chat: the scripted server, the voice session, the camera roll and the upload. */
export function galleryOptions(kind: GalleryScript, voice: VoiceMode = "idle") {
  let n = 0;
  return {
    api: galleryApi(kind),
    useVoice: galleryVoice(voice),
    pick: async () => ({ assets: [{ uri: GALLERY_PHOTO_URI, type: "image" as const, width: 400, height: 400, fileName: "photo.jpg", mimeType: "image/jpeg" }] }),
    // A short upload, so the chip's "uploading" state shows before it is ready.
    upload: async () => {
      await new Promise((r) => setTimeout(r, 1500));
      n += 1;
      return { asset_id: `a0000000-0000-4000-8000-00000000000${n}`, media_type: "IMAGE", url: GALLERY_PHOTO_URI, thumb_url: GALLERY_PHOTO_URI } as never;
    },
  };
}

/** A scripted MilaApi: the real createMilaApi over a fetch that plays `kind`; `long` seeds a 30-message saved chat. */
export function galleryApi(kind: GalleryScript) {
  return ({ conversationId }: { conversationId: () => string }): MilaApi => createMilaApi({
    apiUrl: () => "https://gallery.invalid",
    headers: async () => ({}),
    conversationId,
    fetch: async (url, init) => {
      if (url.endsWith("/api/v1/me/chat/v2")) {
        const enc = new TextEncoder();
        const steps = script(kind);
        const stream = new ReadableStream<Uint8Array>({
          async start(ctl) {
            for (const s of steps) {
              if (init?.signal?.aborted) break;
              if (s.part && Object.keys(s.part).length) ctl.enqueue(enc.encode(`data: ${JSON.stringify(s.part)}\n\n`));
              if (s.waitMs) await new Promise((r) => setTimeout(r, s.waitMs));
            }
            try { ctl.enqueue(enc.encode("data: [DONE]\n\n")); ctl.close(); } catch { /* aborted */ }
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url.includes("/me/conversations/")) {
        // After the failed turn the app catches up from the saved turns (the AI SDK stops reading at the error part).
        const rows: Array<Record<string, unknown>> = kind === "failed"
          ? [{ role: "user" as const, content: "How are my deals?" }, { role: "assistant" as const, content: "Let me look at your deals and" }]
          : kind === "followups" ? FOLLOWUPS : LONG;
        return new Response(JSON.stringify({ messages: rows.map((m, i) => ({ id: `g${i}`, ...m })) }), { status: 200 });
      }
      if (/\/runs\/[^/]+$/.test(url)) {
        return new Response(JSON.stringify({ runId: "run-g3", status: "failed", stopReason: "error", messageIds: [], conversationId: null }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    },
  });
}
