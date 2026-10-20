import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { compareRequest } from './analysis.js';
import { AppError, loadConfig, validateProposal } from './validation.js';
import { openStore, publicProposal, validToken } from './store.js';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const sessionDuration = 8 * 60 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest();

export function createApp(config, { fetchApi = fetch, now = Date.now, store = openStore() } = {}) {
  const app = express();
  const sessions = new Map();
  const limits = new Map();
  const ownerHash = hash(config.ownerKey);
  const secure = config.appUrl.protocol === 'https:';
  const cookieName = secure ? '__Host-scopeshield' : 'scopeshield';
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure, path: '/' };
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
  const requireOwner = (req, res, next) => {
    const key = sessionKey(req);
    const expires = key && sessions.get(key);
    if (!expires || expires <= now()) {
      if (key) sessions.delete(key);
      return next(new AppError(401, 'Please log in to the freelancer workspace.'));
    }
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

  app.post('/api/login', throttle('login', 10, 15 * 60 * 1000), (req, res, next) => {
    const key = req.body?.key;
    if (typeof key !== 'string' || key.length > 512 || !timingSafeEqual(hash(key), ownerHash)) {
      return next(new AppError(401, 'Invalid owner access key.'));
    }
    for (const [id, expires] of sessions) if (expires <= now()) sessions.delete(id);
    const previous = sessionKey(req);
    if (previous) sessions.delete(previous);
    if (sessions.size >= 1024) return next(new AppError(429, 'Too many sessions. Try again later.'));
    const token = randomBytes(32).toString('hex');
    sessions.set(hash(token).toString('hex'), now() + sessionDuration);
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionDuration }).json({ ok: true });
  });
  app.get('/api/session', requireOwner, (req, res) => res.json({ ok: true }));
  app.post('/api/logout', (req, res) => {
    const key = sessionKey(req);
    if (key) sessions.delete(key);
    res.clearCookie(cookieName, cookieOptions).json({ ok: true });
  });
  app.post('/api/analyze', requireOwner, throttle('analysis', 30, 60 * 60 * 1000), async (req, res) => {
    const result = await compareRequest(req.body || {}, config, fetchApi);
    // An expired/revoked session must not release a comparison after a long provider call.
    if ((sessions.get(sessionKey(req)) || 0) <= now()) throw new AppError(401, 'Session ended. Please log in again.');
    res.json(result);
  });

  app.get('/api/proposals', requireOwner, (req, res) => {
    res.json(store.list().map(row => ({ ...publicProposal(row), token: row.token })));
  });
  app.post('/api/proposals', requireOwner, throttle('publish', 30, 60 * 60 * 1000), (req, res) => {
    const row = store.create(validateProposal(req.body));
    res.status(201).json({ ...publicProposal(row), token: row.token });
  });
  app.get('/api/proposals/:token', (req, res) => {
    const row = store.get(req.params.token);
    if (!row) throw new AppError(404, 'Proposal unavailable. Check the link with your freelancer.');
    res.json(publicProposal(row));
  });
  app.get('/p/:token', (req, res) => {
    if (!validToken(req.params.token) || !store.get(req.params.token)) {
      return res.status(404).sendFile('proposal.html', { root: publicDirectory });
    }
    res.sendFile('proposal.html', { root: publicDirectory });
  });

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
