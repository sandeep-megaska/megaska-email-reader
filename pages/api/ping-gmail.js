// pages/api/ping-gmail.js
import { google } from "googleapis";

function timeoutAfter(ms, msg = "Request timed out") {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
}

export default async function handler(req, res) {
  const steps = [];
  try {
    steps.push("init-oauth");
    const o = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      "http://localhost"
    );
    o.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

    steps.push("get-access-token");
    // Validate refresh token first — surfaces invalid_grant immediately
    // (wrap in timeout so it can't hang)
    const token = await Promise.race([
      o.getAccessToken(),
      timeoutAfter(10000, "getAccessToken timeout (10s)")
    ]);

    steps.push("init-gmail-client");
    const gmail = google.gmail({ version: "v1", auth: o });

    // Minimal list call with timeout + tiny page to avoid long waits
    const q = '(subject:"Payment Received in virtual account") OR (subject:"Payment release successful") OR (subject:"Payment release succesfull")';
    steps.push("list-messages");
    const listRes = await Promise.race([
      gmail.users.messages.list({ userId: "me", q, maxResults: 3 }),
      timeoutAfter(10000, "gmail.users.messages.list timeout (10s)")
    ]);

    const found = listRes?.data?.resultSizeEstimate ?? (listRes?.data?.messages?.length || 0);
    return res.status(200).json({
      ok: true,
      steps,
      gotAccessToken: Boolean(token?.token || token?.access_token || token),
      found,
      q
    });
  } catch (e) {
    return res.status(500).json({ ok: false, steps, error: e.message });
  }
}
