import type { AgentConfig } from './index.js';

/**
 * The config fields that change how the agent behaves, in display order.
 * `id` and `name` are labels, and `mockPassRate` only affects the MockRunner, so they are not compared.
 */
export const CONFIG_FIELDS = [
  { key: 'model', label: 'Model' },
  { key: 'provider', label: 'Provider' },
  { key: 'toolsets', label: 'Tools' },
  { key: 'skills', label: 'Skills' },
  { key: 'memoryFiles', label: 'Memory' },
  { key: 'maxTurns', label: 'Max turns' },
  { key: 'runBudgetSec', label: 'Time budget' },
] as const;

export type ConfigField = (typeof CONFIG_FIELDS)[number]['key'];

export interface ConfigDifference {
  field: ConfigField;
  label: string;
  a: string;
  b: string;
}

/** A field as display text. Lists are sorted (order doesn't change behaviour); an empty list is "none". */
export function formatConfigValue(config: AgentConfig, field: ConfigField): string {
  const value = config[field];
  if (Array.isArray(value)) return value.length ? [...value].sort().join(', ') : 'none';
  if (value === undefined) return 'none';
  return field === 'runBudgetSec' ? `${value} s` : String(value);
}

/** The fields that differ between A and B. Ideally exactly one, so a result can be attributed to it. */
export function diffConfigs(a: AgentConfig, b: AgentConfig): ConfigDifference[] {
  return CONFIG_FIELDS.flatMap(({ key, label }) => {
    const [va, vb] = [formatConfigValue(a, key), formatConfigValue(b, key)];
    return va === vb ? [] : [{ field: key, label, a: va, b: vb }];
  });
}
