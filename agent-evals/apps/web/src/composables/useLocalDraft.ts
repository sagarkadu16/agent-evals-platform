/**
 * Reads and writes a form draft as JSON in localStorage, so it survives navigating away and reloads.
 * Storage can be unavailable (private mode, blocked site data), so every access is best effort:
 * a failed read gives an empty draft and a failed write is ignored.
 */
export function useLocalDraft<T extends object>(key: string) {
  function load(): Partial<T> {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<T>) : {}
    } catch {
      return {}
    }
  }

  function save(draft: T) {
    try {
      localStorage.setItem(key, JSON.stringify(draft))
    } catch {
      // Not saved; the form still works for this visit.
    }
  }

  return { load, save }
}
