import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';

import { getPreferences } from '@/lib/preferences';

export type TapOutcome = 'success' | 'declined' | 'timeout';
/** ping = searching for phones nearby; found = a new one showed up. */
type Cue = TapOutcome | 'ready' | 'ping' | 'found';

const sources: Record<Cue, number> = {
  ready: require('../../assets/sounds/nfc-ready.mp3'),
  success: require('../../assets/sounds/tap-success.mp3'),
  declined: require('../../assets/sounds/tap-declined.mp3'),
  timeout: require('../../assets/sounds/tap-timeout.mp3'),
  ping: require('../../assets/sounds/nearby-ping.mp3'),
  found: require('../../assets/sounds/nearby-found.mp3'),
};

const players: Partial<Record<Cue, AudioPlayer>> = {};

function play(cue: Cue) {
  const player = (players[cue] ??= createAudioPlayer(sources[cue]));
  player.seekTo(0).then(() => player.play());
}

/** Sound + haptic cue for NFC events (PRD 4.2), unless the user turned them off on the Cards screen. */
export function tapFeedback(cue: Cue, { sound = true }: { sound?: boolean } = {}) {
  // Cards → "Tap sound & haptics" turns both off.
  if (!getPreferences().tapSound) return;
  if (sound) play(cue);
  switch (cue) {
    case 'ready':
    case 'found':
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      break;
    case 'ping':
      break;
    case 'success':
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      break;
    case 'declined':
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      break;
    case 'timeout':
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      break;
  }
}
