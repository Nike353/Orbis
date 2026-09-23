import { derivePaperMemberships, type ClusterMembership } from '../../domain/hypergraph';
import type { Selection } from '../../store/workspaceStore';
import type { GraphData, GraphEdge, GraphNode } from '../../domain/schema';

export const TYPE_COLORS: Record<GraphNode['type'], string> = {
  paper: '#dce9ef',
  cluster: '#f3f7ff',
  method: '#c49aef',
  representation: '#60d4c1',
  assumption: '#e6bb68',
  experiment: '#9bcf72',
  claim: '#69d39c',
  open_question: '#ee8d78',
};

export const CLUSTER_COLORS = [
  '#46a8d8',
  '#e8704f',
  '#43b993',
  '#a76bd1',
  '#d89d36',
  '#5d7fd2',
  '#d46180',
  '#64b5a4',
  '#d47e5b',
  '#86a94c',
  '#8e73ce',
  '#49a5b5',
  '#d178a8',
] as const;

export type UniverseLens = 'semantic' | 'time';
export type SceneNodeKind = 'paper' | 'concept' | 'field';

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface SceneNode extends Point3 {
  id: string;
  kind: SceneNodeKind;
  label: string;
  type: GraphNode['type'];
  status: GraphNode['status'];
  original: GraphNode;
  clusterColor: string;
  memberships: Array<ClusterMembership & { color: string }>;
  degree: number;
  paperDegree: number;
  radius: number;
  labelVisible: boolean;
  selected: boolean;
  highlighted: boolean;
  dimmed: boolean;
  semanticPosition: Point3;
  timePosition: Point3;
  focusDistance?: number;
  primaryCount?: number;
  bridgeCount?: number;
  conceptCount?: number;
  fx: number;
  fy: number;
  fz: number;
}

export interface SceneLink {
  id: string;
  kind: 'relation' | 'membership';
  source: string | SceneNode;
  target: string | SceneNode;
  relation: string;
  status: GraphEdge['status'] | 'membership';
  original?: GraphEdge;
  color: string;
  highlighted: boolean;
  dimmed: boolean;
  crossCluster: boolean;
  curveRotation: number;
  paperId?: string;
  clusterId?: string;
  membershipRole?: ClusterMembership['role'];
  membershipWeight?: number;
}

export interface SceneField {
  cluster: GraphNode;
  color: string;
  center: Point3;
  radii: Point3;
  paperCount: number;
  primaryCount: number;
  bridgeCount: number;
  conceptCount: number;
  selected: boolean;
  dimmed: boolean;
}

export interface SceneBounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
}

export interface SceneData {
  nodes: SceneNode[];
  links: SceneLink[];
  paperNodes: SceneNode[];
  conceptNodes: SceneNode[];
  fieldNodes: SceneNode[];
  relationLinks: SceneLink[];
  membershipLinks: SceneLink[];
  fields: SceneField[];
  lens: UniverseLens;
  years: number[];
  bounds: SceneBounds;
}

export interface SceneOptions {
  visibleGraph?: GraphData;
  selection?: Selection;
  lens?: UniverseLens;
  showConcepts?: boolean;
  showFields?: boolean;
  focusedClusterId?: string | null;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function unitValue(value: string, salt: number) {
  let state = hashString(value) ^ salt;
  state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
  state = Math.imul(state ^ (state >>> 16), 0x45d9f3b);
  return ((state ^ (state >>> 16)) >>> 0) / 0xffffffff;
}

function clonePoint(point: Point3): Point3 {
  return { x: point.x, y: point.y, z: point.z };
}

function seededDirection(id: string) {
  const theta = unitValue(id, 0x9e3779b9) * Math.PI * 2;
  const y = unitValue(id, 0x85ebca6b) * 2 - 1;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  return {
    x: Math.cos(theta) * ring,
    y,
    z: Math.sin(theta) * ring,
  };
}

function clusterColorMap(graph: GraphData) {
  return new Map(
    graph.nodes
      .filter((node) => node.type === 'cluster')
      .map((cluster, index) => [cluster.id, CLUSTER_COLORS[index % CLUSTER_COLORS.length]]),
  );
}

function computeClusterAnchors(
  graph: GraphData,
  memberships: ReturnType<typeof derivePaperMemberships>,
) {
  const clusters = graph.nodes.filter((node) => node.type === 'cluster');
  const overlap = new Map<string, number>();

  for (const paperMemberships of memberships.values()) {
    for (let left = 0; left < paperMemberships.length; left += 1) {
      for (let right = left + 1; right < paperMemberships.length; right += 1) {
        const key = [paperMemberships[left].cluster.id, paperMemberships[right].cluster.id]
          .sort()
          .join('|');
        overlap.set(
          key,
          (overlap.get(key) ?? 0) +
            Math.min(paperMemberships[left].weight, paperMemberships[right].weight),
        );
      }
    }
  }

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.edges) {
    if (edge.status === 'rejected') continue;
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const sourceCluster = source?.type === 'cluster' ? source.id : source?.cluster;
    const targetCluster = target?.type === 'cluster' ? target.id : target?.cluster;
    if (!sourceCluster || !targetCluster || sourceCluster === targetCluster) continue;
    const key = [sourceCluster, targetCluster].sort().join('|');
    overlap.set(key, (overlap.get(key) ?? 0) + edge.confidence * 0.32);
  }

  const clusterSizes = new Map(
    clusters.map((cluster) => [
      cluster.id,
      graph.nodes.filter((node) => node.type === 'paper' && node.cluster === cluster.id)
        .length,
    ]),
  );
  const footprint = (id: string) => 48 + Math.cbrt(clusterSizes.get(id) ?? 0) * 25;
  const maximumOverlap = Math.max(1, ...overlap.values());
  const initial = clusters.map((_, index) => {
    const y = 1 - ((index + 0.5) / Math.max(1, clusters.length)) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = index * GOLDEN_ANGLE;
    return {
      x: Math.cos(theta) * ring * 190,
      y: y * 150,
      z: Math.sin(theta) * ring * 190,
    };
  });
  const positions = initial.map(clonePoint);

  for (let iteration = 0; iteration < 380; iteration += 1) {
    const changes = positions.map(() => ({ x: 0, y: 0, z: 0 }));
    for (let left = 0; left < clusters.length; left += 1) {
      for (let right = left + 1; right < clusters.length; right += 1) {
        const key = [clusters[left].id, clusters[right].id].sort().join('|');
        const similarity = (overlap.get(key) ?? 0) / maximumOverlap;
        const desiredDistance =
          footprint(clusters[left].id) +
          footprint(clusters[right].id) +
          80 +
          (1 - Math.sqrt(similarity)) * 120;
        const a = positions[left];
        const b = positions[right];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dz = b.z - a.z;
        let distance = Math.hypot(dx, dy, dz);
        if (distance < 0.001) {
          const direction = seededDirection(key);
          dx = direction.x;
          dy = direction.y;
          dz = direction.z;
          distance = 1;
        }
        const force = (distance - desiredDistance) * 0.016;
        dx /= distance;
        dy /= distance;
        dz /= distance;
        changes[left].x += dx * force;
        changes[left].y += dy * force;
        changes[left].z += dz * force;
        changes[right].x -= dx * force;
        changes[right].y -= dy * force;
        changes[right].z -= dz * force;
      }
    }

    for (let index = 0; index < positions.length; index += 1) {
      positions[index].x +=
        changes[index].x + (initial[index].x - positions[index].x) * 0.0025;
      positions[index].y +=
        changes[index].y + (initial[index].y - positions[index].y) * 0.0025;
      positions[index].z +=
        changes[index].z + (initial[index].z - positions[index].z) * 0.0025;
    }

    const center = positions.reduce(
      (sum, point) => ({
        x: sum.x + point.x / Math.max(1, positions.length),
        y: sum.y + point.y / Math.max(1, positions.length),
        z: sum.z + point.z / Math.max(1, positions.length),
      }),
      { x: 0, y: 0, z: 0 },
    );
    positions.forEach((position) => {
      position.x -= center.x;
      position.y -= center.y;
      position.z -= center.z;
    });
  }

  return new Map(clusters.map((cluster, index) => [cluster.id, positions[index]]));
}

function computePaperPositions(
  graph: GraphData,
  memberships: ReturnType<typeof derivePaperMemberships>,
  anchors: Map<string, Point3>,
) {
  const papers = graph.nodes.filter((node) => node.type === 'paper');
  const paperYears = papers.map((paper) => paper.paper?.year ?? 2020);
  const yearCenter =
    paperYears.length > 0 ? (Math.min(...paperYears) + Math.max(...paperYears)) / 2 : 2020;
  const primaryGroups = new Map<string, GraphNode[]>();
  for (const paper of papers) {
    const key = paper.cluster ?? '';
    primaryGroups.set(key, [...(primaryGroups.get(key) ?? []), paper]);
  }
  primaryGroups.forEach((group) =>
    group.sort(
      (left, right) =>
        (left.paper?.year ?? 0) - (right.paper?.year ?? 0) ||
        left.id.localeCompare(right.id),
    ),
  );

  const base = new Map<string, Point3>();
  for (const paper of papers) {
    const paperMemberships = memberships.get(paper.id) ?? [];
    const weighted = paperMemberships.map((membership) => ({
      membership,
      weight: membership.role === 'primary' ? 1.18 : membership.weight,
    }));
    const total = weighted.reduce((sum, item) => sum + item.weight, 0) || 1;
    const center = weighted.reduce(
      (sum, item) => {
        const anchor = anchors.get(item.membership.cluster.id) ?? {
          x: 0,
          y: 0,
          z: 0,
        };
        return {
          x: sum.x + (anchor.x * item.weight) / total,
          y: sum.y + (anchor.y * item.weight) / total,
          z: sum.z + (anchor.z * item.weight) / total,
        };
      },
      { x: 0, y: 0, z: 0 },
    );
    const group = primaryGroups.get(paper.cluster ?? '') ?? [paper];
    const index = Math.max(
      0,
      group.findIndex((candidate) => candidate.id === paper.id),
    );
    const direction = seededDirection(paper.id);
    const spread = 25 + Math.cbrt(index + 1) * 27;
    const year = paper.paper?.year ?? yearCenter;
    base.set(paper.id, {
      x: center.x + direction.x * spread,
      y: center.y + direction.y * spread + (year - yearCenter) * 3.6,
      z: center.z + direction.z * spread,
    });
  }

  const paperIds = new Set(papers.map((paper) => paper.id));
  const neighbors = new Map(papers.map((paper) => [paper.id, new Set<string>()]));
  for (const edge of graph.edges) {
    if (
      edge.status !== 'rejected' &&
      paperIds.has(edge.source) &&
      paperIds.has(edge.target)
    ) {
      neighbors.get(edge.source)?.add(edge.target);
      neighbors.get(edge.target)?.add(edge.source);
    }
  }

  let positions = new Map(
    [...base.entries()].map(([id, position]) => [id, clonePoint(position)]),
  );
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const next = new Map<string, Point3>();
    for (const paper of papers) {
      const origin = base.get(paper.id)!;
      const related = [...(neighbors.get(paper.id) ?? [])]
        .map((id) => positions.get(id))
        .filter((position): position is Point3 => Boolean(position));
      if (!related.length) {
        next.set(paper.id, clonePoint(origin));
        continue;
      }
      const average = related.reduce(
        (sum, point) => ({
          x: sum.x + point.x / related.length,
          y: sum.y + point.y / related.length,
          z: sum.z + point.z / related.length,
        }),
        { x: 0, y: 0, z: 0 },
      );
      next.set(paper.id, {
        x: origin.x * 0.88 + average.x * 0.12,
        y: origin.y * 0.88 + average.y * 0.12,
        z: origin.z * 0.88 + average.z * 0.12,
      });
    }
    positions = next;
  }

  for (let iteration = 0; iteration < 86; iteration += 1) {
    const movement = new Map(papers.map((paper) => [paper.id, { x: 0, y: 0, z: 0 }]));
    for (let left = 0; left < papers.length; left += 1) {
      for (let right = left + 1; right < papers.length; right += 1) {
        const a = positions.get(papers[left].id)!;
        const b = positions.get(papers[right].id)!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dz = b.z - a.z;
        let distance = Math.hypot(dx, dy, dz);
        const minimum = 32;
        if (distance >= minimum) continue;
        if (distance < 0.001) {
          const direction = seededDirection(`${papers[left].id}:${papers[right].id}`);
          dx = direction.x;
          dy = direction.y;
          dz = direction.z;
          distance = 1;
        }
        const shift = (minimum - distance) * 0.3;
        const leftMove = movement.get(papers[left].id)!;
        const rightMove = movement.get(papers[right].id)!;
        leftMove.x -= (dx / distance) * shift;
        leftMove.y -= (dy / distance) * shift;
        leftMove.z -= (dz / distance) * shift;
        rightMove.x += (dx / distance) * shift;
        rightMove.y += (dy / distance) * shift;
        rightMove.z += (dz / distance) * shift;
      }
    }
    for (const paper of papers) {
      const position = positions.get(paper.id)!;
      const origin = base.get(paper.id)!;
      const change = movement.get(paper.id)!;
      position.x += change.x + (origin.x - position.x) * 0.008;
      position.y += change.y + (origin.y - position.y) * 0.008;
      position.z += change.z + (origin.z - position.z) * 0.008;
    }
  }
  return positions;
}

function computeConceptPositions(
  graph: GraphData,
  paperPositions: Map<string, Point3>,
  anchors: Map<string, Point3>,
) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const connectedPapers = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.status === 'rejected') continue;
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (source?.type === 'paper' && target && target.type !== 'cluster') {
      connectedPapers.set(target.id, [
        ...(connectedPapers.get(target.id) ?? []),
        source.id,
      ]);
    }
    if (target?.type === 'paper' && source && source.type !== 'cluster') {
      connectedPapers.set(source.id, [
        ...(connectedPapers.get(source.id) ?? []),
        target.id,
      ]);
    }
  }

  return new Map(
    graph.nodes
      .filter((node) => node.type !== 'paper' && node.type !== 'cluster')
      .map((concept) => {
        const anchor = anchors.get(concept.cluster ?? '') ?? { x: 0, y: 0, z: 0 };
        const related = (connectedPapers.get(concept.id) ?? [])
          .map((id) => paperPositions.get(id))
          .filter((position): position is Point3 => Boolean(position));
        const center = related.length
          ? related.reduce(
              (sum, point) => ({
                x: sum.x + point.x / related.length,
                y: sum.y + point.y / related.length,
                z: sum.z + point.z / related.length,
              }),
              { x: 0, y: 0, z: 0 },
            )
          : anchor;
        const direction = seededDirection(concept.id);
        const spread = 15 + unitValue(concept.id, 0xc2b2ae35) * 14;
        return [
          concept.id,
          {
            x: anchor.x * 0.38 + center.x * 0.62 + direction.x * spread,
            y: anchor.y * 0.38 + center.y * 0.62 + direction.y * spread,
            z: anchor.z * 0.38 + center.z * 0.62 + direction.z * spread,
          },
        ] as const;
      }),
  );
}

function computeTimePositions(
  graph: GraphData,
  semanticPapers: Map<string, Point3>,
  semanticConcepts: Map<string, Point3>,
) {
  const papers = graph.nodes.filter((node) => node.type === 'paper');
  const years = papers.map((paper) => paper.paper?.year ?? 2020);
  const centerYear = years.length ? (Math.min(...years) + Math.max(...years)) / 2 : 2020;
  const paperTime = new Map(
    papers.map((paper) => {
      const semantic = semanticPapers.get(paper.id)!;
      const jitter = unitValue(paper.id, 0x27d4eb2f) - 0.5;
      return [
        paper.id,
        {
          x: ((paper.paper?.year ?? centerYear) - centerYear) * 72 + jitter * 7,
          y: semantic.y * 0.78 + semantic.x * 0.12,
          z: semantic.z * 0.78 + semantic.x * 0.08,
        },
      ] as const;
    }),
  );

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const connectedYears = new Map<string, number[]>();
  for (const edge of graph.edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (source?.type === 'paper' && target && target.type !== 'cluster') {
      connectedYears.set(target.id, [
        ...(connectedYears.get(target.id) ?? []),
        source.paper?.year ?? centerYear,
      ]);
    }
    if (target?.type === 'paper' && source && source.type !== 'cluster') {
      connectedYears.set(source.id, [
        ...(connectedYears.get(source.id) ?? []),
        target.paper?.year ?? centerYear,
      ]);
    }
  }
  const conceptTime = new Map(
    graph.nodes
      .filter((node) => node.type !== 'paper' && node.type !== 'cluster')
      .map((concept) => {
        const semantic = semanticConcepts.get(concept.id)!;
        const relatedYears = connectedYears.get(concept.id) ?? [];
        const year = relatedYears.length
          ? relatedYears.reduce((sum, item) => sum + item, 0) / relatedYears.length
          : centerYear;
        return [
          concept.id,
          {
            x: (year - centerYear) * 72 + (unitValue(concept.id, 0x165667b1) - 0.5) * 16,
            y: semantic.y * 0.78,
            z: semantic.z * 0.78,
          },
        ] as const;
      }),
  );
  return { paperTime, conceptTime };
}

function fieldForCluster(
  cluster: GraphNode,
  color: string,
  graph: GraphData,
  visiblePaperIds: Set<string>,
  visibleConceptIds: Set<string>,
  memberships: ReturnType<typeof derivePaperMemberships>,
  activePaperPositions: Map<string, Point3>,
  activeConceptPositions: Map<string, Point3>,
  anchor: Point3,
  lens: UniverseLens,
  selectedClusterId: string | null,
  focusedClusterId: string | null,
) {
  const allPapers = graph.nodes.filter((node) => node.type === 'paper');
  const memberPapers = allPapers.filter((paper) =>
    memberships.get(paper.id)?.some((membership) => membership.cluster.id === cluster.id),
  );
  const visibleMembers = memberPapers.filter((paper) => visiblePaperIds.has(paper.id));
  const primary = memberPapers.filter((paper) => paper.cluster === cluster.id);
  const visiblePrimary = primary.filter((paper) => visiblePaperIds.has(paper.id));
  const concepts = graph.nodes.filter(
    (node) =>
      node.type !== 'paper' &&
      node.type !== 'cluster' &&
      node.cluster === cluster.id &&
      visibleConceptIds.has(node.id),
  );
  if (
    !visibleMembers.length &&
    !concepts.length &&
    focusedClusterId !== cluster.id &&
    selectedClusterId !== cluster.id
  ) {
    return null;
  }

  const layoutPapers = primary.length ? primary : memberPapers;
  const paperPoints = layoutPapers
    .map((paper) => activePaperPositions.get(paper.id))
    .filter((point): point is Point3 => Boolean(point));
  const conceptPoints = concepts
    .map((concept) => activeConceptPositions.get(concept.id))
    .filter((point): point is Point3 => Boolean(point));
  const layoutPoints = paperPoints.length ? paperPoints : conceptPoints;

  let center = clonePoint(anchor);
  if (lens === 'time' && layoutPoints.length) {
    center = layoutPoints.reduce(
      (sum, point) => ({
        x: sum.x + point.x / layoutPoints.length,
        y: sum.y + point.y / layoutPoints.length,
        z: sum.z + point.z / layoutPoints.length,
      }),
      { x: 0, y: 0, z: 0 },
    );
  }
  const extents = layoutPoints.reduce(
    (maximum, point) => ({
      x: Math.max(maximum.x, Math.abs(point.x - center.x)),
      y: Math.max(maximum.y, Math.abs(point.y - center.y)),
      z: Math.max(maximum.z, Math.abs(point.z - center.z)),
    }),
    { x: 0, y: 0, z: 0 },
  );
  const radii = {
    x: lens === 'time' ? Math.max(44, extents.x + 24) : Math.max(42, extents.x + 26),
    y: Math.max(38, extents.y + 24),
    z: Math.max(40, extents.z + 26),
  };

  return {
    cluster,
    color,
    center,
    radii,
    paperCount: visibleMembers.length,
    primaryCount: visiblePrimary.length,
    bridgeCount: visibleMembers.length - visiblePrimary.length,
    conceptCount: concepts.length,
    selected: selectedClusterId === cluster.id || focusedClusterId === cluster.id,
    dimmed: Boolean(
      (selectedClusterId && selectedClusterId !== cluster.id) ||
      (focusedClusterId && focusedClusterId !== cluster.id),
    ),
  } satisfies SceneField;
}

function sceneBounds(nodes: SceneNode[], fields: SceneField[]): SceneBounds {
  const points = [
    ...nodes.map((node) => ({ x: node.x, y: node.y, z: node.z })),
    ...fields.flatMap((field) => [
      {
        x: field.center.x - field.radii.x,
        y: field.center.y - field.radii.y,
        z: field.center.z - field.radii.z,
      },
      {
        x: field.center.x + field.radii.x,
        y: field.center.y + field.radii.y,
        z: field.center.z + field.radii.z,
      },
    ]),
  ];
  if (!points.length) {
    return { xMin: -1, xMax: 1, yMin: -1, yMax: 1, zMin: -1, zMax: 1 };
  }
  return points.reduce(
    (bounds, point) => ({
      xMin: Math.min(bounds.xMin, point.x),
      xMax: Math.max(bounds.xMax, point.x),
      yMin: Math.min(bounds.yMin, point.y),
      yMax: Math.max(bounds.yMax, point.y),
      zMin: Math.min(bounds.zMin, point.z),
      zMax: Math.max(bounds.zMax, point.z),
    }),
    {
      xMin: Number.POSITIVE_INFINITY,
      xMax: Number.NEGATIVE_INFINITY,
      yMin: Number.POSITIVE_INFINITY,
      yMax: Number.NEGATIVE_INFINITY,
      zMin: Number.POSITIVE_INFINITY,
      zMax: Number.NEGATIVE_INFINITY,
    },
  );
}

function selectedClusterId(graph: GraphData, selection: Selection) {
  if (selection?.kind !== 'node') return null;
  const node = graph.nodes.find((candidate) => candidate.id === selection.id);
  return node?.type === 'cluster' ? node.id : null;
}

function stableRotation(value: string) {
  return unitValue(value, 0x27d4eb2f) * Math.PI * 2;
}

export function buildSceneData(
  graph: GraphData,
  {
    visibleGraph = graph,
    selection = null,
    lens = 'semantic',
    showConcepts = false,
    showFields = true,
    focusedClusterId = null,
  }: SceneOptions = {},
): SceneData {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const colors = clusterColorMap(graph);
  const memberships = derivePaperMemberships(graph);
  const anchors = computeClusterAnchors(graph, memberships);
  const semanticPapers = computePaperPositions(graph, memberships, anchors);
  const semanticConcepts = computeConceptPositions(graph, semanticPapers, anchors);
  const { paperTime, conceptTime } = computeTimePositions(
    graph,
    semanticPapers,
    semanticConcepts,
  );
  const activePapers = lens === 'semantic' ? semanticPapers : paperTime;
  const activeConcepts = lens === 'semantic' ? semanticConcepts : conceptTime;

  const visiblePaperIds = new Set(
    visibleGraph.nodes.filter((node) => node.type === 'paper').map((node) => node.id),
  );
  const visibleConceptIds = new Set(
    visibleGraph.nodes
      .filter((node) => node.type !== 'paper' && node.type !== 'cluster')
      .map((node) => node.id),
  );
  if (!showConcepts) {
    visibleConceptIds.clear();
    if (selection?.kind === 'node') {
      const selected = nodeById.get(selection.id);
      if (selected && selected.type !== 'paper' && selected.type !== 'cluster') {
        visibleConceptIds.add(selected.id);
      }
    }
  }

  const clusterSelection = selectedClusterId(graph, selection);
  let fields = graph.nodes
    .filter((node) => node.type === 'cluster')
    .map((cluster) =>
      fieldForCluster(
        cluster,
        colors.get(cluster.id) ?? TYPE_COLORS.cluster,
        graph,
        visiblePaperIds,
        visibleConceptIds,
        memberships,
        activePapers,
        activeConcepts,
        anchors.get(cluster.id) ?? { x: 0, y: 0, z: 0 },
        lens,
        clusterSelection,
        focusedClusterId,
      ),
    )
    .filter((field): field is SceneField => Boolean(field));
  if (!showFields) fields = [];
  const fieldIds = new Set(fields.map((field) => field.cluster.id));

  const includedIds = new Set([...visiblePaperIds, ...visibleConceptIds]);
  const authoredEdges = visibleGraph.edges.filter(
    (edge) => includedIds.has(edge.source) && includedIds.has(edge.target),
  );
  if (
    selection?.kind === 'edge' &&
    !authoredEdges.some((edge) => edge.id === selection.id)
  ) {
    const edge = graph.edges.find((candidate) => candidate.id === selection.id);
    if (edge && includedIds.has(edge.source) && includedIds.has(edge.target)) {
      authoredEdges.push(edge);
    }
  }

  const degree = new Map([...includedIds].map((id) => [id, 0]));
  const paperDegree = new Map([...visiblePaperIds].map((id) => [id, 0]));
  for (const edge of authoredEdges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    if (visiblePaperIds.has(edge.source) && visiblePaperIds.has(edge.target)) {
      paperDegree.set(edge.source, (paperDegree.get(edge.source) ?? 0) + 1);
      paperDegree.set(edge.target, (paperDegree.get(edge.target) ?? 0) + 1);
    }
  }

  const selectedIds = new Set<string>();
  if (selection?.kind === 'node' && includedIds.has(selection.id)) {
    selectedIds.add(selection.id);
  } else if (selection?.kind === 'edge') {
    const edge = graph.edges.find((candidate) => candidate.id === selection.id);
    if (edge) {
      selectedIds.add(edge.source);
      selectedIds.add(edge.target);
    }
  }
  const highlightedIds = new Set(selectedIds);
  if (clusterSelection) {
    for (const paperId of visiblePaperIds) {
      if (
        memberships
          .get(paperId)
          ?.some((membership) => membership.cluster.id === clusterSelection)
      ) {
        highlightedIds.add(paperId);
      }
    }
  } else {
    for (const edge of authoredEdges) {
      if (selectedIds.has(edge.source) || selectedIds.has(edge.target)) {
        highlightedIds.add(edge.source);
        highlightedIds.add(edge.target);
      }
    }
  }
  const hasFocus = selection !== null || Boolean(focusedClusterId);

  const paperNodes: SceneNode[] = graph.nodes
    .filter((node) => node.type === 'paper' && visiblePaperIds.has(node.id))
    .map((paper) => {
      const paperMemberships = (memberships.get(paper.id) ?? []).map((membership) => ({
        ...membership,
        color: colors.get(membership.cluster.id) ?? TYPE_COLORS.cluster,
      }));
      const primaryCluster = paperMemberships.find(
        (membership) => membership.role === 'primary',
      )?.cluster;
      const semantic = semanticPapers.get(paper.id)!;
      const time = paperTime.get(paper.id)!;
      const position = lens === 'semantic' ? semantic : time;
      const highlighted = highlightedIds.has(paper.id);
      const selected = selection?.kind === 'node' && selection.id === paper.id;
      const pDegree = paperDegree.get(paper.id) ?? 0;
      return {
        id: paper.id,
        kind: 'paper',
        label: paper.label,
        type: paper.type,
        status: paper.status,
        original: paper,
        clusterColor: colors.get(primaryCluster?.id ?? '') ?? TYPE_COLORS.paper,
        memberships: paperMemberships,
        degree: degree.get(paper.id) ?? 0,
        paperDegree: pDegree,
        radius: 4.4 + Math.min(5, pDegree) * 0.34,
        labelVisible: selected || highlighted || pDegree >= 3,
        selected,
        highlighted,
        dimmed: hasFocus && !highlighted,
        semanticPosition: clonePoint(semantic),
        timePosition: clonePoint(time),
        ...position,
        fx: position.x,
        fy: position.y,
        fz: position.z,
      };
    });

  const conceptNodes: SceneNode[] = graph.nodes
    .filter(
      (node) =>
        node.type !== 'paper' && node.type !== 'cluster' && visibleConceptIds.has(node.id),
    )
    .map((concept) => {
      const semantic = semanticConcepts.get(concept.id)!;
      const time = conceptTime.get(concept.id)!;
      const position = lens === 'semantic' ? semantic : time;
      const selected = selection?.kind === 'node' && selection.id === concept.id;
      const highlighted = highlightedIds.has(concept.id);
      return {
        id: concept.id,
        kind: 'concept',
        label: concept.label,
        type: concept.type,
        status: concept.status,
        original: concept,
        clusterColor: colors.get(concept.cluster ?? '') ?? TYPE_COLORS[concept.type],
        memberships: [],
        degree: degree.get(concept.id) ?? 0,
        paperDegree: 0,
        radius: 2.6 + Math.min(4, degree.get(concept.id) ?? 0) * 0.16,
        labelVisible: selected,
        selected,
        highlighted,
        dimmed: hasFocus && !highlighted,
        semanticPosition: clonePoint(semantic),
        timePosition: clonePoint(time),
        ...position,
        fx: position.x,
        fy: position.y,
        fz: position.z,
      };
    });

  const selectedMembershipClusters = new Set(
    paperNodes
      .filter((node) => node.selected)
      .flatMap((node) => node.memberships.map((membership) => membership.cluster.id)),
  );
  const fieldNodes: SceneNode[] = fields.map((field) => {
    const position = field.center;
    const selected = clusterSelection === field.cluster.id;
    const highlighted =
      selected ||
      selectedMembershipClusters.size === 0 ||
      selectedMembershipClusters.has(field.cluster.id);
    return {
      id: field.cluster.id,
      kind: 'field',
      label: field.cluster.label,
      type: field.cluster.type,
      status: field.cluster.status,
      original: field.cluster,
      clusterColor: field.color,
      memberships: [],
      degree: field.paperCount,
      paperDegree: 0,
      radius: 7,
      focusDistance: Math.max(
        205,
        Math.max(field.radii.x, field.radii.y, field.radii.z) * 3.2,
      ),
      labelVisible: true,
      selected,
      highlighted,
      dimmed: field.dimmed || (selection !== null && !highlighted),
      semanticPosition: clonePoint(position),
      timePosition: clonePoint(position),
      primaryCount: field.primaryCount,
      bridgeCount: field.bridgeCount,
      conceptCount: field.conceptCount,
      ...position,
      fx: position.x,
      fy: position.y,
      fz: position.z,
    };
  });

  const sceneNodeById = new Map(
    [...paperNodes, ...conceptNodes, ...fieldNodes].map((node) => [node.id, node]),
  );
  const relationLinks: SceneLink[] = authoredEdges.map((edge) => {
    const source = nodeById.get(edge.source)!;
    const target = nodeById.get(edge.target)!;
    const highlighted =
      selection?.kind === 'edge'
        ? selection.id === edge.id
        : selection?.kind === 'node'
          ? edge.source === selection.id || edge.target === selection.id
          : false;
    const targetColor =
      colors.get(target.cluster ?? '') ??
      colors.get(source.cluster ?? '') ??
      TYPE_COLORS[target.type];
    return {
      id: edge.id,
      kind: 'relation',
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
      status: edge.status,
      original: edge,
      color: targetColor,
      highlighted,
      dimmed: hasFocus && !highlighted,
      crossCluster: Boolean(
        source.cluster && target.cluster && source.cluster !== target.cluster,
      ),
      curveRotation: stableRotation(edge.id),
    };
  });

  const membershipLinks: SceneLink[] = paperNodes.flatMap((paper) =>
    paper.memberships
      .filter((membership) => fieldIds.has(membership.cluster.id))
      .map((membership) => ({
        id: `membership:${membership.cluster.id}:${paper.id}`,
        kind: 'membership' as const,
        source: membership.cluster.id,
        target: paper.id,
        relation: 'membership',
        status: 'membership' as const,
        color: colors.get(membership.cluster.id) ?? TYPE_COLORS.cluster,
        highlighted:
          paper.selected ||
          clusterSelection === membership.cluster.id ||
          focusedClusterId === membership.cluster.id,
        dimmed:
          Boolean(focusedClusterId && focusedClusterId !== membership.cluster.id) ||
          (selection !== null &&
            !paper.highlighted &&
            clusterSelection !== membership.cluster.id),
        crossCluster: membership.role === 'secondary',
        curveRotation: 0,
        paperId: paper.id,
        clusterId: membership.cluster.id,
        membershipRole: membership.role,
        membershipWeight: membership.weight,
      })),
  );
  const nodes = [...paperNodes, ...conceptNodes, ...fieldNodes];
  const links = [...relationLinks, ...membershipLinks].filter((link) => {
    const source = typeof link.source === 'string' ? link.source : link.source.id;
    const target = typeof link.target === 'string' ? link.target : link.target.id;
    return sceneNodeById.has(source) && sceneNodeById.has(target);
  });
  const years = [
    ...new Set(
      paperNodes
        .map((node) => node.original.paper?.year)
        .filter((year): year is number => typeof year === 'number'),
    ),
  ].sort((left, right) => left - right);

  return {
    nodes,
    links,
    paperNodes,
    conceptNodes,
    fieldNodes,
    relationLinks,
    membershipLinks,
    fields,
    lens,
    years,
    bounds: sceneBounds(nodes, fields),
  };
}

export function linkEndpoint(link: SceneLink, endpoint: 'source' | 'target') {
  const value = link[endpoint];
  return typeof value === 'string' ? null : value;
}

export function isPaperNode(node: SceneNode) {
  return node.kind === 'paper';
}

export function isFieldNode(node: SceneNode) {
  return node.kind === 'field';
}
