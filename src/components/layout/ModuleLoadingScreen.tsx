import { useEffect, useState } from 'react'
import { LoaderCircle, RefreshCw, WifiOff } from 'lucide-react'
import './module-loading-screen.css'

type ModuleLoadingScreenProps = {
  isOnline: boolean
  loadError?: boolean
  onRetry?: () => void
}

export function ModuleLoadingScreen({
  isOnline,
  loadError = false,
  onRetry,
}: ModuleLoadingScreenProps) {
  const [isTakingLong, setIsTakingLong] = useState(false)

  useEffect(() => {
    if (loadError) return
    const timeout = window.setTimeout(() => setIsTakingLong(true), 8000)
    return () => window.clearTimeout(timeout)
  }, [loadError])

  const title = loadError
    ? "We couldn't load this module"
    : !isOnline
      ? 'Waiting for connection'
      : isTakingLong
        ? 'Taking longer than usual'
        : 'Preparing your workspace'

  const message = loadError
    ? 'A temporary loading problem interrupted this page. Check your connection and try again.'
    : !isOnline
      ? 'Your device appears to be offline. Reconnect to continue loading your workspace.'
      : isTakingLong
        ? 'Your connection may be slow. PropertyOS is still trying to open this section.'
        : 'Securely preparing your property workspace. This usually takes just a moment.'

  const showRetry = loadError || isTakingLong || !isOnline

  return (
    <section className="module-loading-screen" role="status" aria-live="polite" aria-busy={!loadError}>
      <div className="module-loading-card">
        <div className="module-loading-emblem" aria-hidden="true">
          <img src="/icon-192.png" alt="" />
          {!loadError && <span className="module-loading-orbit" />}
        </div>

        <p className="module-loading-kicker">PROPERTYOS WORKSPACE</p>
        <h1 className="module-loading-title">{title}</h1>
        <p className="module-loading-message">{message}</p>

        {!loadError && isOnline && (
          <div className="module-loading-progress" aria-hidden="true">
            <span />
          </div>
        )}

        <div className={`module-loading-connection ${isOnline ? 'is-online' : 'is-offline'}`}>
          {isOnline ? <span className="module-loading-status-dot" /> : <WifiOff size={15} />}
          <span>{isOnline ? 'Network connection detected' : 'No network connection detected'}</span>
        </div>

        {showRetry && (
          <button
            className="module-loading-retry"
            type="button"
            onClick={onRetry ?? (() => window.location.reload())}
          >
            <RefreshCw size={16} />
            Try again
          </button>
        )}

        {!loadError && isOnline && !isTakingLong && (
          <div className="module-loading-wait-note" aria-hidden="true">
            <LoaderCircle size={14} />
            <span>Loading securely…</span>
          </div>
        )}
      </div>
      <p className="module-loading-footer">T&amp;N House's · Property management</p>
    </section>
  )
}
