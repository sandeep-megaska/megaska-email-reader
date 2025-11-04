import { supabaseAdmin } from "./_supabase";

export default async function handler(req, res) {
  const { from = "1970-01-01", to } = req.query;
  const toDate = to ? `${to} 23:59:59` : new Date().toISOString();

  const { data: rows, error } = await supabaseAdmin
    .from("payments")
    .select("*")
    .gte("received_at", from)
    .lte("received_at", toDate)
    .order("received_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  const totals = rows.reduce((a, r) => {
    a.total_virtual_received += Number(r.virtual_amount || 0);
    a.total_indifi_deduction += Number(r.indifi_deduction || 0);
    a.total_bank_credit += Number(r.bank_credit || 0);
    return a;
  }, { total_virtual_received:0, total_indifi_deduction:0, total_bank_credit:0 });

  res.json({ rows, totals });
}
