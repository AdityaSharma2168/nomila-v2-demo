/**
 * voiceGlobals.web.ts — the WEB half of LiveKit's entry-point setup: nothing.
 *
 * A browser already has WebRTC, TextDecoder, web streams and async iterators, so
 * there is nothing to register. This file exists only so that the side-effect
 * import in client/index.js resolves to an empty module on web instead of
 * pulling @livekit/react-native — and react-native-webrtc behind it — into the
 * web bundle. See voiceGlobals.ts for why the split is a file and not a
 * Platform.OS branch.
 *
 * Web voice is unaffected by any of this: it runs through voiceSession.web.ts,
 * which talks to `livekit-client` directly and needs no setup at entry.
 */

export {};
