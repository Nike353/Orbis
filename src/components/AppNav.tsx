import {
  Filter,
  GitPullRequestArrow,
  Library,
  ListPlus,
  PanelLeftClose,
  MessagesSquare,
  Table2,
  Activity,
} from 'lucide-react';
import { proposedItems } from '../domain/graph';
import { useWorkspaceStore, type WorkspaceTab } from '../store/workspaceStore';

const navItems: Array<{
  id: WorkspaceTab;
  label: string;
  icon: typeof Library;
}> = [
  { id: 'library', label: 'Library', icon: Library },
  { id: 'review', label: 'Review queue', icon: GitPullRequestArrow },
  { id: 'filters', label: 'Filters', icon: Filter },
  { id: 'imports', label: 'Add papers', icon: ListPlus },
  { id: 'research', label: 'Discuss', icon: MessagesSquare },
  { id: 'compare', label: 'Compare', icon: Table2 },
  { id: 'activity', label: 'Activity', icon: Activity },
];

export function AppNav() {
  const activeTab = useWorkspaceStore((state) => state.activeTab);
  const setTab = useWorkspaceStore((state) => state.setTab);
  const select = useWorkspaceStore((state) => state.select);
  const graph = useWorkspaceStore((state) => state.graph)!;
  const reviewCount = proposedItems(graph).length;

  return (
    <nav className="app-nav" aria-label="Workspace tools">
      <div className="nav-items">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={activeTab === id ? 'active' : ''}
            onClick={() => {
              const compactInspector =
                window.matchMedia('(max-width: 1120px)').matches &&
                useWorkspaceStore.getState().selection !== null;
              if (compactInspector) select(null);
              setTab(activeTab === id && !compactInspector ? null : id);
            }}
            aria-label={label}
            aria-pressed={activeTab === id}
            title={label}
          >
            <Icon size={20} aria-hidden="true" />
            {id === 'review' && reviewCount > 0 && (
              <span className="nav-count" aria-label={`${reviewCount} proposed items`}>
                {reviewCount > 99 ? '99+' : reviewCount}
              </span>
            )}
            <span className="nav-label">{label}</span>
          </button>
        ))}
      </div>
      <button
        className="nav-collapse"
        onClick={() => setTab(null)}
        aria-label="Close tools panel"
        title="Close panel"
      >
        <PanelLeftClose size={19} aria-hidden="true" />
      </button>
    </nav>
  );
}
