import { useState } from 'react';
import type { LocalAgent } from '../services/agentBridge';
import { useAgentSettings } from '../store/agentSettings';

export function AgentModelSettings({
  agent,
  disabled = false,
}: {
  agent?: LocalAgent;
  disabled?: boolean;
}) {
  const { choice, setChoice } = useAgentSettings(agent?.id ?? '');
  const models = agent?.models ?? [];
  const known = models.find((m) => m.id === choice.model);
  const [custom, setCustom] = useState(Boolean(choice.model && !known));
  const efforts =
    known?.efforts ??
    (agent?.id === 'codex'
      ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
      : ['low', 'medium', 'high', 'xhigh', 'max']);
  if (!agent) return null;
  return (
    <fieldset className="agent-model-settings" disabled={disabled}>
      <legend>Run settings</legend>
      <div className="agent-model-fields">
        <label>
          Model
          <select
            aria-label="Model"
            value={custom || (choice.model && !known) ? '__custom' : choice.model}
            onChange={(e) => {
              const model = e.target.value;
              if (model === '__custom') {
                setCustom(true);
                setChoice({ model: '', effort: '' });
                return;
              }
              setCustom(false);
              const levels = models.find((m) => m.id === model)?.efforts ?? [];
              setChoice({
                model,
                effort: levels.includes(choice.effort)
                  ? choice.effort
                  : levels.includes('medium')
                    ? 'medium'
                    : '',
              });
            }}
          >
            <option value="">CLI default</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
            <option value="__custom">Custom model ID…</option>
          </select>
        </label>
        <label>
          Effort
          <select
            aria-label="Effort"
            value={choice.effort}
            onChange={(e) => setChoice({ ...choice, effort: e.target.value })}
          >
            <option value="">CLI default</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      </div>
      {(custom || (choice.model && !known)) && (
        <label>
          Custom model ID
          <input
            aria-label="Custom model ID"
            value={choice.model}
            maxLength={160}
            placeholder={agent.id === 'codex' ? 'gpt-5.6-sol' : 'claude-sonnet-4-6'}
            onChange={(e) => setChoice({ ...choice, model: e.target.value })}
          />
        </label>
      )}
      <p>
        Remembered across workflows in this browser. Model access and effort support depend
        on your CLI and account.
      </p>
    </fieldset>
  );
}
