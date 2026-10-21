import { openStore } from '../src/store.js';

const [email, confirm] = process.argv.slice(2);
if (!email || confirm !== '--confirm') {
  console.error('Usage: node scripts/assign-legacy.js account@example.com --confirm');
  process.exitCode = 1;
} else {
  const store = openStore();
  try {
    const user = store.userByEmail(email.trim().toLowerCase());
    if (!user) throw new Error('Create this account in ScopeShield first. No records changed.');
    console.log(`Assigned ${store.assignLegacy(user.id)} previously unassigned proposal records.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { store.close(); }
}
