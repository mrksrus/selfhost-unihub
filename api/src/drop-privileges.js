// Entry point used by the supervisor when it runs as root: drop to the API user
// before any application code loads. Order matters: supplementary groups and the
// group id can only be changed while still root. libuv's spawn-time setgroups is
// best effort and was observed to leave root's groups in place.
//   node drop-privileges.js <uid> <gid> /app/api/server.js
const [uid, gid, entry] = process.argv.slice(2);
const id = value => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('drop-privileges needs non-root numeric uid and gid');
  return n;
};
const targetUid = id(uid), targetGid = id(gid);
process.setgroups([]);
process.setgid(targetGid);
process.setuid(targetUid);
if (process.getuid() !== targetUid || process.getgid() !== targetGid || process.getgroups().some(g => g !== targetGid)) {
  throw new Error('Could not drop API privileges');
}
// The root supervisor may lack CAP_KILL for this user; it closes the IPC
// channel instead, and a process may always signal itself.
process.on('disconnect', () => process.kill(process.pid, 'SIGTERM'));
process.argv.splice(1, 3); // the API sees argv as if started directly
require(entry);
