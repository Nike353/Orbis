// Keep the application lock until its backend has released all library locks.
export function stopBackend(child, { graceMs = 20000, terminateMs = 5000 } = {}) {
  if (!child?.pid || child.exitCode !== null || child.signalCode != null)
    return Promise.resolve();
  return new Promise((resolve) => {
    let terminateTimer;
    const killTimer = setTimeout(() => {
      child.kill('SIGTERM');
      terminateTimer = setTimeout(() => child.kill('SIGKILL'), terminateMs);
    }, graceMs);
    child.once('exit', () => {
      clearTimeout(killTimer);
      clearTimeout(terminateTimer);
      resolve();
    });
    child.kill('SIGINT');
  });
}
