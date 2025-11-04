// pages/api/sync-emails.js
import { google } from "googleapis";
import { supabaseAdmin } from "./_supabase";

function getOAuthClient() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    "http://localhost"
  );
  oAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return oAuth2Client;
}

function parseAmount(s) {
  if (!s) return null;
  const n = String(s).replace(/[^\d.]/g, "");
  return n ? parseFloat(n) : null;
}

function htmlToText(html) {
  // lightweight HTML → text: keep line breaks, strip tags
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function extractBody(payload) {
  let text = "";
  const stack = [payload];
  while (stack.length) {
    const part = stack.pop();
    if (!part) continue;
    if (part.parts) stack.push(...part.parts);
    const body = part.body?.data ? Buffer.from(part.body.data, "base64").toString("utf-8") : "";
    if (part.mimeType === "text/plain" && body) text += body + "\n";
    if (part.mimeType === "text/html" && body) text += htmlToText(body) + "\n";
  }
  // Fallback to top-level body if no parts
  if (!text && payload?.body?.data) {
    text = Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  return text;
}

export default async function handler(req, res) {
  try {
    const auth = getOAuthClient();
    const gmail = google.gmail({ version: "v1", auth });

    // Backfill days (default 120). You can call /api/sync-emails?days=365
    const days = Math.max(1, Math.min(3650, parseInt(req.query.days || "120", 10)));
    const since = new Date(Date.now() - days * 86400000);
    const after = Math.floor(since.getTime() / 1000); // Gmail epoch seconds

    // BROAD query: subjects OR generic phrases; also limit to after:<since>
    const q = [
      '(subject:"Payment Received in virtual account")',
      '(subject:"Payment release successful")',
      // add more if needed:
      '(subject:"Payment received" virtual)',
      '(subject:"Payment release" OR subject:"released to bank")'
    ].join(" OR ") + ` after:${after}`;

    const dryRun = req.query.dry === "1";
    let pageToken = undefined;
    let totalInserted = 0;
    let pages = 0;

    do {
      const listRes = await gmail.users.messages.list({
        userId: "me",
        q,
        maxResults: 100,
        pageToken
      });
      const messages = listRes.data.messages || [];
      pageToken = listRes.data.nextPageToken || undefined;
      pages++;

      for (const m of messages) {
        // Skip duplicates
        const { data: exists } = await supabaseAdmin
          .from("payments").select("id").eq("email_id", m.id).limit(1);
        if (exists && exists.length) continue;

        const msgRes = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
        const payload = msgRes.data.payload;

        const headers = payload.headers || [];
        const subject = (headers.find(h => h.name === "Subject") || {}).value || "";
        const dateHeader = (headers.find(h => h.name === "Date") || {}).value;
        const receivedAt = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();

        const bodyText = extractBody(payload);

        // Regexes (tune if needed)
        const virtualMatch =
          bodyText.match(/credited.*?virtual account.*?(?:INR|Rs\.?)\s?([\d,]+(?:\.\d{1,2})?)/i) ||
          subject.match(/(?:INR|Rs\.?)\s?([\d,]+(?:\.\d{1,2})?)/i);
        const indifiMatch =
          bodyText.match(/EMI(?: deduction| deducted)?.*?(?:INR|Rs\.?)\s?([\d,]+(?:\.\d{1,2})?)/i) ||
          bodyText.match(/(?:deducted|debit).*?(?:INR|Rs\.?)\s?([\d,]+(?:\.\d{1,2})?)/i);
        const bankMatch =
          bodyText.match(/(transferred|credited).*?bank.*?(?:INR|Rs\.?)\s?([\d,]+(?:\.\d{1,2})?)/i);

        const txnMatch = bodyText.match(/\b(?:Ref(?:erence)?|TXN|Transaction)\s*[:#-]?\s*([A-Za-z0-9/_-]+)/i);

        const row = {
          email_id: m.id,
          received_at: receivedAt,
          source: subject.toLowerCase().includes("virtual account")
            ? "virtual_account"
            : subject.toLowerCase().includes("release")
            ? "indifi_release"
            : "email",
          transaction_ref: txnMatch?.[1] || null,
          virtual_amount: parseAmount(virtualMatch?.[1] || null),
          indifi_deduction: parseAmount(indifiMatch?.[1] || null),
          bank_credit: parseAmount(bankMatch?.[2] || null),
          raw_subject: subject,
          raw_body: bodyText,
          parsed: true
        };

        if (dryRun) {
          console.log("[DRY] would insert:", row);
          continue;
        }

        const { error } = await supabaseAdmin.from("payments").insert([row]);
        if (!error) totalInserted++;
        else console.error("Supabase insert error:", error.message);
      }
    } while (pageToken && pages < 20); // safety cap: 20 pages * 100 = 2000 emails

    res.status(200).json({ ok: true, inserted_count: totalInserted, days, pages_scanned: pages, dryRun });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
