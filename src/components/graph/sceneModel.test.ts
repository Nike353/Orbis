import { describe, expect, it } from 'vitest';
import canonicalGraph from '../../../tests/fixtures/library/data/graph.json';
import { migrateAndValidateGraph } from '../../domain/schema';
import { buildSceneData } from './sceneModel';

const graph = migrateAndValidateGraph(canonicalGraph).graph;

describe('literature universe scene model', () => {
  it('uses papers and research fields as the calm default layer', () => {
    const scene = buildSceneData(graph);
    const paperCount = graph.nodes.filter((node) => node.type === 'paper').length;
    const fieldCount = graph.nodes.filter((node) => node.type === 'cluster').length;

    expect(scene.paperNodes).toHaveLength(paperCount);
    expect(scene.fieldNodes).toHaveLength(fieldCount);
    expect(scene.conceptNodes).toHaveLength(0);
    expect(scene.nodes).toHaveLength(paperCount + fieldCount);
    for (const node of scene.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(Number.isFinite(node.z)).toBe(true);
      expect(node.fx).toBe(node.x);
      expect(node.fy).toBe(node.y);
      expect(node.fz).toBe(node.z);
    }
  });

  it('projects evidence-backed cross-cluster edges as weighted hypergraph membership', () => {
    const scene = buildSceneData(graph);
    const bridges = scene.paperNodes.filter((node) => node.memberships.length > 1);

    expect(bridges.length).toBeGreaterThan(0);
    expect(new Set(scene.paperNodes.map((node) => node.id)).size).toBe(
      scene.paperNodes.length,
    );
    expect(scene.membershipLinks).toHaveLength(
      scene.paperNodes.reduce((sum, node) => sum + node.memberships.length, 0),
    );
    expect(scene.fields.some((field) => field.bridgeCount > 0)).toBe(true);
    expect(
      bridges.every((node) => {
        const [primary, ...secondary] = node.memberships;
        return (
          primary.role === 'primary' &&
          primary.weight === 1 &&
          secondary.every(
            (membership) =>
              membership.role === 'secondary' &&
              membership.weight > 0 &&
              membership.weight < 1,
          )
        );
      }),
    ).toBe(true);
  });

  it('restores all authored nodes and relationships when the concept layer is shown', () => {
    const scene = buildSceneData(graph, { showConcepts: true });

    expect(scene.nodes).toHaveLength(graph.nodes.length);
    expect(scene.relationLinks).toHaveLength(graph.edges.length);
    expect(
      scene.relationLinks.every(
        (link) => link.kind === 'relation' && link.original != null,
      ),
    ).toBe(true);
  });

  it('is deterministic and unfolds paper chronology along the time axis', () => {
    const first = buildSceneData(graph);
    const second = buildSceneData(graph);
    expect(second.paperNodes.map(({ id, x, y, z }) => ({ id, x, y, z }))).toEqual(
      first.paperNodes.map(({ id, x, y, z }) => ({ id, x, y, z })),
    );

    const time = buildSceneData(graph, { lens: 'time' });
    const dated = [...time.paperNodes].sort(
      (left, right) => (left.original.paper?.year ?? 0) - (right.original.paper?.year ?? 0),
    );
    expect(dated[0].x).toBeLessThan(dated[dated.length - 1].x);
    expect(time.fields.every((field) => field.radii.x >= 44)).toBe(true);
  });

  it('reveals membership rays and the authored ego network for a selected paper', () => {
    const bridge = buildSceneData(graph).paperNodes.find(
      (node) => node.memberships.length > 1,
    )!;
    const selected = buildSceneData(graph, {
      selection: { kind: 'node', id: bridge.id },
    });

    expect(
      selected.membershipLinks
        .filter((link) => link.paperId === bridge.id)
        .every((link) => link.highlighted),
    ).toBe(true);
    expect(
      selected.relationLinks.some(
        (link) =>
          link.highlighted &&
          (link.original?.source === bridge.id || link.original?.target === bridge.id),
      ),
    ).toBe(true);
    expect(selected.paperNodes.some((node) => node.dimmed)).toBe(true);
  });
});

it('gives larger fields room to grow and keeps paper centers separated', () => {
  const dense = structuredClone(graph);
  const prototype = dense.nodes.find((n) => n.type === 'paper')!;
  for (let i = 0; i < 60; i++)
    dense.nodes.push({
      ...structuredClone(prototype),
      id: `paper:dense-${i}`,
      label: `Dense ${i}`,
    });
  const scene = buildSceneData(dense);
  const field = scene.fields.find((f) => f.cluster.id === prototype.cluster)!;
  const small = buildSceneData(graph).fields.find(
    (f) => f.cluster.id === prototype.cluster,
  )!;
  expect(Math.max(field.radii.x, field.radii.y, field.radii.z)).toBeGreaterThan(
    Math.max(small.radii.x, small.radii.y, small.radii.z),
  );
  for (let i = 0; i < scene.paperNodes.length; i++) {
    for (let j = i + 1; j < scene.paperNodes.length; j++) {
      const a = scene.paperNodes[i],
        b = scene.paperNodes[j];
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThan(27);
    }
  }
});

it('keeps focused cluster members and their paths visible after closing the inspector', () => {
  const baseline = buildSceneData(graph);
  const source = baseline.paperNodes.find((n) => n.paperDegree > 0)!;
  const cluster = source.memberships.find((m) => m.role === 'primary')!.cluster.id;
  const scene = buildSceneData(graph, { selection: null, focusedClusterId: cluster });
  const members = scene.paperNodes.filter((n) =>
    n.memberships.some((m) => m.cluster.id === cluster),
  );
  expect(members.length).toBeGreaterThan(1);
  expect(members.every((n) => n.highlighted && !n.dimmed)).toBe(true);
  const ids = new Set(members.map((n) => n.id));
  const internal = scene.relationLinks.filter(
    (e) => ids.has(String(e.source)) && ids.has(String(e.target)),
  );
  expect(internal.length).toBeGreaterThan(0);
  expect(internal.every((e) => !e.dimmed)).toBe(true);
});
