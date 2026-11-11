/**
 * voiceGlobals.ts — the NATIVE half of LiveKit's entry-point setup.
 *
 * Imported for its side effect by client/index.js, before the app renders.
 * Metro resolves ./voiceGlobals to voiceGlobals.web.ts on web (a no-op) and to
 * this file everywhere else.
 *
 * ── Why a file split and not `if (Platform.OS !== "web")` ────────────────────
 * A runtime guard would still leave the `import` statically reachable, and Metro
 * bundles what it can reach whether or not the call runs. `@livekit/react-native`
 * pulls in react-native-webrtc, which has no web build — so a guarded import
 * would break the web bundle over a feature web does not use. The platform
 * extension means the web bundle never contains either package. Same reasoning,
 * and same shape, as voiceSession.ts / voiceSession.web.ts.
 *
 * ── registerGlobals() does more than WebRTC ──────────────────────────────────
 * Importing this module installs Symbol.asyncIterator, DOMException and a
 * TextEncoder/TextDecoder polyfill; calling registerGlobals() adds the WebRTC
 * globals, web streams, crypto.randomUUID and `global.LiveKitReactNativeGlobal`.
 * That last one is how livekit-client knows it is on React Native and stops
 * taking its DOM paths.
 *
 * Two things in voiceSession.ts depend on the polyfills rather than on WebRTC:
 * the transcript handler iterates a text stream with `for await`, and the widget
 * bridge decodes bytes with `new TextDecoder()`. Neither works without this call
 * having happened first, which is why it runs at entry and not at connect time.
 *
 * ── Why the try/catch ────────────────────────────────────────────────────────
 * This runs before the first frame, so anything thrown here is a boot failure
 * for the whole app — including for athletes who will never tap the mic.
 *
 * The realistic way that happens is an OTA update: expo-updates ships JS to
 * binaries that already exist, and a binary built before react-native-webrtc was
 * added has no native module for registerGlobals() to reach. Bumping the app
 * version (which is the runtimeVersion, see app.json) is what should keep this
 * bundle away from those installs — the catch is the second line of defence for
 * when it doesn't. Voice then reports itself unavailable (Room.connect throws
 * "WebRTC isn't detected, have you called registerGlobals?", which
 * voiceSession.ts turns into a human line) and the rest of the app boots.
 */

import { registerGlobals } from "@livekit/react-native";

try {
  registerGlobals();
} catch (err) {
  // Dev-only: in production this is a silent degrade to "voice unavailable",
  // which is strictly better than failing to launch.
  if (__DEV__) {
    console.warn(
      "[voice] registerGlobals() failed — native voice will be unavailable.",
      "This usually means the JS bundle is newer than the native binary.",
      err,
    );
  }
}
