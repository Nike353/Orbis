import { describe, expect, it } from 'vitest';
import canonicalGraph from '../../../tests/fixtures/library/data/graph.json';
import { filterGraph, type GraphFilters } from '../../domain/graph';
import { migrateAndValidateGraph, NODE_TYPES, STATUSES } from '../../domain/schema';
import { buildLineageMapScene, LEFT_GUTTER, YEAR_GAP } from './lineageMapModel';

const graph = migrateAndValidateGraph(canonicalGraph).graph;

function filters(overrides: Partial<GraphFilters> = {}): GraphFilters {
  return {
    query: '',
    nodeTypes: new Set(NODE_TYPES),
    statuses: new Set(STATUSES),
    relations: new Set(graph.edges.map((edge) => edge.relation)),
    clusterId: null,
    showRejected: false,
    ...overrides,
  };
}

describe('2D lineage map scene model', () => {
  it('places every visible paper once in a primary-cluster lane', () => {
    const visible = filterGraph(graph, filters());
    const scene = buildLineageMapScene(graph, visible, null);
    const papers = visible.nodes.filter((node) => node.type === 'paper');
    const primaryClusters = new Set(papers.map((paper) => paper.cluster));
    const paperNodes = scene.nodes.filter((node) => node.data.kind === 'paper');

    expect(scene.paperCount).toBe(papers.length);
    expect(paperNodes).toHaveLength(papers.length);
    expect(new Set(paperNodes.map((node) => node.id)).size).toBe(papers.length);
    expect(scene.laneCount).toBe(primaryClusters.size);
    expect(
      paperNodes.every(
        (node) =>
          node.data.kind === 'paper' && node.data.lane.id === node.data.node.cluster,
      ),
    ).toBe(true);
  });

  it('draws only authored paper-to-paper connections', () => {
    const visible = filterGraph(graph, filters());
    const visiblePaperIds = new Set(
      visible.nodes.filter((node) => node.type === 'paper').map((node) => node.id),
    );
    const expected = visible.edges.filter(
      (edge) => visiblePaperIds.has(edge.source) && visiblePaperIds.has(edge.target),
    );
    const scene = buildLineageMapScene(graph, visible, null);

    expect(scene.edges).toHaveLength(expected.length);
    expect(scene.edges.map((edge) => edge.id).sort()).toEqual(
      expected.map((edge) => edge.id).sort(),
    );
  });

  it('uses stable year columns and exposes evidence-backed bridge memberships', () => {
    const visible = filterGraph(graph, filters());
    const scene = buildLineageMapScene(graph, visible, null);
    const paperNodes = scene.nodes.filter((node) => node.data.kind === 'paper');

    for (const node of paperNodes) {
      if (node.data.kind !== 'paper') continue;
      const column = scene.years.indexOf(node.data.node.paper.year ?? 0);
      expect(node.position.x).toBe(LEFT_GUTTER + column * YEAR_GAP);
    }
    expect(
      paperNodes.some(
        (node) =>
          node.data.kind === 'paper' &&
          node.data.memberships.some((membership) => membership.role === 'secondary'),
      ),
    ).toBe(true);
  });

  it('keeps full lane metadata under filters and highlights a selected paper lineage', () => {
    const visible = filterGraph(graph, filters({ query: 'Diffusion Policy' }));
    const filtered = buildLineageMapScene(graph, visible, null);
    const filteredPapers = filtered.nodes.filter((node) => node.data.kind === 'paper');

    expect(filteredPapers.length).toBeGreaterThan(0);
    expect(
      filteredPapers.every(
        (node) =>
          node.data.kind === 'paper' &&
          node.data.lane.label === 'Diffusion-Based Visuomotor Policies',
      ),
    ).toBe(true);

    const full = buildLineageMapScene(graph, filterGraph(graph, filters()), null);
    const bridge = full.nodes.find(
      (node) =>
        node.data.kind === 'paper' &&
        node.data.memberships.some((membership) => membership.role === 'secondary'),
    )!;
    const selected = buildLineageMapScene(graph, filterGraph(graph, filters()), {
      kind: 'node',
      id: bridge.id,
    });

    expect(
      selected.edges.some(
        (edge) =>
          edge.data?.highlighted &&
          (edge.source === bridge.id || edge.target === bridge.id),
      ),
    ).toBe(true);
    expect(
      selected.nodes.some((node) => node.data.kind === 'paper' && node.data.dimmed),
    ).toBe(true);
  });
});

it('places undated web sources in an explicit undated column', () => {
  const copy = structuredClone(graph);
  const paper = copy.nodes.find((n) => n.type === 'paper')!;
  paper.paper!.source_kind = 'blog';
  paper.paper!.year = null;
  paper.paper!.authors = [];
  const scene = buildLineageMapScene(copy, copy, null);
  expect(scene.years).toContain(0);
});
