'use strict';
/**
 * The database connection. One module owns it, so every caller reconnects the
 * same way and /api/health reports the same truth the routes see.
 */

const mongoose = require('mongoose');
const { config } = require('./config');

let lastError = null;

async function connect() {
  mongoose.set('strictQuery', true);
  try {
    await mongoose.connect(config.mongoUrl, {
      // Longer than it looks. A hosted database behind `mongodb+srv://` resolves
      // SRV records to find the replica set and then handshakes TLS with each
      // member before the first query — a few seconds of work that a local
      // container never asks for. Refusing to boot in four seconds on a server
      // whose DNS is warm is not a health check, it is a false alarm.
      serverSelectionTimeoutMS: 10000,
    });
    lastError = null;
    return mongoose.connection;
  } catch (err) {
    lastError = err.message;
    throw err;
  }
}

function state() {
  // 0 disconnected, 1 connected, 2 connecting, 3 disconnecting
  const ready = mongoose.connection.readyState === 1;
  return { ready, lastError };
}

/**
 * Where MONGO_URL points, and whether that is this machine. The startup loop uses
 * it to decide which sentence to print: asking "is the container running?" about a
 * hosted database sends someone to check the one thing that is not the problem.
 *
 * The credentials are cut off before the host is read, so no part of a password can
 * end up in a message that is written to a log.
 */
function databaseHost() {
  const url = config.mongoUrl || '';
  const afterAuth = url.slice(url.lastIndexOf('@') + 1).replace(/^[^:]+:\/\//, '');
  const host = (afterAuth.split('/')[0].split(',')[0] || '').replace(/:\d+$/, '');
  // Loopback, or a name with no dot in it — which is how a service on a compose
  // network addresses its own database (`mongo`), and no hosted provider hands out
  // an address that cannot be looked up on the public internet.
  const local = /^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0|\[::1\])$/.test(host) || (host !== '' && !host.includes('.'));
  return { host, local };
}

/**
 * Created at startup rather than left to Mongoose's autoIndex, because two of
 * these are load-bearing rather than a performance detail: `email` unique is
 * what stops one address holding two accounts, and the TTL on
 * `sessions.expiresAt` is what removes a dead session even if its owner never
 * comes back to trigger a lookup.
 */
async function ensureIndexes() {
  const models = require('./models');

  // One row per pair is now enforced by a scalar `pair` key rather than by the
  // `users` array, which a unique index cannot mean. A database that already holds
  // threads has rows without that field, and a unique index over a field every row
  // is missing fails to build — so they are stamped first. This matches nothing
  // once it has run.
  const unkeyed = await models.Match.find({ pair: { $exists: false } }, 'users');
  for (const row of unkeyed) {
    await models.Match.updateOne(
      { _id: row._id },
      { $set: { pair: models.Match.pairValue(row.users[0], row.users[1]) } }
    );
  }
  if (unkeyed.length) console.log(`[db] stamped a pair key on ${unkeyed.length} thread(s) written before it existed`);

  const created = [];
  for (const model of Object.values(models)) {
    await model.syncIndexes();
    created.push(model.modelName);
  }
  return created;
}

async function disconnect() {
  await mongoose.disconnect();
}

module.exports = { connect, state, disconnect, ensureIndexes, databaseHost };
