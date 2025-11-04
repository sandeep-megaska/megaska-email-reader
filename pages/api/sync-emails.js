// pages/api/sync-emails.js
import { google } from "googleapis";
import { supabaseAdmin } from "./_supabase";

/** Build an OAuth2 client from env vars */
function getOAuthClient() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    "http://localhost" // not used in refresh-token flow
  );
  oAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return oAuth2Client;
}

/** Parse "INR 12,345.67" / "Rs. 12,345" / "₹12,345" → Number */
function parseAmount(s) {
  if (!s) return null;
  const n = String(s).replace(/[^\d.]/g, "");
  return n ? parseFloat(n) : null;
}

/** Very small HTML → text converter keeping line breaks readable */
function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li)>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

/** Walks a Gmail message payload and returns concatenated plain text */
function extractBodyAsText(payload) {
  let text = "";
  const stack = [payload];
  while (stack.length) {
    const part = stack.pop();
    if (!part) continue;
    if (part.parts) stack.push(...part.parts);

    const raw = part.body?.data
      ? Buffer.from(part.body.data, "base64").toString("utf-8")
      : "";

    if (part.mimeType === "text/plain" && raw) text += raw + "\n";
    if (part.mimeType === "text/html" && raw) text += htmlToText(raw) + "\n";
  }
  // Fallback to top-level body if no parts
  if (!text && payload?.body?.data) {
    text = Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  return text.trim();
}

/** Build a broad default Gmail search query, with optional override & date window */
function buildQuery({ qOverride, afterEpoch }) {
  if (qOverride) return `${qOverride} after:${afterEpoch}`;
  // Include common subject variants; add more once you see real subjects via debug
  const subjects = [
    '(subject:"Payment Received in virtual account")',
    '(subject:"Payment release successful")',
    '(subject:"Payment release succesfull")', // common typo
  ];
  // Optional sender hints (uncomment/adjust when you know exact senders):
  // const senders = ['from:indifi', 'from:amazon', 'from:noreply@indifi.com'];
  return [...subjects /*, ...senders */].join(" OR ") + ` after:${afterEpoch}`;
}

/** Safe getter for a specific header */
function headerValue(headers, name) {
  return (headers.find(h => h.name === name) || {}).value || "";
}

export default async function handler(req, res) {
  try {
    // Backfill window: default 120 days; cap 1..3650 days
    const days = Math.max(1, Math.min(3650, parseInt(req.query.days || "120", 10)));
    const since = new Date(Date.now() - days * 86400000);
    const afterEpoch = Math.floor(since.getTime() / 1000); // Gmail "after:" needs epoch seconds

    const q = buildQuery({ qOverride: req.query.q, afterEpoch });

    const auth = getOAuthClient();
    const gmail = google.gmail({ version: "v1", auth });

    let pageToken = undefined;
    let pagesScanned = 0;
    let insertedCount = 0;
    const insertedIds = [];
    const errors = [];

    do {
      const list = await gmail.users.messages.list({
        userId: "me",
        q,
        maxResults: 100,
        pageToken,
      });

      const messages = list.data.messages || [];
      pageToken = list.data.nextPageToken || undefined;
      pagesScanned++;

      for (const m of messages) {
        try {
          // Skip if already ingested
          const { data: exists } = await supabaseAdmin
            .from("payments")
            .select("id")
            .eq("email_id", m.id)
            .limit(1);
          if (exists && exists.length) continue;

          const msg = await gmail.users.messages.get({
            userId: "me",
            id: m.id,
            format: "full",
          });

          const payload = msg.data.payload || {};
          const headers = payload.headers || [];

          const subject = headerValue(headers, "Subject");
          const dateHeader = headerValue(headers, "Date");
          const receivedAt = dateHeader
            ? new Date(dateHeader).toISOString()
            : new Date().toISOString();

          const bodyText = extractBodyAsText(payload);

          // ---- AMOUNT EXTRACTION ----
          // Tweak these after you see a couple of real examples if needed
          // Virtual account credit (amount into VA)
          const virtualMatch =
            bodyText.match(/(credited|received).*?virtual account.*?(?:INR|Rs\.?|₹)\s?([\d,]+(?:\.\d{1,2})?)/i) ||
            subject.match(/(?:INR|Rs\.?|₹)\s?([\d,]+(?:\.\d{1,2})?)/i);

          // Deduction by Indifi (EMI or fee)
          const indifiMatch =
            bodyText.match(/EMI(?:\s*deduction|\s*deducted)?.*?(?:INR|Rs\.?|₹)\s?([\d,]+(?:\.\d{1,2})?)/i) ||
            bodyText.match(/(?:deducted|debit(?:ed)?)\s*(?:amount)?\s*(?:of)?\s*(?:INR|Rs\.?|₹)\s?([\d,]+(?:\.\d{1,2})?)/i);

          // Net transfer to bank
          const bankMatch =
            bodyText.match(/(transferred|credited).*?bank.*?(?:INR|Rs\.?|₹)\s?([\d,]+(?:\.\d{1,2})?)/i);

          // Reference / transaction id
          const txnMatch =
            bodyText.match(/\b(?:Ref(?:erence)?|TXN|Transaction)\s*[:#-]?\s*([A-Za-z0-9/_-]+)/i);

          const row = {
            email_id: m.id,
            received_at: receivedAt,
            source: subject.toLowerCase().includes("virtual account")
              ? "virtual_account"
              : subject.toLowerCase().includes("release")
              ? "indifi_release"
              : "email",
            transaction_ref: txnMatch?.[1] || null,
            virtual_amount: parseAmount(virtualMatch?.[2] || virtualMatch?.[1] || null),
            indifi_deduction: parseAmount(indifiMatch?.[1] || null),
            bank_credit: parseAmount(bankMatch?.[2] || null),
            raw_subject: subject,
            raw_body: bodyText,
            parsed: true,
          };

          const { error } = await supabaseAdmin.from("payments").insert([row]);
          if (error) {
            errors.push({ id: m.id, reason: error.message });
          } else {
            insertedCount++;
            insertedIds.push(m.id);
          }
        } catch (inner) {
          // Keep going even if one message fails
          errors.push({ id: m.id, reason: inner.message });
        }
      }
    } while (pageToken && pagesScanned < 20); // safety cap

    return res
      .status(200)
      .json({ ok: true, inserted_count: insertedCount, pages_scanned: pagesScanned, q, errors });
  } catch (e) {
    // Surface auth problems like invalid_grant clearly
    return res.status(500).json({ ok: false, error: e.message });
  }
}
