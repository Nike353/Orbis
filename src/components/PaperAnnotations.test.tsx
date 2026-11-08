import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PaperAnnotation } from '../services/documents';
import { PaperAnnotations } from './PaperAnnotations';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('keeps a saved comment out of drafts when autosave overlaps the save response', async () => {
  vi.useFakeTimers();
  const annotation: PaperAnnotation = {
    id: 'a'.repeat(32),
    document_id: 'b'.repeat(32),
    page: 1,
    quote: 'A passage from the original.',
    comment: '',
    color: 'yellow',
    rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.1 }],
    created_at: '2026-01-01T00:00:00Z',
  };
  let saved = annotation;
  let draft: unknown = null;
  let finishSave!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    finishSave = resolve;
  });
  const json = (value: unknown) => new Response(JSON.stringify(value));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === `/api/annotations/${annotation.id}/draft`) {
        if (options?.body) draft = JSON.parse(options.body as string);
        return json(draft);
      }
      if (url === `/api/annotations/${annotation.id}`) {
        const body = JSON.parse(options!.body as string);
        saved = { ...saved, comment: body.comment, color: body.color };
        draft = null;
        // The server committed; its response is still in flight.
        return response;
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  let flush!: () => Promise<void>;
  const props = {
    onOpen: () => {},
    onSaved: async () => {},
    onDraftFlush: (value: () => Promise<void>) => {
      flush = value;
    },
  };
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<PaperAnnotations {...props} annotations={[annotation]} />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Highlight comment'), {
      target: { value: 'My saved comment.' },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save comment' }));
  });
  expect(saved.comment).toBe('My saved comment.');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  let closed = false;
  let close!: Promise<void>;
  await act(async () => {
    close = flush().then(() => {
      closed = true;
    });
  });
  const closedBeforeSaveResponse = closed;
  await act(async () => {
    finishSave(json(saved));
    await close;
  });
  view.unmount();
  await act(async () => {
    render(<PaperAnnotations {...props} annotations={[saved]} />);
  });
  expect(screen.queryByRole('button', { name: 'Edit comment' })).toBeInTheDocument();
  expect(screen.queryByLabelText('Highlight comment')).not.toBeInTheDocument();
  expect(closedBeforeSaveResponse).toBe(false);
});

interface AnnotationDraft {
  comment: string;
  color: PaperAnnotation['color'];
  expected: PaperAnnotation;
}

type AnnotationMutation = AnnotationDraft | { action: 'delete'; expected: PaperAnnotation };

interface FixtureState {
  saved: PaperAnnotation | null;
  draft: AnnotationDraft | null;
  mutations: AnnotationMutation[];
  nextMutationResponse?: Promise<Response>;
  nextDraftResponse?: Promise<Response>;
  refreshResponse?: Promise<void>;
  draftError?: string;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function createAnnotationFixture() {
  vi.useFakeTimers();
  const initial: PaperAnnotation = {
    id: 'a'.repeat(32),
    document_id: 'b'.repeat(32),
    page: 1,
    quote: 'A passage from the original.',
    comment: 'The initial saved comment.',
    color: 'yellow',
    rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.1 }],
    created_at: '2026-01-01T00:00:00Z',
  };
  const state: FixtureState = {
    saved: { ...initial },
    draft: null,
    mutations: [],
  };
  let flushDrafts: (() => Promise<void>) | undefined;
  const registerFlush = (flush: () => Promise<void>) => {
    flushDrafts = flush;
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === `/api/annotations/${initial.id}/draft`) {
        if (!options?.body) return json(state.draft);
        const body = JSON.parse(options.body as string) as
          AnnotationDraft | { action: 'discard' };
        if ('action' in body) {
          state.draft = null;
          return json(null);
        }
        if (state.draftError) return json({ error: state.draftError }, 503);
        state.draft = body;
        const response = state.nextDraftResponse;
        state.nextDraftResponse = undefined;
        return response ?? json(body);
      }
      if (url === `/api/annotations/${initial.id}`) {
        const body = JSON.parse(options!.body as string) as AnnotationMutation;
        state.mutations.push(body);
        const response = state.nextMutationResponse;
        state.nextMutationResponse = undefined;
        if (response) return response;
        if (JSON.stringify(body.expected) !== JSON.stringify(state.saved)) {
          return json(
            {
              error: 'Highlight changed on another device. Reopen it before saving.',
            },
            409,
          );
        }
        if ('action' in body) state.saved = null;
        else {
          state.saved = {
            ...body.expected,
            comment: body.comment,
            color: body.color,
          };
        }
        state.draft = null;
        return json({ ok: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  function Harness() {
    const [annotations, setAnnotations] = useState<PaperAnnotation[]>([initial]);
    return (
      <PaperAnnotations
        annotations={annotations}
        onOpen={() => {}}
        onSaved={async () => {
          await state.refreshResponse;
          setAnnotations(state.saved ? [{ ...state.saved }] : []);
        }}
        onDraftFlush={registerFlush}
      />
    );
  }
  return {
    state,
    initial,
    mount: () => render(<Harness />),
    flush: () => {
      if (!flushDrafts) throw new Error('Annotation flush has not been registered.');
      return flushDrafts();
    },
  };
}

type AnnotationFixture = ReturnType<typeof createAnnotationFixture>;

async function clickButton(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

async function editComment(fixture: AnnotationFixture, comment = 'My updated comment.') {
  await act(async () => {
    fixture.mount();
  });
  await clickButton('Edit comment');
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Highlight comment'), {
      target: { value: comment },
    });
  });
}

it('keeps Edit and Remove disabled until the saved annotation finishes reloading', async () => {
  const fixture = createAnnotationFixture();
  const refresh = deferred<void>();
  fixture.state.refreshResponse = refresh.promise;
  await editComment(fixture);
  await clickButton('Save comment');
  expect(fixture.state.saved?.comment).toBe('My updated comment.');
  expect(screen.getByRole('button', { name: 'Edit comment' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Remove highlight' })).toBeDisabled();
  await act(async () => {
    refresh.resolve();
  });
  expect(screen.getByRole('button', { name: 'Edit comment' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Remove highlight' })).toBeEnabled();
  expect(screen.getByText('My updated comment.')).toBeInTheDocument();
});

it('removes a previously saved highlight using its current annotation as the CAS base', async () => {
  const fixture = createAnnotationFixture();
  await editComment(fixture);
  await clickButton('Save comment');
  const saved = fixture.state.saved;
  expect(saved?.comment).toBe('My updated comment.');
  await clickButton('Remove highlight');
  await clickButton('Remove');
  expect(fixture.state.mutations[1]).toEqual({
    action: 'delete',
    expected: saved,
  });
  expect(fixture.state.saved).toBeNull();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await act(async () => {
    await fixture.flush();
  });
});

it('rejects close during a failed pending deletion but allows close after the error is handled', async () => {
  const fixture = createAnnotationFixture();
  await act(async () => {
    fixture.mount();
  });
  await clickButton('Remove highlight');
  const failure = deferred<Response>();
  fixture.state.nextMutationResponse = failure.promise;
  await clickButton('Remove');
  let settled = false;
  let close!: Promise<unknown>;
  await act(async () => {
    close = fixture.flush().then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
  });
  expect(settled).toBe(false);
  let closeError: unknown;
  await act(async () => {
    failure.resolve(json({ error: 'The highlight could not be removed.' }, 503));
    closeError = await close;
  });
  expect(closeError).toMatchObject({
    message: 'The highlight could not be removed.',
  });
  expect(screen.getByRole('alert')).toHaveTextContent(
    'The highlight could not be removed.',
  );
  expect(fixture.state.saved).toEqual(fixture.initial);
  await act(async () => {
    await fixture.flush();
  });
});

it('keeps a queued draft persistence failure visible to close after Save fails', async () => {
  const fixture = createAnnotationFixture();
  await editComment(fixture);
  const failure = deferred<Response>();
  fixture.state.nextMutationResponse = failure.promise;
  fixture.state.draftError = 'The comment draft could not be preserved.';
  await clickButton('Save comment');
  let close!: Promise<unknown>;
  await act(async () => {
    close = fixture.flush().catch((error: unknown) => error);
  });
  let closeError: unknown;
  await act(async () => {
    failure.resolve(json({ error: 'The comment could not be saved.' }, 503));
    closeError = await close;
  });
  expect(closeError).toMatchObject({
    message: 'The comment draft could not be preserved.',
  });
  expect(screen.getByLabelText('Highlight comment')).toHaveValue('My updated comment.');
  expect(fixture.state.saved).toEqual(fixture.initial);
  await act(async () => {
    await expect(fixture.flush()).rejects.toThrow(
      'The comment draft could not be preserved.',
    );
  });
});

it('locks comment and color while an explicit close flush waits for acknowledgement', async () => {
  const fixture = createAnnotationFixture();
  await editComment(fixture);
  const response = deferred<Response>();
  fixture.state.nextDraftResponse = response.promise;
  let close!: Promise<void>;
  await act(async () => {
    close = fixture.flush();
  });
  expect(screen.getByLabelText('Highlight comment')).toBeDisabled();
  expect(screen.getByLabelText('Highlight color')).toBeDisabled();
  await act(async () => {
    response.resolve(json(fixture.state.draft));
    await close;
  });
  expect(fixture.state.draft?.comment).toBe('My updated comment.');
  expect(screen.getByLabelText('Highlight comment')).toBeEnabled();
  expect(screen.getByLabelText('Highlight color')).toBeEnabled();
});

it('keeps background autosave editable and preserves text entered during its pending response', async () => {
  const fixture = createAnnotationFixture();
  await editComment(fixture, 'The first draft.');
  const response = deferred<Response>();
  fixture.state.nextDraftResponse = response.promise;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(screen.getByLabelText('Highlight comment')).toBeEnabled();
  expect(screen.getByLabelText('Highlight color')).toBeEnabled();
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Highlight comment'), {
      target: { value: 'The latest draft.' },
    });
    response.resolve(json(fixture.state.draft));
  });
  await act(async () => {
    await fixture.flush();
  });
  expect(fixture.state.draft?.comment).toBe('The latest draft.');
});

it('waits for the recovered draft before focusing a requested comment and keeps its conflict base', async () => {
  const initial: PaperAnnotation = {
    id: 'a'.repeat(32),
    document_id: 'b'.repeat(32),
    page: 1,
    quote: 'A passage from the original.',
    comment: '',
    color: 'yellow',
    rects: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.1 }],
    created_at: '2026-01-01T00:00:00Z',
  };
  const remote = { ...initial, comment: 'A newer synced comment.' };
  const recovered: AnnotationDraft = {
    comment: 'My recovered draft.',
    color: 'blue',
    expected: initial,
  };
  const loading = deferred<Response>();
  let written: AnnotationDraft | undefined;
  let flush!: () => Promise<void>;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options?: RequestInit) => {
      if (!options?.body) return loading.promise;
      written = JSON.parse(options.body as string) as AnnotationDraft;
      return json(written);
    }),
  );
  const props = {
    annotations: [remote],
    onOpen: () => {},
    onSaved: async () => {},
    onDraftFlush: (value: () => Promise<void>) => {
      flush = value;
    },
  };
  const view = render(
    <PaperAnnotations
      {...props}
      annotationRequest={{ id: initial.id, nonce: 1, edit: true }}
    />,
  );
  expect(screen.queryByLabelText('Highlight comment')).not.toBeInTheDocument();
  await act(async () => {
    loading.resolve(json(recovered));
  });
  expect(screen.getByLabelText('Highlight comment')).toHaveFocus();
  expect(screen.getByLabelText('Highlight comment')).toHaveValue(recovered.comment);
  fireEvent.change(screen.getByLabelText('Highlight comment'), {
    target: { value: 'My continued draft.' },
  });
  view.rerender(
    <PaperAnnotations
      {...props}
      annotationRequest={{ id: initial.id, nonce: 2, edit: true }}
    />,
  );
  await act(async () => {
    await flush();
  });
  expect(written).toEqual({ ...recovered, comment: 'My continued draft.' });
});
