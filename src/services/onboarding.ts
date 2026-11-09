import { readPreference, writePreference } from './preferences';

export const ONBOARDING_KEY = 'orbis.onboarding';
const HANDOFF = 'orbis-tour';
const valid = (value: string | null) => value === 'completed' || value === 'skipped';

// Browser graphs use separate loopback ports. Carry only this non-sensitive UI
// preference across navigation, then remove it from the address bar on arrival.
export function graphUrlWithOnboarding(url: string) {
  const outcome = readPreference(ONBOARDING_KEY);
  if (!valid(outcome)) return url;
  const target = new URL(url, window.location.href);
  const fragment = new URLSearchParams(target.hash.slice(1));
  fragment.set(HANDOFF, outcome!);
  target.hash = fragment.toString();
  return target.href;
}

export function readOnboardingPreference() {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const outcome = fragment.get(HANDOFF);
  if (!valid(outcome)) return readPreference(ONBOARDING_KEY);
  fragment.delete(HANDOFF);
  url.hash = fragment.toString();
  window.history.replaceState(window.history.state, '', url);
  try {
    writePreference(ONBOARDING_KEY, outcome!);
  } catch {
    // Still honor dismissal for this page if browser storage is unavailable.
  }
  return outcome;
}
