'use strict';
/**
 * The database connection. One module owns it, so every caller reconnects the
 * same way and /api/health reports the same truth the routes see.
 */

const fs = require('fs');
const mongoose = require('mongoose');
const { config } = require('./config');

let lastError = null;

async function connect() {
  mongoose.set('strictQuery', true);
  try {
    await mongoose.connect(config.mongoUrl, {
      serverSelectionTimeoutMS: 4000,
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

/**
 * The photo directory has to exist before an upload can land in it, and the
 * health endpoint should say whether it truly is writable rather than assume.
 */
function photoStoreWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = { connect, state, disconnect, ensureIndexes, photoStoreWritable };
