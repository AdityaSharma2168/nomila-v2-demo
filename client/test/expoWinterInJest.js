// Jest only (jest.config.cjs, react-native project). Expo SDK 57's `expo` import installs its WinterCG globals
// (expo/src/winter: URL, TextDecoder, DOMException, fetch, ...) as LAZY getters whose first read require()s the
// implementation. When that first read lands after a suite's tests have finished — a refetch or poll timer, or Jest
// walking the global object — Jest refuses the require ("outside of the scope of the test code") and fails a suite
// whose tests all passed. So the runtime is installed here, inside the suite's scope, and every getter is read once.
//
// fetch: Expo's own opt-out keeps React Native's fetch polyfill, which is what every suite ran on before the upgrade;
// expo/fetch is backed by a native module a Jest process does not have. Suites that test streaming mock expo/fetch.
process.env.EXPO_PUBLIC_USE_RN_FETCH = "1";
require("expo/src/winter");
for (const name of [
  "TextDecoder",
  "TextDecoderStream",
  "TextEncoderStream",
  "URL",
  "URLSearchParams",
  "DOMException",
  "__ExpoImportMetaRegistry",
  "structuredClone",
]) {
  void globalThis[name];
}
