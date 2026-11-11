// The Me entry: her avatar, pressable, opening MeStack › Me above the tabs.
//
//   MeAvatar        the button itself. The shell's top bar (components/shell/TopBar.tsx) draws it once on every main
//                   tab screen — on the page, or on a photo hero in white (`onHero`). A circle with a 2px edge: white on
//                   a photo, ink on white (DESIGN.md "Avatar", look B).
//
// Her photo when there is one: THE SAME photo the Home / Me hero shows — her best eligible library photo through
// `useMePhotos` (hero first) — else athletes.photo_url (lib/myStoryLogic `avatarPhotoUrl`). With no photo at all, the
// DESIGN.md Avatar fallback: her sport's icon (lib/knowledgeLogic `sportIcon`, by the kind of sport; "user" with none)
// centred in a circle on the neutral ground — not an initial, never a brand-colour tint.

import React from "react";
import { View, Pressable, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import { useMeOverview, useMePhotos } from "../../hooks/use-me-knowledge";
import { haptics } from "../../lib/haptics";
import { sportIcon } from "../../lib/knowledgeLogic";
import { avatarPhotoUrl } from "../../lib/myStoryLogic";
import { openMe } from "../../navigation/meNav";
import { Bold } from "../../constants/theme";
import { Photo } from "../ui/Photo";

type IconName = React.ComponentProps<typeof Feather>["name"];

/** The header avatar's diameter. Headers that centre a title against it size their opposite spacer to match. */
export const ME_AVATAR_SIZE = 32;

export function MeAvatar({ style, size = ME_AVATAR_SIZE, onHero }: { style?: StyleProp<ViewStyle>; size?: number; onHero?: boolean }) {
  const navigation  = useNavigation();
  const { data }    = useMeOverview();
  const photos      = useMePhotos(1);
  const photoUrl    = avatarPhotoUrl(data?.identity.photoUrl, photos);
  const icon        = sportIcon(data?.identity.primary?.sport) as IconName;
  const round       = { width: size, height: size, borderRadius: size / 2 };

  return (
    <Pressable
      onPress={() => { haptics.press(); openMe(navigation); }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Open Me"
      style={({ pressed }) => [round, pressed && styles.pressed, style]}
    >
      {photoUrl ? (
        <Photo uri={photoUrl} style={[styles.avatar, round, onHero && styles.avatarOnHero]} transition={0} />
      ) : (
        <View style={[styles.avatar, round, styles.avatarEmpty, onHero && styles.avatarOnHero]} testID="me-avatar-fallback">
          <Feather name={icon} size={Math.round(size * 0.5)} color={onHero ? Bold.onDark : Bold.ink} />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed:       { opacity: 0.7 },
  avatar:        { backgroundColor: Bold.ground, borderWidth: 2, borderColor: Bold.ink },
  avatarOnHero:  { backgroundColor: Bold.heroBlank, borderColor: Bold.onDark },
  avatarEmpty:   { alignItems: "center", justifyContent: "center" },
});
