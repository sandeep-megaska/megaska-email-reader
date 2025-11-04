import { google } from "googleapis";
import { supabaseAdmin } from "./_supabase";

/** OAuth client */
function getOAuthClient() {
  const o = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    "http://localhost"
  );
  o.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return o;
}

/** INR parser (₹/INR/Rs; handles 1,23,456.78) */
function parseINR(s) {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/,/g, "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** HTML → text (light) */
function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|td|th)>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
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
    if (part.mimeType === "text/html"  && raw) text += htmlToText(raw) + "\n";
  }
  if (!text && payload?.body?.data) {
    text = Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  return text.trim();
}

const INR = String.raw`(?:INR|₹|Rs\.?)\s*`;
const AMT = String.raw`([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)`;

// Virtual credit (your VA email)
const RE_VIRTUAL = new RegExp(`amount\\s+of\\s+${INR}${AMT}\\s+has\\s+been\\s+credited\\s+to\\s+Virtual\\s+Code\\s+(\\d+)`, "i");

// Release to bank (your “Payment release successful” sample)
const RE_RELEASE = new RegExp(`amount\\s+of\\s+${INR}${AMT}[^\\n]*?released\\s+to\\s+the\\s+registered\\s+bank\\s+account\\s+(.+?)\\s+on`, "i");

// Common “vide …” ref
const RE_VIDE = /\bvide\s+([A-Za-z0-9][A-Za-z0-9/_-]{5,32})\b/i;

// Fallbacks
const RE_BANK_GENERIC = new RegExp(`(?:transferred|credited)\\s+.*?\\bbank\\b.*?${INR}${AMT}`, "i");
const RE_DEDUCT = new RegExp(`(?:EMI\\s*(?:deduction|deducted)|deducted|debited?)\\D*${INR}${AMT}`, "i");

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

    const gmail = google.gmail({ version: "v1", auth: getOAuthClient() });

    let pageToken, insertedCount = 0, pages = 0;
    const errors = [];

    do {
      const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 100, pageToken });
      const msgs = list.data.messages || [];
      pageToken = list.data.nextPageToken || undefined;
      pages++;

      for (const m of msgs) {
        try {
          // de-dupe
          const { data: exists } = await supabaseAdmin.from("payments").select("id").eq("email_id", m.id).limit(1);
          if (exists?.length) continue;

          const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
          const payload = full.data.payload || {};
          const headers = payload.headers || [];
          const subject = headerValue(headers, "Subject") || "";
          const dateHdr = headerValue(headers, "Date");
          const received_at = dateHdr ? new Date(dateHdr).toISOString() : new Date().toISOString();

          const body = extractBodyText(payload);

          // classify + extract
          let kind = "unknown";
          let virtual_amount = null, bank_credit = null, indifi_deduction = null;
          let transaction_ref = null, virtual_code = null, bank_account = null;

          // Explicit EMI (if Indifi ever sends a dedicated email)
          const d = body.match(RE_DEDUCT);
          if (d) {
            indifi_deduction = parseINR(d[1]);
            kind = "emi_deduction_explicit";
          }

          // Virtual credit
          const v = body.match(RE_VIRTUAL);
          if (v) {
            kind = "virtual_credit";
            virtual_amount = parseINR(v[1]); // NOTE: in RE_VIRTUAL, first capture is amount
            if (virtual_amount != null && virtual_amount < 500) virtual_amount = null; // ignore tiny noise
            virtual_code = v[2] || null;      // second capture is VA code
          }

          // Release to bank
          const r = body.match(RE_RELEASE);
          if (r || /Payment release succes+ful/i.test(subject)) {
            kind = "release_to_bank";
            const amt = r?.[1] ? parseINR(r[1]) : null;
            if (amt != null && amt >= 500) bank_credit = amt;
            // bank account friendly name/last digits
            bank_account = r?.[2]?.trim() || null;
          } else if (!v) {
            // generic fallback if the phrase differs; try to catch bank amount
            const b = body.match(RE_BANK_GENERIC);
            const bAmt = b?.[1] ? parseINR(b[1]) : null;
            if (bAmt && bAmt >= 500) {
              kind = "release_to_bank";
              bank_credit = bAmt;
            }
          }

          // Ref after "vide ..."
          const ref = body.match(RE_VIDE) ||
                      body.match(/\b(?:Ref(?:erence)?|TXN|Transaction)\s*[:#-]?\s*([A-Za-z0-9/_-]{6,32})\b/i);
          transaction_ref = ref?.[1] || null;

          const { error } = await supabaseAdmin.from("payments").insert([{
            email_id: m.id,
            received_at,
            source: kind === "virtual_credit" ? "virtual_account" : (kind === "release_to_bank" ? "indifi_release" : "email"),
            kind,
            virtual_amount,
            indifi_deduction,
            bank_credit,
            transaction_ref,
            virtual_code,
            bank_account,
            raw_subject: subject,
            raw_body: body,
            parsed: true
          }]);

          if (error) errors.push({ id: m.id, reason: error.message });
          else insertedCount++;
        } catch (inner) {
          errors.push({ id: m.id, reason: inner.message });
        }
      }
    } while (pageToken && pages < 20);

    return res.status(200).json({ ok: true, inserted_count: insertedCount, pages_scanned: pages, q, errors });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
