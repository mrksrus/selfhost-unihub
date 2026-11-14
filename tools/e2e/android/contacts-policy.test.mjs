// 0.30.0: an administrator forbids UniHub contacts on phones, here for one
// group. At the app's next sync the phone of a member of that group loses
// UniHub's contacts, which stay in UniHub; allowed again, they come back.
// Every app in the support window does this without an update: the server
// answers the contacts sync with the Contacts module's refusal, which the app
// treats as a listing that is gone (ContactsSync.kt). The person is the
// test's own, in the seeded Support group; admin, in no group, is unaffected.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { contactsOn, openApp, rawsFor, requestSync, signOutApp, until } from '../support/android.mjs';
import { addPerson, ok, people, resetPeople, seedOrganisation, setRules } from '../support/people.mjs';

const tag = `E2e${Date.now().toString(36).slice(-5)}`;

// Whatever an earlier file left, and nothing for the next file; the app starts signed out.
before(async () => {
  await resetPeople();
  await signOutApp();
});

after(async () => {
  await resetPeople();
  // The removed person's session ends: the phone drops their contacts at its next sync.
  requestSync();
});

test('[30-10 agent part] phone contacts forbidden for a group leave the phone at its next sync and stay in UniHub; allowed again, they come back', { timeout: 900_000 }, async () => {
  const { support } = await seedOrganisation();
  const person = await addPerson('phone', { groups: [support.id] });
  const api = await person.session();
  const ids = [];
  for (const [given, number] of [['Ada', '+15550700'], ['Ben', '+15550701']]) {
    const { contact } = await ok(api('POST', '/api/contacts', { name: { given, family: tag }, phones: [{ value: number, label: 'mobile', custom_label: null, preferred: false }] }), `create ${given}`);
    ids.push(contact.id);
  }

  await openApp({ email: person.email }).then(({ device }) => device.close());
  await contactsOn();
  await until(() => ids.every(id => rawsFor(id).length === 1), 'the contacts on the phone');

  await setRules({ 'contacts.phone_sync': 'forbidden' }, { group: support.id, others: [api] });
  const allowed = async session => (await ok(session('GET', '/api/policies/effective'), 'rules')).policies['contacts.phone_sync'].allowed;
  assert.equal(await allowed(api), false, "the group's rule reaches its member");
  assert.equal(await allowed((await people())[0]), true, 'admin, in no group, keeps phone contacts');

  await until(() => ids.every(id => rawsFor(id).length === 0), 'the contacts gone from the phone');
  for (const id of ids) {
    const { contact } = await ok(api('GET', `/api/contacts/${id}`), 'the contact in UniHub');
    assert.equal(contact.name.family, tag, 'the contact stays in UniHub');
  }

  await setRules({}, { group: support.id, clear: ['contacts.phone_sync'], others: [api] });
  await until(() => ids.every(id => rawsFor(id).length === 1), 'the contacts back on the phone');
});
