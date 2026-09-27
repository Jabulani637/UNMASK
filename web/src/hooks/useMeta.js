import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * The vocabularies and the account rules, fetched once per page load.
 *
 * A module-level promise rather than per-component state, because the landing
 * page, the signup form and the profile builder all want the same list and the
 * API caches it for five minutes anyway.
 */
let cached = null;

function load() {
  if (!cached) cached = api.meta();
  return cached;
}

export function useMeta() {
  const [meta, setMeta] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    load()
      .then(data => {
        if (alive) setMeta(data);
      })
      .catch(() => {
        // A form that cannot state the rules still has to be fillable, so the
        // screens fall back to the server's own answer at submit time.
        cached = null;
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  return { meta, failed };
}

/**
 * The institutions a form can honestly name to a stranger: "CPUT, NORTHLINK, UCT…".
 *
 * This replaced a line that read `meta.emailDomains` and fell back to the word
 * "CPUT". Both halves were wrong once the collection existed: the field is now a
 * list of documents each holding its own domains, and a hard-coded fallback would
 * have meant a student at a college added ten minutes ago reading about a
 * university they do not attend. So when the list is not there, this says so, and
 * the caller writes a sentence with no names in it.
 */
export function institutionNames(meta, { limit = 6, joiner = ', ' } = {}) {
  const list = (meta && meta.institutions) || [];
  const names = list.map(institution => institution.shortName);
  if (!names.length) return null;
  if (names.length <= limit) return names.join(joiner);
  return `${names.slice(0, limit).join(joiner)} and ${names.length - limit} more`;
}
