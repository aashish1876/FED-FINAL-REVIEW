import serverless from 'serverless-http';
import app from './app.js';

const handler = serverless(app);

export default function apiHandler(req, res) {
  const route = req.query?.path;
  if (typeof route === 'string') {
    const query = new URL(req.url, 'http://localhost').searchParams;
    query.delete('path');
    const remaining = query.toString();
    req.url = `/api/${route}${remaining ? `?${remaining}` : ''}`;
  }
  return handler(req, res);
}
