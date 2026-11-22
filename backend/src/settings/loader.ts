import { SETTINGS_KEYS, type Settings, type SettingsKey, defaultSettings, settingsSchemas } from "./definitions.js";

export interface SettingRow {
  key: string;
  value: unknown;
}

export interface SettingsProblem {
  key: SettingsKey;
  issues: string[];
}

export interface ResolvedSettings {
  settings: Settings;
  /** Keys whose stored value was invalid and fell back to the defaults. */
  problems: SettingsProblem[];
  /** Stored keys this version of the app does not know (kept, ignored). */
  unknownKeys: string[];
}

/**
 * Merge stored rows over the defaults. A broken row never stops the app:
 * that key falls back to its defaults and the problem is reported.
 */
export function resolveSettings(rows: SettingRow[]): ResolvedSettings {
  const settings = defaultSettings();
  const problems: SettingsProblem[] = [];
  const unknownKeys: string[] = [];
  const known = new Set<string>(SETTINGS_KEYS);

  for (const row of rows) {
    if (!known.has(row.key)) {
      unknownKeys.push(row.key);
      continue;
    }
    const key = row.key as SettingsKey;
    const parsed = settingsSchemas[key].safeParse(row.value);
    if (parsed.success) {
      (settings as Record<SettingsKey, unknown>)[key] = parsed.data;
    } else {
      problems.push({ key, issues: parsed.error.issues.map((i) => `${i.path.join(".") || key}: ${i.message}`) });
    }
  }
  return { settings, problems, unknownKeys };
}

/** Keys whose effective value differs between two settings objects. */
export function changedKeys(a: Settings, b: Settings): SettingsKey[] {
  return SETTINGS_KEYS.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}
