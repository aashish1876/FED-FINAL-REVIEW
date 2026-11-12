import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { getSheetStore } from './sheets.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

function sendError(res, error) {
  console.error(error);
  const status = error.status || 500;
  res.status(status).json({ error: status === 500 ? 'The spreadsheet service is unavailable. Check the server configuration.' : error.message });
}

function jwtSecret() {
  if (!process.env.JWT_SECRET) {
    const error = new Error('JWT_SECRET is not configured.');
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
  const email = (process.env.ADMIN_EMAIL || 'admin@feedbackhub.com').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 8) {
    const error = new Error('Set ADMIN_PASSWORD to a value of at least 8 characters before using the API.');
    error.status = 503;
    throw error;
  }
  const existing = await getUserByEmail(store, email);
  if (existing?.record.role === 'admin') return;

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
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    const error = new Error('Please sign in to continue.');
    error.status = 401;
    throw error;
  }
  let claims;
  try {
    claims = jwt.verify(token, jwtSecret());
  } catch {
    const error = new Error('Your session expired. Please sign in again.');
    error.status = 401;
    throw error;
  }

  const store = await getSheetStore();
  const entry = await getUserByEmail(store, claims.email);
  if (!entry || entry.record.id !== claims.sub) {
    const error = new Error('Your account could not be found. Please sign in again.');
    error.status = 401;
    throw error;
  }
  const user = entry.record;
  if (requiredRole && user.role !== requiredRole) {
    const error = new Error('You do not have permission to perform this action.');
    error.status = 403;
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

app.post('/api/auth/signup', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (name.length < 2 || name.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Enter a name, valid email, and password between 8 and 128 characters.' });
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
    res.status(201).json({ user: publicUser(user), token: createToken(user) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const store = await getSheetStore();
    await ensureAdmin(store);
    const entry = await getUserByEmail(store, email);
    if (!entry || !(await bcrypt.compare(password, entry.record.passwordHash))) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    const user = entry.record;
    res.json({ user: publicUser(user), token: createToken(user) });
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

app.get('/api/feedback', async (req, res) => {
  try {
    const store = await getSheetStore();
    const rows = await store.list('Feedback');
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      const publicItems = rows.map(({ record }) => ({ ...record, rating: Number(record.rating) })).filter((item) => item.status === 'Resolved');
      return res.json({ feedback: publicItems });
    }

    const { user } = await authorize(req);
    const items = rows.map(({ record }) => ({ ...record, rating: Number(record.rating) }))
      .filter((item) => user.role === 'admin' || item.userId === user.id);
    res.json({ feedback: items });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/feedback', async (req, res) => {
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
