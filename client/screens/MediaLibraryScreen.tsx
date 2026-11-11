import React from "react";
import { View, Text, SafeAreaView, StatusBar, Pressable, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { StudioStackParamList } from "../navigation/MainTabNavigator";
import { MediaLibraryView } from "../components/media/MediaLibraryView";
import { Colors, Fonts, Spacing } from "../constants/theme";

// The standalone library (Studio masthead → media icon). Tapping a tile opens its "What Mila saw"
// detail. The same MediaLibraryView is reused inside the card editor as a pick-mode browser.
export function MediaLibraryScreen() {
  const nav = useNavigation<NativeStackNavigationProp<StudioStackParamList>>();
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <Pressable onPress={() => nav.goBack()} style={styles.icoBtn} hitSlop={10}>
          <Feather name="chevron-left" size={24} color={Colors.light.text} />
        </Pressable>
        <Text style={styles.title}>Media library</Text>
        <View style={styles.icoBtn} />
      </View>
      <MediaLibraryView
        onOpenDetail={(assetId) => nav.navigate("MediaDetail", { assetId })}
        onReviewCameraRoll={() => nav.navigate("CameraRollReview")}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.light.backgroundRoot },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm },
  icoBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  title: { flex: 1, textAlign: "center", fontFamily: Fonts.heading, fontSize: 18, fontWeight: "700", color: Colors.light.text },
});
