import { afterEach, expect, test, vi } from 'vitest';
import {
  flushDesktopPreferences,
  readPreference,
  restoreDesktopPreferences,
  writePreference,
} from './preferences';

afterEach(() => {
  delete window.orbis;
  localStorage.clear();
});

test('desktop restores only UI choices and flushes queued writes before quit', async () => {
  const setPreference = vi.fn().mockResolvedValue(undefined);
  window.orbis = {
    getPreferences: async () => ({
      'orbis.agent': 'claude',
      'orbis.onboarding': 'skipped',
      'orbis:v2:draft': 'Excluded library draft',
    }),
    setPreference,
  } as unknown as NonNullable<Window['orbis']>;
  await restoreDesktopPreferences();
  expect(readPreference('orbis.agent')).toBe('claude');
  expect(readPreference('orbis.onboarding')).toBe('skipped');
  expect(localStorage.getItem('orbis:v2:draft')).toBeNull();
  writePreference('orbis.agent', 'codex');
  writePreference('orbis.agent-models', '{"model":"fixture"}');
  writePreference('orbis.onboarding', 'completed');
  await flushDesktopPreferences();
  expect(setPreference.mock.calls).toEqual([
    ['orbis.agent', 'codex'],
    ['orbis.agent-models', '{"model":"fixture"}'],
    ['orbis.onboarding', 'completed'],
  ]);
});

test('browser preference migration keeps earlier agent choices', () => {
  localStorage.setItem('litbench.agent', 'codex');
  expect(readPreference('orbis.agent')).toBe('codex');
  expect(localStorage.getItem('orbis.agent')).toBe('codex');
  expect(localStorage.getItem('litbench.agent')).toBeNull();
});
