import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Animated,
  ActivityIndicator,
  TextInput,
  useWindowDimensions,
} from "react-native";
import Svg, { Circle, Path, Defs, RadialGradient, Stop, Ellipse, Rect } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SIGNUPS_CLOSED_MESSAGE, useAuth } from "../lib/auth-context";
import { Bold, Brand, Fonts, Spacing, BorderRadius } from "../constants/theme";

const BG    = Brand.heroBg;
const CORAL = Brand.ringPink;
const BLUE  = Brand.ringBlue;
const GREEN = Brand.ringGreen;
const GOLD  = Brand.ringGold;
// The ring colours above draw the LOGO (AnimatedRings) only. Everything else on this page is white on hero black, and
// its buttons the one raspberry action colour (one look, 23 Oct 2026).
const ACT   = Bold.act;
const GLOW  = "#FFFFFF";
const WHITE = "#FFFFFF";
const MUTED  = "rgba(255,255,255,0.55)";
const MUTED2 = "rgba(255,255,255,0.32)";

const TRUST = ["WESTBOUND", "TRYBE VENTURES", "STANFORD", "WASSERMAN", "BAY FC"];
const AVATARS = [
  { initials: "JR", color: "#3A3A3A" },
  { initials: "AT", color: "#4A4A4A" },
  { initials: "MK", color: "#5A5A5A" },
  { initials: "LD", color: "#6B6B6B" },
];

// ─── Animated ring widget with aurora hue ────────────────────────────────────

function AnimatedRings({ size = 160 }: { size?: number }) {
  const glow = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(glow, { toValue: 1, duration: 2400, delay: 400, useNativeDriver: true }),
        Animated.timing(glow, { toValue: 0, duration: 2400, useNativeDriver: true }),
      ])
    ).start();
  }, [glow]);

  const glowOpacity = glow.interpolate({ inputRange: [0, 1], outputRange: [0.28, 0.65] });
  const auroraSize   = size * 2.6;
  const auroraOffset = -(auroraSize - size) / 2;

  return (
    <View style={{ width: size, height: size }}>
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { width: auroraSize, height: auroraSize, top: auroraOffset, left: auroraOffset, opacity: glowOpacity },
        ]}
      >
        <Svg width={auroraSize} height={auroraSize}>
          <Defs>
            <RadialGradient id="aBlue"  cx="35%" cy="35%" r="50%">
              <Stop offset="0%"   stopColor={BLUE}  stopOpacity="0.45"/>
              <Stop offset="100%" stopColor={BLUE}  stopOpacity="0"/>
            </RadialGradient>
            <RadialGradient id="aCoral" cx="70%" cy="55%" r="50%">
              <Stop offset="0%"   stopColor={CORAL} stopOpacity="0.30"/>
              <Stop offset="100%" stopColor={CORAL} stopOpacity="0"/>
            </RadialGradient>
            <RadialGradient id="aGold"  cx="50%" cy="80%" r="40%">
              <Stop offset="0%"   stopColor={GOLD}  stopOpacity="0.18"/>
              <Stop offset="100%" stopColor={GOLD}  stopOpacity="0"/>
            </RadialGradient>
          </Defs>
          <Ellipse cx={auroraSize * 0.35} cy={auroraSize * 0.35} rx={auroraSize * 0.5}  ry={auroraSize * 0.45} fill="url(#aBlue)"/>
          <Ellipse cx={auroraSize * 0.70} cy={auroraSize * 0.55} rx={auroraSize * 0.45} ry={auroraSize * 0.42} fill="url(#aCoral)"/>
          <Ellipse cx={auroraSize * 0.50} cy={auroraSize * 0.80} rx={auroraSize * 0.35} ry={auroraSize * 0.30} fill="url(#aGold)"/>
        </Svg>
      </Animated.View>

      <Animated.View style={[StyleSheet.absoluteFill, { opacity: glowOpacity }]} pointerEvents="none">
        {([18, 12] as const).map((sw, i) => (
          <Svg key={i} width={size} height={size} viewBox="0 0 112 112" style={StyleSheet.absoluteFill} opacity={0.18 - i * 0.06}>
            <Path d="M 17.7 88.14 A 50 50 0 1 1 99.3 31.0"  stroke={BLUE}  strokeWidth={sw} strokeLinecap="round" fill="none"/>
            <Path d="M 26.89 80.43 A 38 38 0 1 1 93.42 62.6" stroke={GREEN} strokeWidth={sw} strokeLinecap="round" fill="none"/>
            <Path d="M 36.08 72.71 A 26 26 0 1 1 72.71 75.92" stroke={CORAL} strokeWidth={sw} strokeLinecap="round" fill="none"/>
            <Path d="M 45.28 65.0 A 14 14 0 1 1 56.0 70.0"   stroke={GOLD}  strokeWidth={sw} strokeLinecap="round" fill="none"/>
          </Svg>
        ))}
      </Animated.View>

      <Svg width={size} height={size} viewBox="0 0 112 112">
        <Circle cx="56" cy="56" r="50" stroke={WHITE} strokeWidth="2" strokeOpacity="0.035" fill="none"/>
        <Circle cx="56" cy="56" r="38" stroke={WHITE} strokeWidth="2" strokeOpacity="0.035" fill="none"/>
        <Circle cx="56" cy="56" r="26" stroke={WHITE} strokeWidth="2" strokeOpacity="0.035" fill="none"/>
        <Circle cx="56" cy="56" r="14" stroke={WHITE} strokeWidth="2" strokeOpacity="0.035" fill="none"/>
        <Path d="M 17.7 88.14 A 50 50 0 1 1 99.3 31.0"  stroke={BLUE}  strokeWidth="4.5" strokeLinecap="round" fill="none"/>
        <Path d="M 26.89 80.43 A 38 38 0 1 1 93.42 62.6" stroke={GREEN} strokeWidth="4.5" strokeLinecap="round" fill="none"/>
        <Path d="M 36.08 72.71 A 26 26 0 1 1 72.71 75.92" stroke={CORAL} strokeWidth="4.5" strokeLinecap="round" fill="none"/>
        <Path d="M 45.28 65.0 A 14 14 0 1 1 56.0 70.0"   stroke={GOLD}  strokeWidth="4.5" strokeLinecap="round" fill="none"/>
      </Svg>
    </View>
  );
}

// ─── Auto-scrolling trust marquee ────────────────────────────────────────────

function TrustMarquee() {
  const translateX = useRef(new Animated.Value(0)).current;
  const [halfWidth, setHalfWidth] = useState(0);

  useEffect(() => {
    if (halfWidth === 0) return;
    const anim = Animated.loop(
      Animated.timing(translateX, { toValue: -halfWidth, duration: halfWidth * 55, useNativeDriver: true })
    );
    anim.start();
    return () => anim.stop();
  }, [translateX, halfWidth]);

  return (
    <View style={{ overflow: "hidden", minHeight: 20 }}>
      <Animated.View
        style={{ flexDirection: "row", flexShrink: 0, flexWrap: "nowrap", transform: [{ translateX }] }}
        onLayout={(e) => {
          const w = e.nativeEvent.layout.width;
          if (w > 0 && halfWidth === 0) setHalfWidth(w / 2);
        }}
      >
        {[...TRUST, ...TRUST].map((item, i) => (
          <Text key={i} style={styles.trustItem} numberOfLines={1}>{item}</Text>
        ))}
      </Animated.View>
    </View>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function SignInScreen() {
  const insets = useSafeAreaInsets();
  const { width: sw, height: sh } = useWindowDimensions();
  const {
    signInWithGoogle, signInWithApple, signInWithMicrosoft,
    signInWithEmail, createAccountWithEmail, sendEmailPasswordReset,
    appleSignInAvailable, isLoading: authLoading, signupsClosed,
  } = useAuth();

  const [showAuth, setShowAuth]         = useState(false);
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [emailMode, setEmailMode]       = useState<"signin" | "signup">("signin");
  const [name, setName]                 = useState("");
  const [email, setEmail]               = useState("");
  const [password, setPassword]         = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [emailError, setEmailError]     = useState<string | null>(null);
  const [isEmailLoading, setIsEmailLoading] = useState(false);
  const [resetSent, setResetSent]       = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);

  const isLoading = authLoading || isEmailLoading || oauthLoading !== null;

  const handleEmailSubmit = async () => {
    setEmailError(null);
    if (!email.trim()) { setEmailError("Please enter your email."); return; }
    if (!password)     { setEmailError("Please enter your password."); return; }
    if (emailMode === "signup") {
      if (!name.trim())        { setEmailError("Please enter your name."); return; }
      if (password.length < 6) { setEmailError("Password must be at least 6 characters."); return; }
    }
    setIsEmailLoading(true);
    try {
      if (emailMode === "signin") {
        await signInWithEmail(email.trim(), password);
      } else {
        await createAccountWithEmail(email.trim(), password, name.trim());
      }
    } catch (err: unknown) {
      setEmailError((err as Error).message ?? "Something went wrong.");
    } finally {
      setIsEmailLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email.trim()) { setEmailError("Enter your email above, then tap Forgot Password."); return; }
    setIsEmailLoading(true);
    try {
      await sendEmailPasswordReset(email.trim());
      setResetSent(true);
      setEmailError(null);
    } catch {
      setEmailError("Could not send reset email. Check the address and try again.");
    } finally {
      setIsEmailLoading(false);
    }
  };

  const handleOAuth = async (provider: string, fn: () => Promise<void>) => {
    setOauthLoading(provider);
    try { await fn(); } catch { /* errors handled inside fn */ }
    finally { setOauthLoading(null); }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Full-screen aurora */}
      <Svg style={StyleSheet.absoluteFill} width={sw} height={sh} pointerEvents="none">
        <Defs>
          <RadialGradient id="auroraBlue"  cx="25%" cy="30%" r="65%">
            <Stop offset="0%"   stopColor={GLOW}  stopOpacity="0.08"/>
            <Stop offset="100%" stopColor={GLOW}  stopOpacity="0"/>
          </RadialGradient>
          <RadialGradient id="auroraCoral" cx="78%" cy="38%" r="60%">
            <Stop offset="0%"   stopColor={GLOW}  stopOpacity="0.05"/>
            <Stop offset="100%" stopColor={GLOW}  stopOpacity="0"/>
          </RadialGradient>
          <RadialGradient id="auroraGold"  cx="50%" cy="75%" r="45%">
            <Stop offset="0%"   stopColor={GLOW}  stopOpacity="0.03"/>
            <Stop offset="100%" stopColor={GLOW}  stopOpacity="0"/>
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={sw} height={sh} fill="url(#auroraBlue)"/>
        <Rect x="0" y="0" width={sw} height={sh} fill="url(#auroraCoral)"/>
        <Rect x="0" y="0" width={sw} height={sh} fill="url(#auroraGold)"/>
      </Svg>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + Spacing["3xl"] }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Wordmark */}
        <View style={styles.nav}>
          <Text style={styles.wordmark}>NOMILA</Text>
        </View>

        {/* Hero */}
        <View style={styles.hero}>
          <AnimatedRings size={148} />

          <Text style={styles.eyebrow}>The Operating System for Athletes</Text>

          <View style={styles.headlineWrap}>
            <Text style={styles.headline}>{"YOUR BRAND IS"}</Text>
            <Text style={styles.headline}>{"A MEDIA BUSINESS."}</Text>
            <Text style={styles.headline}>{"MONETIZE YOUR IMPACT."}</Text>
          </View>

          <Text style={styles.sub}>
            {"Nomila AI agents work 24/7. They score your market value, create content, engage fans, and negotiate to monetize your brand — all while you train, compete & sleep."}
          </Text>

          {/* Social proof badge */}
          <View style={styles.badge}>
            <View style={styles.avatarStack}>
              {AVATARS.map((a, i) => (
                <View key={a.initials} style={[styles.avatar, { backgroundColor: a.color, marginLeft: i === 0 ? 0 : -6 }]}>
                  <Text style={styles.avatarText}>{a.initials}</Text>
                </View>
              ))}
            </View>
            <Text style={styles.badgeText}>940+ athletes waiting</Text>
            <View style={styles.badgeDivider} />
            <Text style={styles.badgeAccent}>Get priority access</Text>
          </View>

          {/* CTA */}
          <View style={styles.ctaWrap}>
            <Pressable
              style={({ pressed }) => [styles.primaryBtn, pressed && styles.btnPressed]}
              onPress={() => setShowAuth(s => !s)}
            >
              <Text style={styles.primaryBtnText}>
                {showAuth ? "Choose sign-in ↓" : "Get Your Agent"}
              </Text>
            </Pressable>

            {signupsClosed && <Text style={styles.signupsClosed} testID="signups-closed">{SIGNUPS_CLOSED_MESSAGE}</Text>}

            {showAuth && (
              <View style={styles.authSection}>
                {/* Google */}
                <Pressable
                  style={({ pressed }) => [styles.authBtn, pressed && styles.btnPressed]}
                  onPress={() => handleOAuth("google", signInWithGoogle)}
                  disabled={isLoading}
                >
                  {oauthLoading === "google" ? (
                    <ActivityIndicator color={WHITE} size="small" />
                  ) : (
                    <>
                      <Svg width={18} height={18} viewBox="0 0 18 18">
                        <Path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                        <Path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
                        <Path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
                        <Path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
                      </Svg>
                      <Text style={styles.authBtnText}>Continue with Google</Text>
                    </>
                  )}
                </Pressable>

                {/* Apple (iOS only) */}
                {appleSignInAvailable && (
                  <Pressable
                    style={({ pressed }) => [styles.authBtn, styles.appleBtn, pressed && styles.btnPressed]}
                    onPress={() => handleOAuth("apple", signInWithApple)}
                    disabled={isLoading}
                  >
                    {oauthLoading === "apple" ? (
                      <ActivityIndicator color={WHITE} size="small" />
                    ) : (
                      <>
                        <Svg width={18} height={18} viewBox="0 0 24 24" fill={WHITE}>
                          <Path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.7 9.05 7.4c1.39.07 2.35.74 3.15.77 1.2-.24 2.35-.93 3.62-.84 1.54.12 2.7.72 3.47 1.84-3.18 1.89-2.43 5.96.67 7.12-.58 1.34-1.3 2.66-2.91 3.99zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/>
                        </Svg>
                        <Text style={styles.authBtnText}>Continue with Apple</Text>
                      </>
                    )}
                  </Pressable>
                )}

                {/* Microsoft */}
                <Pressable
                  style={({ pressed }) => [styles.authBtn, styles.msBtn, pressed && styles.btnPressed]}
                  onPress={() => handleOAuth("microsoft", signInWithMicrosoft)}
                  disabled={isLoading}
                >
                  {oauthLoading === "microsoft" ? (
                    <ActivityIndicator color={WHITE} size="small" />
                  ) : (
                    <>
                      <Svg width={18} height={18} viewBox="0 0 21 21">
                        <Path d="M10 0H0v10h10V0z" fill="#F25022"/>
                        <Path d="M21 0H11v10h10V0z" fill="#7FBA00"/>
                        <Path d="M10 11H0v10h10V11z" fill="#00A4EF"/>
                        <Path d="M21 11H11v10h10V11z" fill="#FFB900"/>
                      </Svg>
                      <Text style={styles.authBtnText}>Continue with Microsoft</Text>
                    </>
                  )}
                </Pressable>

                {/* Divider */}
                <View style={styles.dividerRow}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>or</Text>
                  <View style={styles.dividerLine} />
                </View>

                {/* Email toggle */}
                {!showEmailForm ? (
                  <Pressable
                    style={({ pressed }) => [styles.authBtn, styles.emailBtn, pressed && styles.btnPressed]}
                    onPress={() => setShowEmailForm(true)}
                    disabled={isLoading}
                  >
                    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={WHITE} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <Path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                      <Path d="M22 6l-10 7L2 6"/>
                    </Svg>
                    <Text style={styles.authBtnText}>Continue with Email</Text>
                  </Pressable>
                ) : (
                  <View style={styles.emailForm}>
                    {/* Sign In / Create Account toggle */}
                    <View style={styles.modeToggle}>
                      <Pressable
                        style={[styles.modeBtn, emailMode === "signin" && styles.modeBtnActive]}
                        onPress={() => { setEmailMode("signin"); setEmailError(null); setResetSent(false); }}
                      >
                        <Text style={[styles.modeBtnText, emailMode === "signin" && styles.modeBtnTextActive]}>Sign In</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.modeBtn, emailMode === "signup" && styles.modeBtnActive]}
                        onPress={() => { setEmailMode("signup"); setEmailError(null); setResetSent(false); }}
                      >
                        <Text style={[styles.modeBtnText, emailMode === "signup" && styles.modeBtnTextActive]}>Create Account</Text>
                      </Pressable>
                    </View>

                    {/* Name (signup only) */}
                    {emailMode === "signup" && (
                      <TextInput
                        style={styles.emailInput}
                        placeholder="Full name"
                        placeholderTextColor={MUTED2}
                        value={name}
                        onChangeText={t => { setName(t); setEmailError(null); }}
                        autoCapitalize="words"
                        autoCorrect={false}
                      />
                    )}

                    {/* Email */}
                    <TextInput
                      style={styles.emailInput}
                      placeholder="Email address"
                      placeholderTextColor={MUTED2}
                      value={email}
                      onChangeText={t => { setEmail(t); setEmailError(null); setResetSent(false); }}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />

                    {/* Password */}
                    <View style={styles.passwordRow}>
                      <TextInput
                        style={[styles.emailInput, styles.passwordInput]}
                        placeholder="Password"
                        placeholderTextColor={MUTED2}
                        value={password}
                        onChangeText={t => { setPassword(t); setEmailError(null); }}
                        secureTextEntry={!showPassword}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                      <Pressable style={styles.eyeBtn} onPress={() => setShowPassword(v => !v)}>
                        <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={MUTED} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          {showPassword ? (
                            <>
                              <Path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                              <Path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                              <Path d="M1 1l22 22"/>
                            </>
                          ) : (
                            <>
                              <Path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                              <Path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/>
                            </>
                          )}
                        </Svg>
                      </Pressable>
                    </View>

                    {emailError  && <Text style={styles.emailError}>{emailError}</Text>}
                    {resetSent   && <Text style={styles.emailSuccess}>Reset email sent — check your inbox.</Text>}

                    <Pressable
                      style={({ pressed }) => [styles.emailSubmitBtn, pressed && styles.btnPressed, isEmailLoading && { opacity: 0.7 }]}
                      onPress={handleEmailSubmit}
                      disabled={isEmailLoading}
                    >
                      {isEmailLoading ? (
                        <ActivityIndicator color={WHITE} size="small" />
                      ) : (
                        <Text style={styles.emailSubmitText}>
                          {emailMode === "signin" ? "Sign In" : "Create Account"}
                        </Text>
                      )}
                    </Pressable>

                    {emailMode === "signin" && (
                      <Pressable style={styles.forgotBtn} onPress={handleForgotPassword} disabled={isEmailLoading}>
                        <Text style={styles.forgotText}>Forgot password?</Text>
                      </Pressable>
                    )}

                    <Pressable
                      style={styles.backToOauthBtn}
                      onPress={() => { setShowEmailForm(false); setEmailError(null); setEmail(""); setPassword(""); setName(""); setResetSent(false); }}
                    >
                      <Text style={styles.backToOauthText}>← Other sign-in options</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            )}
          </View>
        </View>

        {/* Trust bar */}
        <View style={styles.trustBar}>
          <Text style={styles.trustLabel}>Trusted, Funded &amp; Loved by</Text>
          <TrustMarquee />
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.terms}>
            By continuing you agree to our{" "}
            <Text style={styles.termsLink}>Terms</Text> &amp; <Text style={styles.termsLink}>Privacy Policy</Text>
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: BG,
  },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: Spacing["2xl"],
  },

  nav: {
    alignItems: "center",
    paddingTop: Spacing["2xl"],
    marginBottom: Spacing["3xl"],
  },
  wordmark: {
    fontFamily: Fonts.display,
    fontSize: 15,
    letterSpacing: 5,
    color: WHITE,
    textAlign: "center",
  },

  hero: {
    alignItems: "center",
    marginBottom: Spacing["3xl"],
  },
  eyebrow: {
    fontFamily: Fonts.body,
    fontSize: 10,
    letterSpacing: 2.5,
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.6)",
    marginTop: Spacing["2xl"],
    marginBottom: Spacing.md,
    textAlign: "center",
  },
  headlineWrap: {
    alignItems: "center",
    marginBottom: Spacing.lg,
  },
  headline: {
    fontFamily: Fonts.display,
    fontSize: 24,
    letterSpacing: 0.5,
    lineHeight: 31,
    color: WHITE,
    textAlign: "center",
  },
  sub: {
    fontFamily: Fonts.body,
    fontSize: 13,
    color: MUTED,
    lineHeight: 20,
    textAlign: "center",
    marginBottom: Spacing.xl,
  },

  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: BorderRadius.full,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    marginBottom: Spacing["2xl"],
  },
  avatarStack: { flexDirection: "row", marginRight: 2 },
  avatar: {
    width: 18, height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: BG,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontFamily: Fonts.body, fontSize: 5, color: WHITE },
  badgeText:  { fontFamily: Fonts.body, fontSize: 11, color: "rgba(255,255,255,0.5)" },
  badgeDivider: { width: 1, height: 12, backgroundColor: "rgba(255,255,255,0.15)" },
  badgeAccent:  { fontFamily: Fonts.bodySemiBold, fontSize: 11, color: "rgba(255,255,255,0.8)" },

  ctaWrap: { width: "100%", gap: Spacing.sm },
  primaryBtn: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ACT,
    paddingVertical: 15,
    borderRadius: BorderRadius.full,
  },
  primaryBtnText: {
    fontFamily: Fonts.bodySemiBold,
    fontSize: 15,
    letterSpacing: 3,
    textTransform: "uppercase",
    color: WHITE,
  },
  btnPressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },

  authSection: { gap: Spacing.sm, marginTop: Spacing.sm },
  authBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.sm,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    paddingVertical: 14,
    borderRadius: BorderRadius.full,
  },
  appleBtn: { backgroundColor: "#111111", borderColor: "#333333" },
  msBtn:    { backgroundColor: "#1A3A6B", borderColor: "#2F5FA8" },
  emailBtn: { backgroundColor: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.14)" },
  authBtnText: { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: WHITE },

  dividerRow:  { flexDirection: "row", alignItems: "center", gap: Spacing.sm, marginVertical: 2 },
  dividerLine: { flex: 1, height: 1, backgroundColor: "rgba(255,255,255,0.1)" },
  dividerText: { fontFamily: Fonts.body, fontSize: 11, color: MUTED2 },

  emailForm:  { gap: Spacing.sm },
  modeToggle: {
    flexDirection: "row",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: BorderRadius.full,
    padding: 3,
  },
  modeBtn:         { flex: 1, alignItems: "center", paddingVertical: 9, borderRadius: BorderRadius.full },
  modeBtnActive:   { backgroundColor: "rgba(255,255,255,0.12)" },
  modeBtnText:     { fontFamily: Fonts.bodySemiBold, fontSize: 13, color: MUTED2 },
  modeBtnTextActive: { color: WHITE },
  emailInput: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: 13,
    fontFamily: Fonts.body,
    fontSize: 15,
    color: WHITE,
  },
  passwordRow:   { position: "relative" },
  passwordInput: { paddingRight: 48 },
  eyeBtn: {
    position: "absolute",
    right: 14,
    top: 0,
    bottom: 0,
    justifyContent: "center",
    padding: 4,
  },
  emailError:   { fontFamily: Fonts.body, fontSize: 12, color: "#FF6B6B", textAlign: "center" },
  signupsClosed: { fontFamily: Fonts.body, fontSize: 13, color: WHITE, textAlign: "center" },
  emailSuccess: { fontFamily: Fonts.body, fontSize: 12, color: WHITE, textAlign: "center" },
  emailSubmitBtn: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ACT,
    paddingVertical: 14,
    borderRadius: BorderRadius.full,
    marginTop: 2,
  },
  emailSubmitText: { fontFamily: Fonts.bodySemiBold, fontSize: 15, color: WHITE },
  forgotBtn:       { alignItems: "center", paddingVertical: 4 },
  forgotText:      { fontFamily: Fonts.body, fontSize: 12, color: MUTED2 },
  backToOauthBtn:  { alignItems: "center", paddingVertical: Spacing.sm },
  backToOauthText: { fontFamily: Fonts.body, fontSize: 12, color: "rgba(255,255,255,0.3)" },

  trustBar: {
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.05)",
    paddingTop: Spacing.md,
    marginBottom: Spacing["2xl"],
    overflow: "hidden",
  },
  trustLabel: {
    fontFamily: Fonts.body,
    fontSize: 8,
    letterSpacing: 2.5,
    textTransform: "uppercase",
    color: MUTED2,
    textAlign: "center",
    marginBottom: Spacing.sm,
  },
  trustItem: {
    fontFamily: Fonts.display,
    fontSize: 11,
    letterSpacing: 2,
    color: MUTED2,
    marginRight: 36,
    flexShrink: 0,
  },

  footer: { alignItems: "center", paddingBottom: Spacing.lg },
  terms:  { fontFamily: Fonts.body, fontSize: 11, color: MUTED2, textAlign: "center", lineHeight: 16 },
  termsLink: { color: "rgba(255,255,255,0.5)" },
});
