export default function handler(req, res) {
  const required = [
    'GMAIL_CLIENT_ID',
    'GMAIL_CLIENT_SECRET',
    'GMAIL_REFRESH_TOKEN',
    'GMAIL_REDIRECT_URI'
  ];
  const present = {};
  const missing = [];
  for (const k of required) {
    const ok = !!process.env[k];
    present[k] = ok ? 'present' : 'missing';
    if (!ok) missing.push(k);
  }
  res.status(missing.length ? 500 : 200).json({ present, missing });
}
