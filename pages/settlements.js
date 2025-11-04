import { useEffect, useState } from "react";

function fmtINR(n) { if (n == null || isNaN(n)) return "–"; return n.toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }); }
function iso(d) { return d?.slice(0,10); }

export default function Settlements() {
  const today = new Date().toISOString().slice(0,10);
  const monthAgo = new Date(Date.now() - 30*86400000).toISOString().slice(0,10);

  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [grand, setGrand] = useState(null);
  const [settlements, setSettlements] = useState([]);
  const [unmatched, setUnmatched] = useState({ virtual_credits: [], releases: [] });

  async function load() {
    try {
      setLoading(true); setErr("");
      const r = await fetch(`/api/summary?from=${from}&to=${to}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Failed to load");
      setGrand(j.grand); setSettlements(j.settlements || []); setUnmatched(j.unmatched || { virtual_credits: [], releases: [] });
    } catch (e) { setErr(e.message); setGrand(null); setSettlements([]); setUnmatched({ virtual_credits: [], releases: [] }); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const rawExport = `/api/export?from=${from}&to=${to}&format=csv`;
  const cycleExport = `/api/export-settlements?from=${from}&to=${to}`;

  return (
    <div style={{ maxWidth: 1100, margin: "32px auto", padding: "0 16px", fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ marginBottom: 8 }}>Megaska Settlements</h1>
      <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
        <div><label style={{ fontSize: 12, color: "#666" }}>From</label><br/><input type="date" value={from} onChange={e=>setFrom(e.target.value)} /></div>
        <div><label style={{ fontSize: 12, color: "#666" }}>To</label><br/><input type="date" value={to} onChange={e=>setTo(e.target.value)} /></div>
        <button onClick={load} disabled={loading} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #ddd", background: "#111", color: "#fff" }}>
          {loading ? "Loading…" : "View"}
        </button>
        <a href={rawExport} style={{ marginLeft: "auto", textDecoration: "none" }}><button style={btn}>Download Raw CSV</button></a>
        <a href={cycleExport} style={{ textDecoration: "none" }}><button style={btn}>Download Settlement CSV</button></a>
      </div>

      {err && <div style={{ marginTop: 12, color: "#b00020" }}>Error: {err}</div>}

      {grand && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 16 }}>
          <Card title="Total Virtual Received" value={fmtINR(grand.total_virtual)} />
          <Card title="Total Released to Bank" value={fmtINR(grand.total_bank)} />
          <Card title="Total Deducted (explicit ▸ inferred)" value={fmtINR(grand.total_explicit_deduction || grand.total_inferred_deduction)}>
            {grand.total_explicit_deduction > 0 && <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
              Explicit: {fmtINR(grand.total_explicit_deduction)} • Inferred: {fmtINR(grand.total_inferred_deduction)}
            </div>}
          </Card>
        </div>
      )}

      <h2 style={{ marginTop: 28, marginBottom: 8 }}>Settlements (Amazon → Virtual → Bank)</h2>
      {settlements.length === 0 ? (
        <div style={{ color: "#666" }}>No settlements. Try running <code>/api/sync-emails?days=365</code> once.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <Th>Window Start</Th><Th>Window End</Th><Th>Credits Count</Th><Th>Total Virtual</Th>
                <Th>Released to Bank</Th><Th>Deduction</Th><Th>Release Ref</Th>
              </tr>
            </thead>
            <tbody>
              {settlements.map((s,i)=>(
                <tr key={i}>
                  <Td>{iso(s.window_start)}</Td>
                  <Td>{iso(s.window_end)}</Td>
                  <Td style={{textAlign:"center"}}>{s.credits_count}</Td>
                  <Td style={{textAlign:"right"}}>{fmtINR(s.total_virtual)}</Td>
                  <Td style={{textAlign:"right"}}>{fmtINR(s.bank_credit)}</Td>
                  <Td style={{textAlign:"right"}}>{fmtINR(s.explicit_deduction != null ? s.explicit_deduction : s.inferred_deduction)}</Td>
                  <Td>{s.release_ref || "—"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 style={{ marginTop: 24 }}>Unmatched</h3>
      <div style={{ fontSize: 14, color: "#666", marginBottom: 6 }}>Virtual credits waiting for the next release & releases without credits.</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Box title="Pending Virtual Credits">
          {(!unmatched.virtual_credits || unmatched.virtual_credits.length===0) ? <div style={{color:"#666"}}>None</div> :
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {unmatched.virtual_credits.map(v => (<li key={v.id}>{iso(v.received_at)} — {fmtINR(v.virtual_amount)}</li>))}
            </ul>}
        </Box>
        <Box title="Releases (no preceding credits)">
          {(!unmatched.releases || unmatched.releases.length===0) ? <div style={{color:"#666"}}>None</div> :
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {unmatched.releases.map(r => (<li key={r.id}>{iso(r.received_at)} — Ref: {r.transaction_ref || "—"}</li>))}
            </ul>}
        </Box>
      </div>
    </div>
  );
}

const btn = { padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd", background: "#f5f5f5" };
function Th({children}){ return <th style={{ textAlign:"left", fontSize:12, color:"#666", padding:"10px 8px", borderBottom:"1px solid #eee"}}>{children}</th>; }
function Td({children,style}){ return <td style={{ padding:"10px 8px", borderBottom:"1px solid #f3f3f3", ...(style||{}) }}>{children}</td>; }
function Card({title,value,children}){ return (
  <div style={{ padding:16, border:"1px solid #eee", borderRadius:12 }}>
    <div style={{ fontSize:12, color:"#666" }}>{title}</div>
    <div style={{ fontSize:22, fontWeight:700 }}>{value}</div>
    {children}
  </div>
);}
function Box({title,children}){ return (
  <div style={{ border:"1px solid #eee", borderRadius:10, padding:12 }}>
    <div style={{ fontWeight:600, marginBottom:6 }}>{title}</div>
    {children}
  </div>
);}
