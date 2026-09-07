// Current canonical data schema. Keep this reader when adding future versions;
// compatibility is selected from archive metadata, never a user-selected script.
function readV2(backup) {
  return backup;
}

module.exports = { readV2 };
