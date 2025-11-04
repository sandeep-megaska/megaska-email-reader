export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Megaska Settlements</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body{font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial;max-width:1100px;margin:32px auto;padding:0 16px}
    h1{margin:0 0 8px}
    .row{display:flex;gap:12px;align-items:end;flex-wrap:wrap}
    .btn{padding:8px 14px;border-radius:8px;border:1px solid #ddd;background:#111;color:#fff;cursor:pointer}
    .btn2{padding:8px 12px;border-radius:8px;border:1px solid #ddd;background:#f5f5f5;cursor:pointer}
    .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:16px}
    .card{padding:16px;border:1px solid #eee;border-radius:12px}
    .muted{font-size:12px;color:#666}
    table{width:100%;border-collapse:collapse}
    th{ text-align:left;font-size:12px;color:#666;padding:10px 8px;border-bottom:1px solid #eee}
    td{ padding:10px 8px;border-bottom:1px solid #f3f3f3}
  </style>
</head>
<body>
  <h1>Megaska Settlements</h1>

  <div class="row">
    <div>
      <label class="muted">From</label><br/>
      <input id="from" type="date"/>
    </div>
    <div>
      <label class="muted">To</label><br/>
      <input id="to" type="date"/>
    </div>
    <button id="viewBtn" class="btn">View</button>
    <a id="rawCsv" class="btn2" href="#" download>Download Raw CSV</a>
    <a id="setCsv" class="btn2" href="#" download>Download Settlement CSV</a>
  </div>

  <div id="err" style="margin-top:12px;color:#b00020;display:none"></div>

  <div id="kpis" class="kpis" style="display:none">
    <div class="card">
      <div class="muted">Total Virtual Received</div>
      <div id="k1" style="font-size:22px;font-weight:700">–</div>
    </div>
    <div class="card">
      <div class="muted">Total Released to Bank</div>
      <div id="k2" style="font-size:22px;font-weight:700">–</div>
    </div>
    <div class="card">
      <div class="muted">Total Deducted (explicit ▸ inferred)</div>
      <div id="k3" style="font-size:22px;font-weight:700">–</div>
      <div id="k3sub" class="muted" style="margin-top:4px;display:none"></div>
    </div>
  </div>

  <h2 style="margin-top:28px;margin-bottom:8px">Settlements (Amazon → Virtual → Bank)</h2>
  <div id="settWrap" style="color:#666">No data yet.</div>

<script>
function fmtINR(n){ if(n==null||isNaN(n)) return "–"; return Number(n).toLocaleString("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}); }
function iso(d){ return d ? String(d).slice(0,10) : ""; }

(function init(){
  const today = new Date().toISOString().slice(0,10);
  const monthAgo = new Date(Date.now()-30*86400000).toISOString().slice(0,10);
  document.getElementById("from").value = monthAgo;
  document.getElementById("to").value = today;
  hook();
  load();
})();

function hook(){
  document.getElementById("viewBtn").onclick = load;
}

async function load(){
  const from = document.getElementById("from").value;
  const to = document.getElementById("to").value;
  document.getElementById("rawCsv").href = \`/api/export?from=\${from}&to=\${to}&format=csv\`;
  document.getElementById("setCsv").href = \`/api/export-settlements?from=\${from}&to=\${to}\`;

  const err = document.getElementById("err");
  err.style.display = "none"; err.textContent = "";

  try{
    const r = await fetch(\`/api/summary?from=\${from}&to=\${to}\`);
    const j = await r.json();
    if(!j.ok) throw new Error(j.error || "Failed to load");

    // KPIs
    document.getElementById("kpis").style.display = "grid";
    document.getElementById("k1").textContent = fmtINR(j.grand.total_virtual);
    document.getElementById("k2").textContent = fmtINR(j.grand.total_bank);
    const ded = j.grand.total_explicit_deduction || j.grand.total_inferred_deduction;
    document.getElementById("k3").textContent = fmtINR(ded);
    const sub = document.getElementById("k3sub");
    if(j.grand.total_explicit_deduction > 0){
      sub.style.display = "block";
      sub.textContent = \`Explicit: \${fmtINR(j.grand.total_explicit_deduction)} • Inferred: \${fmtINR(j.grand.total_inferred_deduction)}\`;
    } else { sub.style.display = "none"; }

    // Settlements table
    const s = j.settlements || [];
    if(s.length === 0){
      document.getElementById("settWrap").innerHTML = '<div style="color:#666">No settlements in this range.</div>';
      return;
    }
    const rows = s.map(x => \`
      <tr>
        <td>\${iso(x.window_start)}</td>
        <td>\${iso(x.window_end)}</td>
        <td style="text-align:center">\${x.credits_count}</td>
        <td style="text-align:right">\${fmtINR(x.total_virtual)}</td>
        <td style="text-align:right">\${fmtINR(x.bank_credit)}</td>
        <td style="text-align:right">\${fmtINR(x.explicit_deduction != null ? x.explicit_deduction : x.inferred_deduction)}</td>
        <td>\${x.release_ref || "—"}</td>
      </tr>\`).join("");
    document.getElementById("settWrap").innerHTML = \`
      <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Window Start</th><th>Window End</th><th>Credits Count</th>
              <th>Total Virtual</th><th>Released to Bank</th><th>Deduction</th><th>Release Ref</th>
            </tr>
          </thead>
          <tbody>\${rows}</tbody>
        </table>
      </div>\`;
  }catch(e){
    err.style.display = "block";
    err.textContent = e.message;
  }
}
</script>
</body>
</html>`);
}
