import { gmailClient, listMessages, loadMessage, extractBody, headerValue, getTZ } from './_gmail';
import { parse, format } from 'date-fns';

/** Utilities **/
const INR = /INR\s*([0-9][0-9,]*\.\d{2})/i;
const num = s => (s ? Number(String(s).replace(/,/g, '')) : 0);

function ymd(date, tz) {
  const d = new Date(date);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
  return fmt.format(d); // YYYY-MM-DD
}

function extractAmountFromText(text) {
  const m = text && text.match(INR);
  return m ? num(m[1]) : 0;
}

function gmailDateQuery(start, end) {
  const startQ = start.replaceAll('-', '/');
  const endQ = end.replaceAll('-', '/');
  return { startQ, endQ };
}

export default async function handler(req, res) {
  try {
    const tz = getTZ();
    const { start, end } = req.query; // YYYY-MM-DD inclusive

    if (!start || !end) {
      return res.status(400).json({ error: 'Pass start and end as YYYY-MM-DD' });
    }

    const gmail = gmailClient();
    const { startQ, endQ } = gmailDateQuery(start, end);

    // Three focused searches (one subject matches both release variants)
    const qAmazon   = `after:${startQ} before:${endQ} subject:"Your payment is on the way"`;
    const qIndifiIn = `after:${startQ} before:${endQ} subject:"Payment received in virtual account"`;
    const qOutBoth  = `after:${startQ} before:${endQ} subject:"Payment release successful"`;

    const [mAmazon, mIn, mOutBoth] = await Promise.all([
      listMessages(gmail, qAmazon, 300),
      listMessages(gmail, qIndifiIn, 300),
      listMessages(gmail, qOutBoth, 300),
    ]);

    const allIds = [
      ...mAmazon.map(m => ({ id: m.id, kind: 'AMAZON' })),
      ...mIn.map(m => ({ id: m.id, kind: 'INDIFI_IN' })),
      ...mOutBoth.map(m => ({ id: m.id, kind: 'INDIFI_OUT' })),
    ];

    const rows = {};
    const raw = [];

    for (const { id, kind } of allIds) {
      const msg = await loadMessage(gmail, id);
      const subject = headerValue(msg.payload?.headers, 'Subject') || '';
      const internalDate = Number(msg.internalDate); // ms
      const dateKey = ymd(internalDate, tz);
      const body = extractBody(msg.payload);
      const amount = extractAmountFromText(body) || extractAmountFromText(subject);

      raw.push({ id, date: dateKey, subject, amount, kind });

      if (!rows[dateKey]) rows[dateKey] = {
        date: dateKey,
        amazon_disbursed: 0,
        virtual_received: 0,
        released_to_icici: 0,
        released_to_indifi: 0,
      };

      if (kind === 'AMAZON') {
        rows[dateKey].amazon_disbursed += amount;
        continue;
      }

      if (kind === 'INDIFI_IN') {
        rows[dateKey].virtual_received += amount;
        continue;
      }

      if (kind === 'INDIFI_OUT') {
        // Disambiguate by body recipient
        // Example (Indifi): "… released to the registered bank account Indifi Capital Pvt Ltd - 50200021608160 …"
        // Example (ICICI):  "… released to the registered bank account BIGONBUY TRADING PVT LTD - 678105600878 …"
        const isIndifi = /Indifi\s+Capital\s+Pvt\s+Ltd/i.test(body);
        if (isIndifi) {
          rows[dateKey].released_to_indifi += amount;
        } else {
          rows[dateKey].released_to_icici += amount;
        }
        continue;
      }
    }

    const sorted = Object.values(rows).sort((a, b) => a.date.localeCompare(b.date));
    res.status(200).json({
      tz, start, end,
      count: sorted.length,
      rows: sorted,
      debug: { totals: allIds.length, messages: raw.length }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Unexpected error' });
  }
}
