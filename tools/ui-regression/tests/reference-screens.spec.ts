// The reference screens of docs/UI_ACCEPTANCE.md "Baselines and approval":
// Mail with a message open (Wide), ToDo (Wide and Phone), Recordings library
// (Phone), Settings -> Appearance (Wide), the composer (Phone), since 0.26.0
// the contact detail, the contact editor and the merge review (Wide and
// Phone), and since 0.27.0 a ToDo row picked up by its handle, the new-task
// dialog with its list chooser open (Wide and Phone) and Settings -> Pages
// (Wide), and since 0.28.0 Settings -> Backup and restore (Wide), the bin
// (Wide and Phone) and Server settings -> Policies (Wide), and since 0.29.0
// Settings -> App lock (Wide and Phone), the whole-app lock screen (Phone), a
// module's lock screen (Wide), the required-by-your-administrator prompt
// (Phone), the Policies page at its App lock group (Wide) and Settings ->
// Security with Devices (Wide), and since 0.30.0 Server -> People, a person,
// Groups and a group's rules (Wide), the setup link page and the required
// two-factor set-up (Phone), and since 0.31.0 a shared address book with a
// contact open and its share dialog (Wide), the book's list and a company
// directory entry (Phone) and Server -> Shared books (Wide), and since 0.32.0
// the calendars others share and a calendar's share dialog (Wide), an event
// as a contributor reads it (Phone), an offered calendar, the hand-over
// dialog, Server -> Calendars and the calendars of a leaving person (Wide)
// and a custom repeat rule (Phone), and Chat with an open chat at
// its newest and at its first messages (Wide), the list and an open chat
// (Phone), and the chat passphrase chosen and entered and Settings -> Chat
// (Wide and Phone), and a group chat and its people, files in a chat, the
// voice recorder and chat search (Wide and Phone), and the save dialog of a
// shorter chat retention and a retention that waits on Server -> Policies
// (Wide and Phone), and Chat on a device that is not in it yet (as it
// opens, with the code of a request, and with no other device in Chat) and
// the dialog that approves such a device (Wide and Phone), each in Dark
// Default and Light Default.
// One hundred and fifty-eight pictures; see docs/UI_BASELINES.md.
import { chatPicturesDrawn, customRepeat, expect, expectBaseline, sharedCalendars, silentMicrophone, test, THEMES, VIEWPORTS, withCall, withChat, type Page } from '../support/test.ts';
import { CALL_ANSWERED_AT, CHAT_APPROVAL, CHAT_CALL_THREAD, CHAT_DEVICES_IN_CHAT, CURRENT_DEVICE_LOCKED, POLICIES_ADMIN_APP_LOCK, POLICIES_ADMIN_RETENTION, POLICIES_EFFECTIVE_APP_LOCK, POLICIES_EFFECTIVE_TWO_FACTOR, RETENTION_WAITING, USER } from '../support/fixtures.ts';

// The app lock's state is this browser's (a PIN record in IndexedDB
// `unihub-lock-v1`, as src/lib/app-lock/pin.ts keeps it) plus the server's
// answer for this device. A PIN record without a timeline asks at start; the
// pictures never unlock, so the hash is arbitrary.
async function seedPin(page: Page) {
  await page.addInitScript((userId: string) => {
    const request = indexedDB.open('unihub-lock-v1', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('pins')) db.createObjectStore('pins', { keyPath: 'userId' });
      if (!db.objectStoreNames.contains('timeline')) db.createObjectStore('timeline', { keyPath: 'userId' });
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['pins'], 'readwrite');
      tx.objectStore('pins').put({ v: 1, userId, salt: new Uint8Array(16), iterations: 1000, hash: new Uint8Array(32), failures: 0, waitUntil: null, createdAt: Date.now() });
      tx.oncomplete = () => db.close();
    };
  }, USER.id);
}
/** This device locks Mail and Contacts under the administrator's rule; `scope` overrides what it locks, `meets` whether it has a method. */
async function lockedDevice(page: Page, { scope = CURRENT_DEVICE_LOCKED.settings.app_lock_scope.value, meets = true }: { scope?: string[]; meets?: boolean } = {}) {
  // A device short of the requirement reports no lock yet (otherwise its PIN would count as lost, not missing).
  const body = { ...CURRENT_DEVICE_LOCKED, device: { ...CURRENT_DEVICE_LOCKED.device, lock: meets ? CURRENT_DEVICE_LOCKED.device.lock : null },
    settings: { ...CURRENT_DEVICE_LOCKED.settings, app_lock_scope: { ...CURRENT_DEVICE_LOCKED.settings.app_lock_scope, value: scope } }, compliance: { ...CURRENT_DEVICE_LOCKED.compliance, meets } };
  await page.route('**/api/devices/current', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
  await page.route('**/api/settings/values/device', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ device_id: body.device.id, settings: body.settings }) }));
  // The rules that put the floors there, with the server's reasons beside the greyed choices.
  await page.route('**/api/policies/effective', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POLICIES_EFFECTIVE_APP_LOCK) }));
}

/** A setup link's token as the address carries it; synthetic, the fixture router accepts any. */
const INVITE_TOKEN = 'c3ludGhldGljLXNldHVwLWxpbmstdG9rZW4tMDEyMzQ1Njc4OQ';

// A row picked up with the keyboard (P-29, D29/D31): Space on the ≡ handle
// lifts the row with everything it holds; the picture shows that state.
async function pickUpRow(page: Page, title: string) {
  const handle = page.getByRole('button', { name: `Reorder ${title}` });
  await handle.focus();
  await page.keyboard.press('Space');
  await expect(handle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('status').filter({ hasText: `Picked up ${title}` })).toHaveCount(1);
}

// The new-task dialog with its chooser open: the lists grouped by account,
// the server calendar greyed out for a task without a date.
async function openNewTaskChooser(page: Page) {
  await page.getByRole('button', { name: 'New task', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'List' }).click();
  await expect(page.getByRole('option', { name: /Team/ })).toBeVisible();
}

// The chat passphrase where it is chosen (first Chat open) and entered (a new device), and Settings -> Chat.
function chatPassphraseAndSettings(viewport: 'wide' | 'phone', theme: string) {
  test.describe(`chat passphrase and settings (${viewport}, ${theme})`, () => {
    test.use(VIEWPORTS[viewport]);

    test(`choose the chat passphrase (${viewport}, ${theme})`, async ({ page, open, settle }) => {
      await withChat(page, { readiness: { state: 'choose-passphrase' } });
      await open('/chat');
      // Long enough and of two kinds, so the hint under the field reads "Strong."
      await page.getByLabel('Chat passphrase').fill('correct horse battery');
      await expect(page.getByText('Strong.')).toBeVisible();
      await settle();
      await expectBaseline(page, `chat-passphrase-choose-${viewport}-${theme}.png`);
    });

    test(`enter the chat passphrase (${viewport}, ${theme})`, async ({ page, open, settle }) => {
      await withChat(page, { readiness: { state: 'enter-passphrase' } });
      await open('/chat');
      await expect(page.getByRole('button', { name: 'Start a new key…' })).toBeVisible();
      await settle();
      await expectBaseline(page, `chat-passphrase-enter-${viewport}-${theme}.png`);
    });

    // A device that is not in Chat yet: the two ways in and why a new key cannot be started; the code of a request; no other device in Chat.
    for (const [name, waiting, shows] of [
      ['chat-waiting', { approvers: CHAT_DEVICES_IN_CHAT, code: null, code_expires_at: null }, 'Ask for approval'],
      ['chat-waiting-code', { approvers: CHAT_DEVICES_IN_CHAT, code: '481516', code_expires_at: '2026-06-15T09:38:20.000Z' }, 'Ask again'],
      ['chat-waiting-alone', { approvers: [], code: null, code_expires_at: null }, 'Start a new key…'],
    ] as const) {
      test(`${name} (${viewport}, ${theme})`, async ({ page, open, settle }) => {
        await withChat(page, { readiness: { state: 'waiting', ...waiting } });
        await open('/chat');
        await expect(page.getByRole('button', { name: shows })).toBeVisible();
        await settle();
        await expectBaseline(page, `${name}-${viewport}-${theme}.png`);
      });
    }

    test(`a device asks to join the chats (${viewport}, ${theme})`, async ({ page, open, settle }) => {
      await withChat(page, { approvals: [CHAT_APPROVAL] });
      await open('/chat');
      await expect(page.getByRole('dialog', { name: 'A device asks to join your chats' }).getByRole('button', { name: 'Approve' })).toBeVisible();
      await settle();
      await expectBaseline(page, `chat-approval-${viewport}-${theme}.png`);
    });

    test(`settings chat (${viewport}, ${theme})`, async ({ page, open, settle }) => {
      await withChat(page);
      await open('/settings?section=chat');
      await expect(page.getByRole('button', { name: 'Set a new passphrase…' })).toBeVisible();
      await settle();
      await expectBaseline(page, `settings-chat-${viewport}-${theme}.png`);
    });
  });
}

// A call over the page: the dialog while someone calls, the call's screen in four of its states, and the calls' entries in the chat.
function calls(viewport: 'wide' | 'phone', theme: string) {
  test.describe(`calls (${viewport}, ${theme})`, () => {
    test.use(VIEWPORTS[viewport]);

    for (const [name, call, shows] of [
      ['call-ringing', { incoming: true, state: 'ringing', here: false }, 'Answer'],
      ['call-calling', { state: 'calling' }, 'Hang up'],
      ['call-active', { state: 'active', answered_at: CALL_ANSWERED_AT }, 'Hang up'],
      ['call-reconnecting', { state: 'reconnecting', answered_at: CALL_ANSWERED_AT, muted: true }, 'Hang up'],
      ['call-ended', { state: 'ended', ended: 'failed' }, 'Close'],
    ] as const) {
      test(`${name} (${viewport}, ${theme})`, async ({ page, open, settle }) => {
        await withChat(page);
        await withCall(page, call);
        await open('/chat');
        await expect(page.getByRole('button', { name: shows, exact: true })).toBeVisible();
        await settle();
        await expectBaseline(page, `${name}-${viewport}-${theme}.png`);
      });
    }

    // The call alone, as a notification of a call opens it and as the Android app's call screen loads it.
    if (viewport === 'phone') test(`call page (${viewport}, ${theme})`, async ({ page, open, settle }) => {
      await withChat(page);
      await withCall(page, { incoming: true, state: 'ringing', here: false });
      await open('/call?id=call-1');
      await expect(page.getByRole('button', { name: 'Answer', exact: true })).toBeVisible();
      await settle();
      await expectBaseline(page, `call-page-${viewport}-${theme}.png`);
    });

    test(`calls in a chat (${viewport}, ${theme})`, async ({ page, open, settle }) => {
      await withChat(page, { threads: CHAT_CALL_THREAD });
      await open('/chat?c=chat-blair');
      await expect(page.getByText('Voice call, 5 min')).toBeVisible();
      await settle();
      await expectBaseline(page, `chat-calls-${viewport}-${theme}.png`);
    });
  });
}

// Chat retention on Server -> Policies as the owner: the save dialog of a
// shorter time with the server's count, and the change that waits its 24 hours.
function chatRetention(viewport: 'wide' | 'phone', theme: string) {
  test.describe(`chat retention (${viewport}, ${theme})`, () => {
    test.use({ ...VIEWPORTS[viewport], admin: true });

    test(`the save dialog of a shorter chat retention (${viewport}, ${theme})`, async ({ page, open, settle }) => {
      await open('/admin/policies');
      await page.getByRole('combobox', { name: 'Delete chat messages after' }).click();
      await page.getByRole('option', { name: '30 days' }).click();
      await page.getByRole('button', { name: 'Save changes…' }).click();
      await expect(page.getByText(/^128 messages and 9 files in 6 chats/)).toBeVisible();
      await settle();
      await expectBaseline(page, `chat-retention-dialog-${viewport}-${theme}.png`);
    });

    test(`a chat retention that waits (${viewport}, ${theme})`, async ({ page, open, settle }) => {
      const answer = (body: unknown) => (route: { fulfill(response: object): Promise<void> }) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      await page.route('**/api/admin/policies', answer(POLICIES_ADMIN_RETENTION));
      await page.route('**/api/admin/chat/retention-preview', answer(RETENTION_WAITING));
      await open('/admin/policies');
      // From the row above, so that the rule shows whole with the two rules after it.
      await page.getByText('Read receipts', { exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }));
      await expect(page.getByRole('button', { name: 'Apply now…' })).toBeVisible();
      await settle();
      await expectBaseline(page, `chat-retention-pending-${viewport}-${theme}.png`);
    });
  });
}

for (const theme of THEMES) {
  test.describe(`${theme} default`, () => {
    test.use({ theme, colorScheme: theme });
    for (const viewport of ['wide', 'phone'] as const) chatPassphraseAndSettings(viewport, theme);
    for (const viewport of ['wide', 'phone'] as const) calls(viewport, theme);
    for (const viewport of ['wide', 'phone'] as const) chatRetention(viewport, theme);

    test.describe('wide', () => {
      test.use(VIEWPORTS.wide);

      test(`mail reader (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/mail');
        await page.getByRole('button', { name: /^Grace Hopper/ }).click();
        await expect(page.getByRole('heading', { name: /Quarterly planning notes/ })).toBeVisible();
        await settle();
        await expectBaseline(page, `mail-reader-wide-${theme}.png`);
      });

      test(`todo (wide, ${theme})`, async ({ page, open }) => {
        await open('/todo');
        await expectBaseline(page, `todo-wide-${theme}.png`);
      });

      test(`todo row picked up (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/todo');
        await pickUpRow(page, 'Confirm the documentation review dates');
        await settle();
        await expectBaseline(page, `todo-drag-wide-${theme}.png`);
      });

      test(`new task with the list chooser (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/todo');
        await openNewTaskChooser(page);
        await settle();
        await expectBaseline(page, `new-task-wide-${theme}.png`);
      });

      test(`settings pages (wide, ${theme})`, async ({ page, open }) => {
        await open('/settings?section=pages');
        await expect(page.getByRole('button', { name: 'Reorder Mail' })).toBeVisible();
        await expectBaseline(page, `settings-pages-wide-${theme}.png`);
      });

      // 0.28 (P-29, D29): Backup and restore, the bin and the policies page.
      test(`settings backup (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/settings?section=backup');
        await expect(page.getByRole('button', { name: 'Create backup' })).toBeVisible();
        await expect(page.getByText('Not encrypted, made before 0.28.')).toBeVisible();
        await settle();
        await expectBaseline(page, `settings-backup-wide-${theme}.png`);
      });

      test(`bin (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/settings?section=bin');
        await expect(page.getByRole('list', { name: 'Deleted items' })).toBeVisible();
        await settle();
        await expectBaseline(page, `bin-wide-${theme}.png`);
      });

      // Chat with the fixed engine: the conversations beside the open one, at its newest messages and at its first.
      test(`chat (wide, ${theme})`, async ({ page, open, settle }) => {
        await withChat(page);
        await open('/chat?c=chat-blair');
        await expect(page.getByText('And the holiday list?')).toBeVisible();
        await settle();
        await expectBaseline(page, `chat-wide-${theme}.png`);
      });

      test(`chat, earlier messages (wide, ${theme})`, async ({ page, open, settle }) => {
        await withChat(page);
        await open('/chat?c=chat-blair');
        await page.getByRole('list', { name: 'Messages with Blair Example' }).evaluate(list => list.parentElement!.scrollTo(0, 0));
        await expect(page.getByText('Blair Example added a device')).toBeInViewport();
        await settle();
        await expectBaseline(page, `chat-earlier-wide-${theme}.png`);
      });

      // A group chat with the fixed engine: names and initials, a former colleague, mentions, who read and the lines; then its people.
      test(`chat group (wide, ${theme})`, async ({ page, open, settle }) => {
        await withChat(page);
        await open('/chat?c=chat-planning');
        await expect(page.getByText('@Ada Example', { exact: true })).toBeVisible();
        await settle();
        await expectBaseline(page, `chat-group-wide-${theme}.png`);
      });

      test(`chat people (wide, ${theme})`, async ({ page, open, settle }) => {
        await withChat(page);
        await open('/chat?c=chat-planning');
        await page.getByRole('button', { name: 'People in this chat' }).click();
        await expect(page.getByRole('dialog', { name: 'Warehouse planning' }).getByRole('button', { name: 'Leave chat' })).toBeVisible();
        await settle();
        await expectBaseline(page, `chat-people-wide-${theme}.png`);
      });

      // Files in a chat with the fixed engine: a picture by its preview, a PDF and another file, a voice message and an own file on its way with Cancel.
      test(`chat files (wide, ${theme})`, async ({ page, open, settle }) => {
        await withChat(page);
        await open('/chat?c=chat-finley');
        await chatPicturesDrawn(page);
        await settle();
        await expectBaseline(page, `chat-files-wide-${theme}.png`);
      });

      test(`chat recorder (wide, ${theme})`, async ({ page, open, settle }) => {
        await withChat(page);
        await silentMicrophone(page);
        await open('/chat?c=chat-finley');
        await page.getByRole('button', { name: 'Record a voice message' }).click();
        await expect(page.getByRole('timer')).toHaveText('0:00');
        await settle();
        await expectBaseline(page, `chat-recorder-wide-${theme}.png`);
      });

      // What the device finds for "plan": a chat by its name, then messages by their text, the newest first.
      test(`chat search (wide, ${theme})`, async ({ page, open, settle }) => {
        await withChat(page);
        await open('/chat?c=chat-planning');
        await page.getByRole('searchbox', { name: 'Search chats and messages' }).fill('plan');
        await expect(page.getByRole('region', { name: 'Search results' })).toBeVisible();
        await settle();
        await expectBaseline(page, `chat-search-wide-${theme}.png`);
      });

      // 0.31: a shared address book the person manages, with a contact open, and its share dialog.
      test(`shared book (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/contacts?book=book-suppliers&contact=bc-1');
        await expect(page.getByRole('article', { name: 'Maria Okafor' })).toBeVisible();
        await settle();
        await expectBaseline(page, `book-wide-${theme}.png`);
      });

      test(`shared book, share dialog (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/contacts?book=book-suppliers');
        await page.getByRole('button', { name: 'Share', exact: true }).click();
        await expect(page.getByRole('list', { name: 'People and groups to add' })).toBeVisible();
        await settle();
        await expectBaseline(page, `book-share-wide-${theme}.png`);
      });

      // 0.32: the calendars others share, in the panel and the month, and a calendar's share dialog with the five levels.
      test(`shared calendars (wide, ${theme})`, async ({ page, open, settle }) => {
        await sharedCalendars(page);
        await open('/calendar');
        await expect(page.getByRole('region', { name: 'Shared with me' })).toBeVisible();
        await settle();
        await expectBaseline(page, `calendar-shared-wide-${theme}.png`);
      });

      test(`calendar, share dialog (wide, ${theme})`, async ({ page, open, settle }) => {
        await sharedCalendars(page);
        await open('/calendar');
        await page.getByRole('button', { name: 'Settings for Personal' }).click();
        await page.getByRole('dialog', { name: 'Personal' }).getByRole('button', { name: 'Share', exact: true }).click();
        await expect(page.getByRole('list', { name: 'People and groups to add' })).toBeVisible();
        await settle();
        await expectBaseline(page, `calendar-share-wide-${theme}.png`);
      });

      // 0.32: a calendar offered to the person, in the panel, and the owner handing one of their own to a colleague.
      test(`calendar offered to the person (wide, ${theme})`, async ({ page, open, settle }) => {
        await sharedCalendars(page, { offered: true });
        await open('/calendar');
        await expect(page.getByRole('region', { name: 'Offer of Support rota' })).toBeVisible();
        await settle();
        await expectBaseline(page, `calendar-offer-wide-${theme}.png`);
      });

      test(`calendar, hand-over dialog (wide, ${theme})`, async ({ page, open, settle }) => {
        await sharedCalendars(page);
        await open('/calendar');
        await page.getByRole('button', { name: 'Settings for Personal' }).click();
        await page.getByRole('dialog', { name: 'Personal' }).getByRole('button', { name: 'Hand over…' }).click();
        await page.getByRole('dialog', { name: 'Hand over Personal' }).getByText('Blair Example', { exact: true }).click();
        await settle();
        await expectBaseline(page, `calendar-hand-over-wide-${theme}.png`);
      });

      test.describe('as an administrator', () => {
        test.use({ admin: true });

      // 0.32: Server -> Calendars, and the calendars a leaving person shares in the Deactivate dialog.
      test(`calendars of the server (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/admin/calendars');
        await expect(page.getByRole('button', { name: 'Restore Summer party 2025' })).toBeVisible();
        await settle();
        await expectBaseline(page, `server-calendars-wide-${theme}.png`);
      });

      test(`deactivate a person who shares calendars (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/admin/users/user-blair');
        await page.getByRole('button', { name: 'Deactivate', exact: true }).click();
        await expect(page.getByRole('combobox', { name: /^Support rota/ })).toBeVisible();
        await settle();
        await expectBaseline(page, `person-leaving-calendars-wide-${theme}.png`);
      });

      test(`shared books of the server (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/admin/address-books');
        await expect(page.getByRole('button', { name: 'Restore Trade fair 2025' })).toBeVisible();
        await settle();
        await expectBaseline(page, `shared-books-wide-${theme}.png`);
      });
        test(`admin policies (wide, ${theme})`, async ({ page, open, settle }) => {
          await open('/admin/policies');
          await expect(page.getByRole('combobox', { name: 'Creating backups' })).toBeVisible();
          await settle();
          await expectBaseline(page, `admin-policies-wide-${theme}.png`);
        });

        test(`admin policies, the App lock group (wide, ${theme})`, async ({ page, open, settle }) => {
          await page.route('**/api/admin/policies', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POLICIES_ADMIN_APP_LOCK) }));
          await open('/admin/policies');
          await expect(page.getByRole('combobox', { name: 'App lock required' })).toHaveText('Chosen modules');
          await page.getByRole('combobox', { name: 'Screenshots in the Android app' }).scrollIntoViewIfNeeded();
          await settle();
          await expectBaseline(page, `admin-policies-app-lock-wide-${theme}.png`);
        });

        // 0.30 (P-29): the organisation's pages. The administrator of the fixtures is the owner, so every control shows.
        test(`people (wide, ${theme})`, async ({ page, open, settle }) => {
          await open('/admin/users');
          await expect(page.getByRole('link', { name: 'Alex Example' })).toBeVisible();
          await settle();
          await expectBaseline(page, `people-wide-${theme}.png`);
        });

        test(`a person (wide, ${theme})`, async ({ page, open, settle }) => {
          await open('/admin/users/user-alex');
          await expect(page.getByText('UniHub app 0.29.0 on Android')).toBeVisible();
          await expect(page.getByRole('switch', { name: 'Support: manager' })).toBeChecked();
          await settle();
          await expectBaseline(page, `person-wide-${theme}.png`);
        });

        test(`groups (wide, ${theme})`, async ({ page, open, settle }) => {
          await open('/admin/groups');
          await expect(page.getByRole('link', { name: /^Support/ })).toBeVisible();
          await settle();
          await expectBaseline(page, `groups-wide-${theme}.png`);
        });

        test(`a group's rules (wide, ${theme})`, async ({ page, open, settle }) => {
          await open('/admin/groups/grp-support?view=rules');
          await expect(page.getByRole('combobox', { name: 'Two-factor authentication' })).toHaveText('Required');
          await settle();
          await expectBaseline(page, `group-policies-wide-${theme}.png`);
        });
      });

      // 0.29 (P-29): the app lock and the devices.
      test(`settings app lock (wide, ${theme})`, async ({ page, open, settle }) => {
        await seedPin(page);
        await lockedDevice(page);
        await open('/settings?section=app-lock');
        await expect(page.getByRole('checkbox', { name: /^Mail/ })).toBeDisabled();
        await settle();
        await expectBaseline(page, `settings-app-lock-wide-${theme}.png`);
      });

      test(`module lock screen (wide, ${theme})`, async ({ page, open, settle }) => {
        await seedPin(page);
        await lockedDevice(page);
        await open('/mail');
        await expect(page.getByRole('heading', { name: 'Mail is locked' })).toBeVisible();
        await settle();
        await expectBaseline(page, `lock-module-wide-${theme}.png`);
      });

      test(`devices (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/settings?section=security');
        await expect(page.getByText('UniHub app 0.29.0 on Android')).toBeVisible();
        await page.getByRole('heading', { name: 'Devices' }).scrollIntoViewIfNeeded();
        await settle();
        await expectBaseline(page, `devices-wide-${theme}.png`);
      });

      test(`settings appearance (wide, ${theme})`, async ({ page, open }) => {
        await open('/settings?section=appearance');
        await expect(page.getByRole('heading', { name: 'Theme', exact: true })).toBeVisible();
        await expectBaseline(page, `settings-appearance-wide-${theme}.png`);
      });

      test(`contact detail (wide, ${theme})`, async ({ page, open }) => {
        await open('/contacts?contact=c-1');
        await expect(page.getByRole('article', { name: 'Grace Brewster Hopper' })).toBeVisible();
        await expectBaseline(page, `contact-detail-wide-${theme}.png`);
      });

      test(`contact editor (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/contacts?contact=c-1');
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Edit contact' })).toBeVisible();
        await settle();
        await expectBaseline(page, `contact-editor-wide-${theme}.png`);
      });

      test(`merge review (wide, ${theme})`, async ({ page, open, settle }) => {
        await open('/contacts?view=duplicates');
        await page.getByRole('region', { name: /Group of 2, high confidence/ }).first().getByRole('button', { name: 'Review and merge' }).click();
        await expect(page.getByRole('dialog', { name: 'Merge 2 contacts into one' })).toBeVisible();
        await settle();
        await expectBaseline(page, `merge-review-wide-${theme}.png`);
      });
    });

    test.describe('phone', () => {
      test.use(VIEWPORTS.phone);

      test(`todo (phone, ${theme})`, async ({ page, open }) => {
        await open('/todo');
        await expectBaseline(page, `todo-phone-${theme}.png`);
      });

      test(`todo row picked up (phone, ${theme})`, async ({ page, open, settle }) => {
        await open('/todo');
        await pickUpRow(page, 'Confirm the documentation review dates');
        await settle();
        await expectBaseline(page, `todo-drag-phone-${theme}.png`);
      });

      test(`new task with the list chooser (phone, ${theme})`, async ({ page, open, settle }) => {
        await open('/todo');
        await openNewTaskChooser(page);
        await settle();
        await expectBaseline(page, `new-task-phone-${theme}.png`);
      });

      test(`bin (phone, ${theme})`, async ({ page, open, settle }) => {
        await open('/settings?section=bin');
        await expect(page.getByRole('list', { name: 'Deleted items' })).toBeVisible();
        await settle();
        await expectBaseline(page, `bin-phone-${theme}.png`);
      });

      // 0.31: a shared book's list with what its manager may do, and a company directory entry.
      test(`shared book (phone, ${theme})`, async ({ page, open, settle }) => {
        await open('/contacts?book=book-suppliers');
        await expect(page.getByRole('button', { name: /^Maria Okafor/ })).toBeVisible();
        await settle();
        await expectBaseline(page, `book-phone-${theme}.png`);
      });

      test(`company directory entry (phone, ${theme})`, async ({ page, open, settle }) => {
        await open('/contacts?book=company&contact=user-katherine');
        await expect(page.getByRole('region', { name: 'Groups' })).toBeVisible();
        await settle();
        await expectBaseline(page, `company-entry-phone-${theme}.png`);
      });

      // 0.32: an event of a group's calendar as a contributor reads it: the fields read-only with the reason, the subtasks with who added each.
      test(`event for a contributor (phone, ${theme})`, async ({ page, open, settle }) => {
        await sharedCalendars(page);
        await open('/calendar');
        await page.getByRole('button', { name: /Weekly support meeting/ }).click();
        await expect(page.getByRole('dialog', { name: 'Event' }).getByRole('list', { name: 'Subtasks' })).toBeVisible();
        await settle();
        await expectBaseline(page, `event-contribute-phone-${theme}.png`);
      });

      // 0.32: a new event with a repeat rule of its own: every second week on two days, a number of times.
      test(`event with a custom repeat (phone, ${theme})`, async ({ page, open, settle }) => {
        await open('/calendar');
        await customRepeat(page);
        await settle();
        await expectBaseline(page, `event-repeat-phone-${theme}.png`);
      });

      // 0.29: the lock in a phone's hand, and the set-up the administrator requires.
      test(`settings app lock (phone, ${theme})`, async ({ page, open, settle }) => {
        await seedPin(page);
        await lockedDevice(page);
        await open('/settings?section=app-lock');
        await expect(page.getByRole('checkbox', { name: /^Mail/ })).toBeDisabled();
        await settle();
        await expectBaseline(page, `settings-app-lock-phone-${theme}.png`);
      });

      test(`whole-app lock screen (phone, ${theme})`, async ({ page, open, settle }) => {
        await seedPin(page);
        await lockedDevice(page, { scope: ['app'] });
        await open('/todo');
        await expect(page.getByRole('heading', { name: 'UniHub is locked' })).toBeVisible();
        await settle();
        await expectBaseline(page, `lock-app-phone-${theme}.png`);
      });

      test(`required by the administrator (phone, ${theme})`, async ({ page, open, settle }) => {
        await lockedDevice(page, { meets: false });
        await open('/mail');
        await expect(page.getByRole('heading', { name: 'Your administrator requires the app lock' })).toBeVisible();
        await settle();
        await expectBaseline(page, `lock-required-phone-${theme}.png`);
      });

      // 0.30: the public page of a setup link, and the two-factor set-up a rule requires once the 7 days are over.
      test(`setup link page (phone, ${theme})`, async ({ page, open, settle }) => {
        await page.route('**/api/auth/me', route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Not signed in' }) }));
        await open(`/invite#${INVITE_TOKEN}`);
        await expect(page.getByRole('heading', { name: 'Set up your UniHub account' })).toBeVisible();
        await settle();
        await expectBaseline(page, `invite-phone-${theme}.png`);
      });

      test(`two-factor authentication required (phone, ${theme})`, async ({ page, open, settle }) => {
        await page.route('**/api/policies/effective', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POLICIES_EFFECTIVE_TWO_FACTOR) }));
        await open('/todo');
        await expect(page.getByRole('heading', { name: 'Set up two-factor authentication to continue' })).toBeVisible();
        await settle();
        await expectBaseline(page, `two-factor-required-phone-${theme}.png`);
      });

      test(`recordings (phone, ${theme})`, async ({ page, open }) => {
        await open('/recordings');
        await expect(page.getByText('Song sketch in G')).toBeVisible();
        await expectBaseline(page, `recordings-phone-${theme}.png`);
      });

      test(`composer (phone, ${theme})`, async ({ page, open, settle }) => {
        await open('/mail');
        await page.getByRole('button', { name: 'Compose', exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await settle();
        await expectBaseline(page, `composer-phone-${theme}.png`);
      });

      test(`chat list (phone, ${theme})`, async ({ page, open }) => {
        await withChat(page);
        await open('/chat');
        await expect(page.getByRole('list', { name: 'Chats' })).toBeVisible();
        await expectBaseline(page, `chat-list-phone-${theme}.png`);
      });

      test(`chat thread (phone, ${theme})`, async ({ page, open, settle }) => {
        await withChat(page);
        await open('/chat?c=chat-blair');
        await expect(page.getByText('And the holiday list?')).toBeVisible();
        await settle();
        await expectBaseline(page, `chat-thread-phone-${theme}.png`);
      });

      // A group chat with the fixed engine: names and initials, a former colleague, mentions, who read and the lines; then its people.
      test(`chat group (phone, ${theme})`, async ({ page, open, settle }) => {
        await withChat(page);
        await open('/chat?c=chat-planning');
        await expect(page.getByText('@Ada Example', { exact: true })).toBeVisible();
        await settle();
        await expectBaseline(page, `chat-group-phone-${theme}.png`);
      });

      test(`chat people (phone, ${theme})`, async ({ page, open, settle }) => {
        await withChat(page);
        await open('/chat?c=chat-planning');
        await page.getByRole('button', { name: 'People in this chat' }).click();
        await expect(page.getByRole('dialog', { name: 'Warehouse planning' }).getByRole('button', { name: 'Leave chat' })).toBeVisible();
        await settle();
        await expectBaseline(page, `chat-people-phone-${theme}.png`);
      });

      // Files in a chat with the fixed engine: a picture by its preview, a PDF and another file, a voice message and an own file on its way with Cancel.
      test(`chat files (phone, ${theme})`, async ({ page, open, settle }) => {
        await withChat(page);
        await open('/chat?c=chat-finley');
        await chatPicturesDrawn(page);
        await settle();
        await expectBaseline(page, `chat-files-phone-${theme}.png`);
      });

      test(`chat recorder (phone, ${theme})`, async ({ page, open, settle }) => {
        await withChat(page);
        await silentMicrophone(page);
        await open('/chat?c=chat-finley');
        await page.getByRole('button', { name: 'Record a voice message' }).click();
        await expect(page.getByRole('timer')).toHaveText('0:00');
        await settle();
        await expectBaseline(page, `chat-recorder-phone-${theme}.png`);
      });

      // What the device finds for "plan": a chat by its name, then messages by their text, the newest first.
      test(`chat search (phone, ${theme})`, async ({ page, open, settle }) => {
        await withChat(page);
        await open('/chat');
        await page.getByRole('searchbox', { name: 'Search chats and messages' }).fill('plan');
        await expect(page.getByRole('region', { name: 'Search results' })).toBeVisible();
        await settle();
        await expectBaseline(page, `chat-search-phone-${theme}.png`);
      });

      test(`contact detail (phone, ${theme})`, async ({ page, open }) => {
        await open('/contacts?contact=c-1');
        await expect(page.getByRole('article', { name: 'Grace Brewster Hopper' })).toBeVisible();
        await expectBaseline(page, `contact-detail-phone-${theme}.png`);
      });

      test(`contact editor (phone, ${theme})`, async ({ page, open, settle }) => {
        await open('/contacts?contact=c-1');
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await expect(page.getByRole('dialog', { name: 'Edit contact' })).toBeVisible();
        await settle();
        await expectBaseline(page, `contact-editor-phone-${theme}.png`);
      });

      test(`merge review (phone, ${theme})`, async ({ page, open, settle }) => {
        await open('/contacts?view=duplicates');
        await page.getByRole('region', { name: /Group of 2, high confidence/ }).first().getByRole('button', { name: 'Review and merge' }).click();
        await expect(page.getByRole('dialog', { name: 'Merge 2 contacts into one' })).toBeVisible();
        await settle();
        await expectBaseline(page, `merge-review-phone-${theme}.png`);
      });
    });
  });
}
