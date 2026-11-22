import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useChatEngine } from '@/hooks/use-chat-engine';
import { usePolicies } from '@/hooks/use-policies';
import { policyLock } from '@/lib/policies-api';
import { appNeedsUpdateForCalls, callSetup, type CallSetupCheck } from '@/lib/platform';
import { useUserSettings } from '@/hooks/use-settings';
import type { UserSettingValues } from '@/lib/settings-api';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SettingsBlock, SettingsRow, SettingsSection } from '@/components/settings/SettingsLayout';
import { ADMIN_REASON, allowedByFloor, policyReason } from '@/components/settings/setting-policy';
import { ChatPassphraseDialog } from '@/components/chat/ChatPassphrase';
import { useChatSnapshot } from '@/components/chat/chat-state';

const DETAIL: { value: UserSettingValues['chat_notification_detail']; label: string }[] = [
  { value: 'full', label: 'Sender and message' },
  { value: 'sender', label: 'Sender only' },
  { value: 'none', label: 'Nothing, just “New message”' },
];
const DETAIL_ORDER = DETAIL.map(option => option.value);

// What the encryption protects, one entry per sentence so each is easy to change.
const PROTECTION = [
  'Your messages are encrypted on your device before they leave it.',
  'Someone who reads the server\'s database, a backup, its disks or its logs cannot read them, and neither can an administrator.',
  'This does not protect against a server that someone has changed to attack its users.',
];
// What a phone needs for calls, as the app reports it.
const CALL_SETUP: Record<CallSetupCheck['id'], { label: string; description: string }> = {
  microphone: { label: 'Microphone', description: 'Android cannot ask for it over the lock screen, so it is asked before your first call.' },
  full_screen: { label: 'Full-screen call screens', description: 'An incoming call shows over the lock screen. Without it Android shows a banner.' },
  notifications: { label: 'Notifications', description: 'While the app is closed, calls ring on this phone only while UniHub\'s notifications are on.' },
  background: { label: 'Allow in background', description: 'The phone rings reliably while it sleeps.' },
};
const SCREENSHOTS = 'A browser cannot block screenshots; the Android app blocks them while Chat is open.';

/**
 * Settings › Chat: what others see of the person (presence, read receipts),
 * what a chat notification shows, how long messages are kept and how large a
 * file may be for this person, calls, the passphrase of this device's history, and
 * what the encryption does and does not protect. The server applies the
 * three choices and an administrator's locks; the page only reflects them.
 */
export default function ChatSettings() {
  const { settings, values, change, unavailable } = useUserSettings();
  const { policies } = usePolicies();
  const engine = useChatEngine();
  const snapshot = useChatSnapshot(engine);
  const [dialog, setDialog] = useState<'change' | 'new-key' | null>(null);
  // A locked switch says why in the server's words.
  const lock = (key: 'chat_presence' | 'chat_read_receipts', policy: 'chat.presence' | 'chat.read_receipts') =>
    settings[key].locked ? policies[policy].reason ?? ADMIN_REASON : undefined;
  const detail = settings.chat_notification_detail;
  const state = snapshot?.readiness.state ?? 'starting';
  const retention = policies['chat.retention_days'].value;
  const [setup, setSetup] = useState<CallSetupCheck[] | null>(null);
  // Asked again when the page shows: Android's question or setting may have changed an answer.
  useEffect(() => {
    let stopped = false;
    const ask = () => { if (document.visibilityState === 'visible') void callSetup().then(checks => { if (!stopped) setSetup(checks); }); };
    ask();
    document.addEventListener('visibilitychange', ask);
    return () => { stopped = true; document.removeEventListener('visibilitychange', ask); };
  }, []);

  return (
    <>
      <SettingsSection title="Chat" description="Saved with your account, so every device follows.">
        <SettingsRow label="Show when I have UniHub open" htmlFor="chat-presence" lock={lock('chat_presence', 'chat.presence')}
          description="People you chat with see a dot at your name while UniHub is open. With this off, you do not see theirs either.">
          <Switch id="chat-presence" checked={values.chat_presence} disabled={unavailable || settings.chat_presence.locked} onCheckedChange={checked => change({ chat_presence: checked })} />
        </SettingsRow>
        <SettingsRow label="Read receipts" htmlFor="chat-receipts" lock={lock('chat_read_receipts', 'chat.read_receipts')}
          description="The other person sees when you have read their message. With this off, you do not see it for yours either.">
          <Switch id="chat-receipts" checked={values.chat_read_receipts} disabled={unavailable || settings.chat_read_receipts.locked} onCheckedChange={checked => change({ chat_read_receipts: checked })} />
        </SettingsRow>
        <SettingsRow label="What a notification shows" htmlFor="chat-detail" lock={policyReason(detail)}
          description="The sender and the message, the sender, or only that a message arrived.">
          <Select value={values.chat_notification_detail} disabled={unavailable || detail.locked}
            onValueChange={value => change({ chat_notification_detail: value as UserSettingValues['chat_notification_detail'] })}>
            <SelectTrigger id="chat-detail" className="w-full sm:w-64"><SelectValue /></SelectTrigger>
            <SelectContent>
              {DETAIL.map(option => <SelectItem key={option.value} value={option.value} disabled={!allowedByFloor(detail, DETAIL_ORDER, option.value)}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Messages and files" description="Set by your administrator.">
        <SettingsRow label={retention ? `Messages are deleted after ${retention} days` : 'Messages are kept'}
          description={<span className="block max-w-prose">{retention ? 'On the server and on your devices, in every chat you are in.' : 'Nothing is deleted on its own.'} A chat with someone under a shorter time follows theirs and says so at its top.</span>} />
        <SettingsRow label={`Files up to ${policies['chat.attachment_max_mb'].value} MB`} description="The largest file or voice message you can send in a chat." />
      </SettingsSection>

      <SettingsSection title="Calls">
        <SettingsRow label="Voice calls with a colleague" lock={policyLock(policies['chat.calls'])}
          description={<span className="block max-w-prose">Call from your chat with them or from their entry in Contacts. A call you miss stays in the chat. The sound is encrypted between the two devices and is not kept anywhere.</span>} />
        {appNeedsUpdateForCalls() && <SettingsBlock><p className="text-sm">Update the UniHub app to get calls while it is closed.</p></SettingsBlock>}
      </SettingsSection>

      {setup && (
        <SettingsSection title="Calls on this phone" description="What the app needs to ring and to hold a call.">
          {setup.map(check => (
            <SettingsRow key={check.id} label={CALL_SETUP[check.id].label} description={CALL_SETUP[check.id].description}>
              {check.ok ? <span className="text-sm text-muted-foreground">Allowed</span> : <Button variant="outline" onClick={check.fix}>Allow…</Button>}
            </SettingsRow>
          ))}
        </SettingsSection>
      )}

      <SettingsSection title="Chat passphrase" description="Without it and without another signed-in device, a lost device means lost history: nobody else can restore it.">
        {snapshot?.holds_history_key ? (
          <SettingsRow label="This device has your chat history" description="A new passphrase needs your account password, not the old passphrase.">
            <Button variant="outline" onClick={() => setDialog('change')}>Set a new passphrase…</Button>
          </SettingsRow>
        ) : state === 'waiting' ? (
          <SettingsRow label="This device is not in Chat yet" description="Let it in with your chat passphrase, or approve it on another of your devices.">
            <Button asChild variant="outline"><Link to="/chat">Open Chat</Link></Button>
          </SettingsRow>
        ) : state === 'enter-passphrase' ? (
          <>
            <SettingsRow label="This device does not have your earlier messages" description="Enter the passphrase you chose on another device.">
              <Button asChild variant="outline"><Link to="/chat">Enter passphrase</Link></Button>
            </SettingsRow>
            <SettingsRow label="Forgot the passphrase?" description="Set a new one on a device that still shows your chats. If none does, start a new key: earlier messages that no device of yours holds are then lost.">
              <Button variant="outline" onClick={() => setDialog('new-key')}>Start a new key…</Button>
            </SettingsRow>
          </>
        ) : state === 'choose-passphrase' ? (
          <SettingsRow label="No passphrase yet" description="Chat asks you to choose one when you first open it.">
            <Button asChild variant="outline"><Link to="/chat">Open Chat</Link></Button>
          </SettingsRow>
        ) : (
          <SettingsBlock>
            <p className="text-sm text-muted-foreground">{snapshot && 'reason' in snapshot.readiness ? snapshot.readiness.reason : 'Chat is starting on this device…'}</p>
          </SettingsBlock>
        )}
        <SettingsBlock>
          <p className="max-w-prose text-sm text-muted-foreground">A new phone or browser gets nothing of Chat until you let it in. There are two ways: enter your chat passphrase on it, or approve it on a device that shows your chats, after checking that both show the same code. Either way your earlier messages come along.</p>
        </SettingsBlock>
      </SettingsSection>

      <SettingsSection title="What the encryption protects">
        <SettingsBlock className="max-w-prose space-y-2 text-sm">
          {PROTECTION.map(sentence => <p key={sentence}>{sentence}</p>)}
          <p className="text-muted-foreground">{SCREENSHOTS}</p>
        </SettingsBlock>
      </SettingsSection>

      {engine && <ChatPassphraseDialog engine={engine} mode={dialog} onClose={() => setDialog(null)} />}
    </>
  );
}
