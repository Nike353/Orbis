import {
  BookOpen,
  Box,
  ChevronRight,
  FileDown,
  FileInput,
  FileText,
  Layers3,
  LoaderCircle,
} from 'lucide-react';
import { graphStats } from '../../domain/graph';
import { clusterPaperCounts } from '../../domain/hypergraph';
import { buildClusterMarkdown, downloadText } from '../../services/exportMarkdown';
import { loadGraphFile } from '../../services/graphRepository';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { GraphEditor } from '../GraphEditor';

export function LibraryPanel() {
  const graph = useWorkspaceStore((state) => state.graph)!;
  const selection = useWorkspaceStore((state) => state.selection);
  const select = useWorkspaceStore((state) => state.select);
  const setCluster = useWorkspaceStore((state) => state.setCluster);
  const replaceGraph = useWorkspaceStore((state) => state.replaceGraph);
  const addToast = useWorkspaceStore((state) => state.addToast);
  const paperImport = useWorkspaceStore((state) => state.paperImport);
  const openImport = useWorkspaceStore((state) => state.openImport);
  const clusterFilter = useWorkspaceStore((state) => state.filters.clusterId);
  const query = useWorkspaceStore((state) => state.filters.query.trim().toLowerCase());
  const stats = graphStats(graph);
  const clusters = graph.nodes.filter((node) => node.type === 'cluster');
  const paperCounts = clusterPaperCounts(graph);
  const filteredNodes = graph.nodes
    .filter((node) => node.type !== 'cluster' && node.status !== 'rejected')
    .filter(
      (node) =>
        !query ||
        [node.label, node.description, node.paper?.title, node.paper?.authors.join(' ')]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(query),
    );
  const matchingNodes = query
    ? filteredNodes
    : [...filteredNodes]
        .sort((left, right) =>
          (right.created_at ?? '').localeCompare(left.created_at ?? ''),
        )
        .slice(0, 12);
  const showImport =
    paperImport &&
    paperImport.status !== 'ready' &&
    (!query || paperImport.url.toLowerCase().includes(query));

  return (
    <div className="panel-scroll">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Workspace</span>
          <h2>Research library</h2>
        </div>
      </div>

      <div className="metric-row">
        <div>
          <FileText size={15} aria-hidden="true" />
          <strong>{stats.papers}</strong>
          <span>Papers</span>
        </div>
        <div>
          <Box size={15} aria-hidden="true" />
          <strong>{stats.concepts}</strong>
          <span>Concepts</span>
        </div>
        <div>
          <Layers3 size={15} aria-hidden="true" />
          <strong>{stats.connections}</strong>
          <span>Links</span>
        </div>
      </div>
      <GraphEditor />

      {!query && (
        <section className="panel-section">
          <div className="section-title">
            <h3>Clusters</h3>
            <span>{clusters.length}</span>
          </div>
          <div className="cluster-list">
            {clusters.map((cluster) => {
              const count = paperCounts.get(cluster.id) ?? {
                papers: 0,
                primary: 0,
                bridges: 0,
              };
              return (
                <button
                  key={cluster.id}
                  onClick={() => {
                    setCluster(cluster.id);
                    select({ kind: 'node', id: cluster.id });
                  }}
                  className={selection?.id === cluster.id ? 'active' : ''}
                >
                  <span className="cluster-icon">
                    <Layers3 size={16} aria-hidden="true" />
                  </span>
                  <span>
                    <strong>{cluster.label}</strong>
                    <small>
                      {count.papers} papers
                      {count.bridges ? ` · ${count.bridges} bridge` : ''}
                    </small>
                  </span>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="panel-section">
        <div className="section-title">
          <h3>{query ? 'Search results' : 'Recently added'}</h3>
          <span>{query ? filteredNodes.length : ''}</span>
        </div>
        <div className="library-list">
          {showImport && (
            <button onClick={openImport}>
              {['starting', 'running'].includes(paperImport.status) ? (
                <LoaderCircle className="spin" size={15} aria-hidden="true" />
              ) : (
                <BookOpen size={15} aria-hidden="true" />
              )}
              <span>
                <strong>{paperImport.url}</strong>
                <small>
                  {['starting', 'running'].includes(paperImport.status)
                    ? 'Preparing summary · Read now'
                    : 'Import needs attention · Read preview'}
                </small>
              </span>
            </button>
          )}
          {matchingNodes.map((node) => (
            <button
              key={node.id}
              className={selection?.id === node.id ? 'active' : ''}
              onClick={() => select({ kind: 'node', id: node.id })}
            >
              <span className={`type-dot type-${node.type}`} />
              <span>
                <strong>{node.label}</strong>
                <small>
                  {node.type.replace('_', ' ')}
                  {node.paper?.year ? ` · ${node.paper.year}` : ''}
                </small>
              </span>
            </button>
          ))}
          {matchingNodes.length === 0 && !showImport && (
            <div className="empty-panel">
              <BookOpen size={22} aria-hidden="true" />
              <p>No papers or concepts match this search.</p>
            </div>
          )}
        </div>
      </section>

      {!query && (
        <section className="panel-section workspace-actions">
          <div className="section-title">
            <h3>Workspace files</h3>
          </div>
          <div>
            <label className="button secondary">
              <FileInput size={15} />
              Open graph
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void loadGraphFile(file)
                    .then((loaded) => {
                      replaceGraph(loaded);
                      addToast(
                        'Graph file validated and opened as an unsaved draft.',
                        'success',
                      );
                    })
                    .catch((error) =>
                      addToast(
                        `Could not open graph: ${error instanceof Error ? error.message : String(error)}`,
                        'error',
                      ),
                    );
                  event.target.value = '';
                }}
              />
            </label>
            <button
              className="button secondary"
              disabled={!clusterFilter}
              onClick={() => {
                if (!clusterFilter) return;
                try {
                  downloadText(
                    `${clusterFilter.replace(/^cluster:/, '')}-notes.md`,
                    buildClusterMarkdown(graph, clusterFilter),
                  );
                  addToast('Cluster notes exported.', 'success');
                } catch (error) {
                  addToast(error instanceof Error ? error.message : String(error), 'error');
                }
              }}
            >
              <FileDown size={15} />
              Export cluster
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
