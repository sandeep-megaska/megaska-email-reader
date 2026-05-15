import { useEffect, useMemo, useState } from 'react';

const exportHeaders = [
  ['date', 'Date'],
  ['order_id', 'Order ID'],
  ['amount', 'Amount'],
  ['customer', 'Customer'],
  ['fulfilment', 'Fulfilment'],
  ['asin', 'ASIN'],
  ['sku', 'SKU'],
  ['order_quantity', 'Order Quantity'],
  ['return_quantity', 'Return Quantity'],
  ['item', 'Item'],
  ['refund_reason', 'Refund Reason'],
  ['subject', 'Email Subject'],
  ['from', 'From']
];

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows) {
  const lines = [exportHeaders.map(([, label]) => csvEscape(label)).join(',')];
  for (const row of rows) {
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
  const headerCells = exportHeaders.map(([, label]) => `<th>${htmlEscape(label)}</th>`).join('');
  const bodyRows = rows.map(row => (
    `<tr>${exportHeaders.map(([key]) => `<td>${htmlEscape(row[key])}</td>`).join('')}</tr>`
  )).join('');

  return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body>
<table border="1">
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

  return (
    <div style={{ fontFamily: 'system-ui, Arial', padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <h1>Amazon Refunds</h1>
      <p style={{ color: '#666' }}>
        Track Amazon refund initiated emails by order, amount, SKU, item, customer, and reason.
      </p>

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

      <div style={{ marginBottom: 10, fontSize: 14, color: '#444' }}>
        <b>Rows:</b> {rows.length} &nbsp;|&nbsp; <b>Total refund amount:</b> INR {totalAmount.toFixed(2)}
      </div>

      {error && <div style={{ color: 'crimson', marginBottom: 12 }}>Error: {error}</div>}
      {loading && <div>Loading...</div>}

      <div style={{ overflowX: 'auto', border:'1px solid #eee', borderRadius:8 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ background:'#fafafa' }}>
              <th style={th}>Date</th>
              <th style={th}>Order</th>
              <th style={th}>Amount</th>
              <th style={th}>Customer</th>
              <th style={th}>ASIN</th>
              <th style={th}>SKU</th>
              <th style={th}>Qty</th>
              <th style={th}>Return Qty</th>
              <th style={th}>Item</th>
              <th style={th}>Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={10} style={{ padding:14, textAlign:'center', color:'#777' }}>No data</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id}>
                <td style={td}>{r.date}</td>
                <td style={td}>{r.order_id}</td>
                <td style={tdRight}>{(Number(r.amount) || 0).toFixed(2)}</td>
                <td style={td}>{r.customer}</td>
                <td style={td}>{r.asin}</td>
                <td style={td}>{r.sku}</td>
                <td style={tdRight}>{r.order_quantity}</td>
                <td style={tdRight}>{r.return_quantity}</td>
                <td style={td}>{r.item}</td>
                <td style={td}>{r.refund_reason}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ background:'#f6faff', fontWeight: 600 }}>
              <td style={td}>TOTAL</td>
              <td style={td}></td>
              <td style={tdRight}>{totalAmount.toFixed(2)}</td>
              <td style={td} colSpan={7}></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

const th = { textAlign:'left', padding:'10px 12px', borderBottom:'1px solid #eee', whiteSpace:'nowrap' };
const td = { padding:'10px 12px', borderBottom:'1px solid #f2f2f2', verticalAlign:'top' };
const tdRight = { ...td, textAlign:'right', fontVariantNumeric:'tabular-nums' };
