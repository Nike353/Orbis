import { useEffect } from 'react';
import { AppHeader } from './components/AppHeader';
import { AddPaperDialog } from './components/AddPaperDialog';
import { AppNav } from './components/AppNav';
import { GraphScene } from './components/GraphScene';
import { Inspector } from './components/Inspector';
import { LineageMap } from './components/LineageMap';
import { SidePanel } from './components/SidePanel';
import { ToastRegion } from './components/ToastRegion';
import { DraftPrompt } from './components/DraftPrompt';
import { LoadingState, WorkspaceError } from './components/WorkspaceStates';
import { useWorkspaceStore } from './store/workspaceStore';
import { ResearchDesk } from './components/ResearchDesk';
import { DesktopLifecycle } from './components/DesktopSettings';

export function App() {
  const load = useWorkspaceStore((state) => state.load);
  const loading = useWorkspaceStore((state) => state.loading);
  const error = useWorkspaceStore((state) => state.error);
  const graph = useWorkspaceStore((state) => state.graph);
  const dirty = useWorkspaceStore((state) => state.dirty);
  const activeTab = useWorkspaceStore((state) => state.activeTab);
  const graphView = useWorkspaceStore((state) => state.graphView);
  const selection = useWorkspaceStore((state) => state.selection);
  const research = activeTab === 'research' || activeTab === 'compare';
  const addPaper = useWorkspaceStore((s) => s.setAddPaperOpen);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (loading) return <LoadingState />;
  if (error || !graph) return <WorkspaceError message={error ?? 'No graph loaded.'} />;

  return (
    <div className="app-shell">
      <DesktopLifecycle />
      <AppHeader />
      <div className="workspace">
        <AppNav />
        <SidePanel />
        {research ? (
          <main className="research-workspace">
            <ResearchDesk key={activeTab} comparison={activeTab === 'compare'} />
          </main>
        ) : (
          <main
            className={[
              'graph-workspace',
              activeTab ? 'has-side-panel' : '',
              selection ? 'has-inspector' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {graph.nodes.length === 0 ? (
              <div className="empty-universe">
                <span className="eyebrow">A library shaped by your curiosity</span>
                <h1>Your paper universe starts here.</h1>
                <p>
                  Add a paper from any research field. Your local agent will suggest its
                  first cluster, explain its contribution, and help connect each new paper
                  to the literature you care about.
                </p>
                <button className="button primary" onClick={() => addPaper(true)}>
                  Add your first paper
                </button>
              </div>
            ) : graphView === 'lineages' ? (
              <LineageMap />
            ) : (
              <GraphScene />
            )}
          </main>
        )}
        {!research && <Inspector />}
      </div>
      <AddPaperDialog />
      <DraftPrompt />
      <ToastRegion />
    </div>
  );
}
