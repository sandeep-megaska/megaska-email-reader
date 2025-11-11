import { useEffect, useMemo, useState } from 'react';

function toCSV(rows) {
  const headers = ['date','amazon_disbursed','virtual_received','released_to_icici','released_to_indifi'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      r.date,
      (r.amazon_disbursed || 0).toFixed(2),
      (r.virtual_received || 0).toFixed(2),
      (r.released_to_icici || 0).toFixed(2),
      (r.released_to_indifi || 0).toFixed(2),
    ].join(','));
  }
  return lines.join('\n');
}

export default function Settlements() {
  const today = new Date();
  const d14 = new Date(today.getTime() - 13*24*3600*1000);
  const [start, setStart] = useState(d14.toISOString().slice(0,10));
  const [end, setEnd] = useState(today.toISOString().slice(0,10));
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');

  const totals = useMemo(() => {
    return rows.reduce((acc, r) => {
      acc.amazon += r.amazon_disbursed || 0;
      acc.in += r.virtual_received || 0;
      acc.outIcici += r.released_to_icici || 0;
      acc.outIndifi += r.released_to_indifi || 0;
      return acc;
    }, { amazon: 0, in: 0, outIcici: 0, outIndifi: 0 });
  }, [rows]);

  async function load() {
    setError('');
    setLoading(true);
    try {
      const url = `/api/transactions?start=${start}&end=${end}`;
      const res = await fetch(url);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed');
      setRows(json.rows || []);
      setMeta({ tz: json.tz, count: json.count, start: json.start, end: json.end });
    } catch (e) {
      setError(e.message);
      setRows([]);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }

  function exportCSV() {
    const blob = new Blob([toCSV(rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `settlements_${start}_to_${end}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  useEffect(() => { load(); }, []); // auto-load on mount

  return (
    <div style={{ fontFamily: 'system-ui, Arial', padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h1>Amazon ↔ Indifi ↔ ICICI – Settlements</h1>
      <p style={{ color: '#666' }}>
        Pick a date range to see the daily transactions details between amazon, virtual account, BIGONBUY and Indifi Accounts.
      </p>

      <div style={{ display:'flex', gap:12, alignItems:'center', margin:'12px 0 18px' }}>
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
      </div>

      {meta && (
        <div style={{ marginBottom: 10, fontSize: 14, color: '#444' }}>
          <b>Rows:</b> {meta.count} &nbsp;|&nbsp; <b>TZ:</b> {meta.tz} &nbsp;|&nbsp; Range: {meta.start} → {meta.end}
        </div>
      )}

      {error && <div style={{ color: 'crimson', marginBottom: 12 }}>Error: {error}</div>}

      <div style={{ overflowX: 'auto', border:'1px solid #eee', borderRadius:8 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr style={{ background:'#fafafa' }}>
              <th style={th}>Date</th>
              <th style={th}>Amazon Disbursed (INR)</th>
              <th style={th}>Received in Virtual A/c (INR)</th>
              <th style={th}>Released to BIGONBUY (INR)</th>
              <th style={th}>Released to Indifi (INR)</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={5} style={{ padding:14, textAlign:'center', color:'#777' }}>No data</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.date}>
                <td style={td}>{r.date}</td>
                <td style={tdRight}>{(r.amazon_disbursed || 0).toFixed(2)}</td>
                <td style={tdRight}>{(r.virtual_received || 0).toFixed(2)}</td>
                <td style={tdRight}>{(r.released_to_icici || 0).toFixed(2)}</td>
                <td style={tdRight}>{(r.released_to_indifi || 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ background:'#f6faff', fontWeight: 600 }}>
              <td style={td}>TOTAL</td>
              <td style={tdRight}>{totals.amazon.toFixed(2)}</td>
              <td style={tdRight}>{totals.in.toFixed(2)}</td>
              <td style={tdRight}>{totals.outIcici.toFixed(2)}</td>
              <td style={tdRight}>{totals.outIndifi.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

const th = { textAlign:'left', padding:'10px 12px', borderBottom:'1px solid #eee' };
const td = { padding:'10px 12px', borderBottom:'1px solid #f2f2f2' };
const tdRight = { ...td, textAlign:'right', fontVariantNumeric:'tabular-nums' };
