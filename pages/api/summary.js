import { supabaseAdmin } from "./_supabase";

/**
 * Returns:
 * {
 *   ok: true,
 *   grand: { total_virtual, total_bank, total_inferred_deduction, total_explicit_deduction },
 *   settlements: [
 *     {
 *       window_start, window_end,
 *       credits_count, total_virtual, bank_credit, inferred_deduction, explicit_deduction,
 *       release_ref, release_at
 *     }, ...
 *   ],
 *   unmatched: { virtual_credits: [...], releases: [...] }
 * }
 */
export default async function handler(req, res) {
  try {
    const { from = "1970-01-01", to } = req.query;
    const toDate = to ? `${to} 23:59:59` : new Date().toISOString();

    // Get all emails in range ordered by time
    const { data: rows, error } = await supabaseAdmin
      .from("payments")
      .select("id, received_at, kind, virtual_amount, bank_credit, indifi_deduction, transaction_ref, raw_subject")
      .gte("received_at", from)
      .lte("received_at", toDate)
      .order("received_at", { ascending: true });

    if (error) return res.status(500).json({ ok: false, error: error.message });

    // Walk forward: accumulate virtual credits until we hit a release; flush as a settlement
    let bucket = [];
    const settlements = [];
    const unmatchedVirtual = [];
    const unmatchedReleases = [];

    for (const r of rows) {
      if (r.kind === "virtual_credit") {
        bucket.push(r);
      } else if (r.kind === "emi_deduction_explicit") {
        // keep inside bucket to display explicit deduction when we flush
        bucket.push(r);
      } else if (r.kind === "release_to_bank") {
        const credits = bucket.filter(x => x.kind === "virtual_credit");
        const explicit = bucket.find(x => x.kind === "emi_deduction_explicit");
        const total_virtual = credits.reduce((s, x) => s + (x.virtual_amount || 0), 0);
        const bank_credit = r.bank_credit || 0;
        const explicit_deduction = explicit?.indifi_deduction || null;
        const inferred_deduction = Math.max(0, total_virtual - bank_credit);

        if (credits.length === 0 && !explicit) {
          // release with no preceding credits in window → unmatched
          unmatchedReleases.push(r);
        } else {
          settlements.push({
            window_start: bucket[0]?.received_at || r.received_at,
            window_end: r.received_at,
            credits_count: credits.length,
            total_virtual: Number(total_virtual.toFixed(2)),
            bank_credit: Number(bank_credit.toFixed(2)),
            inferred_deduction: Number(inferred_deduction.toFixed(2)),
            explicit_deduction: explicit_deduction != null ? Number(explicit_deduction.toFixed(2)) : null,
            release_ref: r.transaction_ref || null,
            release_at: r.received_at,
          });
        }

        bucket = []; // reset window after a release
      }
    }

    // Anything left in the bucket is “virtual credits waiting for next release”
    for (const v of bucket.filter(x => x.kind === "virtual_credit")) {
      unmatchedVirtual.push(v);
    }

    // Grand totals for the range (simple sums)
    const grand = {
      total_virtual: Number(rows.filter(r => r.kind === "virtual_credit").reduce((s, r) => s + (r.virtual_amount || 0), 0).toFixed(2)),
      total_bank: Number(rows.filter(r => r.kind === "release_to_bank").reduce((s, r) => s + (r.bank_credit || 0), 0).toFixed(2)),
      total_explicit_deduction: Number(rows.filter(r => r.kind === "emi_deduction_explicit").reduce((s, r) => s + (r.indifi_deduction || 0), 0).toFixed(2)),
    };

    // Inferred total deduction across settlements (when no explicit)
    grand.total_inferred_deduction = Number(
      settlements.reduce((s, st) => s + (st.explicit_deduction ?? st.inferred_deduction), 0).toFixed(2)
    );

    res.status(200).json({ ok: true, grand, settlements, unmatched: { virtual_credits: unmatchedVirtual, releases: unmatchedReleases } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
