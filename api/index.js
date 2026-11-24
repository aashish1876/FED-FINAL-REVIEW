import app from '../server/app.js';

export default function apiHandler(req, res) {
  const requestUrl = new URL(req.url, 'http://localhost');
  const route = requestUrl.searchParams.get('path');
  if (route) {
    requestUrl.searchParams.delete('path');
    const remaining = requestUrl.searchParams.toString();
    req.url = `/api/${route}${remaining ? `?${remaining}` : ''}`;
  }
  // Keep the Vercel invocation alive until Express has actually finished the
  // response. This also lets async route handlers complete before the function
  // is considered done.
  return new Promise((resolve) => {
    const finish = () => resolve();
    res.once('finish', finish);
    res.once('close', finish);
    try {
      app(req, res);
    } catch (error) {
      console.error('API handler failed:', error);
      if (!res.headersSent) res.status(500).json({ error: 'The API could not process this request.' });
      finish();
    }
  });
}
