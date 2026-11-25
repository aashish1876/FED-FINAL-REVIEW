# FeedbackHub

FeedbackHub is a responsive customer feedback app built with React, Vite, and Express. Google Sheets stores account and feedback data, so authorized users can access the same records from the local app or a deployed instance.

## Features

- Image-based character CAPTCHA on sign-up and sign-in. The server validates encrypted challenges that expire after five minutes.
- User accounts with bcrypt-hashed passwords and secure, HTTP-only session cookies.
- Feedback submission with category, 1–5 star rating, review text, and status tracking.
- Admin dashboard for reviewing submissions, changing statuses, and deleting feedback.
- Public home feed that displays feedback across all statuses.
- Glass-style interface with saved light/dark theme preference, responsive layouts, hover details, and scroll reveals.
- Optimistic feedback updates: a new review appears immediately while the spreadsheet save completes, then is confirmed or rolled back on error.

## Google Sheets database

The API creates two tabs in the configured spreadsheet:

| Tab | Stored fields |
| --- | --- |
| `Users` | ID, name, email/login ID, bcrypt password hash, role, creation time |
| `Feedback` | ID, user ID, user name, category, rating, review message, status, creation time |

Passwords are never stored as readable text. The API connects to Sheets with a Google service account; the browser does not access the spreadsheet directly. Share the spreadsheet with the service account's `client_email` and grant it **Editor** access.

## Configure

1. Enable the **Google Sheets API** in the Google Cloud project.
2. Create a service account and download its JSON key.
3. Copy `.env.example` to `.env` and set these values:

   - `GOOGLE_SHEET_ID`: the ID from the spreadsheet URL.
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: the full service account JSON, kept private.
   - `JWT_SECRET`: a long, random secret used for sessions and encrypted CAPTCHA challenges.
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and optionally `ADMIN_NAME`: the initial administrator account. Use a unique password of at least 12 characters.

The API creates the `Users` and `Feedback` tabs and their headers the first time it connects. Keep `.env` and downloaded service account keys out of GitHub.

## Run locally

Use Node.js 20.19 or newer in the 20.x line, or Node.js 22.12 or newer.

```bash
npm install
npm run dev
```

The Vite site runs at `http://127.0.0.1:5173`; the Express API runs at `http://127.0.0.1:3001`. Google Sheets credentials must be configured for account and feedback operations.

## Deploy to Vercel

Add `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `ADMIN_NAME` as Vercel project environment variables. Share the spreadsheet with the service account email, then deploy:

```bash
npm run build
npx vercel --prod
```

You can also connect the GitHub repository to Vercel for automatic deployments. Local `.env` values are not uploaded with the repository; configure them in Vercel before deploying.

Google Sheets works well for demos and small deployments. For high traffic, use a database designed for concurrent application workloads.

## Security notes

- Passwords are hashed with bcrypt. New accounts require at least 12 characters; session tokens are stored in HTTP-only, SameSite cookies rather than browser storage.
- The API applies security headers, avoids caching API responses, and rate-limits CAPTCHA, login, and signup requests in each running process.
- Per-process rate limits are best-effort on serverless deployments. Configure Vercel Firewall rate limits for `/api/auth/login`, `/api/auth/signup`, `/api/captcha`, and `POST /api/feedback` before production use.
- Use a `JWT_SECRET` with at least 32 characters and keep all environment variables private. Rotate any credential that may have been shared or committed.
