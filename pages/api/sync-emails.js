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

export default async function handler(req, res) {
  try {
    const auth = getOAuthClient();
    const gmail = google.gmail({ version: "v1", auth });

    const q = 'subject:("Payment Received in virtual account" OR "Payment release successful")';
    const listRes = await gmail.users.messages.list({ userId: "me", q, maxResults: 50 });
    const messages = listRes.data.messages || [];
    const inserted = [];

    for (const m of messages) {
      const { data: exists } = await supabaseAdmin
        .from("payments").select("id").eq("email_id", m.id).limit(1);
      if (exists && exists.length) continue;

      const msgRes = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });

      const headers = msgRes.data.payload.headers || [];
      const subject = (headers.find(h=>h.name==="Subject")||{}).value || "";
      const dateHeader = (headers.find(h=>h.name==="Date")||{}).value;
      const receivedAt = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();

      let body = "";
      const stack = [msgRes.data.payload];
      while (stack.length) {
        const part = stack.pop();
        if (!part) continue;
        if (part.parts) stack.push(...part.parts);
        if (part.mimeType === "text/plain" && part.body?.data) {
          body += Buffer.from(part.body.data, "base64").toString("utf-8") + "\n";
        }
      }
      if (!body && msgRes.data.payload?.body?.data) {
        body = Buffer.from(msgRes.data.payload.body.data, "base64").toString("utf-8");
      }

      const virtualMatch = body.match(/credited.*?virtual account.*?(?:INR|Rs\.?)\s?([\d,]+(?:\.\d{1,2})?)/i)
        || subject.match(/(?:INR|Rs\.?)\s?([\d,]+(?:\.\d{1,2})?)/i);
      const indifiMatch = body.match(/EMI(?: deduction| deducted)?.*?(?:INR|Rs\.?)\s?([\d,]+(?:\.\d{1,2})?)/i)
        || body.match(/deducted.*?(?:INR|Rs\.?)\s?([\d,]+(?:\.\d{1,2})?)/i);
      const bankMatch = body.match(/(transferred|credited).*?bank.*?(?:INR|Rs\.?)\s?([\d,]+(?:\.\d{1,2})?)/i);
      const txnMatch = body.match(/\b(?:Ref|Reference|TXN|Transaction)\s*[:#-]?\s*([A-Za-z0-9-_.]+)/i);

      const row = {
        email_id: m.id,
        received_at: receivedAt,
        source: subject.includes("virtual account") ? "virtual_account"
              : subject.includes("release") ? "indifi_release" : "email",
        transaction_ref: txnMatch?.[1] || null,
        virtual_amount: parseAmount(virtualMatch?.[1] || null),
        indifi_deduction: parseAmount(indifiMatch?.[1] || null),
        bank_credit: parseAmount(bankMatch?.[2] || null),
        raw_subject: subject,
        raw_body: body,
        parsed: true
      };

      const { error } = await supabaseAdmin.from("payments").insert([row]);
      if (!error) inserted.push(m.id);
    }

    res.status(200).json({ ok: true, inserted_count: inserted.length, inserted });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
