import { lazy, Suspense, useEffect, useLayoutEffect } from 'react';
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
import { flushDesktopPreferences } from './services/preferences';
import { ResearchDesk } from './components/ResearchDesk';
import { DesktopLifecycle } from './components/DesktopSettings';
import { flushPaperDrafts } from './services/draftLifecycle';

const PaperWorkspace = lazy(() => import('./components/PaperWorkspace'));

export function App() {
  const load = useWorkspaceStore((state) => state.load);
  const loading = useWorkspaceStore((state) => state.loading);
  const error = useWorkspaceStore((state) => state.error);
  const graph = useWorkspaceStore((state) => state.graph);
  const dirty = useWorkspaceStore((state) => state.dirty);
  const activeTab = useWorkspaceStore((state) => state.activeTab);
  const graphView = useWorkspaceStore((state) => state.graphView);
  const selection = useWorkspaceStore((state) => state.selection);
  const paperWorkspace = useWorkspaceStore((state) => state.paperWorkspace);
  const addPaperOpen = useWorkspaceStore((state) => state.addPaperOpen);
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
  useEffect(() => {
    return window.orbis?.onBeforeClose(async () => {
      await flushDesktopPreferences();
      await flushPaperDrafts();
      const state = useWorkspaceStore.getState();
      if (state.dirty) await state.save();
    });
  }, []);
  useEffect(() => {
    const failed = (event: Event) =>
      useWorkspaceStore
        .getState()
        .addToast(
          `Settings could not be saved: ${(event as CustomEvent<string>).detail}`,
          'error',
        );
    window.addEventListener('orbis:preferenceError', failed);
    return () => window.removeEventListener('orbis:preferenceError', failed);
  }, []);
  useLayoutEffect(() => {
    if (!paperWorkspace) return;
    const background = document.querySelectorAll<HTMLElement>(
      '.app-header, .app-nav, .side-panel, .graph-workspace, .inspector, .research-workspace',
    );
    for (const element of background) element.inert = true;
    return () => {
      for (const element of background) element.inert = false;
    };
  }, [paperWorkspace, loading, error]);

  if (loading) return <LoadingState />;
  if (error || !graph) return <WorkspaceError message={error ?? 'No graph loaded.'} />;

  return (
    <div className="app-shell">
      <DesktopLifecycle />
      <AppHeader />
      <div className="workspace">
        <AppNav />
        <SidePanel />
        <main
          className={[
            'graph-workspace',
            activeTab && !research ? 'has-side-panel' : '',
            selection ? 'has-inspector' : '',
            research ? 'graph-covered' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {graph.nodes.length === 0 ? (
            <div className="empty-universe">
              <span className="eyebrow">A library shaped by your curiosity</span>
              <h1>Your paper universe starts here.</h1>
              <p>
                Add a paper from any research field. Your local agent will suggest its first
                cluster, explain its contribution, and help connect each new paper to the
                literature you care about.
              </p>
              <button className="button primary" onClick={() => addPaper(true)}>
                Add your first paper
              </button>
            </div>
          ) : graphView === 'lineages' ? (
            <LineageMap />
          ) : (
            <GraphScene paused={research || Boolean(paperWorkspace) || addPaperOpen} />
          )}
        </main>
        {research && (
          <main className="research-workspace">
            <ResearchDesk key={activeTab} comparison={activeTab === 'compare'} />
          </main>
        )}
        {!research && <Inspector />}
        {paperWorkspace && (
          <Suspense
            fallback={
              <div className="paper-workspace reader-empty" role="status">
                Opening paper workspace…
              </div>
            }
          >
            <PaperWorkspace key={paperWorkspace.nodeId} />
          </Suspense>
        )}
      </div>
      <AddPaperDialog />
      <DraftPrompt />
      <ToastRegion />
    </div>
  );
}
