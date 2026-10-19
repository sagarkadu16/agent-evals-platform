/** 0.9 -> "90%"; null -> "—". */
export const percent = (rate: number | null | undefined) =>
  rate === null || rate === undefined ? '—' : `${Math.round(rate * 1000) / 10}%`

/** 0.06 -> "+6.0"; -0.2 -> "-20.0" (percentage points). */
export const points = (fraction: number) => {
  const v = Math.round(fraction * 1000) / 10
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`
}

export const seconds = (ms: number | null | undefined) =>
  ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} s`

export const usd = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `$${v < 0.01 && v > 0 ? v.toFixed(5) : v.toFixed(4)}`

export const dateTime = (ms: number) => new Date(ms).toLocaleString()

/** A ratio as a factor: 1.63 -> "1.6×", 17.4 -> "17×". */
export const factor = (x: number) => `${x < 10 ? x.toFixed(1) : Math.round(x)}×`
