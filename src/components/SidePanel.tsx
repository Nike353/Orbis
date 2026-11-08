import { FiltersPanel } from './panels/FiltersPanel';
import { ImportQueue } from './panels/ImportQueue';
import { LibraryPanel } from './panels/LibraryPanel';
import { ReviewPanel } from './panels/ReviewPanel';
import { useWorkspaceStore } from '../store/workspaceStore';
import { ActivityPanel } from './panels/ActivityPanel';

export function SidePanel() {
  const activeTab = useWorkspaceStore((state) => state.activeTab);
  if (!activeTab || activeTab === 'research' || activeTab === 'compare') return null;
  return (
    <aside className="side-panel" aria-label="Workspace panel">
      {activeTab === 'library' && <LibraryPanel />}
      {activeTab === 'review' && <ReviewPanel />}
      {activeTab === 'filters' && <FiltersPanel />}
      {activeTab === 'imports' && <ImportQueue />}
      {activeTab === 'activity' && <ActivityPanel />}
    </aside>
  );
}
