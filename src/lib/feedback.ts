import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';

export type TapOutcome = 'success' | 'declined' | 'timeout';
type Cue = TapOutcome | 'ready';

const sources: Record<Cue, number> = {
  ready: require('../../assets/sounds/nfc-ready.mp3'),
  success: require('../../assets/sounds/tap-success.mp3'),
  declined: require('../../assets/sounds/tap-declined.mp3'),
  timeout: require('../../assets/sounds/tap-timeout.mp3'),
};

const players: Partial<Record<Cue, AudioPlayer>> = {};

function play(cue: Cue) {
  const player = (players[cue] ??= createAudioPlayer(sources[cue]));
  player.seekTo(0).then(() => player.play());
}

/**
 * Sound + haptic cue for NFC events (PRD 4.2). `sound` should follow the
 * user's "Tap sound & haptics" preference on the Cards screen.
 */
export function tapFeedback(cue: Cue, { sound = true }: { sound?: boolean } = {}) {
  if (sound) play(cue);
  switch (cue) {
    case 'ready':
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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
