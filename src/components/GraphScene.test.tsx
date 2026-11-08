import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Group, PerspectiveCamera } from 'three';
import canonicalGraph from '../../tests/fixtures/library/data/graph.json';
import { migrateAndValidateGraph, NODE_TYPES, STATUSES } from '../domain/schema';
import { useWorkspaceStore } from '../store/workspaceStore';
import { GraphScene } from './GraphScene';

const methods = vi.hoisted(() => ({
  pauseAnimation: vi.fn(),
  resumeAnimation: vi.fn(),
  cameraPosition: vi.fn(),
  camera: vi.fn(),
  controls: vi.fn(),
  renderer: vi.fn(),
  scene: vi.fn(),
  lights: vi.fn(),
}));
vi.mock('react-force-graph-3d', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    default: forwardRef((_props, ref) => {
      useImperativeHandle(ref, () => methods);
      return <canvas data-testid="retained-canvas" />;
    }),
  };
});
vi.mock('./graph/sceneObjects', async () => {
  const { Group } = await import('three');
  return {
    createSceneBackdrop: () => new Group(),
    createNodeObject: () => new Group(),
    disposeSceneObject: vi.fn(),
  };
});

const graph = migrateAndValidateGraph(canonicalGraph).graph;
const paperId = graph.nodes.find((node) => node.type === 'paper')!.id;
function Scene() {
  const covered = useWorkspaceStore((state) => state.paperWorkspace !== null);
  return <GraphScene paused={covered} />;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    getExtension: () => null,
  } as unknown as WebGLRenderingContext);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  methods.camera.mockReturnValue(new PerspectiveCamera());
  methods.controls.mockReturnValue({ update: vi.fn() });
  methods.renderer.mockReturnValue({
    domElement: document.createElement('canvas'),
    getContext: () => ({
      getExtension: () => null,
      getParameter: () => 'Hardware GPU',
    }),
    setPixelRatio: vi.fn(),
    setClearColor: vi.fn(),
  });
  methods.scene.mockReturnValue(new Group());
  useWorkspaceStore.setState({
    graph: structuredClone(graph),
    selection: null,
    paperWorkspace: null,
    filters: {
      query: '',
      nodeTypes: new Set(NODE_TYPES),
      statuses: new Set(STATUSES),
      relations: new Set(),
      clusterId: null,
      showRejected: false,
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('keeps the camera still and rendering paused through reader selection, data updates and delayed fit', () => {
  const view = render(<Scene />);
  act(() => vi.advanceTimersByTime(1));
  const canvas = view.getByTestId('retained-canvas');
  methods.resumeAnimation.mockClear();
  methods.cameraPosition.mockClear();
  act(() => useWorkspaceStore.getState().openPaper(paperId));
  act(() => useWorkspaceStore.getState().updateNode(paperId, { notes: 'Reader note' }));
  act(() => vi.advanceTimersByTime(300));
  expect(methods.pauseAnimation).toHaveBeenCalled();
  expect(methods.resumeAnimation).not.toHaveBeenCalled();
  expect(methods.cameraPosition).not.toHaveBeenCalled();
  expect(view.getByTestId('retained-canvas')).toBe(canvas);
  act(() => useWorkspaceStore.getState().closePaper());
  expect(methods.resumeAnimation).toHaveBeenCalledTimes(1);
  expect(methods.cameraPosition).not.toHaveBeenCalled();
});

it('stays paused if renderer initialization finishes while the reader is already open', () => {
  useWorkspaceStore.getState().openPaper(paperId);
  render(<Scene />);
  act(() => vi.advanceTimersByTime(1));
  act(() => vi.advanceTimersByTime(300));
  expect(methods.pauseAnimation).toHaveBeenCalled();
  expect(methods.resumeAnimation).not.toHaveBeenCalled();
  expect(methods.cameraPosition).not.toHaveBeenCalled();
  expect(methods.controls().autoRotate).toBe(true);
  expect(methods.controls().autoRotateSpeed).toBe(0.14);
  expect(methods.controls().update).not.toHaveBeenCalled();
  act(() => useWorkspaceStore.getState().closePaper());
  expect(methods.resumeAnimation).toHaveBeenCalledTimes(1);
  expect(methods.cameraPosition).not.toHaveBeenCalled();
});

it('stops idle software rendering, wakes pointer interaction and supports deliberate rotation', () => {
  methods.renderer().getContext = () => ({
    getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 123 }),
    getParameter: () => 'ANGLE SwiftShader Device',
  });
  const view = render(<Scene />);
  act(() => vi.advanceTimersByTime(1));
  expect(view.getByTestId('graph-stage')).toHaveAttribute('data-render-mode', 'software');
  expect(methods.controls().autoRotate).toBe(false);
  act(() => vi.advanceTimersByTime(2_000));
  expect(methods.pauseAnimation).toHaveBeenCalled();
  methods.resumeAnimation.mockClear();
  fireEvent.pointerMove(methods.renderer().domElement);
  expect(methods.resumeAnimation).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(1_300));
  methods.pauseAnimation.mockClear();
  fireEvent.click(view.getByRole('button', { name: 'Resume universe rotation' }));
  act(() => vi.advanceTimersByTime(2_000));
  expect(methods.controls().autoRotate).toBe(true);
  expect(methods.pauseAnimation).not.toHaveBeenCalled();
  act(() => useWorkspaceStore.getState().openPaper(paperId));
  methods.resumeAnimation.mockClear();
  fireEvent.pointerMove(methods.renderer().domElement);
  expect(methods.resumeAnimation).not.toHaveBeenCalled();
});

it('pauses a minimized window and resumes the visible scene', () => {
  render(<Scene />);
  act(() => vi.advanceTimersByTime(1));
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  fireEvent(document, new Event('visibilitychange'));
  expect(methods.pauseAnimation).toHaveBeenCalled();
  methods.resumeAnimation.mockClear();
  fireEvent.pointerMove(methods.renderer().domElement);
  expect(methods.resumeAnimation).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  fireEvent(document, new Event('visibilitychange'));
  expect(methods.resumeAnimation).toHaveBeenCalledTimes(1);
});

it('uses native minimize events even when Chromium reports a visible document', () => {
  let visibility: (visible: boolean) => void = () => {};
  const unsubscribe = vi.fn();
  vi.stubGlobal('orbis', {
    onWindowVisibility: (callback: typeof visibility) => {
      visibility = callback;
      return unsubscribe;
    },
  });
  const view = render(<Scene />);
  act(() => vi.advanceTimersByTime(1));
  methods.resumeAnimation.mockClear();
  act(() => visibility(false));
  expect(document.hidden).toBe(false);
  expect(methods.pauseAnimation).toHaveBeenCalled();
  fireEvent.pointerMove(methods.renderer().domElement);
  expect(methods.resumeAnimation).not.toHaveBeenCalled();
  act(() => visibility(true));
  expect(methods.resumeAnimation).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
