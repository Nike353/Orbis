import { describe, expect, it } from 'vitest';
import fixture from '../../../tests/fixtures/library/data/graph.json';
import { migrateAndValidateGraph } from '../../domain/schema';
import { buildSceneData } from './sceneModel';
import { membershipHoverVisible, nextSceneHover, resolveSceneHover } from './sceneHover';

const graph = migrateAndValidateGraph(fixture).graph;
const initial = buildSceneData(graph);
const paper = initial.paperNodes.find((node) => node.paperDegree > 0)!;
const focused = buildSceneData(graph, { selection: { kind: 'node', id: paper.id } });

describe('selection-scoped graph hover', () => {
  it('allows the selected paper and its neighbors but never undims unrelated papers', () => {
    const neighbor = focused.paperNodes.find(
      (node) => node.highlighted && node.id !== paper.id,
    )!;
    const unrelated = focused.paperNodes.find((node) => node.dimmed)!;
    expect(neighbor).toBeTruthy();
    expect(unrelated).toBeTruthy();
    expect(resolveSceneHover(focused, { kind: 'node', node: neighbor })?.kind).toBe('node');
    expect(resolveSceneHover(focused, { kind: 'node', node: unrelated })).toBeNull();
    expect(resolveSceneHover(initial, { kind: 'node', node: unrelated })?.kind).toBe(
      'node',
    );
  });

  it('rechecks an existing hover when the selection changes', () => {
    const unrelated = focused.paperNodes.find((node) => node.dimmed)!;
    const prior = resolveSceneHover(initial, { kind: 'node', node: unrelated });
    expect(prior).not.toBeNull();
    expect(resolveSceneHover(focused, prior)).toBeNull();
  });

  it('does not expose unrelated membership rays even when their field is hovered', () => {
    const rays = focused.membershipLinks.filter((link) => link.dimmed);
    expect(rays.length).toBeGreaterThan(0);
    for (const ray of rays) {
      expect(membershipHoverVisible(ray, ray.paperId!, ray.clusterId!)).toBe(false);
    }
    expect(
      focused.membershipLinks.some((link) => membershipHoverVisible(link, paper.id, null)),
    ).toBe(true);
  });

  it('keeps full connection notes available across empty space and unrelated nodes', () => {
    const link = focused.relationLinks.find((item) => item.highlighted)!;
    const current = { kind: 'link' as const, link };
    expect(nextSceneHover(focused, current, null)).toEqual(current);
    const unrelated = focused.paperNodes.find((node) => node.dimmed)!;
    expect(nextSceneHover(focused, current, { kind: 'node', node: unrelated })).toEqual(
      current,
    );
    const selected = focused.paperNodes.find((node) => node.id === paper.id)!;
    expect(nextSceneHover(focused, current, { kind: 'node', node: selected })?.kind).toBe(
      'node',
    );
    expect(resolveSceneHover({ ...focused, links: [] }, current)).toBeNull();
  });
});
