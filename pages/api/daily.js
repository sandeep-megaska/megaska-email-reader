import { supabaseAdmin } from "./_supabase";

// Back-compat: map old `source` to `kind`
function asKind(row) {
  if (row.kind) return row.kind;
  if (row.source === "virtual_account") return "virtual_credit";
  if (row.source === "indifi_release") return "release_to_bank";
  return "unknown";
}

export default async function handler(req, res) {
  try {
    const { from = "1970-01-01", to } = req.query;
    const toDate = to ? `${to} 23:59:59` : new Date().toISOString();

    const { data: rows, error } = await supabaseAdmin
      .from("payments")
      .select("received_at, kind, source, virtual_amount, bank_credit")
      .gte("received_at", from)
      .lte("received_at", toDate);

    if (error) return res.status(500).json({ ok:false, error: error.message });

    const norm = (rows || []).map(r => ({ ...r, kind: asKind(r) }));
    const byDay = new Map(); // day -> { virtual, bank, v_count, b_count }

    function dayOf(ts){ return String(ts).slice(0,10); }

    for (const r of norm) {
      const day = dayOf(r.received_at);
      if (!byDay.has(day)) byDay.set(day, { date: day, virtual: 0, bank: 0, v_count: 0, b_count: 0 });
      const agg = byDay.get(day);
      if (r.kind === "virtual_credit") { agg.virtual += Number(r.virtual_amount || 0); agg.v_count++; }
      if (r.kind === "release_to_bank") { agg.bank    += Number(r.bank_credit   || 0); agg.b_count++; }
    }

    const rowsOut = Array.from(byDay.values())
      .sort((a,b)=> a.date.localeCompare(b.date))
      .map(x => ({
        date: x.date,
        virtual_amount: +x.virtual.toFixed(2),
        bank_credit: +x.bank.toFixed(2),
        deduction: +(Math.max(0, x.virtual - x.bank)).toFixed(2),
        virtual_emails: x.v_count,
        release_emails: x.b_count,
      }));

    // Grand totals (range)
    const totals = rowsOut.reduce((t, r) => {
      t.virtual += r.virtual_amount; t.bank += r.bank_credit; t.deduction += r.deduction; return t;
    }, { virtual:0, bank:0, deduction:0 });
    totals.virtual = +totals.virtual.toFixed(2);
    totals.bank    = +totals.bank.toFixed(2);
    totals.deduction = +totals.deduction.toFixed(2);

    res.status(200).json({ ok:true, from, to: to || toDate.slice(0,10), totals, rows: rowsOut });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
}
