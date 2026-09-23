import { MarkerType, type Edge as FlowEdge, type Node as FlowNode } from '@xyflow/react';
import { derivePaperMemberships } from '../../domain/hypergraph';
import type { GraphData, GraphEdge, GraphNode } from '../../domain/schema';
import type { Selection } from '../../store/workspaceStore';

export const PAPER_WIDTH = 252;
export const PAPER_HEIGHT = 132;
export const YEAR_GAP = 300;
export const LANE_GAP = 16;
export const LANE_HEADER = 82;
export const PAPER_ROW_GAP = 150;
export const LEFT_GUTTER = 220;

export const LINEAGE_COLORS = [
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

type PaperCard = NonNullable<GraphNode['paper']>;

export type PaperGraphNode = GraphNode & {
  type: 'paper';
  paper: PaperCard;
};

export interface LineageLaneDescriptor {
  id: string;
  label: string;
  description?: string;
  color: string;
  cluster: GraphNode | null;
  order: number;
}

export interface MembershipSwatch {
  clusterId: string;
  label: string;
  color: string;
  role: 'primary' | 'secondary';
  weight: number;
}

export interface LineagePaperNodeData extends Record<string, unknown> {
  kind: 'paper';
  node: PaperGraphNode;
  lane: LineageLaneDescriptor;
  color: string;
  memberships: MembershipSwatch[];
  incoming: number;
  outgoing: number;
  dimmed: boolean;
}

export interface LineageLaneNodeData extends Record<string, unknown> {
  kind: 'lane';
  lane: LineageLaneDescriptor;
  years: number[];
  yearGap: number;
  leftGutter: number;
  paperCount: number;
}

export interface LineageEdgeData extends Record<string, unknown> {
  edge: GraphEdge;
  sourceNode: PaperGraphNode;
  targetNode: PaperGraphNode;
  stroke: string;
  highlighted: boolean;
  labelVisible: boolean;
  dimmed: boolean;
}

export type LineageSceneNode = FlowNode<LineagePaperNodeData | LineageLaneNodeData>;
export type LineageSceneEdge = FlowEdge<LineageEdgeData>;

interface PaperLayout {
  x: number;
  y: number;
  yearIndex: number;
}

function isPaperNode(node: GraphNode): node is PaperGraphNode {
  return node.type === 'paper' && node.paper != null;
}

function edgeStroke(edge: GraphEdge, lineageColor: string) {
  if (edge.status === 'proposed') return '#b86d2d';
  if (edge.status === 'uncertain') return '#825ba8';
  if (edge.status === 'rejected') return '#b9544d';
  return lineageColor;
}

function edgeHandles(source: PaperLayout, target: PaperLayout) {
  if (source.yearIndex > target.yearIndex) {
    return { sourceHandle: 'source-left', targetHandle: 'target-right' };
  }
  if (source.yearIndex < target.yearIndex) {
    return { sourceHandle: 'source-right', targetHandle: 'target-left' };
  }
  if (source.y > target.y) {
    return { sourceHandle: 'source-top', targetHandle: 'target-bottom' };
  }
  return { sourceHandle: 'source-bottom', targetHandle: 'target-top' };
}

function selectedPaperIds(graph: GraphData, selection: Selection) {
  if (!selection) return new Set<string>();
  if (selection.kind === 'node') {
    return graph.nodes.some((node) => node.id === selection.id && isPaperNode(node))
      ? new Set([selection.id])
      : new Set<string>();
  }
  const edge = graph.edges.find((candidate) => candidate.id === selection.id);
  if (!edge) return new Set<string>();
  const paperIds = new Set(graph.nodes.filter(isPaperNode).map((paper) => paper.id));
  return new Set([edge.source, edge.target].filter((nodeId) => paperIds.has(nodeId)));
}

function clusterLanes(graph: GraphData) {
  const clusters = graph.nodes.filter((node) => node.type === 'cluster');
  const lanes = clusters.map<LineageLaneDescriptor>((cluster, order) => ({
    id: cluster.id,
    label: cluster.label,
    description: cluster.description,
    color: LINEAGE_COLORS[order % LINEAGE_COLORS.length],
    cluster,
    order,
  }));
  return {
    lanes,
    laneById: new Map(lanes.map((lane) => [lane.id, lane])),
  };
}

export function buildLineageMapScene(
  graph: GraphData,
  visibleGraph: GraphData,
  selection: Selection,
) {
  const allPapers = graph.nodes.filter(isPaperNode);
  const visiblePapers = visibleGraph.nodes.filter(isPaperNode);
  const visiblePaperIds = new Set(visiblePapers.map((paper) => paper.id));
  const paperById = new Map(allPapers.map((paper) => [paper.id, paper]));
  const years = [...new Set(allPapers.map((paper) => paper.paper.year ?? 0))].sort(
    (left, right) => (left || 9999) - (right || 9999),
  );
  const yearIndex = new Map(years.map((year, index) => [year, index]));
  const { lanes, laneById } = clusterLanes(graph);

  const unclusteredPapers = visiblePapers.filter(
    (paper) => !paper.cluster || !laneById.has(paper.cluster),
  );
  if (unclusteredPapers.length) {
    const lane: LineageLaneDescriptor = {
      id: 'unclustered',
      label: 'Unclustered papers',
      color: '#7b8791',
      cluster: null,
      order: lanes.length,
    };
    lanes.push(lane);
    laneById.set(lane.id, lane);
  }

  const visibleEdges = visibleGraph.edges.filter(
    (edge) =>
      visiblePaperIds.has(edge.source) &&
      visiblePaperIds.has(edge.target) &&
      paperById.has(edge.source) &&
      paperById.has(edge.target),
  );
  const selectedIds = selectedPaperIds(graph, selection);
  const visibleSelectedIds = new Set(
    [...selectedIds].filter((paperId) => visiblePaperIds.has(paperId)),
  );
  const selectedEdge =
    selection?.kind === 'edge'
      ? visibleEdges.find((edge) => edge.id === selection.id)
      : undefined;
  const highlightActive = visibleSelectedIds.size > 0 || selectedEdge != null;
  const connectedIds = new Set(visibleSelectedIds);
  if (selection?.kind === 'node' && visibleSelectedIds.has(selection.id)) {
    for (const edge of visibleEdges) {
      if (edge.source === selection.id || edge.target === selection.id) {
        connectedIds.add(edge.source);
        connectedIds.add(edge.target);
      }
    }
  }
  if (selectedEdge) {
    connectedIds.add(selectedEdge.source);
    connectedIds.add(selectedEdge.target);
  }

  const memberships = derivePaperMemberships(graph);
  const colorByCluster = new Map(lanes.map((lane) => [lane.id, lane.color]));
  const totalWidth =
    LEFT_GUTTER + Math.max(0, years.length - 1) * YEAR_GAP + PAPER_WIDTH + 120;
  const nodes: LineageSceneNode[] = [];
  const layoutByPaper = new Map<string, PaperLayout>();
  let laneY = 0;

  for (const lane of lanes) {
    const papers = visiblePapers
      .filter((paper) =>
        lane.id === 'unclustered'
          ? !paper.cluster || !laneById.has(paper.cluster)
          : paper.cluster === lane.id,
      )
      .sort(
        (left, right) =>
          (left.paper.year ?? 9999) - (right.paper.year ?? 9999) ||
          left.label.localeCompare(right.label),
      );
    if (!papers.length) continue;

    const yearBuckets = new Map<number, PaperGraphNode[]>();
    for (const paper of papers) {
      const bucket = yearBuckets.get(paper.paper.year ?? 0) ?? [];
      bucket.push(paper);
      yearBuckets.set(paper.paper.year ?? 0, bucket);
    }
    const maxStack = Math.max(
      1,
      ...[...yearBuckets.values()].map((bucket) => bucket.length),
    );
    const laneHeight = Math.max(244, LANE_HEADER + maxStack * PAPER_ROW_GAP + 24);

    nodes.push({
      id: `lineage-lane:${lane.id}`,
      type: 'lineageLane',
      position: { x: 0, y: laneY },
      data: {
        kind: 'lane',
        lane,
        years,
        yearGap: YEAR_GAP,
        leftGutter: LEFT_GUTTER,
        paperCount: papers.length,
      },
      style: { width: totalWidth, height: laneHeight },
      selectable: false,
      draggable: false,
      connectable: false,
      focusable: false,
      zIndex: -2,
    });

    for (const [year, bucket] of yearBuckets) {
      bucket
        .sort((left, right) => left.label.localeCompare(right.label))
        .forEach((paper, row) => {
          const x = LEFT_GUTTER + (yearIndex.get(year) ?? 0) * YEAR_GAP;
          const y = laneY + LANE_HEADER + row * PAPER_ROW_GAP;
          layoutByPaper.set(paper.id, {
            x,
            y,
            yearIndex: yearIndex.get(year) ?? 0,
          });
          const paperMemberships =
            memberships.get(paper.id)?.map<MembershipSwatch>((membership) => ({
              clusterId: membership.cluster.id,
              label: membership.cluster.label,
              color: colorByCluster.get(membership.cluster.id) ?? LINEAGE_COLORS[0],
              role: membership.role,
              weight: membership.weight,
            })) ?? [];
          const incoming = visibleEdges.filter((edge) => edge.target === paper.id).length;
          const outgoing = visibleEdges.filter((edge) => edge.source === paper.id).length;

          nodes.push({
            id: paper.id,
            type: 'lineagePaper',
            position: { x, y },
            data: {
              kind: 'paper',
              node: paper,
              lane,
              color: lane.color,
              memberships: paperMemberships,
              incoming,
              outgoing,
              dimmed: highlightActive && !connectedIds.has(paper.id),
            },
            style: { width: PAPER_WIDTH, height: PAPER_HEIGHT },
            selected: selection?.kind === 'node' && selection.id === paper.id,
            draggable: false,
            connectable: false,
            ariaLabel: `Paper: ${paper.label}, ${paper.paper.year ?? 'undated'}`,
            zIndex: connectedIds.has(paper.id) ? 5 : 3,
          });
        });
    }
    laneY += laneHeight + LANE_GAP;
  }

  const edges: LineageSceneEdge[] = visibleEdges.flatMap((edge) => {
    const sourceNode = paperById.get(edge.source);
    const targetNode = paperById.get(edge.target);
    const sourceLayout = layoutByPaper.get(edge.source);
    const targetLayout = layoutByPaper.get(edge.target);
    if (!sourceNode || !targetNode || !sourceLayout || !targetLayout) return [];

    const lineageColor =
      colorByCluster.get(targetNode.cluster ?? '') ??
      colorByCluster.get(sourceNode.cluster ?? '') ??
      '#657681';
    const stroke = edgeStroke(edge, lineageColor);
    const highlighted =
      (selection?.kind === 'edge' && selection.id === edge.id) ||
      (selection?.kind === 'node' &&
        (edge.source === selection.id || edge.target === selection.id));
    const handles = edgeHandles(sourceLayout, targetLayout);

    return [
      {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...handles,
        type: 'lineageEdge',
        selected: selection?.kind === 'edge' && selection.id === edge.id,
        ariaLabel: `${sourceNode.label} to ${targetNode.label}: ${edge.relation}`,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 15,
          height: 15,
          color: stroke,
        },
        data: {
          edge,
          sourceNode,
          targetNode,
          stroke,
          highlighted,
          labelVisible: selection?.kind === 'edge' && selection.id === edge.id,
          dimmed: highlightActive && !highlighted,
        },
        zIndex: highlighted ? 7 : 1,
      },
    ];
  });

  return {
    nodes,
    edges,
    paperCount: visiblePapers.length,
    laneCount: nodes.filter((node) => node.data.kind === 'lane').length,
    edgeCount: edges.length,
    years,
    canvas: {
      width: totalWidth,
      height: Math.max(500, laneY - LANE_GAP),
    },
  };
}
