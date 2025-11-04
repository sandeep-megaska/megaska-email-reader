import { google } from "googleapis";

export default async function handler(req, res) {
  try {
    const o = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      "http://localhost"
    );
    o.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
    const gmail = google.gmail({ version: "v1", auth: o });

    const q = 'subject:("Payment Received in virtual account" OR "Payment release successful")';
    const r = await gmail.users.messages.list({ userId: "me", q, maxResults: 5 });
    res.status(200).json({ ok: true, found: r.data.resultSizeEstimate || (r.data.messages?.length || 0) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
