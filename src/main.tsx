import React from 'react';
import ReactDOM from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import { ErrorBoundary } from './components/ErrorBoundary';
import { restoreDesktopPreferences } from './services/preferences';
import './styles/app.css';

async function start() {
  let preferenceError = '';
  try {
    await restoreDesktopPreferences();
  } catch (error) {
    preferenceError = (error as Error).message;
  }
  const { App } = await import('./App');
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
  if (preferenceError)
    window.setTimeout(
      () =>
        window.dispatchEvent(
          new CustomEvent('orbis:preferenceError', { detail: preferenceError }),
        ),
      1000,
    );
}
void start().catch((error: Error) => {
  document.getElementById('root')!.textContent =
    `Orbis could not start: ${error.message}. Reload the application to retry.`;
});
