import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { AgentModelSettings } from './AgentModelSettings';

const codex = {
  id: 'codex' as const,
  label: 'Codex',
  available: true,
  default_model: 'global.openai.gpt-5.6-sol',
  default_model_label: 'GPT-5.6 Sol (Global)',
  default_effort: 'max',
  default_efforts: ['low', 'medium', 'high', 'ultra'],
  cli_version: '0.167.0',
  model_source: 'cli' as const,
  models: [
    {
      id: 'global.openai.gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      efforts: ['low', 'medium', 'high', 'ultra'],
      aliases: ['gpt-5.6-sol'],
    },
    { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
  ],
};
afterEach(cleanup);
it('uses the configured CLI model with balanced effort and shares choices across workflows', async () => {
  const user = userEvent.setup();
  const first = render(<AgentModelSettings agent={codex} />);
  expect(screen.getByLabelText('Model')).toHaveValue('');
  expect(screen.getByLabelText('Effort')).toHaveValue('medium');
  expect(screen.getByRole('option', { name: 'CLI default (max)' })).toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Model'), 'global.openai.gpt-5.6-sol');
  await user.selectOptions(screen.getByLabelText('Effort'), 'ultra');
  await user.selectOptions(screen.getByLabelText('Model'), 'gpt-5.5');
  expect(screen.getByLabelText('Effort')).toHaveValue('medium');
  expect(screen.queryByRole('option', { name: 'ultra' })).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText('Effort'), 'high');
  first.unmount();
  render(<AgentModelSettings agent={codex} />);
  expect(screen.getByLabelText('Model')).toHaveValue('gpt-5.5');
  expect(screen.getByLabelText('Effort')).toHaveValue('high');
  await user.selectOptions(screen.getByLabelText('Model'), '');
  expect(screen.getByLabelText('Effort')).toHaveValue('high');
  await user.selectOptions(screen.getByLabelText('Effort'), '');
  expect(screen.getByLabelText('Effort')).toHaveValue('');
  await user.selectOptions(screen.getByLabelText('Model'), '__custom');
  await user.type(screen.getByLabelText('Custom model ID'), 'my-deployment');
  expect(screen.getByLabelText('Custom model ID')).toHaveValue('my-deployment');
});

it('offers new Claude aliases and only the effort levels reported for them', async () => {
  const user = userEvent.setup();
  render(
    <AgentModelSettings
      agent={{
        id: 'claude',
        label: 'Claude Code',
        available: true,
        default_efforts: ['low', 'medium', 'high'],
        models: [
          { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium'] },
          { id: 'fable', label: 'Fable', efforts: ['high', 'max'] },
        ],
      }}
    />,
  );
  await user.selectOptions(screen.getByLabelText('Model'), 'fable');
  expect(screen.getByRole('option', { name: 'max' })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'medium' })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'ultra' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Effort')).toHaveValue('high');
});

it('displays an old unprefixed Sol preference as its current provider model', async () => {
  const user = userEvent.setup();
  const first = render(<AgentModelSettings agent={codex} />);
  await user.selectOptions(screen.getByLabelText('Model'), '__custom');
  await user.clear(screen.getByLabelText('Custom model ID'));
  await user.type(screen.getByLabelText('Custom model ID'), 'gpt-5.6-sol');
  first.unmount();
  render(<AgentModelSettings agent={codex} />);
  expect(screen.getByLabelText('Model')).toHaveValue('global.openai.gpt-5.6-sol');
  expect(screen.queryByLabelText('Custom model ID')).not.toBeInTheDocument();
});
