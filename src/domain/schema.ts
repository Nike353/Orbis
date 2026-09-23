import { z } from 'zod';

export const NODE_TYPES = [
  'paper',
  'cluster',
  'method',
  'representation',
  'assumption',
  'experiment',
  'claim',
  'open_question',
] as const;

export const STATUSES = ['proposed', 'accepted', 'rejected', 'uncertain'] as const;
export const ORIGINS = ['user', 'agent', 'claude'] as const;

const positionSchema = z.object({ x: z.number(), y: z.number(), z: z.number().optional() });

export const arxivMetadataSchema = z.object({
  id: z.string().regex(/^\d{4}\.\d{4,5}(v\d+)?$/),
  canonical_url: z.string().url(),
  submitted_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  categories: z.array(z.string()).min(1),
  primary_category: z.string(),
  query_id: z.string(),
});

export const paperCardSchema = z.object({
  source_kind: z.enum(['paper', 'blog', 'website']).optional(),
  title: z.string().min(1),
  authors: z.array(z.string().min(1)),
  year: z.number().int().min(1900).max(2200).nullable(),
  venue: z.string(),
  url: z.string().url(),
  summary: z.string(),
  key_findings: z.array(z.string()),
  arxiv: arxivMetadataSchema.optional(),
});

const baseNodeSchema = z.object({
  id: z.string().min(3),
  type: z.enum(NODE_TYPES),
  label: z.string().min(1),
  status: z.enum(STATUSES),
  origin: z.enum(ORIGINS),
  description: z.string().optional(),
  notes: z.string().max(100000).optional(),
  cluster: z.string().optional(),
  created_at: z.string().optional(),
  position: positionSchema.optional(),
  notes_file: z.string().optional(),
  paper: paperCardSchema.optional(),
});

export const graphNodeSchema = baseNodeSchema.superRefine((node, ctx) => {
  if (node.type === 'paper' && !node.paper) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Paper nodes require a paper card',
      path: ['paper'],
    });
  }
  if (
    node.paper &&
    (!node.paper.source_kind || node.paper.source_kind === 'paper') &&
    (!node.paper.authors.length || node.paper.year === null)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Papers require authors and publication year',
      path: ['paper'],
    });
  }
  if (node.type === 'cluster' && node.cluster) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Cluster nodes cannot belong to a cluster',
      path: ['cluster'],
    });
  }
});

export const graphEdgeSchema = z.object({
  id: z.string().regex(/^e\d+$/),
  source: z.string(),
  target: z.string(),
  relation: z.string().min(1),
  transition_note: z.string().min(1),
  confidence: z.number().min(0).max(1),
  evidence: z.string().min(1),
  status: z.enum(STATUSES),
  origin: z.enum(ORIGINS),
  created_at: z.string().optional(),
});

const metaSchema = z.object({
  schema_version: z.number().int().min(1),
  title: z.string().min(1),
  revision: z.number().int().min(0),
  updated_at: z.string(),
});

export const graphSchema = z
  .object({
    meta: metaSchema,
    nodes: z.array(graphNodeSchema),
    edges: z.array(graphEdgeSchema),
  })
  .superRefine((graph, ctx) => {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const clusterIds = new Set(
      graph.nodes.filter((node) => node.type === 'cluster').map((node) => node.id),
    );

    graph.nodes.forEach((node, index) => {
      if (nodeIds.has(node.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate node id: ${node.id}`,
          path: ['nodes', index, 'id'],
        });
      }
      nodeIds.add(node.id);
      if (node.cluster && !clusterIds.has(node.cluster)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unknown cluster: ${node.cluster}`,
          path: ['nodes', index, 'cluster'],
        });
      }
    });

    graph.edges.forEach((edge, index) => {
      if (edgeIds.has(edge.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate edge id: ${edge.id}`,
          path: ['edges', index, 'id'],
        });
      }
      edgeIds.add(edge.id);
      (['source', 'target'] as const).forEach((endpoint) => {
        if (!nodeIds.has(edge[endpoint])) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unknown ${endpoint}: ${edge[endpoint]}`,
            path: ['edges', index, endpoint],
          });
        }
      });
    });
  });

export type GraphData = z.infer<typeof graphSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;
export type NodeType = (typeof NODE_TYPES)[number];
export type ReviewStatus = (typeof STATUSES)[number];

export interface MigrationResult {
  graph: GraphData;
  migratedFrom: number | null;
}

export function migrateAndValidateGraph(input: unknown): MigrationResult {
  const raw = z.record(z.unknown()).parse(input);
  const rawMeta = z.record(z.unknown()).parse(raw.meta);
  const version = z.number().int().min(1).parse(rawMeta.schema_version);

  if (version > 2) {
    throw new Error(`Graph schema v${version} is newer than this application supports.`);
  }

  const candidate =
    version === 1
      ? {
          ...raw,
          meta: { ...rawMeta, schema_version: 2 },
        }
      : raw;

  return {
    graph: graphSchema.parse(candidate),
    migratedFrom: version === 1 ? 1 : null,
  };
}
