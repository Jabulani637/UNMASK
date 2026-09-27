/* Removes the one probe account the rate limit stopped from deleting itself.
   Scoped to the exact address it writes — nothing else is even looked at. */
'use strict';

const API = 'C:/Users/hp/Desktop/UNMASK/api';
process.loadEnvFile('C:/Users/hp/Desktop/UNMASK/.env');

const PASSWORD = 'correct horse battery staple';
const TARGET = 'mi5-cput-1790464764053@mycput.ac.za';

(async () => {
  const { config } = require(`${API}/src/config`);
  const db = require(`${API}/src/db`);
  await db.connect();

  const User = require(`${API}/src/models/User`);
  const Profile = require(`${API}/src/models/Profile`);
  const auth = require(`${API}/src/services/auth`);

  const found = await User.findOne({ email: TARGET });
  if (!found) {
    console.log(`no row for ${TARGET} — nothing to do`);
  } else {
    const result = await auth.deleteAccount({ userId: found.id, password: PASSWORD, confirmText: 'DELETE' });
    console.log(`deleted ${TARGET}`, JSON.stringify(result.removed));
  }

  console.log(
    `after: users=${await User.countDocuments({})} profiles=${await Profile.countDocuments({})} ` +
      `mi5-rows-left=${await User.countDocuments({ email: /^mi5-/ })} ` +
      `institutions=${await require(`${API}/src/models/Institution`).countDocuments({})}`
  );
  await db.disconnect();
})().catch(err => {
  console.error('FAILED', err.message);
  process.exit(1);
});
