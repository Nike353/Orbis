import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import canonicalGraph from '../../tests/fixtures/library/data/graph.json';
import { migrateAndValidateGraph } from '../domain/schema';
import { getBridgeHealth, runAgentInsertion } from '../services/agentBridge';
import { useWorkspaceStore } from '../store/workspaceStore';
import { AddPaperDialog } from './AddPaperDialog';

vi.mock('../services/agentBridge', () => ({
  getBridgeHealth: vi.fn(),
  runAgentInsertion: vi.fn(),
  cancelAgentInsertion: vi.fn(),
}));
vi.mock('./AgentModelSettings', () => ({ AgentModelSettings: () => null }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  useWorkspaceStore.setState({
    paperImport: null,
    paperWorkspace: null,
    addPaperOpen: false,
  });
});

it('offers to save unsaved edits and waits for the save before starting the import', async () => {
  const graph = migrateAndValidateGraph(canonicalGraph).graph;
  useWorkspaceStore.setState({
    graph,
    baseRevision: graph.meta.revision,
    mode: 'api',
    dirty: false,
    addPaperOpen: true,
  });
  useWorkspaceStore.getState().updateNode(graph.nodes[0].id, { notes: 'Keep my notes.' });
  vi.mocked(getBridgeHealth).mockResolvedValue({
    ok: true,
    busy: false,
    default_agent: 'copilot',
    agents: [{ id: 'copilot', label: 'GitHub Copilot', available: true }],
  });
  let finishSave!: (response: Response) => void;
  const fetchMock = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((resolve) => {
        finishSave = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(runAgentInsertion).mockResolvedValue(undefined);
  render(<AddPaperDialog />);
  await screen.findByText('GitHub Copilot ready');
  const submit = screen.getByRole('button', { name: 'Save & add' });
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Paper URL'), {
    target: { value: 'https://arxiv.org/abs/2610.12345' },
  });
  expect(submit).toBeEnabled();
  await act(async () => fireEvent.click(submit));
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/graph',
    expect.objectContaining({ method: 'PUT' }),
  );
  expect(runAgentInsertion).not.toHaveBeenCalled();
  const saved = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  expect(saved.graph.nodes[0].notes).toBe('Keep my notes.');
  expect(saved.base_revision).toBe(graph.meta.revision);
  await act(async () => {
    finishSave(new Response(JSON.stringify(saved.graph), { status: 200 }));
  });
  expect(runAgentInsertion).toHaveBeenCalledOnce();
  expect(useWorkspaceStore.getState().dirty).toBe(false);
  expect(useWorkspaceStore.getState().graph?.nodes[0].notes).toBe('Keep my notes.');
});

it.each(['save conflict', 'newer edit'])(
  'preserves edits and does not start the agent after a %s',
  async (failure) => {
    const graph = migrateAndValidateGraph(canonicalGraph).graph;
    useWorkspaceStore.setState({
      graph,
      baseRevision: graph.meta.revision,
      mode: 'api',
      dirty: false,
      addPaperOpen: true,
    });
    useWorkspaceStore.getState().updateNode(graph.nodes[0].id, { notes: 'Keep my notes.' });
    vi.mocked(getBridgeHealth).mockResolvedValue({
      ok: true,
      busy: false,
      default_agent: 'copilot',
      agents: [{ id: 'copilot', label: 'GitHub Copilot', available: true }],
    });
    let finishSave!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          finishSave = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AddPaperDialog />);
    await screen.findByText('GitHub Copilot ready');
    fireEvent.change(screen.getByLabelText('Paper URL'), {
      target: { value: 'https://arxiv.org/abs/2610.12345' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save & add' }));
    });
    const saved = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    await act(async () => {
      if (failure === 'newer edit') {
        useWorkspaceStore
          .getState()
          .updateNode(graph.nodes[0].id, { notes: 'Keep my newer notes.' });
        finishSave(new Response(JSON.stringify(saved.graph), { status: 200 }));
      } else {
        finishSave(
          new Response(JSON.stringify({ current_revision: graph.meta.revision + 1 }), {
            status: 409,
          }),
        );
      }
    });
    expect(runAgentInsertion).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().dirty).toBe(true);
    expect(useWorkspaceStore.getState().graph?.nodes[0].notes).toBe(
      failure === 'newer edit' ? 'Keep my newer notes.' : 'Keep my notes.',
    );
    expect(localStorage.getItem('orbis:v2:draft')).not.toBeNull();
    expect(useWorkspaceStore.getState().paperImport).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(
        failure === 'newer edit' ? /newer graph edits/i : /changed on disk/i,
      ),
    });
  },
);

it('closes the form and opens a pending reader before the agent produces a summary', async () => {
  const graph = migrateAndValidateGraph(canonicalGraph).graph;
  useWorkspaceStore.setState({ graph, dirty: false, addPaperOpen: true });
  vi.mocked(getBridgeHealth).mockResolvedValue({
    ok: true,
    busy: false,
    default_agent: 'copilot',
    agents: [{ id: 'copilot', label: 'GitHub Copilot', available: true }],
  });
  let fail!: (reason: Error) => void;
  const running = new Promise<void>((_resolve, reject) => {
    fail = reject;
  });
  vi.mocked(runAgentInsertion).mockImplementation(async (...args) => {
    args[6]({ type: 'start', url: args[1], job_id: 'accepted-job' });
    await running;
  });
  render(<AddPaperDialog />);
  await screen.findByText('GitHub Copilot ready');
  fireEvent.change(screen.getByLabelText('Paper URL'), {
    target: { value: 'https://arxiv.org/abs/2610.12345' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Read & add' }));
  });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  const state = useWorkspaceStore.getState();
  expect(state.paperWorkspace?.importId).toBe(state.paperImport?.id);
  expect(state.paperImport).toMatchObject({ status: 'running', jobId: 'accepted-job' });
  expect(state.graph).toBe(graph);
  await act(async () => {
    fail(new Error('Synthetic source unavailable.'));
  });
  expect(useWorkspaceStore.getState().paperImport).toMatchObject({
    status: 'failed',
    message: 'Synthetic source unavailable.',
  });
});
