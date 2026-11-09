import { GraphSwitcher } from './GraphSwitcher';
import { DesktopSettings } from './DesktopSettings';
import {
  CloudOff,
  Database,
  Download,
  GitBranch,
  LoaderCircle,
  Network,
  Orbit,
  Plus,
  RefreshCw,
  Save,
  Search,
  CircleHelp,
} from 'lucide-react';
import { graphStats } from '../domain/graph';
import { RevisionConflictError } from '../services/graphRepository';
import { useWorkspaceStore } from '../store/workspaceStore';

export function AppHeader({ onStartTutorial }: { onStartTutorial: () => void }) {
  const graph = useWorkspaceStore((state) => state.graph)!;
  const mode = useWorkspaceStore((state) => state.mode);
  const dirty = useWorkspaceStore((state) => state.dirty);
  const query = useWorkspaceStore((state) => state.filters.query);
  const setQuery = useWorkspaceStore((state) => state.setQuery);
  const setTab = useWorkspaceStore((state) => state.setTab);
  const graphView = useWorkspaceStore((state) => state.graphView);
  const setGraphView = useWorkspaceStore((state) => state.setGraphView);
  const setAddPaperOpen = useWorkspaceStore((state) => state.setAddPaperOpen);
  const save = useWorkspaceStore((state) => state.save);
  const addToast = useWorkspaceStore((state) => state.addToast);
  const loading = useWorkspaceStore((state) => state.loading);
  const stats = graphStats(graph);

  async function handleSave() {
    try {
      const method = await save();
      addToast(
        method === 'download'
          ? 'Downloaded graph.json. Replace the workspace copy to apply it.'
          : 'Graph saved to disk.',
        method === 'download' ? 'warning' : 'success',
      );
    } catch (error) {
      addToast(
        error instanceof RevisionConflictError
          ? error.message
          : `Save failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }
  }

  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark">
          <Network size={19} aria-hidden="true" />
        </span>
        <span className="brand-name">Orbis</span>
        <GraphSwitcher />
        <span className="workspace-name">
          {graph.meta.title.replace(
            /^(?:Orbis|LitBench|ScholarSync)(?:\s*[—–:-]\s*|\s*$)/i,
            '',
          )}
        </span>
      </div>

      <label className="global-search">
        <Search size={17} aria-hidden="true" />
        <span className="sr-only">Search papers and concepts</span>
        <input
          type="search"
          value={query}
          onFocus={() => setTab('library')}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search papers, authors, concepts"
        />
        {query && <kbd>{stats.papers + stats.concepts}</kbd>}
      </label>

      <div className="header-actions">
        <button
          className="header-icon-button"
          aria-label="Open tutorial"
          title="Tutorial — how to use Orbis"
          onClick={onStartTutorial}
        >
          <CircleHelp size={17} aria-hidden="true" />
        </button>
        <DesktopSettings />
        <div className="graph-view-switch" aria-label="Graph view">
          <button
            type="button"
            className={graphView === 'lineages' ? 'active' : ''}
            onClick={() => setGraphView('lineages')}
            aria-label="2D lineage view"
            aria-pressed={graphView === 'lineages'}
            title="Two-dimensional paper lineages"
          >
            <GitBranch size={15} aria-hidden="true" />
            <span>2D Lineages</span>
          </button>
          <button
            type="button"
            className={graphView === 'universe' ? 'active' : ''}
            onClick={() => setGraphView('universe')}
            aria-label="3D universe view"
            aria-pressed={graphView === 'universe'}
            title="Literature universe"
          >
            <Orbit size={15} aria-hidden="true" />
            <span>3D Universe</span>
          </button>
        </div>
        <div
          className="mode-indicator"
          title={
            mode === 'api'
              ? 'Connected to the local persistence API'
              : mode === 'http'
                ? 'Loaded as a static HTTP workspace'
                : 'Loaded from the offline graph snapshot'
          }
        >
          {mode === 'api' ? (
            <Database size={14} aria-hidden="true" />
          ) : (
            <CloudOff size={14} aria-hidden="true" />
          )}
          <span>
            {mode === 'api' ? 'Local API' : mode === 'http' ? 'Static' : 'Offline'}
          </span>
        </div>
        <button
          className="button secondary add-paper-button"
          aria-label="Add paper"
          title="Add paper or web source"
          onClick={() => setAddPaperOpen(true)}
        >
          <Plus size={16} aria-hidden="true" />
          <span>Add source</span>
        </button>
        <button
          className="header-icon-button"
          title="Reload graph from disk"
          aria-label="Reload graph from disk"
          onClick={() => {
            if (
              !dirty ||
              window.confirm('Discard unsaved changes and reload the graph from disk?')
            ) {
              window.location.reload();
            }
          }}
        >
          <RefreshCw size={16} />
        </button>
        <button
          className="button primary save-button"
          aria-label={dirty ? 'Save changes' : 'Saved'}
          title={dirty ? 'Save changes' : 'Saved'}
          onClick={() => void handleSave()}
          disabled={!dirty || loading}
        >
          {loading ? (
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
          ) : mode === 'api' ? (
            <Save size={16} aria-hidden="true" />
          ) : (
            <Download size={16} aria-hidden="true" />
          )}
          <span>{dirty ? 'Save changes' : 'Saved'}</span>
          {dirty && <i aria-label="Unsaved changes" />}
        </button>
      </div>
    </header>
  );
}
