// pages/api/export.js
import { createClient } from '@supabase/supabase-js';
import { Parser } from 'json2csv';
import ExcelJS from 'exceljs';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  const { from, to, format = 'csv' } = req.query;
  const fromDate = from || '1970-01-01';
  const toDate = to || new Date().toISOString().slice(0,10);

  const { data: rows, error } = await supabase
    .from('payments')
    .select('*')
    .gte('received_at', fromDate)
    .lte('received_at', toDate + ' 23:59:59')
    .order('received_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  // enrich with computed columns
  const enriched = rows.map(r => ({
    received_at: r.received_at,
    source: r.source,
    transaction_ref: r.transaction_ref,
    virtual_amount: r.virtual_amount ?? '',
    indifi_deduction: r.indifi_deduction ?? '',
    bank_credit: r.bank_credit ?? '',
    computed_net_to_bank: ( (r.bank_credit ?? 0) ).toFixed(2),
    raw_subject: r.raw_subject
  }));

  if (format === 'csv') {
    const parser = new Parser();
    const csv = parser.parse(enriched);
    res.setHeader('Content-disposition', `attachment; filename=megaska_statement_${fromDate}_to_${toDate}.csv`);
    res.setHeader('Content-Type', 'text/csv');
    return res.send(csv);
  } else {
    // xlsx
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Statement');
    ws.columns = Object.keys(enriched[0] || {}).map(k => ({ header: k, key: k, width: 20 }));
    ws.addRows(enriched);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-disposition', `attachment; filename=megaska_statement_${fromDate}_to_${toDate}.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  }
}
