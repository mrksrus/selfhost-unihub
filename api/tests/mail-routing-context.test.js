const test = require('node:test');
const assert = require('node:assert/strict');
const { createMailRoutingContext, resolveMailSenderTargetFolder, loadMailFoldersForUser } = require('../src/services/mail');

function fixture() {
  const rows = new Map([['inbox', { id: 'inbox', user_id: 'u1', slug: 'inbox', display_name: 'My Inbox', position: 777, is_system: true }]]);
  const calls = [];
  return { rows, calls, async execute(sql, params) {
    calls.push(sql);
    if (sql.includes('INSERT INTO mail_folders')) {
      assert.match(sql, /ON DUPLICATE KEY UPDATE id = id/);
      for (let i = 0; i < params.length; i += 5) {
        const [id, user_id, slug, display_name, position] = params.slice(i, i + 5);
        if (!rows.has(slug)) rows.set(slug, { id, user_id, slug, display_name, position, is_system: true });
      }
      return [{ affectedRows: 0 }];
    }
    if (sql.includes('FROM mail_folders')) return [[...rows.values()]];
    if (sql.includes('FROM mail_sender_rules')) return [[
      { id: 'global', match_type: 'domain', match_value: 'example.test', target_folder: 'marketing', priority: 0 },
      { id: 'scoped', mail_account_id: 'a1', match_type: 'email', match_value: 'sender@example.test', target_folder: 'important', priority: 1 },
    ]];
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
}

test('default folder seeding batches missing inserts and preserves customization', async () => {
  const db = fixture();
  const result = await loadMailFoldersForUser('u1', db);
  assert.equal(db.calls.length, 2);
  assert.equal(result.length, 10);
  assert.equal(result.find(row => row.slug === 'inbox').display_name, 'My Inbox');
  assert.equal(result.find(row => row.slug === 'inbox').position, 777);
});

test('1,000 rule resolutions use one operation context without per-message SQL', async () => {
  const db = fixture();
  const context = await createMailRoutingContext('u1', 'a1', db);
  assert.equal(db.calls.length, 3);
  for (let i = 0; i < 1000; i += 1) {
    const resolved = await resolveMailSenderTargetFolder({ userId: 'u1', mailAccountId: 'a1', fromAddress: 'sender@example.test', routingContext: context, connection: db });
    assert.equal(resolved.folder, 'important');
  }
  assert.equal(db.calls.length, 3);
  context.folders.delete('important');
  const missing = await resolveMailSenderTargetFolder({ userId: 'u1', mailAccountId: 'a1', fromAddress: 'sender@example.test', routingContext: context, connection: db });
  assert.equal(missing.folder, 'inbox');
});
