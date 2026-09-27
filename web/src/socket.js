/**
 * The one chat socket this page keeps open.
 *
 * Shared rather than per-screen on purpose. A `useEffect` in each of the chat
 * pages would open its own connection, and two tabs of the same student would
 * then hold four sockets, each with its own idea of what has been delivered. One
 * module, one socket, many listeners — and the listeners only ever see frames
 * addressed to a thread they are already looking at.
 *
 * There is no token in the URL. The browser puts the session cookie on the
 * handshake itself, which is why this connects to `/ws` on the same origin the
 * API is already on: a query-string credential would end up in proxy logs and
 * browser history, and a 30-day session does not belong in either.
 */

const SUBSCRIBERS = new Set();

let socket = null;
let retryMs = 1000;
let timer = null;
let stopped = true;
// Which thread is on screen. FR-7.2: the server uses this to decide whether a new
// message in it is news, and a reconnect re-declares it (see tellViewing()).
let viewing = null;

function url() {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/ws`;
}

function emit(frame) {
  for (const handler of SUBSCRIBERS) {
    try {
      handler(frame);
    } catch {
      // A broken listener must not take the socket down with it: the other
      // subscriber still has a conversation to render.
    }
  }
}

function schedule() {
  if (stopped || timer) return;
  timer = setTimeout(() => {
    timer = null;
    open();
  }, retryMs);
  // 1s, 2s, 4s… up to 15s. A laptop that slept through a class should reconnect
  // on its own when it wakes, without hammering a restarting API in between.
  retryMs = Math.min(retryMs * 2, 15000);
}

function tellViewing() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'view', threadId: viewing }));
}

function open() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;

  const ws = new WebSocket(url());
  socket = ws;

  ws.onopen = () => {
    retryMs = 1000;
    // A fresh socket on the server knows nothing about this screen.
    tellViewing();
    emit({ type: 'socket-open' });
  };

  ws.onmessage = event => {
    let frame = null;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (frame) emit(frame);
  };

  ws.onclose = () => {
    if (socket === ws) socket = null;
    emit({ type: 'socket-closed' });
    schedule();
  };

  ws.onerror = () => {
    // Always followed by onclose, which is where the retry lives.
  };
}

/**
 * Listen to every frame, and make sure a socket exists to hear them on.
 *
 * Returns the unsubscribe. A caller that forgets it is not a bug worth
 * protecting against here — the handler holds a `setState` for an unmounted
 * component, which React ignores, and the next screen subscribes again.
 */
export function subscribeChat(handler) {
  SUBSCRIBERS.add(handler);
  startChatSocket();
  return () => SUBSCRIBERS.delete(handler);
}

export function startChatSocket() {
  stopped = false;
  retryMs = 1000;
  open();
}

/** Called on sign-out: no reconnect, and the server drops the socket anyway. */
export function stopChatSocket() {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (socket) {
    const ws = socket;
    socket = null;
    ws.onclose = null;
    ws.close();
  }
}

/**
 * Send a frame. Returns false when the socket is not open, which is the caller's
 * cue to fall back to the REST route rather than to lose the message — a phone
 * on a lecture-hall connection is the normal case here, not the exception.
 */
export function sendChatFrame(frame) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

/**
 * Name the thread this screen is showing, or `null` for "I have left one".
 *
 * The server only ever uses this to decide whether to notify *this* student about
 * *their* inbox (FR-7.2). It is not a read receipt: nothing here is forwarded to the
 * other half of the conversation, and it does not survive the tab.
 */
export function watchThread(threadId) {
  const next = threadId ? String(threadId) : null;
  if (next === viewing) return;
  viewing = next;
  tellViewing();
}
