export default async function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Megaska Totals</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body{font-family:ui-sans-serif,system-ui,Segoe UI,Roboto,Helvetica,Arial;max-width:800px;margin:32px auto;padding:0 16px}
    h1{margin:0 0 8px}
    .row{display:flex;gap:12px;align-items:end;flex-wrap:wrap}
    .btn{padding:8px 14px;border-radius:8px;border:1px solid #ddd;background:#111;color:#fff;cursor:pointer}
    .btn2{padding:8px 12px;border-radius:8px;border:1px solid #ddd;background:#f5f5f5;cursor:pointer;text-decoration:none}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:16px}
    .card{padding:16px;border:1px solid #eee;border-radius:12px}
    .muted{font-size:12px;color:#666}
    #err{margin-top:12px;color:#b00020;display:none}
  </style>
</head>
<body>
  <h1>Megaska Totals (Virtual vs Bank)</h1>

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
    <a id="totCsv" class="btn2" href="#" download>Download Totals CSV</a>
    <a id="rawCsv" class="btn2" href="#" download>Download Raw CSV</a>
  </div>

  <div id="err"></div>

  <div id="kpis" class="grid" style="display:none">
    <div class="card">
      <div class="muted">Total Virtual Received</div>
      <div id="k1" style="font-size:22px;font-weight:700">–</div>
      <div class="muted" id="c1"></div>
    </div>
    <div class="card">
      <div class="muted">Total Released to Bank</div>
      <div id="k2" style="font-size:22px;font-weight:700">–</div>
      <div class="muted" id="c2"></div>
    </div>
    <div class="card">
      <div class="muted">Deduction (Virtual − Bank)</div>
      <div id="k3" style="font-size:22px;font-weight:700">–</div>
    </div>
  </div>

<script>
function fmtINR(n){ if(n==null||isNaN(n)) return "–"; return Number(n).toLocaleString("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}); }

(function init(){
  const today = new Date().toISOString().slice(0,10);
  const monthAgo = new Date(Date.now()-30*86400000).toISOString().slice(0,10);
  document.getElementById("from").value = monthAgo;
  document.getElementById("to").value = today;
  document.getElementById("viewBtn").onclick = load;
  load();
})();

async function load(){
  const from = document.getElementById("from").value;
  const to = document.getElementById("to").value;

  document.getElementById("totCsv").href = \`/api/export-totals?from=\${from}&to=\${to}\`;
  document.getElementById("rawCsv").href = \`/api/export?from=\${from}&to=\${to}&format=csv\`;

  const err = document.getElementById("err"); err.style.display = "none"; err.textContent = "";
  try{
    const r = await fetch(\`/api/summary-simple?from=\${from}&to=\${to}\`);
    const j = await r.json();
    if(!j.ok) throw new Error(j.error || "Failed to load");

    document.getElementById("kpis").style.display = "grid";
    document.getElementById("k1").textContent = fmtINR(j.totals.virtual);
    document.getElementById("k2").textContent = fmtINR(j.totals.bank);
    document.getElementById("k3").textContent = fmtINR(j.totals.deduction);
    document.getElementById("c1").textContent = \`\${j.counts.virtual_credits} virtual credit email(s)\`;
    document.getElementById("c2").textContent = \`\${j.counts.releases} release email(s)\`;
  }catch(e){
    err.style.display = "block"; err.textContent = e.message;
  }
}
</script>
</body>
</html>`);
}
