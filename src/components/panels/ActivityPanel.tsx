import { useEffect, useState } from 'react';
import { Activity, BookOpen, RotateCcw, Square } from 'lucide-react';
import { documentRequest, type ActivityJob } from '../../services/documents';
import { researchRequest } from '../../services/research';
import { cancelAgentInsertion, runAgentInsertion } from '../../services/agentBridge';
import { useWorkspaceStore } from '../../store/workspaceStore';

const RUNNING = ['queued', 'fetching', 'reading', 'running', 'processing'];
const labels: Record<string, string> = {
  queued: 'Queued',
  fetching: 'Downloading',
  reading: 'Reading source',
  retrieving: 'Retrieving evidence',
  answering: 'Preparing answer',
  validating: 'Checking evidence',
  processing: 'Reading and connecting',
  ready_to_review: 'Ready to review',
  completed: 'Complete',
  inserted: 'Added',
  excluded: 'Outside scope',
  duplicate: 'Already in library',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  failed: 'Failed',
};

export function ActivityPanel() {
  const [jobs, setJobs] = useState<ActivityJob[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [history, setHistory] = useState(false);
  const openPaper = useWorkspaceStore((state) => state.openPaper);
  const openResearch = useWorkspaceStore((state) => state.openResearch);
  const setTab = useWorkspaceStore((state) => state.setTab);
  const addPaper = useWorkspaceStore((state) => state.setAddPaperOpen);
  const refresh = useWorkspaceStore((state) => state.refresh);
  useEffect(() => {
    let stopped = false;
    const read = () =>
      documentRequest<{ jobs: ActivityJob[] }>('activity')
        .then((value) => {
          if (!stopped) {
            setJobs(value.jobs);
            setError('');
          }
        })
        .catch((failure: Error) => {
          if (!stopped) setError(failure.message);
        });
    void read();
    const timer = setInterval(() => void read(), 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  async function run(id: string, action: () => Promise<unknown>) {
    setBusy(id);
    try {
      await action();
      setJobs((await documentRequest<{ jobs: ActivityJob[] }>('activity')).jobs);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy('');
    }
  }
  const visible = jobs.filter(
    (job) =>
      history ||
      RUNNING.includes(job.status) ||
      ['failed', 'interrupted', 'ready_to_review'].includes(job.phase ?? job.status),
  );
  return (
    <div className="activity-panel">
      <header className="panel-heading">
        <span className="eyebrow">Keep your place</span>
        <h2>
          <Activity size={19} /> Activity
        </h2>
        <p>Browse the galaxy or read another paper while work continues.</p>
      </header>
      <label className="check-line">
        <input
          type="checkbox"
          checked={history}
          onChange={(event) => setHistory(event.target.checked)}
        />{' '}
        Show completed work
      </label>
      {error && (
        <p className="research-warning" role="alert">
          {error}
        </p>
      )}
      {!visible.length && (
        <p className="activity-empty">
          Nothing needs your attention. Completed work remains in history.
        </p>
      )}
      {visible.map((job) => (
        <article
          className={`activity-card activity-${job.status}`}
          key={`${job.kind}:${job.id}`}
        >
          <div className="activity-meta">
            <span>{job.kind}</span>
            <strong>{labels[job.phase ?? job.status] ?? job.status}</strong>
          </div>
          <h3>{job.title}</h3>
          {job.error && <p className="activity-error">{job.error}</p>}
          <div className="activity-actions">
            {job.node_id && (
              <button
                className="button secondary"
                onClick={() => openPaper(job.node_id!, job.document_id)}
              >
                <BookOpen size={14} /> Open paper
              </button>
            )}
            {job.session_id && (
              <button
                className="button secondary"
                onClick={() =>
                  openResearch(
                    job.scope_ids ?? [],
                    job.kind === 'comparison',
                    job.session_id,
                  )
                }
              >
                Open {job.kind === 'comparison' ? 'comparison' : 'discussion'}
              </button>
            )}
            {RUNNING.includes(job.status) && (
              <button
                className="button secondary"
                disabled={busy === job.id}
                onClick={() =>
                  void run(job.id, () =>
                    job.kind === 'document'
                      ? documentRequest(`activity/${job.id}/cancel`, {})
                      : job.kind === 'import'
                        ? cancelAgentInsertion(job.id)
                        : researchRequest(`/${job.session_id}/cancel/${job.id}`, {}),
                  )
                }
              >
                <Square size={13} /> Cancel
              </button>
            )}
            {['failed', 'cancelled', 'interrupted'].includes(job.status) &&
              job.kind === 'document' && (
                <button
                  className="button secondary"
                  disabled={busy === job.id}
                  onClick={() =>
                    void run(job.id, () =>
                      documentRequest('documents/fetch', {
                        node_id: job.node_id,
                        url: job.url,
                      }),
                    )
                  }
                >
                  <RotateCcw size={14} /> Retry download
                </button>
              )}
            {job.kind === 'import' && !RUNNING.includes(job.status) && (
              <button
                className="button secondary"
                onClick={() => {
                  if (job.url) addPaper(true);
                  else setTab('imports');
                }}
              >
                Review import
              </button>
            )}
            {job.kind === 'import' &&
              ['failed', 'cancelled', 'interrupted'].includes(job.status) &&
              job.url &&
              (job.agent === 'codex' || job.agent === 'claude') && (
                <button
                  className="button secondary"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void run(job.id, async () => {
                      await runAgentInsertion(
                        job.agent as 'codex' | 'claude',
                        job.url!,
                        job.hint ?? '',
                        null,
                        null,
                        new AbortController().signal,
                        (event) => {
                          if (event.type === 'error') throw new Error(event.message);
                        },
                        job.source_kind,
                        job.settings,
                      );
                      await refresh();
                    })
                  }
                >
                  <RotateCcw size={14} /> Retry import
                </button>
              )}
          </div>
        </article>
      ))}
      <p className="research-caption">
        Interrupted tasks require a retry; a stopped agent process is not resumed
        automatically.
      </p>
    </div>
  );
}
