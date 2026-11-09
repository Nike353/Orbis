import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OnboardingTour } from './OnboardingTour';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.orbis;
});

it('walks through the real workflows without running an agent and restores background access', () => {
  const finish = vi.fn();
  const background = document.createElement('button');
  background.textContent = 'Existing app control';
  document.body.append(background);
  const { unmount } = render(<OnboardingTour onFinish={finish} />, {
    container: document.body.appendChild(document.createElement('div')),
  });
  expect(screen.getByRole('dialog')).toHaveAccessibleName(
    'Welcome to your research universe.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Show me around' }));
  expect(screen.getByRole('dialog')).toHaveAccessibleName('Start with a source.');
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByRole('dialog')).toHaveAccessibleName(
    'Read. Highlight. Make it yours.',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('dialog')).toHaveAccessibleName('Start with a source.');
  for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start using Orbis' }));
  expect(finish).toHaveBeenCalledExactlyOnceWith('completed');
  unmount();
  background.remove();
});

it('supports skip and Escape without requiring the user to finish the tour', () => {
  const finish = vi.fn();
  render(<OnboardingTour onFinish={finish} />);
  fireEvent.click(screen.getByRole('button', { name: 'Skip tutorial' }));
  expect(finish).toHaveBeenLastCalledWith('skipped');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(finish).toHaveBeenLastCalledWith('skipped');
});

it('keeps keyboard focus inside the tour and restores the launcher on close', () => {
  const host = document.createElement('div');
  document.body.append(host);
  host.innerHTML =
    '<button aria-label="Open tutorial">Tutorial</button><div id="tour-root"></div>';
  const launcher = host.querySelector<HTMLButtonElement>('button')!;
  launcher.focus();
  const { unmount } = render(<OnboardingTour onFinish={vi.fn()} />, {
    container: host.querySelector('#tour-root') as HTMLElement,
  });
  const next = screen.getByRole('button', { name: 'Show me around' });
  next.focus();
  fireEvent.keyDown(document, { key: 'Tab' });
  expect(screen.getByRole('button', { name: 'Skip tutorial' })).toHaveFocus();
  unmount();
  expect(launcher).toHaveFocus();
  host.remove();
});
