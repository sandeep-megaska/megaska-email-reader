import { supabaseAdmin } from "./_supabase";

function csvLine(arr) {
  return arr.map(v => {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }).join(",");
}

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

    const totalVirtual = norm
      .filter(r => r.kind === "virtual_credit")
      .reduce((s, r) => s + (Number(r.virtual_amount) || 0), 0);

    const totalBank = norm
      .filter(r => r.kind === "release_to_bank")
      .reduce((s, r) => s + (Number(r.bank_credit) || 0), 0);

    const deduction = Math.max(0, totalVirtual - totalBank);

    const header = ["From","To","Total Virtual (INR)","Total Released to Bank (INR)","Deduction (INR)","Virtual Credits (count)","Releases (count)"];
    const row = [
      from,
      to || toDate.slice(0,10),
      totalVirtual.toFixed(2),
      totalBank.toFixed(2),
      deduction.toFixed(2),
      norm.filter(r => r.kind === "virtual_credit").length,
      norm.filter(r => r.kind === "release_to_bank").length
    ];

    const csv = [csvLine(header), csvLine(row)].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="megaska_totals_${from}_to_${to || "today"}.csv"`);
    res.status(200).send(csv);
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
}
