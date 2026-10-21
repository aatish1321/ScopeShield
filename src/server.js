import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { credentials, hashPassword, verifyPassword, publicUser } from './auth.js';
import { compareRequest } from './analysis.js';
import { AppError, loadConfig, validateProposal } from './validation.js';
import { openStore, publicProposal, validToken } from './store.js';
import { createPayments } from './paypal.js';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const sessionDuration = 8 * 60 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest();

export function createApp(config, { fetchApi = fetch, now = Date.now, store = openStore() } = {}) {
  const app = express();
  const sessions = new Map();
  const limits = new Map();
  const secure = config.appUrl.protocol === 'https:';
  const cookieName = secure ? '__Host-scopeshield' : 'scopeshield';
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure, path: '/' };
  const payments = createPayments(store, config, { fetchApi, now });
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    });
    if (secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    // Only the configured host is served, including on loopback, to resist DNS rebinding.
    if (req.headers.host !== config.appUrl.host) return next(new AppError(400, 'Unrecognized application host.'));
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (req.headers.origin !== config.appUrl.origin ||
          (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
        return next(new AppError(403, 'Request must come from this application.'));
      }
      if (!req.is('application/json')) return next(new AppError(415, 'Send application/json.'));
    }
    next();
  });
  app.use(express.json({ limit: '64kb', strict: true }));

  const sessionKey = req => {
    const token = req.headers.cookie?.split(';').map(value => value.trim())
      .find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return token && /^[a-f0-9]{64}$/.test(token) ? hash(token).toString('hex') : null;
  };
  const requireUser = (req, res, next) => {
    const key = sessionKey(req);
    const session = key && sessions.get(key);
    const user = session && session.expires > now() && store.userById(session.userId);
    if (!user) {
      if (key) sessions.delete(key);
      return next(new AppError(401, 'Please log in to the freelancer workspace.'));
    }
    req.user = user;
    next();
  };
  const throttle = (category, count, duration) => (req, res, next) => {
    const time = now();
    for (const [key, entry] of limits) if (entry.until <= time) limits.delete(key);
    const key = `${category}:${req.socket.remoteAddress}`;
    if (!limits.has(key) && limits.size >= 4096) return next(new AppError(429, 'Too many requests. Try again later.'));
    const entry = limits.get(key) || { count: 0, until: time + duration };
    limits.set(key, entry);
    if (++entry.count > count) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.until - time) / 1000))));
      return next(new AppError(429, 'Too many requests. Wait before trying again.'));
    }
    next();
  };

  function signIn(req, res, user, status = 200) {
    for (const [id, session] of sessions) if (session.expires <= now()) sessions.delete(id);
    const previous = sessionKey(req);
    if (previous) sessions.delete(previous);
    if (sessions.size >= 1024) throw new AppError(429, 'Too many sessions. Try again later.');
    const token = randomBytes(32).toString('hex');
    sessions.set(hash(token).toString('hex'), { userId: user.id, expires: now() + sessionDuration });
    res.status(status).cookie(cookieName, token, { ...cookieOptions, maxAge: sessionDuration }).json({ user: publicUser(user) });
  }
  app.post('/api/signup', throttle('signup', 5, 60 * 60 * 1000), async (req, res) => {
    const input = credentials(req.body, true);
    const passwordHash = await hashPassword(input.password);
    // Recheck after hashing so concurrent registrations cannot race the unique constraint.
    if (store.userByEmail(input.email)) throw new AppError(409, 'Unable to create this account. Try logging in or use another email.');
    const user = store.createUser({ ...input, passwordHash });
    signIn(req, res, user, 201);
  });
  app.post('/api/login', throttle('login', 10, 15 * 60 * 1000), async (req, res) => {
    const input = credentials(req.body);
    const user = store.userByEmail(input.email);
    if (!await verifyPassword(input.password, user?.password_hash)) throw new AppError(401, 'Email or password is incorrect.');
    signIn(req, res, user);
  });
  app.get('/api/session', requireUser, (req, res) => res.json({ user: publicUser(req.user), checkoutAvailable: payments.configured }));
  app.post('/api/logout', (req, res) => {
    const key = sessionKey(req);
    if (key) sessions.delete(key);
    res.clearCookie(cookieName, cookieOptions).json({ ok: true });
  });
  app.post('/api/analyze', requireUser, throttle('analysis', 30, 60 * 60 * 1000), async (req, res) => {
    const result = await compareRequest(req.body || {}, config, fetchApi);
    // An expired/revoked session must not release a comparison after a long provider call.
    if ((sessions.get(sessionKey(req))?.expires || 0) <= now()) throw new AppError(401, 'Session ended. Please log in again.');
    res.json(result);
  });

  app.get('/api/proposals', requireUser, (req, res) => {
    res.json(store.list(req.user.id).map(row => ({ ...publicProposal(row), token: row.token })));
  });
  app.post('/api/proposals', requireUser, throttle('publish', 30, 60 * 60 * 1000), (req, res) => {
    const row = store.create(validateProposal(req.body), req.user.id);
    res.status(201).json({ ...publicProposal(row), token: row.token });
  });
  app.post('/api/proposals/:token/delete', requireUser, (req, res) => {
    const row = store.get(req.params.token);
    if (!row || row.owner_id !== req.user.id) throw new AppError(404, 'Proposal unavailable.');
    payments.remove(req.params.token);
    res.json({ ok: true });
  });
  app.get('/api/proposals/:token', (req, res) => {
    const row = store.get(req.params.token);
    if (!row) throw new AppError(404, 'Proposal unavailable. Check the link with your freelancer.');
    res.json({ ...publicProposal(row), checkoutAvailable: payments.configured });
  });
  const paymentLimit = throttle('payments', 60, 5 * 60 * 1000);
  app.post('/api/proposals/:token/checkout', paymentLimit, async (req, res) => {
    res.json(await payments.checkout(req.params.token, req.body?.accepted));
  });
  app.post('/api/proposals/:token/capture', paymentLimit, async (req, res) => {
    res.json(await payments.capture(req.params.token));
  });
  app.post('/api/proposals/:token/status', paymentLimit, async (req, res) => {
    res.json(await payments.status(req.params.token));
  });
  app.get('/p/:token', (req, res) => {
    if (!validToken(req.params.token) || !store.get(req.params.token)) {
      return res.status(404).sendFile('proposal.html', { root: publicDirectory });
    }
    res.sendFile('proposal.html', { root: publicDirectory });
  });

  app.get('/app', (req, res, next) => {
    const session = sessions.get(sessionKey(req));
    if (!session || session.expires <= now()) return res.redirect('/login');
    res.sendFile('workspace.html', { root: publicDirectory });
  });
  app.get(['/login', '/signup'], (req, res) => res.sendFile('login.html', { root: publicDirectory }));

  app.use(express.static(publicDirectory, { dotfiles: 'deny', index: 'index.html', etag: false, cacheControl: false }));
  app.use((req, res, next) => next(new AppError(404, 'Page or endpoint not found.')));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error instanceof AppError ? error.status :
      error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
    const message = error instanceof AppError ? error.message :
      status === 413 ? 'Request is too large. Shorten the agreement or request.' :
      status === 400 ? 'Invalid JSON request.' : 'Unexpected server error. Please try again.';
    res.status(status).json({ error: message });
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.umask(0o077);
    const config = loadConfig();
    const store = openStore();
    const server = createApp(config, { store }).listen(config.port, '127.0.0.1', () => {
      console.log(`ScopeShield running at ${config.appUrl.origin}`);
    }).on('error', () => {
      store.close();
      console.error('Could not start ScopeShield. Check whether PORT is already in use.');
      process.exitCode = 1;
    });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => store.close()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
