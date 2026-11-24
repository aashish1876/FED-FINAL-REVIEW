import { google } from 'googleapis';
import { createPrivateKey } from 'node:crypto';

const TABLES = {
  Users: ['id', 'name', 'email', 'passwordHash', 'role', 'createdAt'],
  Feedback: ['id', 'userId', 'userName', 'category', 'rating', 'message', 'status', 'createdAt'],
};

let cachedClientIdentity = '';
let cachedClient = null;
let tablesReadyPromise = null;

function getClient() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!spreadsheetId || !serviceAccountJson) {
    const error = new Error('Google Sheets is not configured. Set GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON.');
    error.status = 503;
    throw error;
  }

  const identity = `${spreadsheetId}\n${serviceAccountJson}`;
  if (cachedClient && identity === cachedClientIdentity) return cachedClient;

  let credentials;
  try {
    credentials = JSON.parse(serviceAccountJson);
  } catch {
    const error = new Error('GOOGLE_SERVICE_ACCOUNT_JSON must be valid JSON.');
    error.status = 503;
    throw error;
  }
  if (typeof credentials.private_key === 'string') {
    credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
  }
  try {
    createPrivateKey(credentials.private_key);
  } catch {
    const error = new Error('GOOGLE_SERVICE_ACCOUNT_JSON contains an invalid private_key. Download a fresh service account JSON key from Google Cloud and update the local .env file.');
    error.status = 503;
    throw error;
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  cachedClient = { sheets: google.sheets({ version: 'v4', auth }), spreadsheetId };
  cachedClientIdentity = identity;
  tablesReadyPromise = null;
  return cachedClient;
}

async function ensureTables(sheets, spreadsheetId) {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const existing = new Set((metadata.data.sheets || []).map((sheet) => sheet.properties.title));
  const missing = Object.entries(TABLES).filter(([title]) => !existing.has(title));

  if (missing.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: missing.map(([title]) => ({ addSheet: { properties: { title } } })),
      },
    });
  }

  for (const [title, headers] of Object.entries(TABLES)) {
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${title}!A1:Z1`,
    });
    if (!result.data.values?.length) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${title}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headers] },
      });
    }
  }
}

export async function getSheetStore() {
  const { sheets, spreadsheetId } = getClient();
  if (!tablesReadyPromise) {
    tablesReadyPromise = ensureTables(sheets, spreadsheetId);
    try {
      await tablesReadyPromise;
    } catch (error) {
      tablesReadyPromise = null;
      throw error;
    }
  } else {
    await tablesReadyPromise;
  }
  return {
    async list(table) {
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${table}!A1:Z`,
      });
      const [headers = [], ...rows] = result.data.values || [];
      return rows.map((row, index) => ({
        rowNumber: index + 2,
        record: Object.fromEntries(headers.map((header, column) => [header, row[column] ?? ''])),
      }));
    },
    async appendMany(table, records) {
      if (!records.length) return;
      const headers = TABLES[table];
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${table}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: records.map((record) => headers.map((header) => String(record[header] ?? ''))),
        },
      });
    },
    async append(table, record) {
      await this.appendMany(table, [record]);
    },
    async update(table, rowNumber, record) {
      const headers = TABLES[table];
      const lastColumn = String.fromCharCode(64 + headers.length);
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${table}!A${rowNumber}:${lastColumn}${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [headers.map((header) => String(record[header] ?? ''))] },
      });
    },
    async removeFeedback(rowNumber) {
      const metadata = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties',
      });
      const sheet = metadata.data.sheets?.find((item) => item.properties.title === 'Feedback');
      if (!sheet) throw new Error('Feedback worksheet is missing.');
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId: sheet.properties.sheetId,
                dimension: 'ROWS',
                startIndex: rowNumber - 1,
                endIndex: rowNumber,
              },
            },
          }],
        },
      });
    },
  };
}

export const sheetHeaders = TABLES;
