import { gmailClient, listMessages, loadMessage, extractBody, headerValue, getTZ } from './_gmail';

const AMOUNT_INR = /(?:INR\s*([0-9][0-9,]*(?:\.\d{1,2})?)|([0-9][0-9,]*(?:\.\d{1,2})?)\s*INR)/i;
const ORDER_ID = /order\s+([0-9]{3}-[0-9]{7}-[0-9]{7})/i;
const ASIN = /^B[A-Z0-9]{9}$/i;

const num = s => (s ? Number(String(s).replace(/,/g, '')) : 0);

function ymd(date, tz) {
  const d = new Date(date);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
  return fmt.format(d);
}

function addOneDay(dateString) {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function gmailDateQuery(start, end) {
  return {
    startQ: start.replaceAll('-', '/'),
    // Gmail before: is exclusive, so add one day to make the UI end date inclusive.
    endQ: addOneDay(end).replaceAll('-', '/')
  };
}

function extractAmount(text) {
  const m = text && text.match(AMOUNT_INR);
  return m ? num(m[1] || m[2]) : 0;
}

function extractOrderId(text) {
  const m = text && text.match(ORDER_ID);
  return m ? m[1] : '';
}

function cleanLines(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(x => x.trim())
    .filter(Boolean);
}

function parseRefundEmail(subject, body) {
  const combined = `${subject}\n${body}`;
  const lines = cleanLines(body);

  const customerMatch = body.match(/refund\s+in\s+the\s+amount\s+of\s+INR\s*[0-9][0-9,]*(?:\.\d{1,2})?\s+to\s+(.+?)\s+for\s+the\s+following\s+items/i);
  const fulfilmentMatch = body.match(/Fulfilment:\s*(.+)/i);

  const asinIndex = lines.findIndex(line => ASIN.test(line));
  const asin = asinIndex >= 0 ? lines[asinIndex] : '';
  const sku = asinIndex >= 0 ? lines[asinIndex + 1] || '' : '';
  const orderQuantity = asinIndex >= 0 ? Number(lines[asinIndex + 2]) || 0 : 0;
  const returnQuantity = asinIndex >= 0 ? Number(lines[asinIndex + 3]) || 0 : 0;
  const item = asinIndex >= 0 ? lines[asinIndex + 4] || '' : '';
  const refundReason = asinIndex >= 0 ? lines[asinIndex + 5] || '' : '';

  return {
    order_id: extractOrderId(combined),
    amount: extractAmount(subject) || extractAmount(body),
    customer: customerMatch ? customerMatch[1].trim() : '',
    fulfilment: fulfilmentMatch ? fulfilmentMatch[1].trim() : '',
    asin,
    sku,
    order_quantity: orderQuantity,
    return_quantity: returnQuantity,
    item,
    refund_reason: refundReason
  };
}

export default async function handler(req, res) {
  try {
    const tz = getTZ();
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: 'Pass start and end as YYYY-MM-DD' });
    }

    const gmail = gmailClient();
    const { startQ, endQ } = gmailDateQuery(start, end);
    const qRefunds = `after:${startQ} before:${endQ} subject:"refund initiated" subject:order`;

    const messages = await listMessages(gmail, qRefunds, 500);
    const rows = [];

    for (const { id } of messages) {
      const msg = await loadMessage(gmail, id);
      const subject = headerValue(msg.payload?.headers, 'Subject') || '';
      const from = headerValue(msg.payload?.headers, 'From') || '';
      const internalDate = Number(msg.internalDate);
      const body = extractBody(msg.payload);
      const parsed = parseRefundEmail(subject, body);

      rows.push({
        id,
        date: ymd(internalDate, tz),
        subject,
        from,
        ...parsed
      });
    }

    rows.sort((a, b) => a.date.localeCompare(b.date) || a.order_id.localeCompare(b.order_id));

    res.status(200).json({
      tz,
      start,
      end,
      count: rows.length,
      total_refund_amount: rows.reduce((sum, row) => sum + (row.amount || 0), 0),
      rows,
      debug: { messages: messages.length, query: qRefunds }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Unexpected error' });
  }
}
