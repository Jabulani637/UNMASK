import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Reads /api/health once on mount. The landing page says out loud whether the
 * service behind it is up, instead of letting a button fail silently.
 */
export function useApiStatus() {
  const [status, setStatus] = useState({ state: 'checking', data: null, error: null });

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    api
      .health({ signal: controller.signal })
      .then(data => {
        if (active) setStatus({ state: data.status === 'ok' ? 'up' : 'degraded', data, error: null });
      })
      .catch(err => {
        if (active && err.name !== 'AbortError') setStatus({ state: 'down', data: null, error: err.message });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  return status;
}
