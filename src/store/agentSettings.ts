import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { writePreference, removePreference } from '../services/preferences';
import type { AgentSettings, LocalAgent } from '../services/agentBridge';

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
    {
      name: 'orbis.agent-models',
      storage: createJSONStorage(() => ({
        getItem: (key) => localStorage.getItem(key),
        setItem: writePreference,
        removeItem: removePreference,
      })),
    },
  ),
);

export function useAgentSettings(agent: string, local?: LocalAgent) {
  const stored = preferences((s) => s.choices[agent]);
  const choice = stored ?? {
    model: '',
    effort: local?.default_efforts?.includes('medium') ? 'medium' : '',
  };
  const canonical = local?.models?.find(
    (model) => model.id === choice.model || model.aliases?.includes(choice.model),
  );
  const update = preferences((s) => s.setChoice);
  return {
    choice: canonical ? { ...choice, model: canonical.id } : choice,
    setChoice: (value: AgentSettings) => update(agent, value),
  };
}
