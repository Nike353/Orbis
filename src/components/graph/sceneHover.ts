import type { SceneData, SceneLink, SceneNode } from './sceneModel';

export type SceneHover =
  { kind: 'node'; node: SceneNode } | { kind: 'link'; link: SceneLink } | null;

// Resolve against the current scene: selection/filter changes replace its objects.
export function resolveSceneHover(scene: SceneData, hover: SceneHover): SceneHover {
  if (!hover) return null;
  if (hover.kind === 'node') {
    const node = scene.nodes.find((item) => item.id === hover.node.id);
    return node && !node.dimmed ? { kind: 'node', node } : null;
  }
  const link = scene.links.find((item) => item.id === hover.link.id);
  return link && !link.dimmed ? { kind: 'link', link } : null;
}

export function nextSceneHover(
  scene: SceneData,
  current: SceneHover,
  candidate: SceneHover,
) {
  const next = resolveSceneHover(scene, candidate);
  if (next) return next;
  const previous = resolveSceneHover(scene, current);
  // Connection notes stay available while moving from the line onto the card.
  return previous?.kind === 'link' ? previous : null;
}

export function membershipHoverVisible(
  link: SceneLink,
  paperId: string | null,
  clusterId: string | null,
) {
  return (
    link.kind === 'membership' &&
    !link.dimmed &&
    (link.highlighted || link.paperId === paperId || link.clusterId === clusterId)
  );
}
