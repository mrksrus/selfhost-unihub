const { spawn } = require('node:child_process');

function superviseServices({ spawnChild = spawn, delayMs = 2000, graceMs = 10000, exit = code => process.exit(code), signals = process } = {}) {
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
    for (const child of children) child.kill('SIGTERM');
    if (children.size === 0) return finish();
    killTimer = setTimeout(() => {
      for (const child of children) child.kill('SIGKILL');
    }, graceMs);
  }
  function onSignal() { stop(0); }
  function launch(command, args, onExit) {
    const child = spawnChild(command, args, { stdio: 'inherit' });
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
  launch(process.execPath, ['/app/api/server.js']);
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
  superviseServices({ delayMs: Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 300 ? seconds * 1000 : 2000 });
}
module.exports = { superviseServices };
