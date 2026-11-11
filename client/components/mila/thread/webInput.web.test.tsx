/**
 * webInput.web.test — the browser side of the composer (thread/webInput.web.ts), against a stand-in visualViewport and
 * document: the keyboard inset is what the keyboard covers (and 0 for browser chrome), and the focus ring shows only
 * for keyboard focus (Tab), never for a click or a tap.
 */
import { act, renderHook } from "@testing-library/react-native";

type Listener = (e?: unknown) => void;

const vvListeners: Record<string, Listener[]> = {};
const docListeners: Record<string, Listener[]> = {};
const g = globalThis as unknown as Record<string, unknown>;

beforeAll(() => {
  g.innerHeight = 800;
  g.visualViewport = {
    height: 800,
    offsetTop: 0,
    addEventListener: (t: string, f: Listener) => { (vvListeners[t] ??= []).push(f); },
    removeEventListener: (t: string, f: Listener) => { vvListeners[t] = (vvListeners[t] ?? []).filter((x) => x !== f); },
  };
  g.document = { addEventListener: (t: string, f: Listener) => { (docListeners[t] ??= []).push(f); } };
});
afterAll(() => {
  delete g.visualViewport;
  delete g.document;
  delete g.innerHeight;
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const web = require("./webInput.web") as typeof import("./webInput.web");

const vv = () => g.visualViewport as { height: number; offsetTop: number };

it("no keyboard: 0; the keyboard up: the height it covers; the URL bar moving: still 0", () => {
  expect(web.keyboardInsetNow()).toBe(0);
  vv().height = 460; // a phone keyboard
  expect(web.keyboardInsetNow()).toBe(340);
  vv().offsetTop = 40; // iOS scrolled the page a little to show the field
  expect(web.keyboardInsetNow()).toBe(300);
  vv().height = 744; vv().offsetTop = 0; // Safari's toolbar showing, no keyboard
  expect(web.keyboardInsetNow()).toBe(0);
  vv().height = 800;
});

it("the browser outline comes off the text field", () => {
  expect(web.NO_OUTLINE).toMatchObject({ outlineStyle: "none", outlineWidth: 0 });
});

it("the focus ring: on after Tab, off after a click or a tap", () => {
  const { result } = renderHook(() => web.useFocusRing());
  act(() => { for (const f of docListeners.keydown ?? []) f({ key: "Tab", metaKey: false, altKey: false, ctrlKey: false }); });
  act(() => result.current.onFocus());
  expect(result.current.focusRing).toBe(true);
  act(() => result.current.onBlur());
  expect(result.current.focusRing).toBe(false);
  act(() => { for (const f of docListeners.pointerdown ?? []) f({}); });
  act(() => result.current.onFocus());
  expect(result.current.focusRing).toBe(false);
});
