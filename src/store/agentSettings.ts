import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AgentSettings } from '../services/agentBridge';

const DEFAULTS: Record<string, AgentSettings> = {
  codex: { model: 'gpt-5.6-sol', effort: 'medium' },
  claude: { model: '', effort: '' },
};
const EMPTY: AgentSettings = { model: '', effort: '' };
const preferences = create(
  persist<{
    choices: Record<string, AgentSettings>;
    setChoice: (agent: string, value: AgentSettings) => void;
  }>(
    (set) => ({
      choices: {},
      setChoice: (agent, value) =>
        set((state) => ({ choices: { ...state.choices, [agent]: value } })),
    }),
    { name: 'orbis.agent-models' },
  ),
);

export function useAgentSettings(agent: string) {
  const choice = preferences((s) => s.choices[agent] ?? DEFAULTS[agent] ?? EMPTY);
  const update = preferences((s) => s.setChoice);
  return { choice, setChoice: (value: AgentSettings) => update(agent, value) };
}
