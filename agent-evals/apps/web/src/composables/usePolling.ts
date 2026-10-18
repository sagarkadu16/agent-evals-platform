import { onMounted, onUnmounted } from 'vue'

const INTERVAL_MS = 3000

/**
 * Calls `load` now and every 3 s. `load` returns true to keep polling, false to stop
 * (e.g. once the experiment is done). The interval is always cleared on unmount.
 * `start()` restarts polling, e.g. after "Retry errored runs".
 */
export function usePolling(load: () => Promise<boolean>) {
  let timer: ReturnType<typeof setInterval> | undefined

  const stop = () => {
    clearInterval(timer)
    timer = undefined
  }

  const tick = async () => {
    const keepGoing = await load().catch(() => true) // a failed request is retried next tick
    if (!keepGoing) stop()
  }

  const start = () => {
    stop()
    timer = setInterval(tick, INTERVAL_MS)
    void tick()
  }

  onMounted(start)
  onUnmounted(stop)
  return { start }
}
