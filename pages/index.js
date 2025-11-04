import { useState } from 'react';

export default function Page() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rows, setRows] = useState(null);

  async function fetchStatement() {
    const res = await fetch(`/api/statement?from=${from}&to=${to}`);
    const json = await res.json();
    setRows(json.rows);
  }

  function downloadCSV() {
    const url = `/api/export?from=${from}&to=${to}&format=csv`;
    window.location.href = url;
  }

  return (
    <div style={{ padding: 20 }}>
      <h2>Megaska Payments Statement</h2>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        <input type="date" value={to} onChange={e => setTo(e.target.value)} />
        <button onClick={fetchStatement}>View</button>
        <button onClick={downloadCSV}>Download CSV</button>
      </div>

      {rows && (
        <table style={{ width: '100%', marginTop: 16, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th>Date</th><th>Source</th><th>Virtual Amount</th><th>Indifi Deduction</th><th>Bank Credit</th><th>Ref</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{new Date(r.received_at).toLocaleString()}</td>
                <td>{r.source}</td>
                <td>{r.virtual_amount ?? ''}</td>
                <td>{r.indifi_deduction ?? ''}</td>
                <td>{r.bank_credit ?? ''}</td>
                <td>{r.transaction_ref}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
