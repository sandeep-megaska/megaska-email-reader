import { supabaseAdmin } from "./_supabase";

function csvLine(arr) {
  return arr.map(v => {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }).join(",");
}

export default async function handler(req, res) {
  try {
    const { from = "1970-01-01", to } = req.query;
    const toDate = to ? `${to} 23:59:59` : new Date().toISOString();

    // Reuse the logic from /api/summary (inline to keep this file standalone)
    const { data: rows, error } = await supabaseAdmin
      .from("payments")
      .select("id, received_at, kind, virtual_amount, bank_credit, indifi_deduction, transaction_ref")
      .gte("received_at", from)
      .lte("received_at", toDate)
      .order("received_at", { ascending: true });

    if (error) return res.status(500).json({ ok: false, error: error.message });

    let bucket = [];
    const settlements = [];
    for (const r of rows) {
      if (r.kind === "virtual_credit" || r.kind === "emi_deduction_explicit") {
        bucket.push(r);
      } else if (r.kind === "release_to_bank") {
        const credits = bucket.filter(x => x.kind === "virtual_credit");
        const explicit = bucket.find(x => x.kind === "emi_deduction_explicit");
        const total_virtual = credits.reduce((s, x) => s + (x.virtual_amount || 0), 0);
        const bank_credit = r.bank_credit || 0;
        const explicit_deduction = explicit?.indifi_deduction ?? null;
        const inferred_deduction = Math.max(0, total_virtual - bank_credit);
        settlements.push({
          window_start: bucket[0]?.received_at || r.received_at,
          window_end: r.received_at,
          credits_count: credits.length,
          total_virtual: +total_virtual.toFixed(2),
          bank_credit: +bank_credit.toFixed(2),
          deduction: +(explicit_deduction ?? inferred_deduction).toFixed(2),
          release_ref: r.transaction_ref || "",
        });
        bucket = [];
      }
    }

    // CSV
    const header = ["Window Start","Window End","Credits Count","Total Virtual (INR)","Released to Bank (INR)","Deduction (INR)","Release Ref"];
    const lines = [csvLine(header)];
    for (const s of settlements) {
      lines.push(csvLine([
        s.window_start,
        s.window_end,
        s.credits_count,
        s.total_virtual,
        s.bank_credit,
        s.deduction,
        s.release_ref
      ]));
    }
    const csv = lines.join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="megaska_settlements_${from}_to_${to || "today"}.csv"`);
    res.status(200).send(csv);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
