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
  const { choice, setChoice } = useAgentSettings(agent?.id ?? '', agent);
  const models = agent?.models ?? [];
  const known = models.find((m) => m.id === choice.model);
  const [custom, setCustom] = useState(false);
  const efforts = known?.efforts ?? (choice.model ? [] : (agent?.default_efforts ?? []));
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
              const levels = model
                ? (models.find((m) => m.id === model)?.efforts ?? [])
                : (agent.default_efforts ?? []);
              setChoice({
                model,
                effort: levels.includes(choice.effort)
                  ? choice.effort
                  : levels.includes('medium')
                    ? 'medium'
                    : (levels[0] ?? ''),
              });
            }}
          >
            <option value="">
              CLI default
              {agent.default_model_label ? ` (${agent.default_model_label})` : ''}
            </option>
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
            <option value="">
              CLI default{agent.default_effort ? ` (${agent.default_effort})` : ''}
            </option>
            {choice.effort && !efforts.includes(choice.effort) && (
              <option value={choice.effort}>{choice.effort} (not reported by CLI)</option>
            )}
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
            placeholder="Exact model or deployment ID from your CLI"
            onChange={(e) => {
              setCustom(true);
              setChoice({ ...choice, model: e.target.value });
            }}
          />
        </label>
      )}
      {agent.model_error ? (
        <p role="status">{agent.model_error}</p>
      ) : (
        <p>
          {agent.label}
          {agent.cli_version ? ` ${agent.cli_version}` : ''}: models and effort levels
          reported by your installed CLI. {known?.description}
        </p>
      )}
      <p>
        Medium balances speed and depth; low is faster. Higher effort can take longer.
        Choices are shared across imports and discussions on this device. Your account
        determines model access.
      </p>
    </fieldset>
  );
}
