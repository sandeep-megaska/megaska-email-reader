import { useEffect, useMemo, useState } from 'react';

function money(value) {
  return `INR ${(Number(value) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function fetchReport(url, label) {
  try {
    const res = await fetch(url);
    let json = null;

    try {
      json = await res.json();
    } catch (_) {
      throw new Error(`${label}: server returned an invalid response`);
    }

    if (!res.ok) {
      throw new Error(`${label}: ${json?.error || `HTTP ${res.status}`}`);
    }

    return { data: json, error: '' };
  } catch (e) {
    return {
      data: null,
      error: `${label}: ${e?.message || 'Failed to fetch'}`
    };
  }
}

export default function Dashboard() {
  const today = new Date();
  const d14 = new Date(today.getTime() - 13 * 24 * 3600 * 1000);
  const [start, setStart] = useState(d14.toISOString().slice(0, 10));
  const [end, setEnd] = useState(today.toISOString().slice(0, 10));
  const [loading, setLoading] = useState(false);
  const [settlements, setSettlements] = useState(null);
  const [refunds, setRefunds] = useState(null);
  const [reimbursements, setReimbursements] = useState(null);
  const [sectionErrors, setSectionErrors] = useState({ settlements:'', refunds:'', reimbursements:'' });

  const settlementTotals = useMemo(() => {
    const rows = settlements?.rows || [];
    return rows.reduce((acc, row) => {
      acc.amazon += Number(row.amazon_disbursed) || 0;
      acc.virtual += Number(row.virtual_received) || 0;
      acc.icici += Number(row.released_to_icici) || 0;
      acc.indifi += Number(row.released_to_indifi) || 0;
      return acc;
    }, { amazon: 0, virtual: 0, icici: 0, indifi: 0 });
  }, [settlements]);

  async function load() {
    setLoading(true);
    setSectionErrors({ settlements:'', refunds:'', reimbursements:'' });

    try {
      // Load sequentially to avoid three Gmail-heavy serverless requests competing at the same time.
      const settlementResult = await fetchReport(
        `/api/transactions?start=${start}&end=${end}`,
        'Settlements'
      );
      if (settlementResult.data) setSettlements(settlementResult.data);
      else setSettlements(null);

      const refundResult = await fetchReport(
        `/api/refunds?start=${start}&end=${end}`,
        'Customer refunds'
      );
      if (refundResult.data) setRefunds(refundResult.data);
      else setRefunds(null);

      const reimbursementResult = await fetchReport(
        `/api/reimbursements?start=${start}&end=${end}`,
        'Amazon reimbursements'
      );
      if (reimbursementResult.data) setReimbursements(reimbursementResult.data);
      else setReimbursements(null);

      setSectionErrors({
        settlements: settlementResult.error,
        refunds: refundResult.error,
        reimbursements: reimbursementResult.error
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const refundAmount = refunds?.total_refund_amount || 0;
  const refundEmails = refunds?.analytics?.total_refund_emails ?? 0;
  const refundItems = refunds?.analytics?.total_refund_items ?? (refunds?.rows?.length || 0);
  const reimbursementAmount = reimbursements?.total_reimbursed || 0;
  const reimbursementRows = reimbursements?.count || 0;

  return (
    <div style={{ fontFamily:'system-ui, Arial', padding:24, maxWidth:1200, margin:'0 auto' }}>
      <h1 style={{ marginBottom:8 }}>Finance Overview</h1>
      <p style={{ color:'#666', maxWidth:900 }}>
        Overview of Amazon settlement flows, refunds issued to customers, and reimbursements credited by Amazon to us. Customer refunds and Amazon reimbursements are shown separately because they are different financial events.
      </p>

      <div style={{ display:'flex', gap:12, alignItems:'center', flexWrap:'wrap', margin:'18px 0 24px' }}>
        <label>Start:&nbsp;<input type="date" value={start} onChange={e => setStart(e.target.value)} /></label>
        <label>End:&nbsp;<input type="date" value={end} onChange={e => setEnd(e.target.value)} /></label>
        <button onClick={load} disabled={loading} style={{ padding:'8px 14px' }}>
          {loading ? 'Loading…' : 'Refresh Dashboard'}
        </button>
      </div>

      <h2>Settlement Flow</h2>
      {sectionErrors.settlements && <SectionError text={sectionErrors.settlements} />}
      <div style={grid}>
        <MetricCard title="Amazon Disbursed" value={money(settlementTotals.amazon)} note="Amazon payment communication" unavailable={!settlements} />
        <MetricCard title="Received in Virtual A/c" value={money(settlementTotals.virtual)} note="Funds received into virtual account" unavailable={!settlements} />
        <MetricCard title="Released to BIGONBUY / ICICI" value={money(settlementTotals.icici)} note="Settlement released to company bank account" unavailable={!settlements} />
        <MetricCard title="Released to Indifi" value={money(settlementTotals.indifi)} note="Settlement released to Indifi" unavailable={!settlements} />
      </div>

      <h2 style={{ marginTop:30 }}>Customer Refunds</h2>
      {sectionErrors.refunds && <SectionError text={sectionErrors.refunds} />}
      <div style={grid}>
        <MetricCard title="Refunds Issued to Customers" value={money(refundAmount)} note="Amazon refund initiated communications to customers" unavailable={!refunds} />
        <MetricCard title="Refund Emails" value={refundEmails} note="Distinct refund communications" unavailable={!refunds} />
        <MetricCard title="Refunded Items" value={refundItems} note="Item rows parsed from refund emails" unavailable={!refunds} />
      </div>

      <h2 style={{ marginTop:30 }}>Amazon Reimbursements to Us</h2>
      {sectionErrors.reimbursements && <SectionError text={sectionErrors.reimbursements} />}
      <div style={grid}>
        <MetricCard title="Reimbursements Credited by Amazon" value={money(reimbursementAmount)} note="Amounts Amazon has reimbursed to our seller account" unavailable={!reimbursements} />
        <MetricCard title="Reimbursed Orders" value={reimbursementRows} note="Order reimbursement rows found in Amazon emails" unavailable={!reimbursements} />
      </div>

      <div style={{ marginTop:30, padding:16, border:'1px solid #e5e7eb', borderRadius:10, background:'#fafafa' }}>
        <b>Important:</b> this dashboard does not subtract reimbursements from customer refunds. A reimbursement may arise from lost/damaged inventory, returns/refunds, or another Amazon policy event. Any reconciliation between the two should be done only by matching specific order IDs and reimbursement context.
      </div>
    </div>
  );
}

function MetricCard({ title, value, note, unavailable }) {
  return (
    <div style={{ border:'1px solid #e5e7eb', borderRadius:12, padding:18, background:'#fff' }}>
      <div style={{ color:'#555', fontSize:14, marginBottom:8 }}>{title}</div>
      <div style={{ fontSize:28, fontWeight:700, marginBottom:8 }}>{unavailable ? '—' : value}</div>
      <div style={{ color:'#777', fontSize:13 }}>{unavailable ? 'Data unavailable for this refresh' : note}</div>
    </div>
  );
}

function SectionError({ text }) {
  return (
    <div style={{ color:'crimson', background:'#fff7f7', border:'1px solid #ffd6d6', borderRadius:8, padding:'10px 12px', marginBottom:12 }}>
      {text}
    </div>
  );
}

const grid = {
  display:'grid',
  gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))',
  gap:14
};
