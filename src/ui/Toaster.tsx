import { useToasts } from '@/components/toast'

/** The floating messages: one per transaction, or one live row for a run of several. */
export function Toaster() {
  const { toasts, live, docked, dismiss, close } = useToasts()
  if (!toasts.length && !live.length) return null
  // Couch mode shows the toasts itself, docked in place of its tablets.
  if (docked) return null
  return (
    <div className="toasts" aria-live="polite">
      {live.map((t) => (
        <button key={t.id} type="button" className={`toast is-${t.state}`} onClick={() => t.state !== 'running' && close(t.id)}>
          <b>{t.title}</b>
          <span className="toast__steps">
            {t.steps.map((s, i) => (
              <i key={i} className={`is-${s}`} />
            ))}
          </span>
          {t.line && <small>{t.line}</small>}
        </button>
      ))}
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`toast is-${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.message}
        </button>
      ))}
    </div>
  )
}
