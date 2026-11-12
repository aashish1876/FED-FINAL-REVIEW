# FeedbackHub - Project Review 2

FeedbackHub is a React + Vite customer feedback app. Its users, password hashes, and feedback records are stored in Google Sheets through server-side API endpoints. The browser does not connect to Google Sheets directly.

## Configure Google Sheets

1. Enable the Google Sheets API for the Google Cloud project associated with service account client ID `93950818768-okeho532rlr351j8dduqss32875s80ai.apps.googleusercontent.com`.
2. Create a spreadsheet and share it with `a-271-664@planmytrip-482810.iam.gserviceaccount.com`, granting Editor access. Copy the spreadsheet ID from its URL.
3. Copy `.env.example` to `.env`. Set `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`, and a unique `JWT_SECRET`. Set the administrator email and a unique password of at least 8 characters.
4. Keep `.env` and all service account keys private. Add the same variables as encrypted Environment Variables in Vercel for production.

The API creates `Users` and `Feedback` tabs with headers automatically. Passwords are bcrypt-hashed before being written to the Users tab. The API provisions the administrator from `ADMIN_EMAIL` and `ADMIN_PASSWORD` the first time it connects.
After the configured administrator first signs in from a browser that has the previous app's Local Storage, the old users and feedback are migrated to Sheets once; migrated passwords are hashed on the server.

The client ID and service-account email identify the account but do not grant API access by themselves. Download that service account's JSON key securely and set the complete JSON as `GOOGLE_SERVICE_ACCOUNT_JSON`; also set the spreadsheet ID as `GOOGLE_SHEET_ID`. Never put the private key in source code or commit it.

## Run locally

```bash
npm install
npm run dev
```

The Vite app runs at `http://127.0.0.1:5173`; its API runs locally on port 3001. Google Sheets credentials must be configured for signup, login, and feedback operations to work.

## Deploy to Vercel

Add the environment variables from `.env.example` to the Vercel project settings, then run:

```bash
npm run build
npx vercel --prod
```

## Modules

- **User:** sign up, log in with CAPTCHA, submit feedback, and track its status.
- **Admin:** review all feedback, update statuses, and delete records.
- **Public home:** view resolved feedback and sign in or create an account.

Google Sheets is suitable for a small project/review demo, not high-concurrency production workloads. Keep the spreadsheet private and share it only with the service account and trusted administrators.
