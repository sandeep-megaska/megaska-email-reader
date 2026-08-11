import Link from 'next/link';

const card = {
  display: 'block',
  padding: 22,
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  textDecoration: 'none',
  color: 'inherit',
  background: '#fff',
  boxShadow: '0 1px 3px rgba(0,0,0,0.06)'
};

export default function Home() {
  return (
    <div style={{ fontFamily: 'system-ui, Arial', padding: 24, maxWidth: 1000, margin: '0 auto' }}>
      <h1 style={{ marginBottom: 8 }}>Megaska Email Reader</h1>
      <p style={{ color: '#666', marginBottom: 24 }}>
        Select a report to fetch and summarize Gmail communications.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
        <Link href="/settlements" style={card}>
          <h2 style={{ marginTop: 0 }}>Indifi Settlements</h2>
          <p style={{ color: '#555', marginBottom: 0 }}>
            Track Amazon disbursements, virtual account receipts, and releases to ICICI / Indifi.
          </p>
        </Link>

        <Link href="/refunds" style={card}>
          <h2 style={{ marginTop: 0 }}>Refund Tracking</h2>
          <p style={{ color: '#555', marginBottom: 0 }}>
            Track Amazon refund initiated emails by order, SKU, quantity, and refund reason.
          </p>
        </Link>

        <Link href="/reimbursements" style={card}>
          <h2 style={{ marginTop: 0 }}>Amazon Reimbursements</h2>
          <p style={{ color: '#555', marginBottom: 0 }}>
            Track Amazon reimbursement postings by order ID, reimbursement date, and amount.
          </p>
        </Link>
      </div>
    </div>
  );
}
