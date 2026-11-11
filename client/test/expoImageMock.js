// Jest only: expo-image's native view does not render under the test renderer, so every suite sees it as react-native's
// Image (same `source.uri`, contentFit mapped to resizeMode). A suite's own jest.mock("expo-image") still wins.
jest.mock("expo-image", () => {
  const React = require("react");
  const RN = require("react-native");
  const fit = { cover: "cover", contain: "contain", fill: "stretch", none: "center", "scale-down": "contain" };
  const Image = ({ source, style, contentFit, testID, onError, accessibilityLabel }) =>
    React.createElement(RN.Image, { source, style, resizeMode: fit[contentFit] || "cover", testID, onError, accessibilityLabel });
  Image.prefetch = () => Promise.resolve(true);
  Image.clearMemoryCache = () => Promise.resolve(true);
  Image.clearDiskCache = () => Promise.resolve(true);
  return { Image };
});
