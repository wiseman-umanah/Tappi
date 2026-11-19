import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router, type Href } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { TappiLogo } from '@/components/tappi-logo';
import { Text } from '@/components/text';
import { api } from '@/lib/api';
import type { AiAction, AiConversation, AiMessage, AiTurn } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { tapFeedback } from '@/lib/feedback';
import { when } from '@/lib/format';
import { goBack } from '@/lib/nav';
import { useAiConversation, useAiConversations, useAiLanguages, useMe } from '@/lib/queries';
import { readRecording, useReplyVoice, useVoiceRecorder } from '@/lib/voice';
import colors from '@/theme/colors';

// No design yet: built from the app's existing pieces (TopBar layout, surfaces, primary pills).
// Tappi AI — the centre button in the tab bar. Type or hold the mic and talk, in the language
// picked in Profile (mixing in English is fine). Replies are read aloud. Money actions come back
// as buttons that open /approve, so nothing moves without the PIN.

const SUGGESTIONS = ["What's my balance?", 'How much did I spend this month?', 'What can I do with Tappi?', 'Send ₦2,000 to a friend'];
const TABS = new Set(['/activity', '/cards', '/profile']);

const seconds = (ms: number) => `0:${String(Math.floor(ms / 1000)).padStart(2, '0')}`;

function ActionButton({ action }: { action: AiAction }) {
  const onPress = () => {
    if (action.kind === 'approve') {
      router.push({ pathname: '/approve', params: { ...action.params, back: '1' } });
    } else if (TABS.has(action.href)) {
      // Tabs live under this modal: close it, then switch tab.
      goBack();
      router.navigate(action.href as Href);
    } else {
      router.push(action.href as Href);
    }
  };
  const approve = action.kind === 'approve';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className={cn(
        'mt-2 flex-row items-center gap-2 self-start rounded-full px-4 py-2.5',
        approve ? 'bg-primary active:bg-primary-600' : 'border border-border-secondary bg-surface-2 active:bg-surface-3',
      )}>
      <Icon name={approve ? 'shield-check-line' : 'arrow-right-up-line'} size={14} />
      <Text weight="medium" className="text-xs">
        {action.label}
      </Text>
    </Pressable>
  );
}

function Bubble({ message }: { message: AiMessage }) {
  const mine = message.role === 'user';
  return (
    <View className={cn('mb-3 max-w-[85%]', mine ? 'self-end' : 'self-start')}>
      <View className={cn('rounded-3xl px-4 py-3', mine ? 'rounded-br-md bg-primary-800' : 'rounded-bl-md bg-surface-2')}>
        {message.spoken ? (
          <View className="mb-1 flex-row items-center gap-1">
            <Icon name="mic-line" size={10} className="text-content-tertiary" />
            <Text className="text-[10px] text-content-tertiary">Spoken</Text>
          </View>
        ) : null}
        <Text className="text-sm leading-5">{message.content}</Text>
      </View>
      {message.actions.map((action) => (
        <ActionButton key={action.label} action={action} />
      ))}
    </View>
  );
}

function Thinking() {
  return (
    <View className="mb-3 flex-row items-center gap-2 self-start rounded-3xl rounded-bl-md bg-surface-2 px-4 py-3">
      <ActivityIndicator size="small" color={colors.primary.DEFAULT} />
      <Text className="text-xs text-content-tertiary">Thinking…</Text>
    </View>
  );
}

/** Past chats: tap one to continue it. */
function HistorySheet({
  visible,
  current,
  onPick,
  onDeleted,
  onClose,
}: {
  visible: boolean;
  current: string | null;
  onPick: (id: string) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const list = useAiConversations();
  const remove = useMutation({
    mutationFn: (id: string) => api(`/ai/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: (_, id) => {
      onDeleted(id);
      queryClient.removeQueries({ queryKey: ['ai-conversation', id] });
      return queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
    },
  });
  const chats = list.data?.conversations ?? [];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable className="flex-1 bg-overlay" onPress={onClose} accessibilityLabel="Close" />
      <View className="max-h-[75%] rounded-t-[32px] bg-surface-2 px-6 pt-8" style={{ paddingBottom: insets.bottom + 16 }}>
        <View className="mb-4 flex-row items-center justify-between">
          <Text weight="bold" className="text-xl">
            Your chats
          </Text>
          <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Close">
            <Icon name="close-line" size={22} />
          </Pressable>
        </View>
        {list.isPending ? (
          <ActivityIndicator className="py-8" color="#FFFFFF" />
        ) : list.isError ? (
          <Text className="py-6 text-center text-sm text-content-negative">{list.error.message}</Text>
        ) : chats.length === 0 ? (
          <Text className="py-6 text-center text-sm text-content-tertiary">No chats yet.</Text>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false}>
            {chats.map((c) => (
              <Pressable
                key={c.id}
                onPress={() => onPick(c.id)}
                className={cn(
                  'mb-2 flex-row items-center gap-3 rounded-xl border-2 bg-surface-1 py-3 pl-4 pr-2',
                  c.id === current ? 'border-primary' : 'border-border-tertiary',
                )}>
                <View className="flex-1">
                  <Text className="text-sm" numberOfLines={1}>
                    {c.title}
                  </Text>
                  <Text className="mt-0.5 text-[10px] text-content-tertiary">{when(c.updatedAt)}</Text>
                </View>
                {remove.isPending && remove.variables === c.id ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Pressable
                    onPress={() => remove.mutate(c.id)}
                    hitSlop={6}
                    accessibilityLabel={`Delete chat: ${c.title}`}
                    className="h-9 w-9 items-center justify-center rounded-full active:bg-surface-3">
                    <Icon name="delete-bin-line" size={16} className="text-content-tertiary" />
                  </Pressable>
                )}
              </Pressable>
            ))}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

export default function AssistantScreen() {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const me = useMe();
  const list = useAiConversations();
  // undefined = not chosen yet: reopen the most recent chat. null = a new chat.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const conversationId = chosen !== undefined ? chosen : list.isSuccess ? (list.data.conversations[0]?.id ?? null) : undefined;
  const chat = useAiConversation(conversationId ?? null);
  const [showHistory, setShowHistory] = useState(false);
  const languages = useAiLanguages();
  const recorder = useVoiceRecorder();
  const voice = useReplyVoice();
  const [text, setText] = useState('');
  const [voiceOn, setVoiceOn] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);

  const languageCode = me.data?.user.language ?? 'en';
  const language = languages.data?.languages.find((l) => l.code === languageCode);

  const received = (turn: AiTurn) => {
    queryClient.setQueryData<AiConversation>(['ai-conversation', turn.conversationId], (old) => ({
      id: turn.conversationId,
      title: turn.title,
      messages: [...(old?.messages ?? []), turn.question, turn.reply],
    }));
    setChosen(turn.conversationId);
    queryClient.invalidateQueries({ queryKey: ['ai-conversations'] });
    if (turn.speechId && voiceOn) voice.play(turn.speechId);
    if (turn.reply.actions.length) tapFeedback('ready', { sound: false });
  };
  const failed = (error: Error) => {
    tapFeedback('declined', { sound: false });
    setNotice(error.message);
  };

  const send = useMutation({
    mutationFn: (message: string) => api<AiTurn>('/ai/chat', { body: { text: message, conversationId, speak: voiceOn } }),
    onMutate: (message) => {
      setNotice(null);
      setPendingText(message);
    },
    onSuccess: received,
    onError: (error, message) => {
      failed(error);
      setText(message); // give it back so it can be resent
    },
    onSettled: () => setPendingText(null),
  });

  const talk = useMutation({
    mutationFn: async (uri: string) =>
      api<AiTurn>('/ai/voice', { body: { ...(await readRecording(uri)), conversationId, speak: voiceOn } }),
    onMutate: () => setNotice(null),
    onSuccess: received,
    onError: failed,
  });

  /** Old chats stay in History. */
  const newChat = () => {
    voice.stop();
    setNotice(null);
    setChosen(null);
  };
  const openChat = (id: string) => {
    voice.stop();
    setNotice(null);
    setShowHistory(false);
    setChosen(id);
  };

  const busy = send.isPending || talk.isPending;
  const messages = conversationId ? (chat.data?.messages ?? []) : [];
  const loading = conversationId === undefined ? list.isPending : conversationId !== null && chat.isPending;
  const loadError = conversationId === undefined ? list.error : conversationId !== null ? chat.error : null;

  const submit = (value = text) => {
    const message = value.trim();
    if (!message || busy) return;
    setText('');
    send.mutate(message);
  };

  const startTalking = async () => {
    if (busy || recorder.recording) return;
    voice.stop();
    setNotice(null);
    try {
      if (!(await recorder.start())) return setNotice('Allow microphone access in Settings to talk to Tappi AI.');
      tapFeedback('ready', { sound: false });
    } catch {
      setNotice("Couldn't start the microphone.");
    }
  };
  const stopTalking = async () => {
    if (!recorder.recording) return;
    const uri = await recorder.stop().catch(() => null);
    if (uri) talk.mutate(uri);
    else setNotice('Hold the mic while you talk, then let go.');
  };

  const empty = !loading && !loadError && messages.length === 0 && !pendingText && !talk.isPending;

  return (
    <KeyboardAvoidingView
      behavior="padding"
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top }}>
      <View className="mt-2 h-11 flex-row items-center gap-3 px-5">
        <Pressable
          onPress={() => goBack()}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={8}
          className="h-9 w-9 items-center justify-center rounded-full bg-surface-2">
          <Icon name="close-line" size={18} />
        </Pressable>
        <View className="flex-1 items-center">
          <Text weight="bold" className="text-base">
            Tappi AI
          </Text>
          <Pressable onPress={() => router.navigate('/profile')} hitSlop={6} className="flex-row items-center gap-1">
            <Icon name="translate-2" size={10} className="text-content-tertiary" />
            <Text className="text-[10px] text-content-tertiary">{language?.label ?? 'English'}</Text>
          </Pressable>
        </View>
        <View className="flex-row gap-1.5">
          <Pressable
            onPress={() => {
              if (voiceOn) voice.stop();
              setVoiceOn(!voiceOn);
            }}
            accessibilityRole="switch"
            accessibilityState={{ checked: voiceOn }}
            accessibilityLabel="Read replies aloud"
            hitSlop={6}
            className="h-9 w-9 items-center justify-center rounded-full bg-surface-2">
            <Icon name={voiceOn ? 'volume-up-line' : 'volume-mute-line'} size={16} className={voiceOn ? 'text-primary' : undefined} />
          </Pressable>
          <Pressable
            onPress={() => setShowHistory(true)}
            accessibilityRole="button"
            accessibilityLabel="Your chats"
            hitSlop={6}
            className="h-9 w-9 items-center justify-center rounded-full bg-surface-2">
            <Icon name="history-line" size={16} />
          </Pressable>
          <Pressable
            onPress={newChat}
            disabled={busy || conversationId === null}
            accessibilityRole="button"
            accessibilityLabel="New chat"
            hitSlop={6}
            className={cn('h-9 w-9 items-center justify-center rounded-full bg-surface-2', (busy || conversationId === null) && 'opacity-40')}>
            <Icon name="chat-new-line" size={16} />
          </Pressable>
        </View>
      </View>

      <ScrollView
        ref={scroll}
        className="flex-1"
        contentContainerClassName="flex-grow px-5 pt-6"
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        {loading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator color="#FFFFFF" />
          </View>
        ) : loadError ? (
          <View className="flex-1 items-center justify-center px-6">
            <Text className="text-center text-sm text-content-negative">{loadError.message}</Text>
          </View>
        ) : empty ? (
          <View className="flex-1 items-center justify-center pb-10">
            <View className="h-16 w-16 items-center justify-center rounded-full bg-primary" style={{ boxShadow: `0 0 28px ${colors.primary.DEFAULT}99` }}>
              <TappiLogo size={28} />
            </View>
            <Text weight="bold" className="mt-5 text-xl">
              {`Hi ${me.data?.user.name?.split(' ')[0] ?? 'there'}`}
            </Text>
            <Text className="mt-1 px-6 text-center text-xs text-content-tertiary">
              {`Ask about your money, or tell me what to do. Talk in ${language?.label ?? 'English'}, mix in English if you like.`}
            </Text>
            <View className="mt-8 flex-row flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <Pressable key={s} onPress={() => submit(s)} className="rounded-full border border-border-tertiary bg-surface-1 px-3.5 py-2 active:bg-surface-3">
                  <Text className="text-xs">{s}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          <>
            {messages.map((m) => (
              <Bubble key={m.id} message={m} />
            ))}
            {pendingText ? (
              <Bubble message={{ id: 'pending', role: 'user', content: pendingText, spoken: false, actions: [], at: '' }} />
            ) : null}
            {busy ? <Thinking /> : null}
          </>
        )}
      </ScrollView>

      <View className="px-5 pt-2" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
        {notice ? <Text className="mb-2 text-center text-xs text-content-negative">{notice}</Text> : null}
        {voice.preparing || voice.speaking ? (
          <Pressable onPress={voice.stop} className="mb-2 flex-row items-center justify-center gap-1.5">
            <Icon name={voice.speaking ? 'volume-up-line' : 'sparkling-2-line'} size={12} className="text-primary" />
            <Text className="text-[11px] text-primary">{voice.speaking ? 'Speaking · tap to stop' : 'Getting the voice ready…'}</Text>
          </Pressable>
        ) : null}

        <View className="flex-row items-end gap-2">
          {recorder.recording ? (
            <View className="h-[52px] flex-1 flex-row items-center gap-3 rounded-full bg-surface-2 px-5">
              <View className="h-2.5 w-2.5 rounded-full bg-background-negative" />
              <Text className="flex-1 text-sm">{`Listening… ${seconds(recorder.durationMs)}`}</Text>
              <Text className="text-[11px] text-content-tertiary">Let go to send</Text>
            </View>
          ) : (
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={talk.isPending ? 'Listening to your message…' : 'Message Tappi AI'}
              placeholderTextColor={colors.content.disabled}
              multiline
              maxLength={2000}
              editable={!talk.isPending}
              className="max-h-32 min-h-[52px] flex-1 rounded-[26px] bg-surface-2 px-5 py-3.5 font-sans text-sm text-white"
            />
          )}
          {text.trim() && !recorder.recording ? (
            <Pressable
              onPress={() => submit()}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Send"
              className={cn('h-[52px] w-[52px] items-center justify-center rounded-full bg-primary', busy && 'opacity-50')}>
              <Icon name="send-plane-2-fill" size={20} />
            </Pressable>
          ) : (
            <Pressable
              onPressIn={startTalking}
              onPressOut={stopTalking}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Hold to talk"
              className={cn('h-[52px] w-[52px] items-center justify-center rounded-full bg-primary', busy && 'opacity-50')}
              style={recorder.recording ? { transform: [{ scale: 1.1 + recorder.level * 0.25 }], boxShadow: `0 0 24px ${colors.primary.DEFAULT}AA` } : undefined}>
              <Icon name={recorder.recording ? 'mic-fill' : 'mic-line'} size={22} />
            </Pressable>
          )}
        </View>
        {!recorder.recording && !text.trim() && !busy ? (
          <Text className="mt-2 text-center text-[10px] text-content-tertiary">Hold the mic to talk · money only moves after your PIN</Text>
        ) : null}
      </View>
      <HistorySheet
        visible={showHistory}
        current={conversationId ?? null}
        onPick={openChat}
        onDeleted={(id) => {
          if (id === conversationId) newChat();
        }}
        onClose={() => setShowHistory(false)}
      />
    </KeyboardAvoidingView>
  );
}
