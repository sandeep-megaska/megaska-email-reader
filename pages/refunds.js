import { useEffect, useState } from 'react';

export default function Refunds() {
  const today = new Date();
  const d14 = new Date(today.getTime() - 13*24*3600*1000);
  const [start, setStart] = useState(d14.toISOString().slice(0,10));
  const [end, setEnd] = useState(today.toISOString().slice(0,10));
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    const res = await fetch(`/api/refunds?start=${start}&end=${end}`);
    const json = await res.json();
    setRows(json.rows || []);
    setLoading(false);
  }

  useEffect(()=>{ load(); }, []);

  return (
    <div style={{ padding:20 }}>
      <h1>Amazon Refunds</h1>

      <div style={{ marginBottom: 10 }}>
        <input type="date" value={start} onChange={e=>setStart(e.target.value)} />
        <input type="date" value={end} onChange={e=>setEnd(e.target.value)} />
        <button onClick={load}>Fetch</button>
      </div>

      {loading && <div>Loading...</div>}

      <table border="1" cellPadding="6">
        <thead>
          <tr>
            <th>Date</th>
            <th>Order</th>
            <th>Amount</th>
            <th>Customer</th>
            <th>Item</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{r.date}</td>
              <td>{r.order_id}</td>
              <td>{r.amount}</td>
              <td>{r.customer}</td>
              <td>{r.item}</td>
              <td>{r.refund_reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
