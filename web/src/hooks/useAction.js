import { useCallback, useState } from 'react';
import { ApiError } from '../api.js';

/**
 * The shape every form on this site has: press, wait for the API, then either
 * show what came back or show the server's own sentence.
 *
 * The server's wording is shown verbatim on purpose. Several of those sentences
 * are written so that they read the same whether or not an address exists, and a
 * locally-invented message would break that (FR-1.1, NFR-3.3).
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [code, setCode] = useState(null);
  const [result, setResult] = useState(null);

  const run = useCallback(async (action, onSuccess) => {
    setBusy(true);
    setError(null);
    setCode(null);
    setResult(null);
    try {
      const value = await action();
      setResult(value);
      if (onSuccess) await onSuccess(value);
      return value;
    } catch (err) {
      setError(messageFor(err));
      setCode(err instanceof ApiError ? err.code : null);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setCode(null);
    setResult(null);
  }, []);

  return { busy, error, code, result, run, reset };
}

function messageFor(err) {
  if (err instanceof ApiError) return err.message;
  // No response at all: the API is not running, or the proxy is pointed
  // somewhere else. Naming the command is more use than naming the exception.
  return 'The site could not reach the server. If the API is not running, start it with: npm run dev  (from the UNMASK folder)';
}
