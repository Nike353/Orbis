import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { AgentModelSettings } from './AgentModelSettings';

const codex = {
  id: 'codex' as const,
  label: 'Codex',
  available: true,
  models: [
    {
      id: 'gpt-5.6-sol',
      label: 'GPT-5.6 Sol',
      efforts: ['low', 'medium', 'high', 'ultra'],
    },
    { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
  ],
};
afterEach(cleanup);
it('starts with Sol medium, constrains effort and shares changes across workflows', async () => {
  const user = userEvent.setup();
  const first = render(<AgentModelSettings agent={codex} />);
  expect(screen.getByLabelText('Model')).toHaveValue('gpt-5.6-sol');
  expect(screen.getByLabelText('Effort')).toHaveValue('medium');
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
  expect(screen.getByLabelText('Effort')).toHaveValue('');
  await user.selectOptions(screen.getByLabelText('Model'), '__custom');
  await user.type(screen.getByLabelText('Custom model ID'), 'my-deployment');
  expect(screen.getByLabelText('Custom model ID')).toHaveValue('my-deployment');
});
