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

/** INR parser: INR/₹/Rs, 1,23,456.78 etc. drops commas */
function parseINR(s) {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/[^0-9.]/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** minimal HTML→text */
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
function extractBodyText(payload) {
  let text = "";
  const stack = [payload];
  while (stack.length) {
    const part = stack.pop();
    if (!part) continue;
    if (part.parts) stack.push(...part.parts);
    const raw = part.body?.data ? Buffer.from(part.body.data, "base64").toString("utf-8") : "";
    if (part.mimeType === "text/plain" && raw) text += raw + "\n";
    if (part.mimeType === "text/html" && raw) text += htmlToText(raw) + "\n";
  }
  if (!text && payload?.body?.data) {
    text = Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  return text.trim();
}
const INR = String.raw`(?:INR|₹|Rs\.?)\s*`;
const AMT = String.raw`([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)`;

// VIRTUAL credit emails (your sample wording)
const RE_VIRTUAL_STRICT_1 = new RegExp(`amount\\s+of\\s+${INR}${AMT}\\s+has\\s+been\\s+credited\\s+to\\s+Virtual\\s+Code`, "i");
const RE_VIRTUAL_STRICT_2 = new RegExp(`${INR}${AMT}\\s+has\\s+been\\s+credited\\s+to\\s+Virtual\\s+Code`, "i");
const RE_VIRTUAL_LOOSE    = new RegExp(`credited.*?${INR}${AMT}`, "i");

// RELEASE→bank emails (your sample wording)
const RE_RELEASE_AMOUNT   = new RegExp(`amount\\s+of\\s+${INR}${AMT}[^\\n]*?released\\s+to\\s+the\\s+registered\\s+bank\\s+account`, "i");

// Reference: “vide ABC123…”, forbid “is” etc. (≥6 chars, alnum first)
const RE_REF_VIDE = /\bvide\s+([A-Za-z0-9][A-Za-z0-9/_-]{5,32})\b/i;
// Generic fallback
const RE_REF_GENERIC = /\b(?:Ref(?:erence)?|TXN|Transaction)\s*[:#-]?\s*([A-Za-z0-9/_-]{6,32})\b/i;

// Indifi deduction (EMI)
const RE_DEDUCT = new RegExp(`(?:EMI\\s*(?:deduction|deducted)|deducted|debited?)\\D*${INR}${AMT}`, "i");

// Fallback “bank credited/transferred … INR …”
const RE_BANK_GENERIC = new RegExp(`(?:transferred|credited)\\s+.*?\\bbank\\b.*?${INR}${AMT}`, "i");

function headerValue(headers, name) {
  return (headers.find(h => h.name === name) || {}).value || "";
}

function buildQuery({ qOverride, afterEpoch }) {
  if (qOverride) return `${qOverride} after:${afterEpoch}`;
  const parts = [
    'from:info@indificapital.com',
    '"Virtual Code"',
    '"Payment release successful"',
    '"Payment release succesfull"',
    '"Payment Received in virtual account"',
  ];
  return parts.join(" OR ") + ` after:${afterEpoch}`;
}

export default async function handler(req, res) {
  try {
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

    do {
      const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 100, pageToken });
      const messages = list.data.messages || [];
      pageToken = list.data.nextPageToken || undefined;
      pagesScanned++;

      for (const m of messages) {
        try {
          // de-dupe
          const { data: exists } = await supabaseAdmin.from("payments").select("id").eq("email_id", m.id).limit(1);
          if (exists && exists.length) continue;

          const msg = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
          const payload = msg.data.payload || {};
          const headers = payload.headers || [];

          const subject   = headerValue(headers, "Subject");
          const dateHdr   = headerValue(headers, "Date");
          const receivedAt= dateHdr ? new Date(dateHdr).toISOString() : new Date().toISOString();
          const bodyText  = extractBodyText(payload);

          // MAIL TYPE
          const isVirtual = /virtual code/i.test(bodyText) || /Payment Received in virtual account/i.test(subject);
          const isRelease = /Payment release successful/i.test(subject) || /Payment release succesfull/i.test(subject);

          let virtual_amount = null, bank_credit = null, indifi_deduction = null, transaction_ref = null;

          if (isVirtual) {
            const m1 = bodyText.match(RE_VIRTUAL_STRICT_1) || bodyText.match(RE_VIRTUAL_STRICT_2) || bodyText.match(RE_VIRTUAL_LOOSE);
            const amt = parseINR(m1?.[1] || null);
            virtual_amount = (amt != null && amt >= 500) ? amt : null; // ignore tiny/garbage
            // ref (if present)
            const r1 = bodyText.match(RE_REF_VIDE) || bodyText.match(RE_REF_GENERIC);
            const ref = r1?.[1] || null;
            // Ensure “is” etc. never pass as a ref
            transaction_ref = ref && ref.length >= 6 ? ref : null;
            // do NOT set bank_credit from virtual mails
            bank_credit = null;
          } else if (isRelease) {
            // bank release amount
            const rAmt = bodyText.match(RE_RELEASE_AMOUNT) || bodyText.match(RE_BANK_GENERIC);
            const b = parseINR(rAmt?.[1] || null);
            bank_credit = (b != null && b >= 500) ? b : null;
            // ref
            const r1 = bodyText.match(RE_REF_VIDE) || bodyText.match(RE_REF_GENERIC);
            const ref = r1?.[1] || null;
            transaction_ref = ref && ref.length >= 6 ? ref : null;
            // do NOT set virtual_amount from release mails
            virtual_amount = null;
          } else {
            // unknown type: try both, but still gate with >=500
            const m1 = bodyText.match(RE_VIRTUAL_STRICT_1) || bodyText.match(RE_VIRTUAL_STRICT_2) || bodyText.match(RE_VIRTUAL_LOOSE);
            const rAmt = bodyText.match(RE_RELEASE_AMOUNT) || bodyText.match(RE_BANK_GENERIC);
            const v = parseINR(m1?.[1] || null);
            const b = parseINR(rAmt?.[1] || null);
            virtual_amount = (v != null && v >= 500) ? v : null;
            bank_credit    = (b != null && b >= 500) ? b : null;
            const r1 = bodyText.match(RE_REF_VIDE) || bodyText.match(RE_REF_GENERIC);
            const ref = r1?.[1] || null;
            transaction_ref = ref && ref.length >= 6 ? ref : null;
          }

          // optional: try to detect EMI deduction lines
          const d1 = bodyText.match(RE_DEDUCT);
          const d = parseINR(d1?.[1] || null);
          indifi_deduction = (d != null && d >= 1) ? d : null;

          const source = isVirtual ? "virtual_account" : isRelease ? "indifi_release" : "email";

          const row = {
            email_id: m.id,
            received_at: receivedAt,
            source,
            transaction_ref,
            virtual_amount,
            indifi_deduction,
            bank_credit,
            raw_subject: subject,
            raw_body: bodyText,
            parsed: true
          };

          const { error } = await supabaseAdmin.from("payments").insert([row]);
          if (error) errors.push({ id: m.id, reason: error.message });
          else insertedCount++;
        } catch (inner) {
          errors.push({ id: m.id, reason: inner.message });
        }
      }
    } while (pageToken && pagesScanned < 20);

    return res.status(200).json({ ok: true, inserted_count: insertedCount, pages_scanned: pagesScanned, q, errors });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
