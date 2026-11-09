import { afterEach, expect, test } from 'vitest';
import {
  graphUrlWithOnboarding,
  ONBOARDING_KEY,
  readOnboardingPreference,
} from './onboarding';

afterEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

test('a browser graph handoff carries only dismissal, consumes it, and survives reload', () => {
  localStorage.setItem(ONBOARDING_KEY, 'skipped');
  const url = graphUrlWithOnboarding('http://localhost:8123/');
  expect(url).toBe('http://localhost:8123/#orbis-tour=skipped');
  localStorage.clear();
  window.history.replaceState(null, '', '/#orbis-tour=skipped&other=keep');
  expect(readOnboardingPreference()).toBe('skipped');
  expect(window.location.hash).toBe('#other=keep');
  expect(readOnboardingPreference()).toBe('skipped');
});

test('a fresh user and unknown handoff never suppress the tutorial', () => {
  expect(graphUrlWithOnboarding('http://localhost:8123/')).toBe('http://localhost:8123/');
  window.history.replaceState(null, '', '/#orbis-tour=unknown');
  expect(readOnboardingPreference()).toBeNull();
  expect(localStorage.getItem(ONBOARDING_KEY)).toBeNull();
});
