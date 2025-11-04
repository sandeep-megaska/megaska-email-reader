export default function handler(req, res) {
  const must = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_KEY",
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_REFRESH_TOKEN"
  ];
  const status = Object.fromEntries(
    must.map(k => [k, Boolean(process.env[k])])
  );
  const allSet = Object.values(status).every(Boolean);
  res.status(allSet ? 200 : 500).json({ ok: allSet, status });
}
