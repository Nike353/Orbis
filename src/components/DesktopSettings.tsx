import { useEffect, useState } from 'react';
import { Cloud, X } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspaceStore';

type Conflict = { id: string; path: string; choices: { id: string; value: string }[] };
export type DesktopStatus = {
  configured: boolean;
  connected: boolean;
  paired: boolean;
  email: string;
  library: string;
  signingIn: boolean;
  phase: string;
  lastSync?: string;
  message?: string;
  error?: string;
  vaults: { id: string; name: string }[];
  conflicts: Conflict[];
  heads?: string[];
};
declare global {
  interface Window {
    orbis?: {
      status(): Promise<DesktopStatus>;
      configureGoogle(): Promise<DesktopStatus>;
      connect(): Promise<DesktopStatus>;
      disconnect(): Promise<DesktopStatus>;
      createVault(): Promise<string>;
      unlock(id: string, key: string): Promise<DesktopStatus>;
      recoveryKey(): Promise<string>;
      sync(choices?: Record<string, string>, heads?: string[]): Promise<DesktopStatus>;
      importLibrary(): Promise<void>;
      openLibrary(): Promise<void>;
      openGraph(id: string): Promise<void>;
      onLibraryChanged(callback: () => void): () => void;
    };
  }
}
export function DesktopSettings() {
  const [open, setOpen] = useState(false),
    [status, setStatus] = useState<DesktopStatus>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [key, setKey] = useState(''),
    [recovery, setRecovery] = useState('');
  const [vault, setVault] = useState(''),
    [choices, setChoices] = useState<Record<string, string>>({});
  const dirty = useWorkspaceStore((s) => s.dirty);
  useEffect(() => {
    if (!window.orbis) return;
    const read = () =>
      window
        .orbis!.status()
        .then(setStatus)
        .catch((e) => setError(e.message));
    void read();
    const timer = setInterval(() => void read(), 2000);
    return () => clearInterval(timer);
  }, []);
  if (!window.orbis) return null;
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      setStatus(await window.orbis!.status());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const label = !status?.connected
    ? 'Local library'
    : !status.paired
      ? 'Connect library'
      : status.phase === 'synced'
        ? 'Synced'
        : status.phase === 'syncing'
          ? 'Syncing…'
          : status.phase === 'conflict'
            ? 'Review conflicts'
            : 'Sync needs attention';
  return (
    <>
      <button
        className="button secondary desktop-sync-button"
        aria-label="Google Drive sync settings"
        onClick={() => setOpen(true)}
      >
        <Cloud size={16} />
        <span>{label}</span>
      </button>
      {open && (
        <div className="graph-picker-backdrop">
          <section
            className="graph-picker desktop-settings"
            role="dialog"
            aria-modal="true"
            aria-labelledby="desktop-title"
          >
            <header>
              <div>
                <span className="eyebrow">ORBIS DESKTOP</span>
                <h2 id="desktop-title">Your library, everywhere</h2>
              </div>
              <button
                className="button secondary"
                aria-label="Close sync settings"
                onClick={() => {
                  setOpen(false);
                  setRecovery('');
                  setKey('');
                }}
              >
                <X size={18} />
              </button>
            </header>
            <p>
              Your library lives on this computer. Connect Google Drive to sync graphs,
              paper notes, and conversations between your devices.
            </p>
            <div className="desktop-status" role="status">
              <strong>{label}</strong>
              {status?.email && <span>{status.email}</span>}
              {status?.lastSync && (
                <small>Last synced {new Date(status.lastSync).toLocaleString()}</small>
              )}
            </div>
            {(error || status?.message || status?.error) && (
              <p className="desktop-error" role="alert">
                {error || status?.message || status?.error}
              </p>
            )}
            {!status?.configured && (
              <div className="desktop-setup">
                <h3>One-time Google setup for this preview</h3>
                <p>
                  The app owner must register Orbis with Google before sign-in works. After
                  that, users simply sign in.
                </p>
                <ol>
                  <li>
                    In Google Cloud, create a project and enable the Google Drive API.
                  </li>
                  <li>
                    Configure Google Auth Platform branding and an External audience. While
                    testing, add your Google account as a test user.
                  </li>
                  <li>
                    Create an OAuth client with application type{' '}
                    <strong>Desktop app</strong> and download its JSON file.
                  </li>
                </ol>
                <a
                  href="https://console.cloud.google.com/auth/clients"
                  target="_blank"
                  rel="noreferrer"
                >
                  Open Google Cloud setup ↗
                </a>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void run(() => window.orbis!.configureGoogle())}
                >
                  Choose Google client JSON
                </button>
              </div>
            )}
            {status?.configured && !status.connected && (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void run(() => window.orbis!.connect())}
              >
                {busy ? 'Complete sign-in in your browser…' : 'Sign in with Google'}
              </button>
            )}
            {status?.connected && !status.paired && (
              <div className="desktop-setup">
                {status.vaults.length ? (
                  <>
                    <h3>Unlock your existing library</h3>
                    <p>
                      Enter the recovery key shown on your first device. Saved local content
                      will be merged; conflicting edits will ask for review.
                    </p>
                    <label className="field">
                      <span>Google Drive library</span>
                      <select
                        value={vault || status.vaults[0].id}
                        onChange={(e) => setVault(e.target.value)}
                      >
                        {status.vaults.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Recovery key</span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={key}
                        onChange={(e) => setKey(e.target.value)}
                      />
                    </label>
                    <button
                      className="button primary"
                      disabled={busy || !key}
                      onClick={() =>
                        void run(async () => {
                          await window.orbis!.unlock(vault || status.vaults[0].id, key);
                          setKey('');
                        })
                      }
                    >
                      Unlock and sync
                    </button>
                  </>
                ) : (
                  <>
                    <h3>Start syncing this library</h3>
                    <p>
                      Orbis encrypts your library before storing it in its private Google
                      Drive app folder. Only Orbis data is accessible to the app.
                    </p>
                    <button
                      className="button primary"
                      disabled={busy || dirty}
                      onClick={() =>
                        void run(async () => setRecovery(await window.orbis!.createVault()))
                      }
                    >
                      Enable encrypted sync
                    </button>
                  </>
                )}
              </div>
            )}
            {recovery && (
              <div className="desktop-recovery">
                <strong>Save your recovery key</strong>
                <p>
                  You need this key to unlock your library on another device. Google sign-in
                  alone cannot recover it.
                </p>
                <textarea
                  readOnly
                  aria-label="Your recovery key"
                  value={recovery}
                  rows={2}
                />
              </div>
            )}
            {status?.paired && (
              <div className="desktop-actions">
                <button
                  className="button primary"
                  disabled={busy || dirty || !status.connected}
                  onClick={() => void run(() => window.orbis!.sync())}
                >
                  Sync now
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => setRecovery(await window.orbis!.recoveryKey()))
                  }
                >
                  Show recovery key
                </button>
              </div>
            )}
            {!!status?.conflicts.length && (
              <div className="desktop-conflicts">
                <h3>Choose which edits to keep</h3>
                <p>
                  All versions remain in encrypted sync history and local backups. Review
                  each difference before applying.
                </p>
                {status.conflicts.map((c) => (
                  <fieldset key={c.id}>
                    <legend>{c.path}</legend>
                    {c.choices.map((choice, index) => (
                      <label key={choice.id}>
                        <input
                          type="radio"
                          name={c.id}
                          checked={choices[c.id] === choice.id}
                          onChange={() => setChoices({ ...choices, [c.id]: choice.id })}
                        />
                        Version {index + 1}
                        <pre>{choice.value}</pre>
                      </label>
                    ))}
                  </fieldset>
                ))}
                <button
                  className="button primary"
                  disabled={busy || dirty || status.conflicts.some((c) => !choices[c.id])}
                  onClick={() => void run(() => window.orbis!.sync(choices, status.heads))}
                >
                  Apply selected versions
                </button>
              </div>
            )}
            <div className="desktop-actions">
              {!status?.paired && (
                <button
                  className="button secondary"
                  disabled={busy || dirty}
                  onClick={() => void run(() => window.orbis!.importLibrary())}
                >
                  Import existing Orbis library
                </button>
              )}
              <button
                className="button secondary"
                onClick={() => void run(() => window.orbis!.openLibrary())}
              >
                Open local library folder
              </button>
              {status?.connected && (
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void run(() => window.orbis!.disconnect())}
                >
                  Disconnect Google
                </button>
              )}
            </div>
            <small>
              Sync runs every 30 seconds while Orbis is open. Offline changes stay on this
              device until you reconnect. This preview syncs your existing records and
              notes; PDF caching is a separate upcoming feature.
            </small>
          </section>
        </div>
      )}
    </>
  );
}

export function DesktopLifecycle() {
  useEffect(() => {
    if (!window.orbis) return;
    return window.orbis.onLibraryChanged(() => {
      const s = useWorkspaceStore.getState();
      if (!s.dirty) void s.refresh().catch((e) => s.addToast(e.message, 'error'));
      else
        s.addToast(
          'Changes arrived from another device. Your local draft is preserved; review before reloading.',
          'warning',
        );
    });
  }, []);
  useEffect(() => {
    if (!window.orbis) return;
    let failedGraph: unknown;
    const timer = setInterval(() => {
      const s = useWorkspaceStore.getState();
      if (s.dirty && s.graph !== failedGraph) {
        void s.save().catch((e) => {
          failedGraph = s.graph;
          s.addToast(`Automatic save paused: ${e.message}`, 'error');
        });
      }
    }, 1500);
    return () => clearInterval(timer);
  }, []);
  return null;
}
