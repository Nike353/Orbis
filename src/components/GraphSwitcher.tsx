import { useState } from 'react';
import { FolderOpen, Plus, X } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspaceStore';

type Library = { id: string; name: string; sources: number; active: boolean };
async function request(path: string, body?: object) {
  const response = await fetch(`/api/graphs${path}`, {
    cache: 'no-store',
    ...(body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Could not open your graphs.');
  return result;
}
export function GraphSwitcher() {
  const [open, setOpen] = useState(false);
  const [graphs, setGraphs] = useState<Library[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = useWorkspaceStore((s) => s.dirty);
  async function show() {
    setOpen(true);
    setError('');
    try {
      setGraphs((await request('')).graphs);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function choose(id: string) {
    if (dirty) {
      setError('Save your graph changes before switching.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { url } = await request(`/${id}/open`, {});
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  async function create() {
    setBusy(true);
    setError('');
    try {
      await request('', { name });
      setName('');
      setGraphs((await request('')).graphs);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="header-icon-button"
        aria-label="Choose graph"
        title="Choose graph"
        onClick={() => void show()}
      >
        <FolderOpen size={18} />
      </button>
      {open && (
        <div className="graph-picker-backdrop">
          <section
            className="graph-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="graph-picker-title"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false);
            }}
          >
            <header>
              <div>
                <span className="eyebrow">YOUR WORKSPACES</span>
                <h2 id="graph-picker-title">Choose your graph</h2>
              </div>
              <button
                className="button secondary"
                aria-label="Close graph picker"
                onClick={() => setOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            <p>
              Keep different projects in independent graphs. Each has its own sources,
              notes, connections, and research history.
            </p>
            {error && (
              <p role="alert" className="graph-picker-error">
                {error}
              </p>
            )}
            <div className="graph-cards">
              {graphs.map((g) => (
                <button
                  key={g.id}
                  className={g.active ? 'graph-card active' : 'graph-card'}
                  disabled={busy || g.active}
                  onClick={() => void choose(g.id)}
                >
                  <FolderOpen size={24} />
                  <strong>{g.name}</strong>
                  <span>
                    {g.sources} sources · {g.active ? 'Current graph' : 'Open graph'}
                  </span>
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <label>
                New graph name
                <input
                  autoFocus
                  value={name}
                  maxLength={100}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. World models, Reading list…"
                />
              </label>
              <button className="button primary" disabled={busy || !name.trim()}>
                <Plus size={16} />
                Create empty graph
              </button>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
