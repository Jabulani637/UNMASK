'use strict';
const API = 'C:/Users/hp/Desktop/UNMASK/api';
process.loadEnvFile('C:/Users/hp/Desktop/UNMASK/.env');
(async () => {
  const db = require(`${API}/src/db`);
  await db.connect();
  const User = require(`${API}/src/models/User`);
  const Profile = require(`${API}/src/models/Profile`);
  const users = await User.find({}, 'email verifiedAt createdAt');
  const profiles = await Profile.find({}, 'userId faculty year updatedAt');
  const ids = new Set(users.map(u => String(u.id)));
  const withProfile = new Set(profiles.map(p => String(p.userId)));
  console.log('orphan profiles (no account):');
  for (const p of profiles.filter(x => !ids.has(String(x.userId)))) console.log('  ', p.id, p.faculty, p.year, p.updatedAt);
  console.log('accounts with no profile:', users.filter(u => !withProfile.has(String(u.id))).map(u => u.email).join(', ') || 'none');
  console.log('all accounts:');
  for (const u of users) console.log('  ', u.email, u.verifiedAt ? 'verified' : 'UNVERIFIED', String(u.createdAt).slice(0,15));
  await db.disconnect();
})().catch(e => { console.error('FAILED', e.message); process.exit(1); });
