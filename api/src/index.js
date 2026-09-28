'use strict';
/**
 * Process entry point: validate configuration, connect to Mongo, then listen.
 *
 * A missing .env or an unsigned session is a stop-the-startup problem — an API
 * with no institution to verify a student against should not come up quietly.
 * A database that is not answering yet is not: the container may still be
 * booting, so this retries and lets /api/health report the delay.
 */

const { config, configProblems } = require('./config');
const db = require('./db');
const institutions = require('./services/institutions');
const { buildApp } = require('./app');
const { attachChatServer } = require('./realtime');

const RETRY_MS = 3000;

function logProblems() {
  const problems = configProblems();
  if (problems.length === 0) return true;

  console.error('\nUnmask API cannot start:');
  for (const problem of problems) console.error(`  - ${problem}`);
  // A host that deploys from git has no file here to edit, and telling it to open
  // one costs a round trip through the dashboard to discover that.
  console.error(
    config.envFileFound
      ? '\nEdit UNMASK\\.env (copy it from UNMASK\\.env.example), then run: npm run dev\n'
      : `\nNo .env was found at ${config.envFile}, so these came from the environment: fix them there — on Render, Railway or Fly that is the service's Environment Variables tab, and the change needs a new deploy to be read.\n`
  );
  return false;
}

async function connectWithRetry(attempt = 1) {
  try {
    await db.connect();
  } catch (err) {
    const isUp = attempt > 1;
    console.error(
      `• Database not reachable${isUp ? '' : ' yet'} (attempt ${attempt}): ${err.message}`
    );
    const host = db.databaseHost();
    if (host.local) {
      console.error('  Is the container running?  docker compose up -d   (from UNMASK\\)');
    } else if (/querySrv|SRV/i.test(err.message)) {
      // Measured on a laptop whose router refuses Node's DNS queries: this fails
      // before the provider has been asked anything at all, so pointing at its
      // allow list would send someone to the one place the problem is not.
      console.error(
        `  "${host.host}" was never resolved — this machine's DNS server refused the SRV query, so nothing about the database or its allow list has been checked yet.`
      );
      console.error('  Either give this adapter a resolver that answers (1.1.1.1 is the usual choice), or use the connection string Atlas prints when its DNS SRV option is switched off.');
    } else {
      console.error(`  Nothing on this machine serves "${host.host}", so check the provider: is this address on its access allow list, and has the database finished starting?`);
    }
    console.error(`  /api/health will report "degraded" until it is. Retrying in ${RETRY_MS / 1000}s.`);
    await new Promise(resolve => setTimeout(resolve, RETRY_MS));
    return connectWithRetry(attempt + 1);
  }

  // The unique email index is what makes "one address, one account" true, and the
  // session TTL is what removes a dead cookie's row. Both are created here, in
  // front of you, rather than as a side effect of the first query that needed them.
  try {
    const names = await db.ensureIndexes();
    console.log(`• Database connected. Indexes ready for: ${names.join(', ')}.`);
  } catch (err) {
    console.error(`• Database connected, but indexes could not be created: ${err.message}`);
    console.error('  Registration may allow a duplicate address until this is fixed.');
  }

  await ensureInstitutions();
}

/**
 * Put the pilot institutions into an empty collection, and say what is there.
 *
 * A first deployment cannot be bootstrapped from the /staff screen, because
 * nobody can sign in to it until an account exists and no account can be made
 * until an institution does — so the starting list is written on the way up. It is
 * `$setOnInsert` only: an institution a staff member has since edited, or switched
 * off, stays exactly as they left it across a restart, which is the difference
 * between a starting point and a reset button.
 *
 * Zero active institutions is reported, not fatal. It is a state a staff member can
 * walk into on purpose, the site's answer to it is "we cannot verify you yet", and
 * /api/health has called itself degraded since the day it learned to count.
 */
async function ensureInstitutions() {
  try {
    const { created, present } = await institutions.ensurePilot();
    const active = await institutions.activeList();
    if (created) {
      console.log(`• Institutions: ${created} added to the collection (${active.map(row => row.shortName).join(', ')}).`);
    }
    if (!active.length) {
      console.error('• No active institution in this database. Nobody can register until one is added at /staff.');
      console.error('  /api/health reports "degraded" until then.');
      return;
    }
    console.log(
      `• ${active.length} active institution(s), ${present} already in place: ${active.map(row => row.shortName).join(', ')}.`
    );
  } catch (err) {
    console.error(`• Institutions could not be checked: ${err.message}`);
    console.error('  Registration will refuse every address until this is fixed.');
  }
}

async function main() {
  if (!logProblems()) process.exit(1);

  const app = buildApp();
  const server = app.listen(config.port, () => {
    console.log(`Unmask API listening on http://localhost:${config.port}`);
    console.log(`  health    http://localhost:${config.port}/api/health`);
    console.log(`  chat      ws://localhost:${config.port}/ws  (same session cookie)`);
    console.log(`  web origin(s) allowed: ${config.webOrigins.join(', ')}`);
    console.log(
      config.serveWeb
        ? `  site      http://localhost:${config.port}  (serving ${config.webDist})`
        : `  site      not served by this process — set SERVE_WEB=1 after \`npm run build\`, or run the web app separately`
    );
    console.log(
      `  email     ${
        config.mail.apiKey
          ? `via ${config.mail.apiUrl} (HTTPS; SMTP is blocked on some hosts, including Render's free tier)`
          : config.smtp.host
            ? `via ${config.smtp.host}`
            : 'no SMTP host and no BREVO_API_KEY — confirmation codes are written to api/outbox/ instead'
      }`
    );
  });

  // One process, one session implementation: chat shares this HTTP server rather
  // than running as a second service that has to agree with this one about who is
  // signed in.
  const chatServer = attachChatServer(server);

  connectWithRetry().catch(err => {
    console.error('Database connection loop failed:', err);
  });

  const shutdown = signal => {
    console.log(`\n${signal} received — closing.`);
    chatServer.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main();
}

module.exports = { main };
