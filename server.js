import 'dotenv/config';
import app from './api/app.js';

const port = Number(process.env.API_PORT || 3001);

app.listen(port, '127.0.0.1', () => {
  console.log(`FeedbackHub API listening on http://127.0.0.1:${port}`);
});
