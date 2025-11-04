import { supabaseAdmin } from "./_supabase";
import ExcelJS from "exceljs";

function toCSV(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => esc(r[h])).join(",")),
  ];
  return lines.join("\n");
}

export default async function handler(req, res) {
  const { from = "1970-01-01", to, format = "csv" } = req.query;
  const toDate = to ? `${to} 23:59:59` : new Date().toISOString();

  const { data: rows, error } = await supabaseAdmin
    .from("payments")
    .select("*")
    .gte("received_at", from)
    .lte("received_at", toDate)
    .order("received_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  const enriched = rows.map((r) => ({
    received_at: r.received_at,
    source: r.source,
    transaction_ref: r.transaction_ref,
    virtual_amount: r.virtual_amount ?? "",
    indifi_deduction: r.indifi_deduction ?? "",
    bank_credit: r.bank_credit ?? "",
    computed_net_to_bank: Number(r.bank_credit || 0).toFixed(2),
    raw_subject: r.raw_subject,
  }));

  const fromFile = from.slice(0, 10);
  const toFile = to || new Date().toISOString().slice(0, 10);

  if (format === "csv") {
    const csv = toCSV(enriched);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=megaska_statement_${fromFile}_to_${toFile}.csv`
    );
    res.setHeader("Content-Type", "text/csv");
    return res.send(csv);
  }

  // XLSX export
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Statement");
  if (enriched[0]) {
    ws.columns = Object.keys(enriched[0]).map((k) => ({
      header: k,
      key: k,
      width: 24,
    }));
  }
  ws.addRows(enriched);
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=megaska_statement_${fromFile}_to_${toFile}.xlsx`
  );
  await wb.xlsx.write(res);
  res.end();
}
