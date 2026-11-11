# Dependency watch list

The libraries where a bad version, a breaking change or a security advisory would cost us most: money (model calls
that are no longer counted or capped), athlete data, or a broken app build. Everything else follows the normal
Dependabot / `npm audit` flow.

- **Owner:** the product owner. Claude does the work (checks, upgrade PRs, tests); the owner approves and merges.
- **Cadence:** a check of every row below **once a month** (first working day). A **security advisory** for any row
  is handled **immediately**: read it, decide whether we are affected, and open the fix PR the same day if we are.
- **How to check:** compare the pinned version with the latest release, read the changelog between them, and look at
  the advisory source. Record the date and the outcome in the "Last checked" column.

Versions are as pinned on `main` (package.json range → the version `package-lock.json` resolves), 4 Nov 2026.

| Library | Pinned (package.json → lockfile) | Why it matters to us | Where advisories are posted | Last checked |
|---|---|---|---|---|
| **Mastra** (`@mastra/core`, `@mastra/memory`, `@mastra/pg`, `@mastra/ai-sdk`) | `1.79.0`, `1.39.0`, `1.32.0`, `1.11.3` (exact pins) | Runs Mila's chat turns (server/agent/engine/mastra). Its usage numbers feed our cost ledger and caps; a change in how it reports usage or web-search calls silently changes what we count. Its pg store holds chat threads. | github.com/mastra-ai/mastra/security/advisories · releases and CHANGELOG in the repo | 4 Nov 2026 |
| **AI SDK** (`ai`, `@ai-sdk/openai`, `@ai-sdk/react`) | `7.0.159`, `4.0.103`, `4.0.163` (exact pins) | The streaming layer under Mastra and the chat v2 wire. Usage fields (`totalUsage`, step usage) are what our cost caps read. | github.com/vercel/ai/security/advisories · github.com/vercel/ai/releases | 4 Nov 2026 |
| **OpenAI SDK** (`openai`) | `^4.104.0` → `4.104.0` | Every direct OpenAI call (Responses API, web search, embeddings). All web search goes through OpenAI (model/provider policy), so this is on the spend path. | github.com/openai/openai-node/security/advisories · github.com/openai/openai-node/releases | 4 Nov 2026 |
| **Gemini SDK** (`@google/genai`) | `^2.7.0` → `2.7.0` | Vertex Gemini calls: routine jobs, Studio vision and generation, voice. Usage metadata feeds our cost records. | github.com/googleapis/js-genai/security/advisories · its releases · Vertex AI release notes | 4 Nov 2026 |
| **LiveKit** (`livekit-server-sdk`, `livekit-client`, `@livekit/react-native`, `@livekit/react-native-webrtc`) | `^2.17.0` → `2.17.0`; `^2.21.0` → `2.21.0`; `^3.1.0` → `3.1.0`; `^150.1.1` → `150.1.1` | Voice: the server signs room tokens and agent dispatch (server/voice/webTokenRoute.ts); the token is the voice security boundary. WebRTC is native code in the app. | github.com/livekit/node-sdks/security/advisories · github.com/livekit/client-sdk-js/security · livekit.io changelog | 4 Nov 2026 |
| **LiveKit Agents** (`@livekit/agents`, `@livekit/agents-plugin-google`, in the separate `nomila-co/mila-voice` worker repo) | `1.6.2`, `1.6.2` (exact pins, that repo's package.json) | Runs every voice session against Gemini Live: the biggest per-minute spend path, and where the Gemini Live session config (e.g. `contextWindowCompression`) is set. Not in this repo's lockfile, so check it there. | github.com/livekit/agents-js/security/advisories · github.com/livekit/agents-js/releases | 5 Nov 2026 |
| **pdfjs-dist** | `^6.5.438` → `6.5.438` | Parses PDFs athletes and brands send (contracts, briefs): untrusted input. pdf.js has had code-execution advisories before. | github.com/mozilla/pdf.js/security/advisories · GitHub Advisory Database (npm `pdfjs-dist`) | 4 Nov 2026 |
| **Remotion** (`remotion`, `@remotion/*`, in media/remotion) | `4.0.537` (exact pins) | Renders Studio motion videos in its own Cloud Run service. Licence terms depend on company size (see the Remotion licence note). | github.com/remotion-dev/remotion/security · remotion.dev changelog and license page | 4 Nov 2026 |
| **Expo** (`expo` and its SDK packages) | `~57.0.31` → `57.0.31` | The whole mobile app and its EAS builds and updates. An SDK bump moves React Native, native modules and build images together. | github.com/expo/expo/security/advisories · expo.dev/changelog (SDK release posts) | 4 Nov 2026 |
| **Drizzle** (`drizzle-orm`, `drizzle-kit`, `drizzle-zod`) | `^0.39.3` → `0.39.3`; `^0.31.4` → `0.31.11`; `^0.7.1` → `0.7.1` | Every database query and every migration. A query-builder bug is a tenancy or data bug. | github.com/drizzle-team/drizzle-orm/security/advisories · its releases | 4 Nov 2026 |
| **sharp** | `^0.34.5` → `0.34.5` | Decodes and resizes every uploaded image (untrusted input) through bundled libvips; also part of the EAS build (SHARP_IGNORE_GLOBAL_LIBVIPS). | github.com/lovell/sharp/security/advisories · libvips releases · GitHub Advisory Database | 4 Nov 2026 |

## When an upgrade touches the spend path

Mastra, the AI SDK, the OpenAI SDK and the Gemini SDK sit on the path every paid call takes. An upgrade PR for any of
them also runs the spend-guard suites (`server/lib/spendCap.test.ts`, `server/lib/platformSpend.test.ts`, the cost
tests under `server/agent/engine/mastra/`) and says in its body whether usage reporting changed.
