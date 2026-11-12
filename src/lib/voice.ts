import {
  IOSOutputFormat,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio';
import { useEffect, useRef, useState } from 'react';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

import { api, apiUrl, authHeaders } from '@/lib/api';

/**
 * Voice for Tappi AI: hold the mic to record a message (sent to Whisper on the server), and play
 * the spoken replies (Sahara or Orpheus). expo-audio is in Expo Go, so this works without a new
 * development build.
 */

/** Speech, not music: mono, 16 kHz, small AAC files that upload quickly. */
const SPEECH: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 16_000,
  numberOfChannels: 1,
  bitRate: 32_000,
  isMeteringEnabled: true,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: 96 },
  web: { mimeType: 'audio/webm', bitsPerSecond: 32_000 },
};

/** Shorter than this is a slip of the finger, not a message. */
export const MIN_RECORDING_MS = 600;
export const MAX_RECORDING_MS = 60_000;

export function useVoiceRecorder() {
  const recorder = useAudioRecorder(SPEECH);
  const state = useAudioRecorderState(recorder, 100);

  /** Returns false if the microphone permission was refused. */
  const start = async () => {
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) return false;
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: MAX_RECORDING_MS / 1000 });
    return true;
  };

  /** Stops and returns the recording, or null if it was too short to be a message. */
  const stop = async () => {
    const duration = recorder.currentTime * 1000;
    await recorder.stop();
    // Back to playback mode, or iPhones play replies through the earpiece.
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    const uri = recorder.uri;
    if (!uri || duration < MIN_RECORDING_MS) return null;
    return uri;
  };

  return {
    recording: state.isRecording,
    durationMs: state.durationMillis,
    /** 0–1 loudness while recording, for the level ring. */
    level: state.metering == null ? 0 : Math.max(0, Math.min(1, (state.metering + 50) / 50)),
    start,
    stop,
  };
}

/**
 * The recording as base64 for POST /api/ai/voice. Sent as JSON like every other request:
 * React Native's multipart file upload fails on some Android phones ("Network request failed").
 */
export async function readRecording(uri: string): Promise<{ audio: string; format: 'm4a' | 'webm' }> {
  if (Platform.OS === 'web') {
    // The browser recorder hands back a blob: URL of WebM audio.
    const bytes = new Uint8Array(await (await fetch(uri)).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { audio: btoa(binary), format: 'webm' };
  }
  const file = new File(uri);
  if (!file.exists || file.size === 0) throw new Error("The recording didn't save. Try again.");
  return { audio: await file.base64(), format: 'm4a' };
}

/** Plays Tappi AI's spoken replies, one at a time. */
export function useReplyVoice() {
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const latest = useRef<string | null>(null);
  /** A reply whose voice is still being made. */
  const [preparing, setPreparing] = useState(false);
  // The player is released on unmount; a voice still being made must not start after that.
  useEffect(
    () => () => {
      latest.current = null;
    },
    [],
  );

  /** Waits for the server to finish the voice (Sahara can take a while), then plays it. */
  const play = async (speechId: string) => {
    latest.current = speechId;
    player.pause();
    setPreparing(true);
    const { ready } = await api<{ ready: boolean }>(`/ai/speech/${speechId}/ready`).catch(() => ({ ready: false }));
    // A newer reply (or stop()) came in while this one was being made.
    if (latest.current !== speechId) return;
    setPreparing(false);
    if (!ready) return;
    player.replace({ uri: apiUrl(`/ai/speech/${speechId}`), headers: authHeaders() });
    player.play();
  };

  const stop = () => {
    latest.current = null;
    setPreparing(false);
    player.pause();
  };

  return { play, stop, speaking: status.playing, preparing };
}
