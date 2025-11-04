// pages/api/reparse-existing.js
import { supabaseAdmin } from "./_supabase";

const INR = String.raw`(?:INR|₹|Rs\.?)\s*`;
const AMOUNT = String.raw`([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)`;
const RE_VIRTUAL_1 = new RegExp(`amount\\s+of\\s+${INR}${AMOUNT}`, "i");
const RE_VIRTUAL_2 = new RegExp(`${INR}${AMOUNT}\\s+has\\s+been\\s+credited\\s+to\\s+Virtual\\s+Code`, "i");
const RE_VIRTUAL_3 = new RegExp(`credited.*?${INR}${AMOUNT}`, "i");
const RE_DEDUCT = new RegExp(`(?:EMI\\s*(?:deduction|deducted)|deducted|debited?)\\D*${INR}${AMOUNT}`, "i");
const RE_BANK   = new RegExp(`(?:transferred|credited)\\s+.*?\\bbank\\b.*?${INR}${AMOUNT}`, "i");
const RE_REF_VIDE = /\bvide\s+([A-Za-z0-9][A-Za-z0-9/_-]{5,32})\b/i;

function parseAmountStr(s) {
  if (!s) return null;
  const normalized = String(s).replace(/[^0-9.,]/g, "").replace(/,/g, "");
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

export default async function handler(req, res) {
  const updates = [];
  const { data: rows, error } = await supabaseAdmin
    .from("payments")
    .select("id, raw_body, raw_subject, virtual_amount, indifi_deduction, bank_credit, transaction_ref")
    .or("virtual_amount.is.null,transaction_ref.is.null,indifi_deduction.is.null,bank_credit.is.null")
    .limit(1000);

  if (error) return res.status(500).json({ ok: false, error: error.message });

  for (const r of rows) {
    const body = r.raw_body || "";
    const subj = r.raw_subject || "";

    const v1 = body.match(RE_VIRTUAL_1);
    const v2 = v1 ? null : body.match(RE_VIRTUAL_2);
    const v3 = v1 || v2 ? null : body.match(RE_VIRTUAL_3);
    const vAmt = r.virtual_amount ?? parseAmountStr((v1?.[1] || v2?.[1] || v3?.[1]) || null);

    const d1 = body.match(RE_DEDUCT);
    const b1 = body.match(RE_BANK);
    const dAmt = r.indifi_deduction ?? parseAmountStr(d1?.[1] || null);
    const bAmt = r.bank_credit ?? parseAmountStr(b1?.[1] || null);

    const ref  = r.transaction_ref ?? (body.match(RE_REF_VIDE)?.[1] ||
                                       body.match(/\b(?:Ref(?:erence)?|TXN|Transaction)\s*[:#-]?\s*([A-Za-z0-9/_-]{6,32})\b/i)?.[1] || null);

    // Only push if something new to update
    if (vAmt || dAmt || bAmt || ref) {
      updates.push({ id: r.id, virtual_amount: vAmt, indifi_deduction: dAmt, bank_credit: bAmt, transaction_ref: ref });
    }
  }

  // Apply updates one by one (simple & safe)
  for (const u of updates) {
    await supabaseAdmin.from("payments").update({
      virtual_amount: u.virtual_amount,
      indifi_deduction: u.indifi_deduction,
      bank_credit: u.bank_credit,
      transaction_ref: u.transaction_ref
    }).eq("id", u.id);
  }

  return res.status(200).json({ ok: true, scanned: rows.length, updated: updates.length });
}
