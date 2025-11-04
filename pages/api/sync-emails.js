import { google } from "googleapis";
import { supabaseAdmin } from "./_supabase";

/** OAuth client */
function getOAuthClient() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    "http://localhost"
  );
  oAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return oAuth2Client;
}

/** INR parser: INR/₹/Rs, 1,23,456.78 etc. */
function parseAmountStr(s) {
  if (!s) return null;
  const normalized = String(s).replace(/[^0-9.,]/g, "").replace(/,/g, "");
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Minimal HTML -> text */
function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|td|th)>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Walk Gmail payload -> text */
function extractBodyAsText(payload) {
  let text = "";
  const stack = [payload];
  while (stack.length) {
    const part = stack.pop();
    if (!part) continue;
    if (part.parts) stack.push(...part.parts);

    const raw = part.body?.data ? Buffer.from(part.body.data, "base64").toString("utf-8") : "";

    if (part.mimeType === "text/plain" && raw) text += raw + "\n";
    if (part.mimeType === "text/html"  && raw) text += htmlToText(raw) + "\n";
  }
  if (!text && payload?.body?.data) {
    text = Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  return text.trim();
}

const INR = String.raw`(?:INR|₹|Rs\.?)\s*`;
const AMOUNT = String.raw`([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)`;

/** Virtual-account credit (from your “Virtual Code … has been credited …” mails) */
const RE_VIRTUAL_1 = new RegExp(`amount\\s+of\\s+${INR}${AMOUNT}`, "i");
const RE_VIRTUAL_2 = new RegExp(`${INR}${AMOUNT}\\s+has\\s+been\\s+credited\\s+to\\s+Virtual\\s+Code`, "i");
const RE_VIRTUAL_3 = new RegExp(`credited.*?${INR}${AMOUNT}`, "i");

/** Indifi deduction (EMI/fees) */
const RE_DEDUCT = new RegExp(`(?:EMI\\s*(?:deduction|deducted)|deducted|debited?)\\D*${INR}${AMOUNT}`, "i");

/** Release-to-bank emails (your new sample) */
const RE_RELEASE_AMOUNT = new RegExp(
  `amount\\s+of\\s+${INR}${AMOUNT}[^\\n]*?released\\s+to\\s+the\\s+registered\\s+bank\\s+account`,
  "i"
);
// Accepts “vide ABC123…”
const RE_RELEASE_REF = /\bvide\s+([A-Za-z0-9][A-Za-z0-9/_-]{5,32})\b/i;

/** Fallback “bank credited/transferred … INR …” */
const RE_BANK_GENERIC = new RegExp(`(?:transferred|credited)\\s+.*?\\bbank\\b.*?${INR}${AMOUNT}`, "i");

/** Safe header getter */
function headerValue(headers, name) {
  return (headers.find(h => h.name === name) || {}).value || "";
}

/** Search query (includes sender + phrases + subjects). Override with ?q= */
function buildQuery({ qOverride, afterEpoch }) {
  if (qOverride) return `${qOverride} after:${afterEpoch}`;
  const parts = [
    'from:info@indificapital.com',
    '"Virtual Code"',
    '"Payment release successful"',
    '"Payment release succesfull"',
    '"Payment Received in virtual account"'
  ];
  return parts.join(" OR ") + ` after:${afterEpoch}`;
}

export default async function handler(req, res) {
  try {
    // Backfill window (default 120d; cap 1..3650)
    const days = Math.max(1, Math.min(3650, parseInt(req.query.days || "120", 10)));
    const since = new Date(Date.now() - days * 86400000);
    const afterEpoch = Math.floor(since.getTime() / 1000);

    const q = buildQuery({ qOverride: req.query.q, afterEpoch });

    const auth = getOAuthClient();
    const gmail = google.gmail({ version: "v1", auth });

    let pageToken;
    let pagesScanned = 0;
    let insertedCount = 0;
    const errors = [];
    const insertedIds = [];

    do {
      const list = await gmail.users.messages.list({
        userId: "me", q, maxResults: 100, pageToken
      });

      const messages = list.data.messages || [];
      pageToken = list.data.nextPageToken || undefined;
      pagesScanned++;

      for (const m of messages) {
        try {
          // de-dupe
          const { data: exists } = await supabaseAdmin
            .from("payments").select("id").eq("email_id", m.id).limit(1);
          if (exists && exists.length) continue;

          const msg = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
          const payload = msg.data.payload || {};
          const headers = payload.headers || [];

          const subject = headerValue(headers, "Subject");
          const dateHdr = headerValue(headers, "Date");
          const receivedAt = dateHdr ? new Date(dateHdr).toISOString() : new Date().toISOString();

          const bodyText = extractBodyAsText(payload);

          // --- Extract values depending on mail type ---
          let virtualAmount = null;
          let indifiDeduction = null;
          let bankCredit = null;
          let transactionRef = null;

          // Virtual-account credits
          const v1 = bodyText.match(RE_VIRTUAL_1);
          const v2 = v1 ? null : bodyText.match(RE_VIRTUAL_2);
          const v3 = v1 || v2 ? null : bodyText.match(RE_VIRTUAL_3);
          virtualAmount = parseAmountStr((v1?.[1] || v2?.[1] || v3?.[1]) || null);

          // Indifi deductions
          const d1 = bodyText.match(RE_DEDUCT);
          indifiDeduction = parseAmountStr(d1?.[1] || null);

          // Release-to-bank: prefer this strong pattern for your exact mail
          const rAmt = bodyText.match(RE_RELEASE_AMOUNT);
          if (rAmt) {
            bankCredit = parseAmountStr(rAmt[1]);
          } else {
            // fallback generic
            const b1 = bodyText.match(RE_BANK_GENERIC);
            bankCredit = parseAmountStr(b1?.[1] || null);
          }

          // Reference number (vide … or TXN/Ref)
          const ref1 = bodyText.match(RE_RELEASE_REF);
          transactionRef =
            ref1?.[1] ||
            (bodyText.match(/\b(?:Ref(?:erence)?|TXN|Transaction)\s*[:#-]?\s*([A-Za-z0-9/_-]{6,32})\b/i)?.[1] || null);

          const source =
            /virtual code/i.test(bodyText) || /virtual account/i.test(subject)
              ? "virtual_account"
              : /release/i.test(subject)
              ? "indifi_release"
              : "email";

          const row = {
            email_id: m.id,
            received_at: receivedAt,
            source,
            transaction_ref: transactionRef,
            virtual_amount: virtualAmount,
            indifi_deduction: indifiDeduction,
            bank_credit: bankCredit,
            raw_subject: subject,
            raw_body: bodyText,
            parsed: true
          };

          const { error } = await supabaseAdmin.from("payments").insert([row]);
          if (error) errors.push({ id: m.id, reason: error.message });
          else { insertedCount++; insertedIds.push(m.id); }
        } catch (inner) {
          errors.push({ id: m.id, reason: inner.message });
        }
      }
    } while (pageToken && pagesScanned < 20);

    return res.status(200).json({
      ok: true, inserted_count: insertedCount, pages_scanned: pagesScanned, q, errors
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
