import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stopBackend } from '../backend-lifecycle.mjs';

function backend() {
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null, signals: [] });
  child.kill = (signal) => child.signals.push(signal);
  return child;
}

test('quit waits for the backend to finish releasing library locks', async () => {
  const child = backend();
  let finished = false;
  const stopping = stopBackend(child).then(() => (finished = true));
  await Promise.resolve();
  assert.equal(finished, false);
  assert.deepEqual(child.signals, ['SIGINT']);
  child.exitCode = 0;
  child.emit('exit', 0);
  await stopping;
  assert.equal(finished, true);
  assert.deepEqual(child.signals, ['SIGINT']);
});

test('quit escalates only a backend that has not exited', async () => {
  const child = backend();
  child.kill = (signal) => {
    child.signals.push(signal);
    if (signal === 'SIGKILL') {
      child.signalCode = signal;
      child.emit('exit', null, signal);
    }
  };
  await stopBackend(child, { graceMs: 10, terminateMs: 10 });
  assert.deepEqual(child.signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);
});

test('an absent, failed-to-start, or exited backend needs no shutdown signal', async () => {
  await stopBackend(undefined);
  const child = backend();
  child.pid = undefined;
  await stopBackend(child);
  child.pid = 123;
  child.exitCode = 0;
  await stopBackend(child);
  child.exitCode = null;
  child.signalCode = 'SIGINT';
  await stopBackend(child);
  assert.deepEqual(child.signals, []);
});
