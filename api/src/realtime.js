'use strict';
/**
 * The live half of chat: a WebSocket that carries messages the moment the other
 * student presses send. FR-4.2.
 *
 * **It rides on the HTTP server the API already has.** The architecture note in
 * PLAN\DOCUMENT asked for a separate Python chat service; the stack decision for
 * this build was to run chat inside the Node API instead. That removes a second
 * process, a second session implementation, and an entire class of bug where the
 * two services disagree about who is signed in — the cookie the browser already
 * sends is the only credential here.
 *
 * **Authentication happens on the upgrade, before a socket exists.** The session
 * cookie is read off the handshake header and resolved through the same
 * services/sessions.js the REST routes use. A rejection is a plain HTTP status on
 * the handshake, so an unauthenticated client never gets a connection to talk on.
 * No token goes in the URL: a query string is logged by proxies and sits in
 * browser history, which is where a 30-day credential does not belong.
 *
 * **Every frame is built for the reader.** `chat.toWire()` is called once per
 * recipient, so the payload that reaches a student says `'me'` about their own
 * messages and `'them'` about the other person's. There is no account id, no
 * email and no profile id anywhere on this socket — which is the point of the
 * whole product (FR-2.3, NFR-3.3).
 *
 * There is deliberately no typing indicator, no "seen" marker and no presence
 * list. Each of those is a timestamp about a specific person's behaviour, and
 * NFR-3.3 bans identity that is inferable from metadata.
 */

const { WebSocketServer } = require('ws');

const chat = require('./services/chat');
const notifications = require('./services/notifications');
const sessions = require('./services/sessions');
const { config } = require('./config');

const PATH = '/ws';
const HEARTBEAT_MS = 30 * 1000;
/** Enough for a 1000-character message and the JSON around it, nothing more. */
const MAX_PAYLOAD = 16 * 1024;
/** Frames per connection per window; a client that exceeds it is not a browser. */
const FRAMES_PER_WINDOW = 60;
const FRAME_WINDOW_MS = 10 * 1000;

// userId -> Set<ws>. One student can have two tabs open, so it is a set.
const clients = new Map();

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (name === sessions.cookieName) {
      try {
        out[name] = decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        out[name] = part.slice(eq + 1).trim();
      }
    }
  }
  return out;
}

/**
 * The page that opened this socket has to be one of ours. A cross-origin
 * WebSocket would let any site with a link on it read a signed-in student's
 * conversations, because the browser sends the session cookie either way.
 */
function originAllowed(header) {
  // A non-browser client sends no Origin. It still needs a live session cookie,
  // and there is no page for it to be a page from.
  if (!header) return true;
  return config.webOrigins.includes(header);
}

function track(userId, socket) {
  // Stringified on purpose: an account id arrives as a BSON ObjectId from the
  // session and as a plain string from a query, and a Map that keys on objects
  // would file the socket where no lookup would ever find it.
  const key = String(userId);
  let set = clients.get(key);
  if (!set) {
    set = new Set();
    clients.set(key, set);
  }
  set.add(socket);
  // FR-7.2's "which thread is this tab showing" — per socket, in memory, never sent
  // anywhere. See isViewing().
  socket.viewing = new Set();
  socket.unsub = () => {
    set.delete(socket);
    if (set.size === 0) clients.delete(key);
  };
}

/**
 * Which thread this tab is showing, as far as it says it is.
 *
 * FR-7.2 is about a student who is *not looking at that conversation*, and an open
 * socket does not tell you that — a tab sitting on the chat list is connected and
 * is not watching anything. So the chat screen names the thread it has on screen,
 * and names nothing when it leaves one.
 *
 * This lives on the socket and nowhere else. It is never written to a document, and
 * it is never sent to the other student: the only thing it can change is whether
 * *you* get told about *your* inbox. That is the line NFR-3.3 draws — a read cursor
 * that leaves the server is a timestamp about one person's behaviour, and a read
 * cursor that stays here is a switch on a notice the reader asked for.
 *
 * A client can lie about it, and nothing follows: the worst it can do is silence its
 * own notification.
 */
function isViewing(userId, threadId) {
  const set = clients.get(String(userId));
  if (!set || !threadId) return false;
  const wanted = String(threadId);
  for (const socket of set) {
    if (socket.viewing && socket.viewing.has(wanted)) return true;
  }
  return false;
}

function send(socket, frame) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

/**
 * Push a frame to every open tab of one student. Exported so the REST routes can
 * use the same door: a message sent over HTTP still has to appear on the other
 * student's screen, and a thread closed by a click still has to close.
 */
function publish(userId, frame) {
  const set = clients.get(String(userId));
  if (!set) return 0;
  for (const socket of set) send(socket, frame);
  return set.size;
}

/**
 * The one way a message reaches its reader: the frame, and then the notice if the
 * frame landed on a screen that was not looking at that thread. FR-7.2.
 *
 * Both send paths run through here — the WebSocket frame and the HTTP fallback the
 * routes use when a socket is down — because "were they watching?" and "should we
 * tell them?" are one decision, and two copies of it would disagree in the case that
 * matters: a student with two tabs open, one on the thread and one on the chat list.
 */
async function deliver(message, recipientId) {
  publish(recipientId, {
    type: 'message',
    threadId: String(message.matchId),
    message: chat.toWire(message, recipientId),
  });

  if (isViewing(recipientId, message.matchId)) return { notified: false, reason: 'viewing' };
  const sent = await notifications.notify({
    userId: recipientId,
    kind: 'message',
    threadId: message.matchId,
  });
  return { notified: sent.inApp || sent.email };
}

/**
 * FR-6.3 — a suspension has to reach the tab that is already open.
 *
 * Dropping a session stops the next request; it says nothing about a socket that is
 * already standing, and a student who has been paused should not be able to keep
 * writing into a conversation they no longer have an account in. So every socket for
 * that account is closed. The browser retries, the handshake finds no live session,
 * and the API answers 401 the way it answers every other dead cookie.
 *
 * The frame is a courtesy, not a gate: the client could ignore it, and nothing would
 * follow, because the close and the revoked session are the enforcement.
 */
function disconnect(userId) {
  const set = clients.get(String(userId));
  if (!set) return 0;
  for (const socket of [...set]) {
    send(socket, { type: 'signed-out' });
    socket.close(1008, 'Signed out');
  }
  return set.size;
}

/** Both halves of a thread learn that it is closed — and not who closed it. */
function announceClosed(match) {
  const frame = { type: 'closed', threadId: String(match._id) };
  // The pair's two ids cover the student who pressed the button as well, so one
  // loop sends everyone exactly one frame.
  for (const id of match.users) publish(id, frame);
  return frame;
}

/**
 * FR-5.1 to FR-5.5: a reveal request, an answer, a cancellation, or the moment
 * both said yes — pushed, so neither student has to reload to find out.
 *
 * The frame carries one word and nothing else. A reveal is the one place this
 * product does hold a name, and the socket that exists before the consent is not
 * where it travels: a screen that learns "asked" goes and asks the API for the
 * state, over the route that has already checked who is calling.
 *
 * These frames are written by the REST routes only. There is deliberately no
 * `type: 'ask'` a client can send here, because the rule behind a reveal (three
 * of your own messages, both halves' consent, one pair check) belongs in one
 * place, and a second door would be a second copy of it.
 *
 * Two of the four events are also FR-7.3's notifications, and they are the two that
 * answer something a person did: somebody asked, or you both said yes. A declined
 * request and a cancelled one stay silent — the requirement names only those two
 * moments, and a bell that rings when someone turns you down is a worse thing to put
 * in a student's inbox than the small convenience of it.
 */
const REVEAL_NOTICE = {
  asked: 'reveal-request',
  revealed: 'reveal-done',
};

async function announceReveal(threadId, event, recipients) {
  const frame = { type: 'reveal', threadId, event };
  for (const id of recipients) publish(id, frame);

  const kind = REVEAL_NOTICE[event];
  if (kind) {
    for (const id of recipients) {
      try {
        await notifications.notify({ userId: id, kind, threadId });
      } catch (err) {
        console.error(`[reveal] the frame went out and the notice did not: ${err.message}`);
      }
    }
  }
  return frame;
}

async function handleFrame(userId, socket, raw) {
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    return send(socket, { type: 'error', code: 'bad_frame', error: 'That was not something I could read.' });
  }
  if (!frame || typeof frame !== 'object') {
    return send(socket, { type: 'error', code: 'bad_frame', error: 'That was not something I could read.' });
  }

  if (frame.type === 'send') {
    try {
      const { message, recipientId } = await chat.send({ userId, matchId: frame.matchId, body: frame.body });
      // The writer gets the stored copy back, with its real id and timestamp, so
      // the screen can put the bubble in the place the other student will see it.
      // Their tempId rides along: it is the only thing that says which waiting
      // bubble this row replaces, and without it the screen shows the message twice.
      send(socket, {
        type: 'message',
        threadId: String(message.matchId),
        message: chat.toWire(message, userId),
        tempId: frame.tempId,
      });
      await deliver(message, recipientId);
    } catch (err) {
      const ours = err.name === 'UserError';
      send(socket, {
        type: 'error',
        code: ours ? err.code : 'send_failed',
        error: ours ? err.message : 'That message could not be sent.',
        retryAfterSeconds: ours ? err.retryAfterSeconds || null : null,
        tempId: frame.tempId,
      });
    }
    return;
  }

  if (frame.type === 'view') {
    // The chat screen names the thread it has on screen, and names nothing when it
    // leaves one. An id that is not an id is ignored rather than believed: the only
    // thing it can affect is whether this tab's own student gets a notice.
    socket.viewing = socket.viewing || new Set();
    socket.viewing.clear();
    const threadId = String(frame.threadId || '');
    if (/^[0-9a-f]{24}$/.test(threadId)) socket.viewing.add(threadId);
    return;
  }

  if (frame.type === 'ping') {
    return send(socket, { type: 'pong' });
  }

  send(socket, { type: 'error', code: 'unknown_frame', error: 'I do not know that command.', tempId: frame.tempId });
}

function attachChatServer(server, { heartbeatMs = HEARTBEAT_MS } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (requestUrl.pathname !== PATH) {
      // Anything else on this port is not this server's business; Express would
      // never have seen it, so the handshake simply does not happen.
      socket.destroy();
      return;
    }

    const abort = (status, message) => {
      socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    if (!originAllowed(req.headers.origin)) return abort(403, 'Forbidden origin');

    const cookies = parseCookies(req.headers.cookie);
    sessions
      .resolve(cookies[sessions.cookieName])
      .then(resolved => {
        if (!resolved) return abort(401, 'Unauthorized');

        wss.handleUpgrade(req, socket, head, ws => {
          track(resolved.userId, ws);

          let frames = 0;
          let windowAt = Date.now();

          ws.on('message', (data, isBinary) => {
            if (isBinary) return;
            const now = Date.now();
            if (now - windowAt > FRAME_WINDOW_MS) {
              windowAt = now;
              frames = 0;
            }
            frames += 1;
            if (frames > FRAMES_PER_WINDOW) {
              // A browser cannot type sixty messages in ten seconds. This is the
              // same NFR-2.4 concern the per-account message budget answers, one
              // layer down: it stops a flooded socket from becoming sixty
              // database writes.
              return ws.close(1008, 'Too quickly');
            }
            handleFrame(String(resolved.userId), ws, data.toString('utf8')).catch(err => {
              // handleFrame reports its own expected failures as frames. Getting here
              // means something unexpected happened (a database blip mid-write), and
              // an unhandled rejection would take the process down with every other
              // student's socket on it. The socket stays open; the client's own
              // request either succeeded or will be retried.
              console.error(`[ws] a frame could not be handled: ${err.message}`);
            });
          });

          ws.on('close', () => ws.unsub && ws.unsub());
          ws.on('error', () => ws.unsub && ws.unsub());

          // `noServer` mode hands the socket to us, and ws then never emits
          // 'connection' on its own — emitting it here is the documented pattern.
          // Without it the heartbeat below never learns the socket exists, and its
          // first tick treats a healthy tab as dead and terminates it.
          wss.emit('connection', ws, req);

          send(ws, { type: 'connected' });
        });
      })
      .catch(() => abort(503, 'Session store unavailable'));

    return undefined;
  });

  // A tab that went away without closing (a laptop lid) would otherwise hold a
  // phantom socket, and its student's next message would be written into the
  // void. An unanswered pong means the socket is dead.
  const alive = new WeakSet();
  const ticker = setInterval(() => {
    for (const set of clients.values()) {
      for (const ws of set) {
        if (!alive.has(ws)) {
          try {
            ws.terminate();
          } catch {
            /* already gone */
          }
          ws.unsub && ws.unsub();
          continue;
        }
        alive.delete(ws);
        try {
          ws.ping();
        } catch {
          /* the close handler will clean it up */
        }
      }
    }
  }, heartbeatMs);

  wss.on('connection', ws => {
    ws.on('pong', () => alive.add(ws));
    alive.add(ws);
  });
  ticker.unref();

  return { wss, close: () => clearInterval(ticker) };
}

module.exports = {
  attachChatServer,
  publish,
  deliver,
  isViewing,
  disconnect,
  announceClosed,
  announceReveal,
  PATH,
  _internal: { clients, parseCookies, originAllowed },
};
