/**
 * SignInFront — the agent onboarding's sign-in (EXPO_PUBLIC_AGENT_V3 + the server's AGENT_ONBOARDING; promoted from the
 * #900 prototype, feedback round Oct 2026). The full-bleed photo hero (MeHero at full height) on ROTATING photos from
 * the shared library's "signin" category (0120), or the neutral dark ground when there are none; the current tagline
 * in display caps; and ON the photo ONE raspberry "Get your agent" (the one look's action colour). Tapping it (or anywhere on the hero) reveals Google,
 * Apple (iOS only — App Store guideline 4.8) and Microsoft; tapping outside the buttons, or ~8s with no choice made,
 * collapses back to "Get your agent" — the old sign-in's ("Choose sign-in ↓", client/screens/SignInScreen.tsx) feel.
 *
 * The provider buttons keep look B's own shape and corner (white `onHero` fill, corner 4 — no DESIGN.md exception):
 * only what is INSIDE them borrows the old screen's feel — the coloured provider mark inline (never a boxed tile) and
 * a sentence-case "Continue with …" label, not look B's uppercase button type.
 *
 * Sign in with email (design "Sign in with email", 12 Oct 2026; only when the server offers it, `emailSignIn`): a quiet
 * "Use email instead →" link under the providers opens two more steps on the same hero —
 *   email   "What's your email?" (displaySm so the field, the button and the back link sit above the keyboard)
 *   code    "Enter your code": six cells over ONE real TextInput (number pad, one-time-code autofill, paste), sent by
 *           itself at the sixth digit; "Resend in 0:42" → "Resend code"; an expired or locked code dims the cells and
 *           offers "Send a new code".
 * Every failure, the providers' included, is ONE error line: white with an alert icon and the error haptic — no red
 * (DESIGN.md keeps colour for the score). The collapse timer runs only while the providers show; email mode has none.
 */
import React, { useEffect, useRef, useState } from "react";
import {
  View, Text, Pressable, StatusBar, StyleSheet, ActivityIndicator, TextInput, KeyboardAvoidingView, Keyboard, Platform,
  AccessibilityInfo, useWindowDimensions,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MeHero, MeHeroLine } from "../../components/me/MeHero";
import { Button, LinkText } from "../../components/ui";
import { Bold, BoldType } from "../../constants/theme";
import { haptics } from "../../lib/haptics";
import { CODE_LENGTH, codeDigits, countdown, looksLikeEmail, minutesToWait, type StartOutcome } from "../../lib/emailCodeSignIn";
import type { EmailVerifyResult, SignInFailure } from "../../lib/auth-context";
import { FRONT_COPY } from "./frontCopy";
import type { SigninPhoto } from "../../lib/onboardingFront";

type Provider = "google" | "apple" | "microsoft";

export type EmailError = { kind: "invalid" } | { kind: "sendFailed" } | { kind: "busy" } | { kind: "tooMany"; minutes: number };
export type CodeError =
  | { kind: "wrong"; triesLeft: number }
  | { kind: "expired" }
  | { kind: "locked" }
  | { kind: "sendFailed" }
  | { kind: "busy" }
  | { kind: "tooMany"; minutes: number }
  | { kind: "failed" };

/** Where the email steps open (the dev gallery and the tests draw each state; the app always starts on the providers). */
export interface EmailStepInitial {
  step: "email" | "code";
  email?: string;
  emailError?: EmailError | null;
  code?: string;
  codeError?: CodeError | null;
  resendInSec?: number;
}

export function SignInFront({
  photos, onGoogle, onApple, onMicrosoft, appleAvailable = true, busy = null, intervalMs = 5000, optionsOpen = false, revealMs = 8000,
  emailSignIn = false, onEmailStart, onEmailVerify, providerError = null, initialEmailStep = null, notice = null,
}: {
  photos: SigninPhoto[];
  /** A plain line under the buttons (e.g. "Sign-ups are closed for now" when the server answered signups_closed). */
  notice?: string | null;
  onGoogle: () => void;
  onApple: () => void;
  onMicrosoft: () => void;
  /** iOS only (auth-context's `appleSignInAvailable`); App Store guideline 4.8 requires it wherever Google/Microsoft show. */
  appleAvailable?: boolean;
  /** Which sign-in is under way (its button shows the spinner). */
  busy?: Provider | null;
  intervalMs?: number;
  optionsOpen?: boolean;
  /** No choice made this long after the options reveal ⇒ collapse back to the CTA (old screen's feel). */
  revealMs?: number;
  /** The server offers the email code (GET /public/onboarding-front `emailSignIn`): "Use email instead" shows. */
  emailSignIn?: boolean;
  onEmailStart?: (email: string) => Promise<StartOutcome>;
  onEmailVerify?: (email: string, code: string) => Promise<EmailVerifyResult>;
  /**
   * A Google, Apple or Microsoft sign-in just failed: the error line under the buttons (and the options stay open).
   * `account_exists` says the address already has an account and, with the email code on, offers it for that address.
   */
  providerError?: SignInFailure | null;
  initialEmailStep?: EmailStepInitial | null;
}) {
  const c = FRONT_COPY.signIn;
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<"providers" | "email" | "code">(initialEmailStep?.step ?? "providers");
  const [options, setOptions] = useState(optionsOpen || !!providerError);
  const [i, setI] = useState(0);
  const keyboard = useKeyboardShown();
  useEffect(() => {
    if (photos.length < 2 || intervalMs <= 0) return;
    const t = setInterval(() => setI((x) => (x + 1) % photos.length), intervalMs);
    return () => clearInterval(t);
  }, [photos.length, intervalMs]);
  // A failed sign-in keeps the choices (and its error line) on screen.
  useEffect(() => { if (providerError) setOptions(true); }, [providerError]);
  const emailOffered = emailSignIn && !!onEmailStart && !!onEmailVerify;
  // Nobody chose: collapse back to the CTA. Only on the providers step; cleared while a choice is under way (busy) or
  // an error is showing, and restarted after.
  useEffect(() => {
    if (step !== "providers" || !options || busy || providerError || revealMs <= 0) return;
    const t = setTimeout(() => setOptions(false), revealMs);
    return () => clearTimeout(t);
  }, [step, options, busy, providerError, revealMs]);
  const photo = photos[i % Math.max(1, photos.length)] ?? null;
  const emailStep = step !== "providers";

  const flow = useEmailFlow({ initial: initialEmailStep, onEmailStart, onEmailVerify, setStep, appleAvailable });

  const hero = (
    <MeHero
      photoUrl={photo?.url ?? null}
      photoKey={photo?.id ?? null}
      eyebrow={step === "email" ? FRONT_COPY.email.eyebrow : step === "code" ? FRONT_COPY.code.eyebrow : c.eyebrow}
      title={step === "email" ? FRONT_COPY.email.title : step === "code" ? FRONT_COPY.code.title : c.line}
      titleSize={emailStep ? "sm" : "display"}
      subtitle={step === "email" ? <MeHeroLine>{FRONT_COPY.email.sub}</MeHeroLine>
        : step === "code" ? (
          <MeHeroLine>
            {FRONT_COPY.code.subBefore}<Text style={styles.subStrong}>{flow.email.trim()}</Text>{FRONT_COPY.code.subAfter}
          </MeHeroLine>
        ) : c.sub}
      deep
      minHeight={emailStep ? 0 : height}
      style={[styles.fill, { paddingTop: insets.top, paddingBottom: emailStep && keyboard ? 0 : insets.bottom }]}
    >
      {step === "providers" ? (
        <>
          {photos.length > 1 ? (
            <View style={styles.dots} accessibilityLabel={`Image ${i + 1} of ${photos.length}`} testID="signin-dots">
              {photos.map((p, k) => <View key={p.id} style={[styles.dot, k === i && styles.dotOn]} />)}
            </View>
          ) : null}
          {options ? (
            <View style={styles.options} testID="signin-options">
              <ProviderButton provider="google" label={c.google} onPress={onGoogle} loading={busy === "google"} disabled={!!busy} testID="signin-google" />
              {appleAvailable ? (
                <ProviderButton provider="apple" label={c.apple} onPress={onApple} loading={busy === "apple"} disabled={!!busy} testID="signin-apple" />
              ) : null}
              <ProviderButton provider="microsoft" label={c.microsoft} onPress={onMicrosoft} loading={busy === "microsoft"} disabled={!!busy} testID="signin-microsoft" />
              {providerError ? (
                <ErrorLine testID="signin-error">
                  {providerError.kind === "account_exists" ? FRONT_COPY.err.accountExists(emailOffered) : FRONT_COPY.err.signInFailed}
                </ErrorLine>
              ) : null}
              {emailOffered && providerError?.kind === "account_exists" ? (
                <Button bold="onHero" onPress={() => { if (!busy) flow.openEmail(providerError.email ?? undefined); }} style={styles.onHeroBtn} testID="signin-account-exists-code">
                  {FRONT_COPY.err.useCode}
                </Button>
              ) : emailOffered ? (
                <LinkText onDark onPress={() => { if (!busy) flow.openEmail(); }} style={styles.useEmail} testID="signin-use-email">{c.useEmail}</LinkText>
              ) : null}
            </View>
          ) : (
            <Button bold="primary" onPress={() => setOptions(true)} style={[styles.onHeroBtn, styles.cta]} testID="signin-cta">{c.cta}</Button>
          )}
          {notice ? <Text style={styles.notice} testID="signin-notice">{notice}</Text> : null}
          <Text style={[styles.terms, options && emailOffered && styles.termsTight]}>{c.terms}</Text>
        </>
      ) : step === "email" ? (
        <EmailStep flow={flow} onBack={() => { flow.reset(); setStep("providers"); setOptions(true); }} />
      ) : (
        <CodeStep flow={flow} />
      )}
      {emailStep && !keyboard ? <Text style={styles.terms}>{c.terms}</Text> : null}
    </MeHero>
  );

  return (
    <View style={styles.root} testID="signin-front">
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === "ios" ? "padding" : undefined} enabled={emailStep}>
        {emailStep ? hero : (
          <Pressable style={styles.fill} onPress={() => { if (!busy) setOptions((o) => !o); }} accessible={false} testID="signin-hero">
            {hero}
          </Pressable>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

// ─── The email steps ────────────────────────────────────────────────────────────────────────────────────────────────

type Flow = ReturnType<typeof useEmailFlow>;

function useEmailFlow({ initial, onEmailStart, onEmailVerify, setStep, appleAvailable }: {
  initial: EmailStepInitial | null;
  onEmailStart?: (email: string) => Promise<StartOutcome>;
  onEmailVerify?: (email: string, code: string) => Promise<EmailVerifyResult>;
  setStep: (s: "providers" | "email" | "code") => void;
  appleAvailable: boolean;
}) {
  const [email, setEmail] = useState(initial?.email ?? "");
  const [emailError, setEmailError] = useState<EmailError | null>(initial?.emailError ?? null);
  const [sending, setSending] = useState(false);
  const [code, setCode] = useState(initial?.code ?? "");
  const [codeError, setCodeError] = useState<CodeError | null>(initial?.codeError ?? null);
  const [verifying, setVerifying] = useState(false);
  // The guard against a double submit (autofill + the sixth keystroke, a paste): a ref, so two calls in one render
  // can't both get past it the way a state read could.
  const verifyingRef = useRef(false);
  const [resendAt, setResendAt] = useState(() => Date.now() + (initial?.resendInSec ?? 0) * 1000);
  const [now, setNow] = useState(() => Date.now());
  const waiting = resendAt > now;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);

  const failHaptic = () => haptics.error();
  const dead = codeError?.kind === "expired" || codeError?.kind === "locked";

  /** Ask for a code. From the email step it opens the code step; from the code step it starts over with a new code. */
  const send = async (from: "email" | "code") => {
    if (!onEmailStart || sending) return;
    if (!looksLikeEmail(email)) { setEmailError({ kind: "invalid" }); failHaptic(); return; }
    setSending(true);
    const out = await onEmailStart(email).catch((): StartOutcome => ({ kind: "failed" }));
    setSending(false);
    if (out.kind === "sent" || out.kind === "too_soon") {
      // too_soon: a code went out under a minute ago and still works — the code step opens on the countdown.
      const after = out.kind === "sent" ? out.resendAfterSec : out.retryAfterSec;
      const t = Date.now();
      setNow(t); setResendAt(t + after * 1000);
      setCode(""); setCodeError(null); setEmailError(null);
      if (out.kind === "sent") haptics.success();
      setStep("code");
      return;
    }
    failHaptic();
    const err = out.kind === "invalid" ? { kind: "invalid" as const }
      : out.kind === "too_many" ? { kind: "tooMany" as const, minutes: minutesToWait(out.retryAfterSec) }
        : out.kind === "busy" ? { kind: "busy" as const }
          : { kind: "sendFailed" as const };
    if (from === "email") setEmailError(err);
    else setCodeError(err.kind === "invalid" ? { kind: "sendFailed" } : err);   // the address was already accepted
  };

  const verify = async (full: string) => {
    if (!onEmailVerify || verifyingRef.current) return;
    verifyingRef.current = true;
    setVerifying(true); setCodeError(null);
    const out = await onEmailVerify(email, full).catch((): EmailVerifyResult => ({ kind: "failed" }));
    if (out.kind === "ok") { haptics.success(); return; }   // signing in: the gate moves on, the spinner stays
    verifyingRef.current = false;
    setVerifying(false);
    failHaptic();
    if (out.kind === "wrong") { setCode(""); setCodeError({ kind: "wrong", triesLeft: out.triesLeft }); return; }
    if (out.kind === "expired" || out.kind === "locked") { Keyboard.dismiss(); setCodeError({ kind: out.kind }); return; }
    setCode(""); setCodeError({ kind: "failed" });
  };

  const onCode = (text: string) => {
    if (dead || verifyingRef.current) return;
    const d = codeDigits(text);
    setCode(d);
    if (d.length > 0 && codeError?.kind !== "tooMany" && codeError?.kind !== "sendFailed" && codeError?.kind !== "busy") setCodeError(null);
    if (d.length === CODE_LENGTH) void verify(d);
  };

  return {
    email, emailError, sending, code, codeError, verifying, dead, appleAvailable,
    resendIn: waiting ? Math.ceil((resendAt - now) / 1000) : 0,
    setEmail: (v: string) => { setEmail(v); if (emailError) setEmailError(null); },
    send, onCode,
    openEmail: (prefill?: string) => { if (prefill) setEmail(prefill); setEmailError(null); setStep("email"); },
    changeEmail: () => { setCode(""); setCodeError(null); setStep("email"); },
    reset: () => { setEmailError(null); setCode(""); setCodeError(null); },
  };
}

function emailErrorText(e: EmailError, apple: boolean): string {
  if (e.kind === "invalid") return FRONT_COPY.err.invalid;
  if (e.kind === "tooMany") return FRONT_COPY.err.tooMany(e.minutes, apple);
  if (e.kind === "busy") return FRONT_COPY.err.busy;
  return FRONT_COPY.err.sendFailed;
}

function codeErrorText(e: CodeError, apple: boolean): string {
  switch (e.kind) {
    case "wrong": return FRONT_COPY.err.wrong(e.triesLeft);
    case "expired": return FRONT_COPY.err.expired;
    case "locked": return FRONT_COPY.err.locked;
    case "tooMany": return FRONT_COPY.err.tooMany(e.minutes, apple);
    case "sendFailed": return FRONT_COPY.err.sendFailed;
    case "busy": return FRONT_COPY.err.busy;
    default: return FRONT_COPY.err.signInFailed;
  }
}

function EmailStep({ flow, onBack }: { flow: Flow; onBack: () => void }) {
  const e = FRONT_COPY.email;
  const blocked = flow.emailError?.kind === "tooMany";
  return (
    <View style={styles.form} testID="signin-email-step">
      <Text style={styles.label} nativeID="signin-email-label">{e.label}</Text>
      <TextInput
        value={flow.email}
        onChangeText={flow.setEmail}
        placeholder={e.placeholder}
        placeholderTextColor={Bold.quiet}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        inputMode="email"
        returnKeyType="go"
        autoFocus
        editable={!flow.sending}
        onSubmitEditing={() => { if (!blocked) void flow.send("email"); }}
        style={styles.input}
        accessibilityLabel={e.label}
        accessibilityLabelledBy="signin-email-label"
        testID="signin-email-input"
      />
      {flow.emailError ? <ErrorLine testID="signin-email-error">{emailErrorText(flow.emailError, flow.appleAvailable)}</ErrorLine> : null}
      <Button
        bold="primary"
        onPress={() => { void flow.send("email"); }}
        loading={flow.sending}
        disabled={blocked || !flow.email.trim()}
        style={[styles.onHeroBtn, styles.sendBtn]}
        testID="signin-email-send"
      >
        {e.send}
      </Button>
      <Pressable onPress={onBack} style={({ pressed }) => [styles.back, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={e.back} testID="signin-email-back">
        <Feather name="chevron-left" size={16} color={Bold.onDarkSoft} />
        <Text style={styles.backText}>{e.back}</Text>
      </Pressable>
    </View>
  );
}

function CodeStep({ flow }: { flow: Flow }) {
  const k = FRONT_COPY.code;
  const input = useRef<TextInput>(null);
  const focusAt = flow.dead || flow.verifying ? -1 : Math.min(flow.code.length, CODE_LENGTH - 1);
  return (
    <View style={styles.form} testID="signin-code-step">
      <View style={styles.cellsWrap}>
        <View style={styles.cells} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          {Array.from({ length: CODE_LENGTH }, (_, n) => {
            const d = flow.code[n] ?? "";
            const focus = n === focusAt;
            return (
              <View key={n} style={[styles.cell, focus && styles.cellFocus, flow.dead && styles.cellDim]} testID={`signin-code-cell-${n}`}>
                {d ? <Text style={styles.cellDigit}>{d}</Text> : focus ? <View style={styles.caret} /> : null}
              </View>
            );
          })}
        </View>
        {/* ONE real field under the cells: the number pad, paste, and the OS's one-time-code autofill. */}
        <TextInput
          ref={input}
          value={flow.code}
          onChangeText={flow.onCode}
          keyboardType="number-pad"
          inputMode="numeric"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          maxLength={CODE_LENGTH}
          autoFocus={!flow.dead}
          editable={!flow.dead && !flow.verifying}
          caretHidden
          contextMenuHidden={false}
          style={styles.codeInput}
          accessibilityLabel={k.field}
          testID="signin-code-input"
        />
      </View>
      {flow.codeError ? <ErrorLine testID="signin-code-error">{codeErrorText(flow.codeError, flow.appleAvailable)}</ErrorLine> : null}
      {flow.dead ? (
        <>
          <Button bold="onHero" onPress={() => { void flow.send("code"); }} loading={flow.sending} style={[styles.onHeroBtn, styles.newCodeBtn]} testID="signin-code-new">
            {FRONT_COPY.err.newCode}
          </Button>
          <View style={styles.center}>
            <LinkText onDark arrow={false} onPress={flow.changeEmail} style={styles.metaLink} testID="signin-code-change">{k.change}</LinkText>
          </View>
        </>
      ) : (
        <>
          <View style={styles.meta}>
            {flow.verifying || flow.sending ? <ActivityIndicator color={Bold.onDark} size="small" testID="signin-code-busy" />
              : flow.resendIn > 0 ? <Text style={styles.wait} testID="signin-code-wait">{k.resendIn(countdown(flow.resendIn))}</Text>
                : <LinkText onDark arrow={false} onPress={() => { void flow.send("code"); }} style={styles.metaLink} testID="signin-code-resend">{k.resend}</LinkText>}
            <LinkText onDark arrow={false} onPress={flow.changeEmail} style={styles.metaLink} testID="signin-code-change">{k.change}</LinkText>
          </View>
          <Text style={styles.hint}>{k.spam}</Text>
        </>
      )}
    </View>
  );
}

/**
 * The one error line: white, an alert icon, no red (DESIGN.md §1 keeps colour for the score). Read out by the screen
 * reader when it appears or changes (a live region alone is Android-only).
 */
function ErrorLine({ children, testID }: { children: string; testID?: string }) {
  useEffect(() => { AccessibilityInfo.announceForAccessibility(children); }, [children]);
  return (
    <View style={styles.err} accessibilityRole="alert" accessibilityLiveRegion="polite" testID={testID}>
      <Feather name="alert-circle" size={15} color={Bold.onDark} style={styles.errIcon} />
      <Text style={styles.errText}>{children}</Text>
    </View>
  );
}

/** Whether the software keyboard is up (iOS: will-show, so the terms line leaves before the keyboard covers it). */
function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const a = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setShown(true));
    const b = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setShown(false));
    return () => { a.remove(); b.remove(); };
  }, []);
  return shown;
}

// ─── The providers ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Look B's own `onHero` button shape (corner 4, white fill — same geometry as the CTA above it), with the old
 * screen's feel inside: the coloured provider mark inline (not a boxed tile) and a sentence-case label.
 */
function ProviderButton({ provider, label, onPress, loading, disabled, testID }: {
  provider: Provider;
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.providerBtn, disabled && styles.providerDisabled, pressed && !disabled && styles.providerPressed]}
      onPress={() => { haptics.press(); onPress(); }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      testID={testID}
    >
      {loading ? <ActivityIndicator color={Bold.ink} size="small" /> : (
        <>
          <ProviderMark provider={provider} testID={`signin-mark-${provider}`} />
          <Text style={styles.providerText}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

function ProviderMark({ provider, testID }: { provider: Provider; testID: string }) {
  if (provider === "google") {
    return (
      <View testID={testID} accessibilityRole="image" accessibilityLabel="Google">
        <Svg width={20} height={20} viewBox="0 0 18 18">
          <Path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
          <Path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
          <Path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
          <Path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
        </Svg>
      </View>
    );
  }
  if (provider === "apple") {
    return (
      <View testID={testID} accessibilityRole="image" accessibilityLabel="Apple">
        <Svg width={20} height={20} viewBox="0 0 24 24" fill={Bold.ink}>
          <Path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.7 9.05 7.4c1.39.07 2.35.74 3.15.77 1.2-.24 2.35-.93 3.62-.84 1.54.12 2.7.72 3.47 1.84-3.18 1.89-2.43 5.96.67 7.12-.58 1.34-1.3 2.66-2.91 3.99zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
        </Svg>
      </View>
    );
  }
  return (
    <View testID={testID} accessibilityRole="image" accessibilityLabel="Microsoft">
      <Svg width={20} height={20} viewBox="0 0 21 21">
        <Path d="M10 0H0v10h10V0z" fill="#F25022"/>
        <Path d="M21 0H11v10h10V0z" fill="#7FBA00"/>
        <Path d="M10 11H0v10h10V11z" fill="#00A4EF"/>
        <Path d="M21 11H11v10h10V11z" fill="#FFB900"/>
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  root:      { flex: 1, backgroundColor: Bold.ink },
  fill:      { flex: 1 },
  pressed:   { opacity: 0.7 },
  dots:      { flexDirection: "row", gap: 6, marginTop: 6 },
  dot:       { width: 6, height: 6, borderRadius: 3, backgroundColor: Bold.onDarkMute },
  dotOn:     { backgroundColor: Bold.onDark },
  options:   { gap: 10, marginTop: 14 },
  onHeroBtn: { alignSelf: "stretch", height: Bold.button },
  cta:       { marginTop: 14 },
  // Look B's `onHero` button shape (Bold.radius.control, Bold.paper fill) — the same geometry as the CTA; only the
  // mark + label inside borrow the old screen's feel (see ProviderButton).
  providerBtn:      { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, alignSelf: "stretch", height: Bold.button, paddingHorizontal: 18, borderRadius: Bold.radius.control, backgroundColor: Bold.paper },
  providerPressed:  { transform: [{ scale: Bold.pressScale }] },
  providerDisabled: { opacity: 0.4 },
  providerText:     { ...BoldType.rowTitle, color: Bold.ink },
  // DESIGN.md link on black (#6D95FF, 13/800, arrow), centred under the providers; a full 44 touch target.
  useEmail:  { alignSelf: "center", minHeight: 44, justifyContent: "center" },
  notice:    { ...BoldType.caption, color: Bold.onDark, marginTop: 10 },
  terms:     { ...BoldType.caption, color: Bold.onDarkMute, marginTop: 10 },
  termsTight: { marginTop: 0 },
  subStrong: { fontFamily: BoldType.rowTitle.fontFamily, fontWeight: BoldType.rowTitle.fontWeight, color: Bold.onDark },
  form:      { gap: 8, marginTop: 6 },
  label:     { ...BoldType.label, color: Bold.onDarkLabel },
  input:     { ...BoldType.body, color: Bold.ink, height: Bold.button, borderRadius: Bold.radius.control, borderWidth: 1.5, borderColor: Bold.ink, backgroundColor: Bold.paper, paddingHorizontal: 14 },
  sendBtn:   { marginTop: 4 },
  newCodeBtn: { marginTop: 6 },
  back:      { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, minHeight: 44 },
  backText:  { ...BoldType.link, color: Bold.onDarkSoft },
  err:       { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 2 },
  errIcon:   { marginTop: 2 },
  errText:   { ...BoldType.heroLineSmall, color: Bold.onDark, flex: 1 },
  cellsWrap: { position: "relative" },
  cells:     { flexDirection: "row", gap: 8 },
  cell:      { flex: 1, height: 56, borderRadius: Bold.radius.control, backgroundColor: Bold.paper, borderWidth: 1.5, borderColor: Bold.paper, alignItems: "center", justifyContent: "center" },
  cellFocus: { borderWidth: 3, borderColor: Bold.ink },
  cellDim:   { opacity: 0.4 },
  cellDigit: { ...BoldType.statement, letterSpacing: 0, color: Bold.ink },
  caret:     { width: 2, height: 26, backgroundColor: Bold.ink },
  // The real field covers the cells, invisible: a tap anywhere on them focuses it, and paste / autofill land in it.
  codeInput: { ...StyleSheet.absoluteFill, opacity: 0.011, color: "transparent" },
  meta:      { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 },
  metaLink:  { minHeight: 44 },
  wait:      { ...BoldType.link, color: Bold.onDarkMute },
  hint:      { ...BoldType.caption, color: Bold.onDarkMute },
  center:    { alignItems: "center" },
});
