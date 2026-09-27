/**
 * One place that talks to the API.
 *
 * Every call goes through /api on the same origin (Vite proxies it to the Node
 * process in development), so the session cookie stays first-party and no CORS
 * pre-flight runs on each request.
 */

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body && body.code;
    this.retrySeconds = body && body.retrySeconds;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body, form, signal } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    signal,
    // A FormData body must not be given a content type: the browser adds the
    // multipart boundary, and anything we write here would override it.
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: form || (body ? JSON.stringify(body) : undefined),
  });

  if (res.status === 204) return null;

  let data = null;
  try {
    data = await res.json();
  } catch {
    // A proxy or crashed server can answer with HTML. The caller needs a
    // status and a sentence, not a JSON parse error.
  }

  if (!res.ok) {
    throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status, data);
  }
  return data;
}

export const api = {
  health: opts => request('/api/health', opts),
  meta: () => request('/api/meta'),
  get: path => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  del: (path, body) => request(path, { method: 'DELETE', body }),

  /**
   * NFR-SCALE-1, the student's half: "Don't see yours? Request it."
   *
   * Called by someone with no account — that is the whole point of the button — so
   * it carries no session and gets no reply address back. The record names a
   * college, not a person.
   */
  requestInstitution: body => request('/api/institution-requests', { method: 'POST', body }),

  auth: {
    register: body => request('/api/auth/register', { method: 'POST', body }),
    verifyCode: ({ email, code }) => request('/api/auth/verify-code', { method: 'POST', body: { email, code } }),
    resend: email => request('/api/auth/resend-verification', { method: 'POST', body: { email } }),
    signIn: body => request('/api/auth/login', { method: 'POST', body }),
    signOut: () => request('/api/auth/logout', { method: 'POST' }),
    me: opts => request('/api/auth/me', opts),
    forgot: email => request('/api/auth/forgot', { method: 'POST', body: { email } }),
    reset: body => request('/api/auth/reset', { method: 'POST', body }),
    changePassword: body => request('/api/auth/password', { method: 'POST', body }),
    /** NFR-3.1: the whole record about you, shaped to be read by you. */
    exportData: body => request('/api/auth/export', { method: 'POST', body }),
    deleteAccount: body => request('/api/auth/account', { method: 'DELETE', body }),
  },

  profile: {
    get: () => request('/api/profile'),
    save: body => request('/api/profile', { method: 'PUT', body }),
    uploadPhoto: form => request('/api/profile/photo', { method: 'POST', form }),
    removePhoto: () => request('/api/profile/photo', { method: 'DELETE' }),
    /**
     * For an <img> tag. The stored file has a random name the browser is never
     * told, so this path is always the same and `stamp` is what makes a replaced
     * photo redraw instead of being served from cache.
     */
    url: stamp => `/api/profile/photo${stamp ? `?at=${encodeURIComponent(stamp)}` : ''}`,
  },

  /**
   * Stage 4. A suggestion is addressed by its sealed token and never by an id:
   * there is no route here that takes a profile id as input, which is what keeps
   * "who is this?" a question only the server can answer.
   */
  matching: {
    suggestion: () => request('/api/matches/suggestion'),
    pass: token => request('/api/matches/suggestion/pass', { method: 'POST', body: { token } }),
    connect: token => request('/api/matches/suggestion/connect', { method: 'POST', body: { token } }),
  },

  /**
   * Stage 5. A thread is addressed by its match id, which only ever reaches this
   * student's own account — the server checks the pair on every one of these
   * calls, so an id copied out of devtools opens nothing for anyone else.
   *
   * `send` is the door used when the socket is down. Both doors write once,
   * because the budget and the insert live in the API's chat service.
   */
  chats: {
    list: () => request('/api/chats'),
    thread: (id, opts = {}) => {
      const query = new URLSearchParams();
      if (opts.before) query.set('before', opts.before);
      if (opts.beforeId) query.set('beforeId', opts.beforeId);
      if (opts.limit) query.set('limit', String(opts.limit));
      const tail = query.toString();
      return request(`/api/chats/${id}${tail ? `?${tail}` : ''}`);
    },
    send: (id, body) => request(`/api/chats/${id}/messages`, { method: 'POST', body: { body } }),
    leave: id => request(`/api/chats/${id}/leave`, { method: 'POST' }),
    clear: id => request(`/api/chats/${id}`, { method: 'DELETE' }),
  },

  /**
   * Stage 6. The three writes are the whole of a reveal's consent: ask, answer,
   * take it back. The two reads are the only doors in the app that can return a
   * name or a face, and the server refuses both until the pair's own row says the
   * two of you agreed — so a screen calling them early gets one sentence, not a
   * partial answer it would have to remember not to show.
   */
  reveals: {
    ask: id => request(`/api/reveals/${id}/ask`, { method: 'POST' }),
    answer: (id, accept) => request(`/api/reveals/${id}/answer`, { method: 'POST', body: { accept } }),
    revoke: id => request(`/api/reveals/${id}/revoke`, { method: 'POST' }),
    profile: id => request(`/api/reveals/${id}/profile`),
    /** For an <img> tag: always the same path, and the gate is the session. */
    photoUrl: (id, stamp) => `/api/reveals/${id}/photo${stamp ? `?at=${encodeURIComponent(stamp)}` : ''}`,
  },

  /**
   * Stage 7. Every call here names its target the way the screen already holds it —
   * a thread id, a message id, or the sealed token of the card on screen — and never
   * an account id, because this page has never been given one and does not start
   * inventing them to file a report.
   */
  safety: {
    report: body => request('/api/safety/reports', { method: 'POST', body }),
    block: target => request('/api/safety/blocks', { method: 'POST', body: target }),
    blocks: () => request('/api/safety/blocks'),
    unblock: id => request(`/api/safety/blocks/${id}`, { method: 'DELETE' }),
  },

  /**
   * Stage 8. A student's own bell, and the FR-7.4 switches over it.
   *
   * A notice carries the thread it belongs to and nothing else — no name, no quote,
   * no sender — and that thread id is the same address `/api/chats` already guards,
   * so linking a notice needs no new capability and a leaked bell shows nobody's
   * conversation. There is also no route here that sends one: the event behind it
   * writes it, in wording the server owns, which means the worst any of these five
   * doors can do is read, mark and mute the caller's own notices.
   */
  notifications: {
    list: (limit = 30) => request(`/api/notifications?limit=${encodeURIComponent(String(limit))}`),
    read: ids => request('/api/notifications/read', { method: 'POST', body: ids === 'all' ? { all: true } : { ids } }),
    settings: () => request('/api/notifications/settings'),
    setSettings: body => request('/api/notifications/settings', { method: 'PUT', body }),
  },

  /**
   * Stage 7, staff side. Nothing here is reachable by a student: the routes answer
   * the same 404 the rest of the unknown API paths give, so a page that only knows
   * it is a staff page because the server said so cannot be talked into showing
   * anything. `photoUrl` is the one face door that is not a student's consent, which
   * is why it is `no-store` and why opening it is a press rather than a re-render.
   */
  staff: {
    queue: (status = 'open') => request(`/api/staff/reports?status=${encodeURIComponent(status)}`),
    account: userId => request(`/api/staff/accounts/${userId}`),
    setStudent: (userId, body) => request(`/api/staff/accounts/${userId}/student`, { method: 'POST', body }),
    stats: () => request('/api/staff/stats'),
    decide: (id, body) => request(`/api/staff/reports/${id}/decide`, { method: 'POST', body }),
    setStatus: (userId, body) => request(`/api/staff/accounts/${userId}/status`, { method: 'POST', body }),
    photoUrl: userId => `/api/staff/accounts/${userId}/photo`,
    /**
     * NFR-SCALE-1, the staff half. `institutions` is the whole collection including
     * the switched-off rows — the toggle that brings one back has to be reachable —
     * which is a longer list than `/api/meta` hands a student.
     */
    institutions: () => request('/api/staff/institutions'),
    createInstitution: body => request('/api/staff/institutions', { method: 'POST', body }),
    updateInstitution: (id, body) => request(`/api/staff/institutions/${id}`, { method: 'PUT', body }),
    institutionRequests: () => request('/api/staff/institution-requests'),
  },
};
