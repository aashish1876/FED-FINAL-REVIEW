import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getSheetStore } from './sheets.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.VERCEL ? 1 : false);
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

function createRateLimiter({ windowMs, maxRequests }) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maxRequests) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
    }
    if (buckets.size > 5000) {
      for (const [address, entry] of buckets) {
        if (entry.resetAt <= now) buckets.delete(address);
      }
    }
    next();
  };
}

const captchaRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 60 });
const loginRateLimit = createRateLimiter({ windowMs: 15 * 60_000, maxRequests: 20 });
const signupRateLimit = createRateLimiter({ windowMs: 60 * 60_000, maxRequests: 10 });
const feedbackReadRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 60 });
const feedbackWriteRateLimit = createRateLimiter({ windowMs: 10 * 60_000, maxRequests: 10 });
let weakAdminPasswordWarningLogged = false;

app.get('/api/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

const captchaAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createCaptchaImage(code) {
  const chars = [...code].map((char, index) => {
    const x = 24 + index * 31;
    const y = 38 + (index % 2 ? 5 : -2);
    const rotate = (index * 13 % 25) - 12;
    return `<text x="${x}" y="${y}" transform="rotate(${rotate} ${x} ${y})">${char}</text>`;
  }).join('');
  const lines = Array.from({ length: 7 }, (_, index) => {
    const x1 = (index * 37 + 9) % 180;
    const y1 = (index * 17 + 8) % 56;
    const x2 = (index * 61 + 31) % 180;
    const y2 = (index * 29 + 19) % 56;
    return `<path d="M${x1} ${y1} Q90 ${y2} ${x2} ${56 - y1}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="56" viewBox="0 0 180 56" role="img" aria-label="CAPTCHA characters"><rect width="180" height="56" rx="6" fill="#edf1ef"/><g fill="none" stroke="#98a8a5" stroke-width="1.2" opacity=".8">${lines}</g><g fill="#183446" font-family="monospace" font-size="29" font-weight="700" letter-spacing="2">${chars}</g></svg>`;
}

function captchaKey() {
  return createHash('sha256').update(jwtSecret()).digest();
}

function createCaptchaToken(answer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', captchaKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ answer, expiresAt: Date.now() + 5 * 60 * 1000 }), 'utf8'),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

function verifyCaptcha(token, answer) {
  if (typeof token !== 'string' || token.length > 1024 || typeof answer !== 'string') return false;
  const [ivPart, tagPart, encryptedPart] = token.split('.');
  if (!ivPart || !tagPart || !encryptedPart) return false;
  try {
    const decipher = createDecipheriv('aes-256-gcm', captchaKey(), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encryptedPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const challenge = JSON.parse(plaintext);
    if (challenge.expiresAt < Date.now()) return false;
    const expected = Buffer.from(String(challenge.answer || ''));
    const actual = Buffer.from(answer.trim().toUpperCase());
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function readSessionToken(req) {
  const cookie = (req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith('feedback_session='));
  return cookie ? cookie.slice('feedback_session='.length) : '';
}

function setSessionCookie(res, token) {
  res.cookie('feedback_session', token, {
    httpOnly: true,
    secure: Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie('feedback_session', {
    httpOnly: true,
    secure: Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api',
  });
}

app.get('/api/captcha', captchaRateLimit, (req, res) => {
  const answer = Array.from({ length: 5 }, () => captchaAlphabet[randomBytes(1)[0] % captchaAlphabet.length]).join('');
  res.set('Cache-Control', 'no-store');
  res.json({ id: createCaptchaToken(answer), image: createCaptchaImage(answer) });
});

function sendError(res, error) {
  const status = error.expose ? error.status : 503;
  if (status >= 500) console.error('API request failed', { status, name: error.name, code: error.code });
  res.status(status).json({ error: error.expose ? error.message : 'The service is temporarily unavailable. Please try again later.' });
}

function jwtSecret() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    const error = new Error('JWT_SECRET must contain at least 32 characters.');
    error.status = 503;
    throw error;
  }
  return process.env.JWT_SECRET;
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

async function getUserByEmail(store, email) {
  const users = await store.list('Users');
  return users.find(({ record }) => record.email.toLowerCase() === email.toLowerCase());
}

async function ensureAdmin(store) {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error('Set ADMIN_EMAIL to a valid administrator email before using the API.');
    error.status = 503;
    throw error;
  }
  const existing = await getUserByEmail(store, email);
  if (existing?.record.role === 'admin') {
    const existingHash = typeof existing.record.passwordHash === 'string' ? existing.record.passwordHash : '';
    if (password && password.length >= 12 && (!existingHash || !(await bcrypt.compare(password, existingHash)))) {
      await store.update('Users', existing.rowNumber, {
        ...existing.record,
        passwordHash: await bcrypt.hash(password, 12),
      });
    } else if ((!password || password.length < 12) && !weakAdminPasswordWarningLogged) {
      console.warn('ADMIN_PASSWORD should be rotated to at least 12 characters.');
      weakAdminPasswordWarningLogged = true;
    }
    return;
  }
  if (!password || password.length < 12) {
    const error = new Error('Set ADMIN_PASSWORD to a value of at least 12 characters before using the API.');
    error.status = 503;
    throw error;
  }

  const adminUser = {
    id: existing?.record.id || randomUUID(),
    name: process.env.ADMIN_NAME || existing?.record.name || 'Project Admin',
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role: 'admin',
    createdAt: existing?.record.createdAt || new Date().toISOString(),
  };
  if (existing) {
    await store.update('Users', existing.rowNumber, adminUser);
  } else {
    await store.append('Users', adminUser);
  }
}

async function authorize(req, requiredRole) {
  const token = readSessionToken(req);
  if (!token) {
    const error = new Error('Please sign in to continue.');
    error.status = 401;
    error.expose = true;
    throw error;
  }
  let claims;
  try {
    claims = jwt.verify(token, jwtSecret());
  } catch {
    const error = new Error('Your session expired. Please sign in again.');
    error.status = 401;
    error.expose = true;
    throw error;
  }

  const store = await getSheetStore();
  const entry = await getUserByEmail(store, claims.email);
  if (!entry || entry.record.id !== claims.sub) {
    const error = new Error('Your account could not be found. Please sign in again.');
    error.status = 401;
    error.expose = true;
    throw error;
  }
  const user = entry.record;
  if (requiredRole && user.role !== requiredRole) {
    const error = new Error('You do not have permission to perform this action.');
    error.status = 403;
    error.expose = true;
    throw error;
  }
  return { store, user };
}

function createToken(user) {
  return jwt.sign({ email: user.email }, jwtSecret(), {
    subject: user.id,
    expiresIn: '7d',
  });
}

app.get('/api/session', async (req, res) => {
  try {
    const { user } = await authorize(req);
    res.json({ user: publicUser(user) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

app.post('/api/auth/signup', signupRateLimit, async (req, res) => {
  try {
    if (!verifyCaptcha(req.body.captchaId, req.body.captchaAnswer)) {
      return res.status(400).json({ error: 'CAPTCHA is incorrect or expired. Please try a new image.' });
    }
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (name.length < 2 || name.length > 80 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 128) {
      return res.status(400).json({ error: 'Enter a name, valid email, and password between 12 and 128 characters.' });
    }
    const store = await getSheetStore();
    await ensureAdmin(store);
    if (await getUserByEmail(store, email)) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    const user = {
      id: randomUUID(),
      name,
      email,
      passwordHash: await bcrypt.hash(password, 12),
      role: 'user',
      createdAt: new Date().toISOString(),
    };
    await store.append('Users', user);
    setSessionCookie(res, createToken(user));
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  try {
    if (!verifyCaptcha(req.body.captchaId, req.body.captchaAnswer)) {
      return res.status(400).json({ error: 'CAPTCHA is incorrect or expired. Please try a new image.' });
    }
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (email.length > 254 || password.length > 128) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const store = await getSheetStore();
    await ensureAdmin(store);
    const entry = await getUserByEmail(store, email);
    if (!entry || !(await bcrypt.compare(password, entry.record.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const user = entry.record;
    setSessionCookie(res, createToken(user));
    res.json({ user: publicUser(user) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/migrate/local-storage', async (req, res) => {
  try {
    const { store, user: admin } = await authorize(req, 'admin');
    const legacyUsers = Array.isArray(req.body.users) ? req.body.users.slice(0, 200) : [];
    const legacyFeedback = Array.isArray(req.body.feedback) ? req.body.feedback.slice(0, 500) : [];
    const currentUsers = await store.list('Users');
    const usersByEmail = new Map(currentUsers.map((entry) => [entry.record.email.toLowerCase(), entry.record]));
    const userIds = new Map();
    const usersToImport = [];
    let importedUsers = 0;

    for (const oldUser of legacyUsers) {
      const email = String(oldUser.email || '').trim().toLowerCase();
      const name = String(oldUser.name || '').trim().slice(0, 80);
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      if (email === admin.email.toLowerCase()) {
        userIds.set(String(oldUser.id), admin.id);
        continue;
      }

      const existing = usersByEmail.get(email);
      if (existing) {
        userIds.set(String(oldUser.id), existing.id);
        continue;
      }

      const oldPassword = String(oldUser.password || '');
      if (!name || oldPassword.length < 6 || oldPassword.length > 128) continue;
      const migrated = {
        id: randomUUID(),
        name,
        email,
        passwordHash: await bcrypt.hash(oldPassword, 12),
        role: 'user',
        createdAt: new Date().toISOString(),
      };
      usersToImport.push(migrated);
      usersByEmail.set(email, migrated);
      userIds.set(String(oldUser.id), migrated.id);
      importedUsers += 1;
    }
    await store.appendMany('Users', usersToImport);

    const currentFeedback = await store.list('Feedback');
    const feedbackIds = new Set(currentFeedback.map(({ record }) => record.id));
    const feedbackToImport = [];
    let importedFeedback = 0;
    const categories = ['Service', 'Product', 'Support', 'Website', 'Other'];
    const statuses = ['Submitted', 'In Review', 'Resolved'];
    for (const oldItem of legacyFeedback) {
      const oldId = String(oldItem.id || '');
      if (!oldId) continue;
      const id = `legacy-${oldId}`;
      if (feedbackIds.has(id)) continue;
      const message = String(oldItem.message || '').trim().slice(0, 2000);
      if (!message) continue;
      const item = {
        id,
        userId: userIds.get(String(oldItem.userId)) || `legacy-${String(oldItem.userId || 'unknown')}`,
        userName: String(oldItem.userName || 'Former user').trim().slice(0, 80),
        category: categories.includes(oldItem.category) ? oldItem.category : 'Other',
        rating: Math.min(5, Math.max(1, Number.parseInt(oldItem.rating, 10) || 3)),
        message,
        status: statuses.includes(oldItem.status) ? oldItem.status : 'Submitted',
        createdAt: oldItem.createdAt && !Number.isNaN(Date.parse(oldItem.createdAt))
          ? new Date(oldItem.createdAt).toISOString()
          : new Date().toISOString(),
      };
      feedbackToImport.push(item);
      feedbackIds.add(id);
      importedFeedback += 1;
    }
    await store.appendMany('Feedback', feedbackToImport);

    res.json({ importedUsers, importedFeedback });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/feedback', feedbackReadRateLimit, async (req, res) => {
  try {
    if (!readSessionToken(req)) {
      const store = await getSheetStore();
      const rows = await store.list('Feedback');
      const publicItems = rows.map(({ record }) => ({
        id: record.id,
        userName: record.userName,
        category: record.category,
        rating: Number(record.rating),
        message: record.message,
        status: record.status,
        createdAt: record.createdAt,
      }));
      return res.json({ feedback: publicItems });
    }

    const { store, user } = await authorize(req);
    const rows = await store.list('Feedback');
    const items = rows.map(({ record }) => ({ ...record, rating: Number(record.rating) }))
      .filter((item) => user.role === 'admin' || item.userId === user.id);
    res.json({ feedback: items });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/feedback', feedbackWriteRateLimit, async (req, res) => {
  try {
    const { store, user } = await authorize(req);
    const category = String(req.body.category || '');
    const message = String(req.body.message || '').trim();
    const rating = Number(req.body.rating);
    const categories = ['Service', 'Product', 'Support', 'Website', 'Other'];
    if (!categories.includes(category) || !Number.isInteger(rating) || rating < 1 || rating > 5 || message.length < 10 || message.length > 2000) {
      return res.status(400).json({ error: 'Enter a category, rating from 1 to 5, and feedback between 10 and 2000 characters.' });
    }
    const item = {
      id: randomUUID(),
      userId: user.id,
      userName: user.name,
      category,
      rating,
      message,
      status: 'Submitted',
      createdAt: new Date().toISOString(),
    };
    await store.append('Feedback', item);
    res.status(201).json({ feedback: item });
  } catch (error) {
    sendError(res, error);
  }
});

app.patch('/api/feedback/:id', async (req, res) => {
  try {
    const { store } = await authorize(req, 'admin');
    const status = String(req.body.status || '');
    if (!['Submitted', 'In Review', 'Resolved'].includes(status)) {
      return res.status(400).json({ error: 'Choose a valid feedback status.' });
    }
    const rows = await store.list('Feedback');
    const entry = rows.find(({ record }) => record.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Feedback was not found.' });
    const updated = { ...entry.record, rating: Number(entry.record.rating), status };
    await store.update('Feedback', entry.rowNumber, updated);
    res.json({ feedback: updated });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/feedback/:id', async (req, res) => {
  try {
    const { store } = await authorize(req, 'admin');
    const rows = await store.list('Feedback');
    const entry = rows.find(({ record }) => record.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Feedback was not found.' });
    await store.removeFeedback(entry.rowNumber);
    res.status(204).end();
  } catch (error) {
    sendError(res, error);
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  sendError(res, error);
});

export default app;
