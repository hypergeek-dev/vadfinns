import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FoodStore } from './store.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');
const MAX_UPLOAD = 12 * 1024 * 1024;
const SESSION_AGE = 12 * 60 * 60 * 1000;

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2));
}

function createSessionTools(secret) {
  const sign = (value) => createHmac('sha256', secret).update(value).digest('base64url');
  return {
    make() {
      const payload = Buffer.from(JSON.stringify({ expires: Date.now() + SESSION_AGE, csrf: randomBytes(24).toString('base64url') })).toString('base64url');
      return { cookie: `${payload}.${sign(payload)}`, data: JSON.parse(Buffer.from(payload, 'base64url').toString()) };
    },
    read(cookie) {
      if (!cookie) return null;
      const [payload, signature] = cookie.split('.');
      if (!payload || !signature || !secureEqual(sign(payload), signature)) return null;
      try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        return data.expires > Date.now() ? data : null;
      } catch {
        return null;
      }
    }
  };
}

export async function createApp(options = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? (production ? '' : 'vadfinns-dev');
  const sessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET ?? (production ? '' : 'lokal-utveckling-vad-finns-session-hemlighet');
  if (production && (adminPassword.length < 12 || sessionSecret.length < 32)) {
    throw new Error('ADMIN_PASSWORD (minst 12 tecken) och SESSION_SECRET (minst 32 tecken) krävs i produktion.');
  }

  const store = options.store || await new FoodStore({
    rootDir: options.dataDir || path.join(projectRoot, 'data'),
    seedDir: options.seedDir || path.join(projectRoot, 'assets')
  }).init();
  const sessions = createSessionTools(sessionSecret);
  const attempts = new Map();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD, files: 1 },
    fileFilter(_req, file, callback) {
      callback(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype));
    }
  });
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  function sessionFor(req) {
    return sessions.read(parseCookies(req.headers.cookie).vad_session);
  }
  function requireAdmin(req, res, next) {
    const session = sessionFor(req);
    if (!session) return res.status(401).json({ error: 'Du behöver logga in som administratör.' });
    req.adminSession = session;
    next();
  }
  function requireCsrf(req, res, next) {
    if (!secureEqual(req.adminSession.csrf, req.get('x-csrf-token') || '')) return res.status(403).json({ error: 'Sessionen kunde inte verifieras. Ladda om sidan.' });
    next();
  }

  app.get('/api/foods', (req, res) => res.json({ foods: store.list({ availableOnly: req.query.available === 'true' }) }));
  app.post('/api/admin/login', (req, res) => {
    const key = req.ip;
    const record = attempts.get(key) || { count: 0, reset: Date.now() + 10 * 60 * 1000 };
    if (record.reset < Date.now()) Object.assign(record, { count: 0, reset: Date.now() + 10 * 60 * 1000 });
    if (record.count >= 8) return res.status(429).json({ error: 'För många försök. Vänta en stund och försök igen.' });
    if (!secureEqual(req.body?.password || '', adminPassword)) {
      record.count += 1;
      attempts.set(key, record);
      return res.status(401).json({ error: 'Fel lösenord.' });
    }
    attempts.delete(key);
    const session = sessions.make();
    res.cookie('vad_session', session.cookie, { httpOnly: true, sameSite: 'strict', secure: production, maxAge: SESSION_AGE, path: '/' });
    res.json({ authenticated: true, csrfToken: session.data.csrf });
  });
  app.get('/api/admin/session', (req, res) => {
    const session = sessionFor(req);
    res.status(session ? 200 : 401).json(session ? { authenticated: true, csrfToken: session.csrf } : { authenticated: false });
  });
  app.post('/api/admin/logout', requireAdmin, requireCsrf, (_req, res) => {
    res.clearCookie('vad_session', { path: '/' });
    res.status(204).end();
  });
  app.patch('/api/admin/foods/:id', requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      const food = await store.update(req.params.id, { available: req.body?.available, name: req.body?.name });
      if (!food) return res.status(404).json({ error: 'Maten hittades inte.' });
      res.json({ food });
    } catch (error) { next(error); }
  });
  app.post('/api/admin/foods/:id/move', requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      if (!['up', 'down'].includes(req.body?.direction)) return res.status(400).json({ error: 'Ogiltig riktning.' });
      const food = await store.move(req.params.id, req.body.direction);
      if (!food) return res.status(404).json({ error: 'Maten hittades inte.' });
      res.json({ food });
    } catch (error) { next(error); }
  });
  app.post('/api/admin/foods', requireAdmin, requireCsrf, upload.single('image'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Välj en JPG-, PNG- eller WebP-bild.' });
      const food = await store.addImage({ buffer: req.file.buffer, name: req.body.name || foodNameFromUpload(req.file.originalname) });
      res.status(201).json({ food });
    } catch (error) { next(error); }
  });
  app.post('/api/admin/foods/:id/image', requireAdmin, requireCsrf, upload.single('image'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Välj en JPG-, PNG- eller WebP-bild.' });
      const food = await store.replaceImage(req.params.id, req.file.buffer);
      if (!food) return res.status(404).json({ error: 'Maten hittades inte.' });
      res.json({ food });
    } catch (error) { next(error); }
  });
  app.delete('/api/admin/foods/:id', requireAdmin, requireCsrf, async (req, res, next) => {
    try {
      if (!await store.remove(req.params.id)) return res.status(404).json({ error: 'Maten hittades inte.' });
      res.status(204).end();
    } catch (error) { next(error); }
  });

  app.use('/media', express.static(store.mediaDir, { immutable: true, maxAge: '30d', fallthrough: false }));
  app.use(express.static(path.join(projectRoot, 'public'), { extensions: ['html'] }));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(projectRoot, 'public', 'index.html')));
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Bilden är större än 12 MB.' : 'Bilden kunde inte laddas upp.' });
    if (error.name === 'InputBufferContainsUnsupportedImageFormat') return res.status(400).json({ error: 'Bildformatet stöds inte.' });
    if (!error.status) console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Något gick fel på servern.' });
  });
  return { app, store };
}

function foodNameFromUpload(filename) {
  return path.basename(filename, path.extname(filename)).replace(/[-_]+/g, ' ').trim().slice(0, 80) || 'Namnlös mat';
}
