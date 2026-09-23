import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import ForceGraph3D, {
  type ForceGraphMethods,
  type LinkObject,
  type NodeObject,
} from 'react-force-graph-3d';
import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  PerspectiveCamera,
  SRGBColorSpace,
  Vector3,
} from 'three';
import {
  Box,
  Clock3,
  Focus,
  Maximize2,
  Orbit,
  Route,
  Rotate3D,
  SearchX,
  Shapes,
  X,
} from 'lucide-react';
import { filterGraph } from '../domain/graph';
import { useWorkspaceStore } from '../store/workspaceStore';
import {
  buildSceneData,
  linkEndpoint,
  type SceneLink,
  type SceneNode,
  type UniverseLens,
} from './graph/sceneModel';
import {
  createNodeObject,
  createSceneBackdrop,
  disposeSceneObject,
} from './graph/sceneObjects';

interface OrbitControlsLike {
  autoRotate: boolean;
  autoRotateSpeed: number;
  enableDamping: boolean;
  dampingFactor: number;
  minDistance: number;
  maxDistance: number;
  update?: () => void;
}

type GraphNode = NodeObject<SceneNode>;
type GraphLink = LinkObject<SceneNode, SceneLink>;
type HoveredItem =
  { kind: 'node'; node: SceneNode } | { kind: 'link'; link: SceneLink } | null;

function supportsWebGL() {
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!context) return false;
    context.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function rgba(hex: string, alpha: number) {
  const value = hex.replace('#', '');
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function nodePosition(node: SceneNode) {
  return { x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 };
}

function GraphFallback({
  nodes,
  onSelect,
  reason,
}: {
  nodes: SceneNode[];
  onSelect: (node: SceneNode) => void;
  reason: string;
}) {
  return (
    <div className="graph-fallback" data-testid="graph-fallback">
      <div className="fallback-heading">
        <Box aria-hidden="true" />
        <h2>Literature universe</h2>
        <span>{reason}</span>
      </div>
      <div className="fallback-grid">
        {nodes.map((node) => (
          <button key={node.id} onClick={() => onSelect(node)}>
            <span
              className={`type-dot type-${node.type}`}
              style={{ background: node.clusterColor }}
            />
            <strong>{node.label}</strong>
            <small>
              {node.kind === 'field' ? 'research field' : node.type.replace('_', ' ')}
            </small>
          </button>
        ))}
      </div>
    </div>
  );
}

export function GraphScene() {
  const graph = useWorkspaceStore((state) => state.graph)!;
  const filters = useWorkspaceStore((state) => state.filters);
  const selection = useWorkspaceStore((state) => state.selection);
  const select = useWorkspaceStore((state) => state.select);
  const setCluster = useWorkspaceStore((state) => state.setCluster);
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<SceneNode, SceneLink> | undefined>(undefined);
  const [size, setSize] = useState({ width: 900, height: 640 });
  const [hovered, setHovered] = useState<HoveredItem>(null);
  const [hasWebGL] = useState(supportsWebGL);
  const [renderFailure, setRenderFailure] = useState<string | null>(null);
  const [sceneReady, setSceneReady] = useState(false);
  const [lens, setLens] = useState<UniverseLens>('semantic');
  const [showRelations, setShowRelations] = useState(true);
  const [showConcepts, setShowConcepts] = useState(false);
  const [autoRotate, setAutoRotate] = useState(
    () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  const visibleGraph = useMemo(() => filterGraph(graph, filters), [filters, graph]);
  const conceptLayerActive = showConcepts || filters.query.trim().length > 0;
  const sceneData = useMemo(
    () =>
      buildSceneData(graph, {
        visibleGraph,
        selection,
        lens,
        showConcepts: conceptLayerActive,
        showFields: filters.nodeTypes.has('cluster'),
        focusedClusterId: filters.clusterId,
      }),
    [
      conceptLayerActive,
      filters.clusterId,
      filters.nodeTypes,
      graph,
      lens,
      selection,
      visibleGraph,
    ],
  );
  const graphData = useMemo(
    () => ({ nodes: sceneData.nodes, links: sceneData.links }),
    [sceneData.links, sceneData.nodes],
  );
  const activeCluster = filters.clusterId
    ? graph.nodes.find((node) => node.id === filters.clusterId)
    : null;

  const hoveredNode = hovered?.kind === 'node' ? hovered.node : null;
  const hoveredLink = hovered?.kind === 'link' ? hovered.link : null;
  const hoveredPaperId =
    hoveredNode?.kind === 'paper'
      ? hoveredNode.id
      : hoveredLink?.kind === 'membership'
        ? (hoveredLink.paperId ?? null)
        : null;
  const hoveredClusterId =
    hoveredNode?.kind === 'field'
      ? hoveredNode.id
      : hoveredLink?.kind === 'membership'
        ? (hoveredLink.clusterId ?? null)
        : null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: Math.max(320, Math.floor(entry.contentRect.width)),
        height: Math.max(320, Math.floor(entry.contentRect.height)),
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!hasWebGL || renderFailure) return;
    let removeCanvasListeners: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      const forceGraph = graphRef.current;
      if (!forceGraph) {
        setRenderFailure('The 3D renderer could not be initialized');
        return;
      }
      const renderer = forceGraph.renderer();
      const camera = forceGraph.camera() as PerspectiveCamera;
      const controls = forceGraph.controls() as OrbitControlsLike;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      renderer.outputColorSpace = SRGBColorSpace;
      renderer.toneMapping = ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.12;
      renderer.setClearColor('#071015', 1);
      camera.fov = 46;
      camera.near = 0.5;
      camera.far = 4_000;
      camera.updateProjectionMatrix();
      controls.enableDamping = true;
      controls.dampingFactor = 0.07;
      controls.minDistance = 48;
      controls.maxDistance = 2_400;

      const keyLight = new DirectionalLight('#f6fbff', 2.1);
      keyLight.position.set(260, 330, 420);
      const fillLight = new DirectionalLight('#80a8b8', 0.7);
      fillLight.position.set(-280, -100, 160);
      forceGraph.lights([new AmbientLight('#dce7ea', 1.12), keyLight, fillLight]);

      const canvas = renderer.domElement;
      const contextLost = (event: Event) => {
        event.preventDefault();
        setRenderFailure('The 3D context was interrupted');
      };
      const contextError = () =>
        setRenderFailure('The browser could not create a 3D context');
      canvas.addEventListener('webglcontextlost', contextLost);
      canvas.addEventListener('webglcontextcreationerror', contextError);
      removeCanvasListeners = () => {
        canvas.removeEventListener('webglcontextlost', contextLost);
        canvas.removeEventListener('webglcontextcreationerror', contextError);
      };
      setSceneReady(true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      removeCanvasListeners?.();
    };
  }, [hasWebGL, renderFailure]);

  useEffect(() => {
    if (!hasWebGL || renderFailure || !sceneReady || !graphRef.current) return;
    const controls = graphRef.current.controls() as OrbitControlsLike;
    controls.autoRotate = autoRotate && lens === 'semantic';
    controls.autoRotateSpeed = 0.14;
    controls.update?.();
    graphRef.current.resumeAnimation();
  }, [autoRotate, hasWebGL, lens, renderFailure, sceneReady]);

  useEffect(() => {
    if (!hasWebGL || renderFailure || !sceneReady || !graphRef.current) return;
    const environment = createSceneBackdrop(sceneData);
    const graphScene = graphRef.current.scene();
    graphScene.add(environment);
    return () => {
      graphScene.remove(environment);
      disposeSceneObject(environment);
    };
  }, [hasWebGL, renderFailure, sceneData, sceneReady]);

  const fitAll = useCallback(
    (duration = 650) => {
      const forceGraph = graphRef.current;
      if (!forceGraph || !sceneData.nodes.length) return;
      const target = {
        x: (sceneData.bounds.xMin + sceneData.bounds.xMax) / 2,
        y: (sceneData.bounds.yMin + sceneData.bounds.yMax) / 2,
        z: (sceneData.bounds.zMin + sceneData.bounds.zMax) / 2,
      };
      const extent = Math.max(
        sceneData.bounds.xMax - sceneData.bounds.xMin,
        sceneData.bounds.yMax - sceneData.bounds.yMin,
        sceneData.bounds.zMax - sceneData.bounds.zMin,
        180,
      );
      const direction =
        lens === 'time' ? new Vector3(0.1, 0.62, 1) : new Vector3(0.18, 0.14, 1);
      direction.normalize().multiplyScalar(extent * (size.width < 640 ? 1.78 : 1.3) + 76);
      forceGraph.cameraPosition(
        {
          x: target.x + direction.x,
          y: target.y + direction.y,
          z: target.z + direction.z,
        },
        target,
        duration,
      );
      forceGraph.resumeAnimation();
    },
    [lens, sceneData.bounds, sceneData.nodes.length, size.width],
  );

  useEffect(() => {
    if (!sceneReady || !sceneData.nodes.length || renderFailure) return;
    const timer = window.setTimeout(() => fitAll(0), 120);
    return () => window.clearTimeout(timer);
  }, [
    conceptLayerActive,
    filters.clusterId,
    filters.query,
    fitAll,
    lens,
    renderFailure,
    sceneData.nodes.length,
    sceneReady,
  ]);

  const focusPoint = useCallback(
    (point: { x: number; y: number; z: number }, distance = 120, duration = 650) => {
      const forceGraph = graphRef.current;
      if (!forceGraph) return;
      const camera = forceGraph.camera();
      const direction = new Vector3(
        camera.position.x - point.x,
        camera.position.y - point.y,
        camera.position.z - point.z,
      );
      if (direction.lengthSq() < 0.01) direction.set(0.16, 0.22, 1);
      direction.normalize().multiplyScalar(size.width < 640 ? distance * 1.35 : distance);
      forceGraph.cameraPosition(
        {
          x: point.x + direction.x,
          y: point.y + direction.y,
          z: point.z + direction.z,
        },
        point,
        duration,
      );
      forceGraph.resumeAnimation();
    },
    [size.width],
  );

  useEffect(() => {
    if (!selection) return;
    if (selection.kind === 'node') {
      const node = sceneData.nodes.find((candidate) => candidate.id === selection.id);
      if (node) focusPoint(nodePosition(node), node.focusDistance ?? 112);
      return;
    }
    const link = sceneData.relationLinks.find((candidate) => candidate.id === selection.id);
    if (!link) return;
    const source =
      linkEndpoint(link, 'source') ??
      sceneData.nodes.find((node) => node.id === link.original?.source);
    const target =
      linkEndpoint(link, 'target') ??
      sceneData.nodes.find((node) => node.id === link.original?.target);
    if (source && target) {
      focusPoint({
        x: (source.x + target.x) / 2,
        y: (source.y + target.y) / 2,
        z: (source.z + target.z) / 2,
      });
    }
  }, [focusPoint, sceneData.nodes, sceneData.relationLinks, selection]);

  const focusSelection = useCallback(() => {
    if (selection?.kind === 'node') {
      const node = sceneData.nodes.find((candidate) => candidate.id === selection.id);
      if (node) focusPoint(nodePosition(node), node.focusDistance ?? 112);
      return;
    }
    if (selection?.kind === 'edge') {
      const link = sceneData.relationLinks.find(
        (candidate) => candidate.id === selection.id,
      );
      const source = link
        ? sceneData.nodes.find((node) => node.id === link.original?.source)
        : null;
      const target = link
        ? sceneData.nodes.find((node) => node.id === link.original?.target)
        : null;
      if (source && target) {
        focusPoint({
          x: (source.x + target.x) / 2,
          y: (source.y + target.y) / 2,
          z: (source.z + target.z) / 2,
        });
      }
      return;
    }
    if (activeCluster) {
      const field = sceneData.fieldNodes.find((node) => node.id === activeCluster.id);
      if (field) focusPoint(nodePosition(field), field.focusDistance ?? 205);
    }
  }, [
    activeCluster,
    focusPoint,
    sceneData.fieldNodes,
    sceneData.nodes,
    sceneData.relationLinks,
    selection,
  ]);

  function handleKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!sceneData.paperNodes.length) return;
    if (event.key === 'Escape') {
      select(null);
      return;
    }
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Enter'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const currentIndex = sceneData.paperNodes.findIndex(
      (node) => selection?.kind === 'node' && node.id === selection.id,
    );
    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const nextIndex =
      currentIndex < 0
        ? direction > 0
          ? 0
          : sceneData.paperNodes.length - 1
        : event.key === 'Enter'
          ? currentIndex
          : (currentIndex + direction + sceneData.paperNodes.length) %
            sceneData.paperNodes.length;
    select({ kind: 'node', id: sceneData.paperNodes[nextIndex].id });
  }

  function membershipVisible(link: SceneLink) {
    return (
      link.kind === 'membership' &&
      (link.highlighted ||
        link.paperId === hoveredPaperId ||
        link.clusterId === hoveredClusterId)
    );
  }

  function relationVisible(link: SceneLink) {
    if (link.kind !== 'relation' || !showRelations) return false;
    if (link.highlighted) return true;
    if (link.dimmed) return false;
    const source = linkEndpoint(link, 'source');
    const target = linkEndpoint(link, 'target');
    const paperPath = source?.kind === 'paper' && target?.kind === 'paper';
    return paperPath || conceptLayerActive;
  }

  function selectNode(node: SceneNode) {
    setAutoRotate(false);
    select({ kind: 'node', id: node.id });
  }

  const tooltipNode =
    hoveredNode ??
    (hoveredLink?.kind === 'membership'
      ? sceneData.nodes.find((node) => node.id === hoveredLink.paperId)
      : null);
  const tooltipField =
    hoveredNode?.kind === 'field'
      ? hoveredNode
      : hoveredLink?.kind === 'membership'
        ? sceneData.fieldNodes.find((node) => node.id === hoveredLink.clusterId)
        : null;
  const tooltipLink = hoveredLink?.kind === 'relation' ? hoveredLink : null;

  return (
    <div
      className="graph-stage literature-universe"
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyboard}
      aria-label={`Interactive literature universe with ${sceneData.paperNodes.length} papers, ${sceneData.fields.length} research fields, and ${sceneData.relationLinks.length} visible relationships`}
      data-testid="graph-stage"
      data-view="universe"
      data-render-state={
        !hasWebGL || renderFailure ? 'fallback' : sceneReady ? 'ready' : 'starting'
      }
      data-lens={lens}
      data-concepts={conceptLayerActive ? 'visible' : 'hidden'}
      data-selected-node={selection?.kind === 'node' ? selection.id : undefined}
      data-membership-rays={sceneData.membershipLinks.filter(membershipVisible).length}
    >
      <div className="universe-topbar">
        <div className="universe-status" aria-label="Visible universe statistics">
          <strong>{sceneData.paperNodes.length} papers</strong>
          <span>{sceneData.fields.length} fields</span>
          {sceneData.conceptNodes.length > 0 && (
            <span>{sceneData.conceptNodes.length} concepts</span>
          )}
          <span>{sceneData.relationLinks.length} paths</span>
        </div>
        <div className="universe-lens" aria-label="Universe lens">
          <button
            type="button"
            className={lens === 'semantic' ? 'active' : ''}
            onClick={() => setLens('semantic')}
            aria-pressed={lens === 'semantic'}
            title="Semantic constellation"
          >
            <Orbit size={14} />
            <span>Semantic</span>
          </button>
          <button
            type="button"
            className={lens === 'time' ? 'active' : ''}
            onClick={() => setLens('time')}
            aria-pressed={lens === 'time'}
            title="Chronological constellation"
          >
            <Clock3 size={14} />
            <span>Time</span>
          </button>
        </div>
        {activeCluster && (
          <button
            type="button"
            className="universe-filter-chip"
            onClick={() => setCluster(null)}
            title="Clear field filter"
            aria-label="Clear field filter"
          >
            <span>{activeCluster.label}</span>
            <X size={13} />
          </button>
        )}
      </div>

      <div className="universe-controls" aria-label="Universe controls">
        <button
          type="button"
          className={showRelations ? 'active' : ''}
          onClick={() => setShowRelations((value) => !value)}
          title={showRelations ? 'Hide evidence paths' : 'Show evidence paths'}
          aria-label={showRelations ? 'Hide evidence paths' : 'Show evidence paths'}
          aria-pressed={showRelations}
        >
          <Route size={16} />
        </button>
        <button
          type="button"
          className={conceptLayerActive ? 'active' : ''}
          onClick={() => setShowConcepts((value) => !value)}
          disabled={Boolean(filters.query.trim())}
          title={conceptLayerActive ? 'Hide concept layer' : 'Show concept layer'}
          aria-label={conceptLayerActive ? 'Hide concept layer' : 'Show concept layer'}
          aria-pressed={conceptLayerActive}
        >
          <Shapes size={16} />
        </button>
        <button
          type="button"
          className={autoRotate && lens === 'semantic' ? 'active' : ''}
          onClick={() => setAutoRotate((value) => !value)}
          disabled={lens === 'time'}
          title={autoRotate ? 'Pause universe rotation' : 'Resume universe rotation'}
          aria-label={autoRotate ? 'Pause universe rotation' : 'Resume universe rotation'}
          aria-pressed={autoRotate && lens === 'semantic'}
        >
          <Rotate3D size={16} />
        </button>
        <button
          type="button"
          onClick={() => fitAll()}
          title="Fit literature universe"
          aria-label="Fit literature universe"
        >
          <Maximize2 size={16} />
        </button>
        <button
          type="button"
          onClick={focusSelection}
          disabled={!selection && !activeCluster}
          title="Focus selection"
          aria-label="Focus selection in universe"
        >
          <Focus size={16} />
        </button>
      </div>

      {hasWebGL && !renderFailure && sceneData.nodes.length ? (
        <ForceGraph3D<SceneNode, SceneLink>
          ref={graphRef}
          width={size.width}
          height={size.height}
          graphData={graphData}
          backgroundColor="#071015"
          controlType="orbit"
          showNavInfo={false}
          rendererConfig={{
            antialias: true,
            alpha: false,
            preserveDrawingBuffer: true,
            powerPreference: 'high-performance',
          }}
          nodeLabel={() => ''}
          nodeVal={(node: GraphNode) =>
            node.kind === 'field' ? 4.8 : node.kind === 'paper' ? 3.6 : 1.8
          }
          nodeThreeObject={(node: GraphNode) =>
            createNodeObject(
              node,
              selection?.kind === 'node' && selection.id === node.id,
              hoveredNode?.id === node.id,
            )
          }
          linkVisibility={(link: GraphLink) =>
            link.kind === 'membership' ? membershipVisible(link) : relationVisible(link)
          }
          linkColor={(link: GraphLink) => {
            if (link.kind === 'membership') {
              return rgba(link.color, link.highlighted ? 0.9 : 0.56);
            }
            if (link.status === 'proposed') {
              return link.highlighted ? '#f3a95d' : 'rgba(217, 149, 63, 0.26)';
            }
            if (link.status === 'uncertain') {
              return link.highlighted ? '#c49bea' : 'rgba(168, 122, 221, 0.24)';
            }
            return rgba(
              link.color,
              link.highlighted ? 0.94 : link.crossCluster ? 0.18 : 0.12,
            );
          }}
          linkWidth={(link: GraphLink) =>
            link.kind === 'membership'
              ? link.highlighted
                ? 1.65
                : link.membershipRole === 'primary'
                  ? 0.72
                  : 0.5
              : link.highlighted
                ? 3.2
                : link.crossCluster
                  ? 0.55
                  : 0.38
          }
          linkOpacity={0.86}
          linkCurvature={(link: GraphLink) =>
            link.kind === 'membership' ? 0 : link.highlighted ? 0.1 : 0.035
          }
          linkCurveRotation={(link: GraphLink) =>
            link.kind === 'relation' ? link.curveRotation : 0
          }
          linkDirectionalArrowLength={(link: GraphLink) =>
            link.kind === 'relation' && link.highlighted ? 4.2 : 0
          }
          linkDirectionalArrowRelPos={0.9}
          linkDirectionalArrowColor={(link: GraphLink) =>
            link.kind === 'relation' && link.highlighted ? link.color : '#708a96'
          }
          linkDirectionalParticles={(link: GraphLink) =>
            link.kind === 'relation' && link.highlighted ? 3 : 0
          }
          linkDirectionalParticleColor={(link: GraphLink) => link.color}
          linkDirectionalParticleWidth={1.7}
          linkDirectionalParticleSpeed={0.003}
          linkHoverPrecision={5}
          enableNodeDrag={false}
          warmupTicks={0}
          cooldownTicks={0}
          cooldownTime={0}
          onNodeHover={(node) =>
            setHovered(node ? { kind: 'node', node: node as SceneNode } : null)
          }
          onNodeClick={(node) => selectNode(node as SceneNode)}
          onLinkHover={(link) =>
            setHovered(link ? { kind: 'link', link: link as SceneLink } : null)
          }
          onLinkClick={(link) => {
            const item = link as SceneLink;
            if (item.kind === 'relation') {
              setAutoRotate(false);
              select({ kind: 'edge', id: item.id });
            }
          }}
          onBackgroundClick={() => select(null)}
        />
      ) : sceneData.nodes.length === 0 ? (
        <div className="graph-empty" role="status">
          <SearchX size={23} aria-hidden="true" />
          <strong>No papers in this view</strong>
          <span>Clear a search or widen the active filters.</span>
        </div>
      ) : (
        <GraphFallback
          nodes={[...sceneData.paperNodes, ...sceneData.conceptNodes]}
          onSelect={selectNode}
          reason={renderFailure ?? 'WebGL unavailable'}
        />
      )}

      {hovered && (tooltipNode || tooltipField || tooltipLink) && (
        <div className="universe-tooltip" role="status">
          <i
            style={{
              background:
                tooltipField?.clusterColor ??
                tooltipNode?.clusterColor ??
                tooltipLink?.color,
            }}
          />
          {tooltipLink?.original ? (
            <div>
              <small>
                {tooltipLink.original.relation} ·{' '}
                {Math.round(tooltipLink.original.confidence * 100)}% confidence
              </small>
              <strong>{tooltipLink.original.transition_note}</strong>
              <span>
                {sceneData.nodes.find((node) => node.id === tooltipLink.original?.source)
                  ?.label ?? tooltipLink.original.source}
                {' → '}
                {sceneData.nodes.find((node) => node.id === tooltipLink.original?.target)
                  ?.label ?? tooltipLink.original.target}
              </span>
            </div>
          ) : tooltipField ? (
            <div>
              <small>
                {tooltipField.primaryCount ?? 0} core · {tooltipField.bridgeCount ?? 0}{' '}
                bridge
              </small>
              <strong>{tooltipField.label}</strong>
              <span>{tooltipField.original.description}</span>
            </div>
          ) : tooltipNode?.kind === 'paper' ? (
            <div>
              <small>
                {tooltipNode.original.paper?.year} · {tooltipNode.memberships.length} field
                {tooltipNode.memberships.length === 1 ? '' : 's'}
              </small>
              <strong>{tooltipNode.label}</strong>
              <span>
                {tooltipNode.paperDegree} paper paths ·{' '}
                {tooltipNode.original.paper?.authors.slice(0, 2).join(', ')}
              </span>
            </div>
          ) : tooltipNode ? (
            <div>
              <small>{tooltipNode.type.replace('_', ' ')}</small>
              <strong>{tooltipNode.label}</strong>
              <span>{tooltipNode.original.description}</span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
