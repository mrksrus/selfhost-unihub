// Historical schema 2, including provider-folder mappings. Keep this reader;
// compatibility is selected from archive metadata, never a user-selected script.
function readV2(backup) {
  return backup;
}

module.exports = { readV2 };
