const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { portableName, portableZipPath, NameRegistry } = require('../dist/src/services/backup-readable') as typeof import('../src/services/backup-readable');

// The readable names inside a backup (D37) must extract on Windows, macOS and
// Linux, and the ZIP writer applies the same rules again: a name that changed
// the second time would no longer match the path backup.json records.

test('readable names are portable, cut on whole characters and unchanged when made portable again', () => {
  const hostile = ['a/b\\c:d*e?f"g|h<i>', 'CON', 'nul.txt', 'Com1 .eml', ' .hidden', 'trailing. . ', '\u202etxt.exe', 'tab\there', '..', '😀'.repeat(40), 'e\u0301'];
  for (const value of hostile) {
    const name = portableName(value, { maxBytes: 100 });
    assert.equal(portableName(name, { maxBytes: 100 }), name, `${JSON.stringify(value)} is stable`);
    assert.equal(portableZipPath(name), name, `${JSON.stringify(value)} survives the ZIP writer`);
    assert.ok(Buffer.byteLength(name) <= 100);
    // eslint-disable-next-line no-control-regex -- the control characters are what it refuses
    assert.doesNotMatch(name, /[\u0000-\u001f<>:"/\\|?*\u202e]|[. ]$|^\./);
    assert.doesNotMatch(name.split('.')[0].trimEnd(), /^(con|nul|com1)$/i);
  }
  assert.equal(portableName('😀'.repeat(40), { maxBytes: 10 }), '😀😀', 'four-byte characters are not split');
  assert.equal(portableName('e\u0301'), '\u00e9', 'stored as NFC');
  assert.equal(portableName('..'), 'Untitled');
});

test('names unique per folder as Windows and macOS compare them', () => {
  const names = new NameRegistry();
  assert.equal(names.take('Recordings', 'Memo', '.wav'), 'Recordings/Memo.wav');
  assert.equal(names.take('Recordings', 'MEMO', '.wav'), 'Recordings/MEMO (2).wav');
  // A decomposed é is the same name to macOS.
  assert.equal(names.take('Recordings', 'Caf\u00e9', '.wav'), 'Recordings/Caf\u00e9.wav');
  assert.equal(names.take('Recordings', 'Cafe\u0301', '.wav'), 'Recordings/Cafe\u0301 (2).wav');
  assert.equal(names.take('Other', 'Memo', '.wav'), 'Other/Memo.wav', 'another folder has its own names');
});
