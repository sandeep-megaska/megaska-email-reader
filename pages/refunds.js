import { useEffect, useMemo, useState } from 'react';

const exportHeaders = [
  ['marketplace', 'bbbbbbbbb'],
  ['order_id', 'Oder id'],
  ['forward_courier', 'Forward Co'],
  ['refund_initiated_date', 'Refund initia'],
  ['return_courier', 'Return'],
  ['return_date', 'Return date'],
  ['refund_reason', 'Refund reoason'],
  ['sku', 'SKU'],
  ['qty', 'Qty']
];

function reportRows(rows) {
  return rows.map(row => ({
    marketplace: 'Flex',
    order_id: row.order_id || '',
    forward_courier: '',
    refund_initiated_date: row.refund_initiated_timestamp || '',
    return_courier: '',
    return_date: '',
    refund_reason: row.refund_reason || '',
    sku: row.sku || '',
    qty: row.return_quantity || row.order_quantity || '',
  }));
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows) {
  const formattedRows = reportRows(rows);
  const lines = [exportHeaders.map(([, label]) => csvEscape(label)).join(',')];
  for (const row of formattedRows) {
    lines.push(exportHeaders.map(([key]) => csvEscape(row[key])).join(','));
  }
  return lines.join('\n');
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toExcelHtml(rows) {
  const formattedRows = reportRows(rows);
  const headerCells = exportHeaders.map(([, label]) => `<th style="border:1px solid #ccc;">${htmlEscape(label)}</th>`).join('');
  const bodyRows = formattedRows.map(row => (
    `<tr>${exportHeaders.map(([key]) => `<td style="border:1px solid #ccc;">${htmlEscape(row[key])}</td>`).join('')}</tr>`
  )).join('');

  return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body>
<table style="border-collapse:collapse;">
<thead><tr>${headerCells}</tr></thead>
<tbody>${bodyRows}</tbody>
</table>
</body>
</html>`;
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Refunds() {
  const today = new Date();
  const d14 = new Date(today.getTime() - 13*24*3600*1000);
  const [start, setStart] = useState(d14.toISOString().slice(0,10));
  const [end, setEnd] = useState(today.toISOString().slice(0,10));
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const totalAmount = useMemo(() => {
    return rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  }, [rows]);

  async function load() {
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`/api/refunds?start=${start}&end=${end}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to fetch refunds');
      setRows(json.rows || []);
    } catch (e) {
      setError(e.message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  function exportCSV() {
    downloadFile(
      toCSV(rows),
      `amazon_refunds_${start}_to_${end}.csv`,
      'text/csv;charset=utf-8;'
    );
  }

  function exportExcel() {
    downloadFile(
      toExcelHtml(rows),
      `amazon_refunds_${start}_to_${end}.xls`,
      'application/vnd.ms-excel;charset=utf-8;'
    );
  }

  useEffect(()=>{ load(); }, []);

  const displayRows = reportRows(rows);

  return (
    <div style={{ fontFamily: 'system-ui, Arial', padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <h1>Amazon Refunds</h1>

      <div style={{ display:'flex', gap:12, alignItems:'center', flexWrap:'wrap', margin:'12px 0 18px' }}>
        <label>Start:&nbsp;
          <input type="date" value={start} onChange={e=>setStart(e.target.value)} />
        </label>
        <label>End:&nbsp;
          <input type="date" value={end} onChange={e=>setEnd(e.target.value)} />
        </label>
        <button onClick={load} disabled={loading} style={{ padding:'8px 14px' }}>
          {loading ? 'Loading…' : 'Fetch'}
        </button>
        <button onClick={exportCSV} disabled={!rows.length} style={{ padding:'8px 14px' }}>
          Export CSV
        </button>
        <button onClick={exportExcel} disabled={!rows.length} style={{ padding:'8px 14px' }}>
          Export Excel
        </button>
      </div>

      <div style={{ marginBottom: 10 }}>
        Rows: {rows.length} | Total refund amount: INR {totalAmount.toFixed(2)}
      </div>

      {error && <div style={{ color: 'red' }}>Error: {error}</div>}
      {loading && <div>Loading...</div>}

      <table style={{ borderCollapse:'collapse', width:'100%' }}>
        <thead>
          <tr>
            {exportHeaders.map(([, label]) => <th key={label} style={{ border:'1px solid #ccc', padding:8 }}>{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {displayRows.map((r, idx) => (
            <tr key={rows[idx]?.row_key || idx}>
              {exportHeaders.map(([key]) => (
                <td key={key} style={{ border:'1px solid #ccc', padding:8 }}>{r[key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
