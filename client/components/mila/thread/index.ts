/**
 * client/components/mila/thread — Mila's chat v2 module (EXPO_PUBLIC_MILA_THREAD_V2). The ONLY place in the app that
 * may import @assistant-ui/*, @ai-sdk/* or `ai` (thread/importGuard.test.ts fails otherwise), so a library upgrade
 * touches this folder alone. The card views it draws live in ../cards and know nothing about the library.
 */
export { MilaThreadScreen, type MilaThreadScreenProps } from "./MilaThreadScreen";
/** DEV ONLY: the agent gallery's scripted chat v2 pages. */
export { galleryApi, galleryOptions, type GalleryScript } from "./galleryFixture";
