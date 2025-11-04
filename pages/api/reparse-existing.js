import { supabaseAdmin } from "./_supabase";

const INR = String.raw`(?:INR|₹|Rs\.?)\s*`;
const AMOUNT = String.raw`([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)`;

const RE_VIRTUAL_1 = new RegExp(`amount\\s+of\\s+${INR}${AMOUNT}`, "i");
const RE_VIRTUAL_2 = new RegExp(`${INR}${AMOUNT}\\s+has\\s+been\\s+credited\\s+to\\s+Virtual\\s+Code`, "i");
const RE_VIRTUAL_3 = new RegExp(`credited.*?${INR}${AMOUNT}`, "i");

const RE_DEDUCT = new RegExp(`(?:EMI\\s*(?:deduction|deducted)|deducted|debited?)\\D*${INR}${AMOUNT}`, "i");

const RE_RELEASE_AMOUNT = new RegExp(
  `amount\\s+of\\s+${INR}${AMOUNT}[^\\n]*?released\\s+to\\s+the\\s+registered\\s+bank\\s+account`,
  "i"
);
const RE_RELEASE_REF = /\bvide\s+([A-Za-z0-9][A-Za-z0-9/_-]{5,32})\b/i;

const RE_BANK_GENERIC = new RegExp(`(?:transferred|credited)\\s+.*?\\bbank\\b.*?${INR}${AMOUNT}`, "i");

function parseAmountStr(s) {
  if (!s) return null;
  const normalized = String(s).replace(/[^0-9.,]/g, "").replace(/,/g, "");
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

export default async function handler(req, res) {
  const { data: rows, error } = await supabaseAdmin
    .from("payments")
    .select("id, source, raw_body, raw_subject, virtual_amount, indifi_deduction, bank_credit, transaction_ref")
    .or("virtual_amount.is.null,indifi_deduction.is.null,bank_credit.is.null,transaction_ref.is.null")
    .limit(2000);

  if (error) return res.status(500).json({ ok: false, error: error.message });

  let updated = 0;

  for (const r of rows) {
    const body = r.raw_body || "";
    const subj = r.raw_subject || "";

    // Virtual
    let vAmt = r.virtual_amount;
    if (vAmt == null) {
      const v1 = body.match(RE_VIRTUAL_1);
      const v2 = v1 ? null : body.match(RE_VIRTUAL_2);
      const v3 = v1 || v2 ? null : body.match(RE_VIRTUAL_3);
      vAmt = parseAmountStr((v1?.[1] || v2?.[1] || v3?.[1]) || null);
    }

    // Deduction
    let dAmt = r.indifi_deduction;
    if (dAmt == null) {
      const d1 = body.match(RE_DEDUCT);
      dAmt = parseAmountStr(d1?.[1] || null);
    }

    // Bank credit
    let bAmt = r.bank_credit;
    if (bAmt == null) {
      const rAmt = body.match(RE_RELEASE_AMOUNT);
      bAmt = parseAmountStr(rAmt?.[1] || null);
      if (bAmt == null) {
        const b1 = body.match(RE_BANK_GENERIC);
        bAmt = parseAmountStr(b1?.[1] || null);
      }
    }

    // Reference
    let ref = r.transaction_ref;
    if (ref == null) {
      ref = (body.match(RE_RELEASE_REF)?.[1] ||
            body.match(/\b(?:Ref(?:erence)?|TXN|Transaction)\s*[:#-]?\s*([A-Za-z0-9/_-]{6,32})\b/i)?.[1] || null);
    }

    if (vAmt != null || dAmt != null || bAmt != null || ref != null) {
      await supabaseAdmin.from("payments").update({
        virtual_amount: vAmt ?? r.virtual_amount,
        indifi_deduction: dAmt ?? r.indifi_deduction,
        bank_credit: bAmt ?? r.bank_credit,
        transaction_ref: ref ?? r.transaction_ref
      }).eq("id", r.id);
      updated++;
    }
  }

  return res.status(200).json({ ok: true, scanned: rows.length, updated });
}
