import { router, type Href } from 'expo-router';

/**
 * Leave a flow (pay, approve) for the home tab. `dismissTo('/')` is a no-op with a dev warning
 * when the flow was opened from a link (NFC tap, camera, chat app) and nothing sits beneath it.
 */
export function goHome() {
  if (!router.canDismiss()) return router.replace('/');
  router.dismissAll();
  router.navigate('/'); // the tab bar may be on another tab
}

/** `router.back()` that falls back to `fallback` when the screen was opened directly. */
export function goBack(fallback: Href = '/') {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}
