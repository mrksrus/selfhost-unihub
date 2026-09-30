const { readV3 } = require('./v3');

// Old archives remain readable. No provider observation or raw-integrity claim
// is fabricated by a format upgrade; the restore layer quarantines live work.
function readV4(backup) {
  readV3(backup);
  return backup;
}
module.exports = { readV4 };
