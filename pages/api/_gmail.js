import { google } from 'googleapis';

export function getTZ() {
  return process.env.APP_TZ || 'Asia/Kolkata';
}

export function gmailClient() {
  const {
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    GMAIL_REFRESH_TOKEN,
    GMAIL_REDIRECT_URI
  } = process.env;

  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN || !GMAIL_REDIRECT_URI) {
    throw new Error('Missing Gmail OAuth env vars.');
  }

  const oAuth2Client = new google.auth.OAuth2(
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    GMAIL_REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });

  return google.gmail({ version: 'v1', auth: oAuth2Client });
}

// --- Gmail helpers ---
export async function listMessages(gmail, q, max = 200) {
  const out = [];
  let pageToken = undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: Math.min(100, max),
      pageToken
    });
    const msgs = res.data.messages || [];
    out.push(...msgs);
    pageToken = res.data.nextPageToken;
  } while (pageToken && out.length < max);
  return out;
}

export async function loadMessage(gmail, id) {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'full'
  });
  return res.data;
}

function base64Decode(b64) {
  if (!b64) return '';
  const buff = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return buff.toString('utf8');
}

export function extractBody(payload) {
  if (!payload) return '';
  if (payload.parts && payload.parts.length) {
    // prefer text/plain, then text/html
    for (const p of payload.parts) {
      if (p.mimeType === 'text/plain' && p.body?.data) return base64Decode(p.body.data);
    }
    for (const p of payload.parts) {
      if (p.mimeType === 'text/html' && p.body?.data) return base64Decode(p.body.data);
    }
    // nested
    for (const p of payload.parts) {
      const s = extractBody(p);
      if (s) return s;
    }
  }
  if (payload.body?.data) return base64Decode(payload.body.data);
  return '';
}

export function headerValue(headers, name) {
  const h = headers?.find(x => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}
