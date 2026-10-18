import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import fixture from '../../tests/fixtures/library/data/graph.json';
import { migrateAndValidateGraph } from '../domain/schema';
import { buildSceneData } from './graph/sceneModel';
import { ConnectionPreview } from './ConnectionPreview';

it('shows the entire Markdown connection note and evidence with open and dismiss actions', () => {
  const graph = migrateAndValidateGraph(fixture).graph;
  const link = buildSceneData(graph).relationLinks[0];
  const original = {
    ...link.original!,
    transition_note:
      '## Connection reasoning\n\n' +
      'A detailed explanation. '.repeat(100) +
      '\n\nFinal paragraph remains readable.',
    evidence: 'Evidence from section 4.',
  };
  const onOpen = vi.fn(),
    onClose = vi.fn();
  render(
    <ConnectionPreview
      link={{ ...link, original }}
      graph={graph}
      onOpen={onOpen}
      onClose={onClose}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Connection reasoning' })).toBeTruthy();
  expect(screen.getByText('Final paragraph remains readable.')).toBeTruthy();
  expect(screen.getByText('Evidence from section 4.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open connection' }));
  expect(onOpen).toHaveBeenCalledWith(link.id);
  fireEvent.click(screen.getByRole('button', { name: 'Close connection preview' }));
  expect(onClose).toHaveBeenCalledOnce();
});

it('shows source connection notes for an inferred bridge, rather than just a field name', () => {
  const graph = migrateAndValidateGraph(fixture).graph;
  const link = buildSceneData(graph).membershipLinks.find(
    (item) => item.membershipRole === 'secondary',
  )!;
  render(
    <ConnectionPreview link={link} graph={graph} onOpen={vi.fn()} onClose={vi.fn()} />,
  );
  expect(screen.getByText('Bridge to research field')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Open connection' }).length).toBeGreaterThan(
    0,
  );
});
