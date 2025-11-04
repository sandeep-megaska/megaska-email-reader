import { supabaseAdmin } from "./_supabase";

const INR = String.raw`(?:INR|₹|Rs\.?)\s*`;
const AMT = String.raw`([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)`;
const RE_VIRTUAL_STRICT_1 = new RegExp(`amount\\s+of\\s+${INR}${AMT}\\s+has\\s+been\\s+credited\\s+to\\s+Virtual\\s+Code`, "i");
const RE_VIRTUAL_STRICT_2 = new RegExp(`${INR}${AMT}\\s+has\\s+been\\s+credited\\s+to\\s+Virtual\\s+Code`, "i");
const RE_VIRTUAL_LOOSE    = new RegExp(`credited.*?${INR}${AMT}`, "i");
const RE_RELEASE_AMOUNT   = new RegExp(`amount\\s+of\\s+${INR}${AMT}[^\\n]*?released\\s+to\\s+the\\s+registered\\s+bank\\s+account`, "i");
const RE_BANK_GENERIC     = new RegExp(`(?:transferred|credited)\\s+.*?\\bbank\\b.*?${INR}${AMT}`, "i");
const RE_REF_VIDE         = /\bvide\s+([A-Za-z0-9][A-Za-z0-9/_-]{5,32})\b/i;
const RE_REF_GENERIC      = /\b(?:Ref(?:erence)?|TXN|Transaction)\s*[:#-]?\s*([A-Za-z0-9/_-]{6,32})\b/i;
const RE_DEDUCT           = new RegExp(`(?:EMI\\s*(?:deduction|deducted)|deducted|debited?)\\D*${INR}${AMT}`, "i");

function parseINR(s) {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/[^0-9.]/g, "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export default async function handler(req, res) {
  const { data: rows, error } = await supabaseAdmin
    .from("payments")
    .select("id, source, raw_subject, raw_body, virtual_amount, bank_credit, indifi_deduction, transaction_ref")
    .limit(2000);

  if (error) return res.status(500).json({ ok: false, error: error.message });

  let updated = 0;
  for (const r of rows) {
    const body = r.raw_body || "";
    const subj = r.raw_subject || "";
    const isVirtual = /virtual code/i.test(body) || /Payment Received in virtual account/i.test(subj);
    const isRelease = /Payment release successful/i.test(subj) || /Payment release succesfull/i.test(subj);

    let virtual_amount = r.virtual_amount;
    let bank_credit    = r.bank_credit;
    let indifi_deduction = r.indifi_deduction;
    let transaction_ref  = r.transaction_ref;

    if (isVirtual) {
      const m1 = body.match(RE_VIRTUAL_STRICT_1) || body.match(RE_VIRTUAL_STRICT_2) || body.match(RE_VIRTUAL_LOOSE);
      const v = parseINR(m1?.[1] || null);
      virtual_amount = (v != null && v >= 500) ? v : null;
      bank_credit = null; // never from virtual mails
    }
    if (isRelease) {
      const a = body.match(RE_RELEASE_AMOUNT) || body.match(RE_BANK_GENERIC);
      const b = parseINR(a?.[1] || null);
      bank_credit = (b != null && b >= 500) ? b : null;
      virtual_amount = null; // never from release mails
    }

    // deduction
    if (indifi_deduction == null) {
      const d = body.match(RE_DEDUCT);
      const dAmt = parseINR(d?.[1] || null);
      indifi_deduction = (dAmt != null && dAmt >= 1) ? dAmt : indifi_deduction;
    }

    // ref (reject too-short tokens like "is")
    if (!transaction_ref || transaction_ref.length < 6) {
      const r1 = body.match(RE_REF_VIDE) || body.match(RE_REF_GENERIC);
      const ref = r1?.[1] || null;
      transaction_ref = ref && ref.length >= 6 ? ref : null;
    }

    const needUpdate =
      virtual_amount !== r.virtual_amount ||
      bank_credit !== r.bank_credit ||
      indifi_deduction !== r.indifi_deduction ||
      transaction_ref !== r.transaction_ref;

    if (needUpdate) {
      await supabaseAdmin.from("payments").update({
        virtual_amount, bank_credit, indifi_deduction, transaction_ref
      }).eq("id", r.id);
      updated++;
    }
  }

  return res.status(200).json({ ok: true, scanned: rows.length, updated });
}
