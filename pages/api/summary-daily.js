import { supabaseAdmin } from "./_supabase";

function d(dts) { return dts.slice(0,10); }

export default async function handler(req, res) {
  try {
    const { from = "1970-01-01", to } = req.query;
    const toDate = to ? `${to} 23:59:59` : new Date().toISOString();

    const { data: rows, error } = await supabaseAdmin
      .from("payments")
      .select("received_at, kind, virtual_amount, bank_credit, indifi_deduction")
      .gte("received_at", from)
      .lte("received_at", toDate);

    if (error) return res.status(500).json({ ok:false, error: error.message });

    const map = {};
    for (const r of rows) {
      const day = d(r.received_at);
      map[day] ||= { date: day, virtual: 0, bank: 0, explicit_deduct: 0 };
      if (r.kind === "virtual_credit") map[day].virtual += (r.virtual_amount || 0);
      if (r.kind === "release_to_bank") map[day].bank    += (r.bank_credit || 0);
      if (r.kind === "emi_deduction_explicit") map[day].explicit_deduct += (r.indifi_deduction || 0);
    }

    const daily = Object.values(map).sort((a,b) => a.date.localeCompare(b.date))
      .map(x => ({
        date: x.date,
        total_virtual: Number(x.virtual.toFixed(2)),
        total_bank: Number(x.bank.toFixed(2)),
        total_explicit_deduction: Number(x.explicit_deduct.toFixed(2)),
        inferred_gap: Number((x.virtual - x.bank).toFixed(2)) // simple per-day gap
      }));

    res.json({ ok:true, daily });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
}
