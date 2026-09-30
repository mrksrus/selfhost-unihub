const { spawn } = require('node:child_process');

// The image sets UNIHUB_API_UID/GID. When the supervisor runs as root (it must,
// for Nginx to bind port 80), the API process drops to that user through
// drop-privileges.js, which needs SETGID/SETUID but no new privileges.
function apiIdentity(env = process.env, getuid = process.getuid) {
  if (env.UNIHUB_API_UID === undefined && env.UNIHUB_API_GID === undefined) return null;
  const uid = Number(env.UNIHUB_API_UID), gid = Number(env.UNIHUB_API_GID);
  if (![uid, gid].every(id => Number.isSafeInteger(id) && id > 0 && id < 2 ** 31)) {
    throw new Error('UNIHUB_API_UID and UNIHUB_API_GID must both be non-root numeric IDs');
  }
  // Already unprivileged (for example `docker run --user`): start as-is.
  if (typeof getuid !== 'function' || getuid() !== 0) return null;
  return { uid, gid };
}

function superviseServices({ spawnChild = spawn, delayMs = 2000, graceMs = 10000, exit = code => process.exit(code), signals = process, apiUser = null } = {}) {
  const children = new Set();
  let stopping = false;
  let exitCode = 1;
  let startTimer;
  let killTimer;
  function finish() {
    clearTimeout(startTimer);
    clearTimeout(killTimer);
    signals.removeListener('SIGTERM', onSignal);
    signals.removeListener('SIGINT', onSignal);
    exit(exitCode);
  }
  function stop(code) {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    clearTimeout(startTimer);
    for (const child of children) signal(child, 'SIGTERM');
    if (children.size === 0) return finish();
    killTimer = setTimeout(() => {
      for (const child of children) signal(child, 'SIGKILL');
      // An API running as another user cannot be SIGKILLed without CAP_KILL;
      // exiting PID 1's child ends the container and the kernel reaps the rest.
      killTimer = setTimeout(finish, 1000);
    }, graceMs);
  }
  // With `cap_drop: ALL`, root may not signal the API once it runs as another
  // user. That child stops when its IPC channel closes (drop-privileges.js).
  function signal(child, name) {
    if (child.ownerChannel) { try { if (child.connected) child.disconnect(); } catch { /* already closed */ } return; }
    try { child.kill(name); } catch { /* already exited */ }
  }
  function onSignal() { stop(0); }
  function launch(command, args, onExit, options = {}) {
    const child = spawnChild(command, args, { stdio: 'inherit', ...options });
    children.add(child);
    child.once('error', error => { console.error('Service failed to start:', error.message); stop(1); });
    child.once('close', code => {
      children.delete(child);
      if (stopping) { if (children.size === 0) finish(); return; }
      if (onExit) onExit(code);
      else { console.error('An essential service stopped; restarting the container.'); stop(1); }
    });
    return child;
  }
  signals.on('SIGTERM', onSignal);
  signals.on('SIGINT', onSignal);
  console.log('✓ Starting Node.js API server...');
  // The wrapper clears supplementary groups, then sets gid and uid, before any
  // API code loads; server.js stays in the command line for process lookups.
  if (apiUser) launch(process.execPath, [require('node:path').join(__dirname, 'drop-privileges.js'),
    String(apiUser.uid), String(apiUser.gid), '/app/api/server.js'], undefined,
  { env: { ...process.env, HOME: '/tmp' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] }).ownerChannel = true;
  else launch(process.execPath, ['/app/api/server.js']);
  startTimer = setTimeout(() => {
    launch('nginx', ['-t'], code => {
      if (code !== 0) return stop(1);
      console.log('✓ Starting Nginx...');
      launch('nginx', ['-g', 'daemon off;']);
      console.log('✓ All services started. Container is ready.');
    });
  }, delayMs);
  return { stop };
}

if (require.main === module) {
  const seconds = Number(process.env.UNIHUB_API_START_DELAY_SECONDS ?? 2);
  superviseServices({ delayMs: Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 300 ? seconds * 1000 : 2000,
    apiUser: apiIdentity() });
}
module.exports = { superviseServices, apiIdentity };
