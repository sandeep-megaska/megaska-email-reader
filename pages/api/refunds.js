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

function stripHtml(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '\n')
    .replace(/<\/th>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function cleanLines(text) {
  return stripHtml(text)
    .replace(/\r/g, '')
    .split('\n')
    .map(x => x.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function isHeaderLine(line) {
  return /^(ASIN|SKU|Order Quantity|Return Quantity|Order Item|Refund Reason)$/i.test(line);
}

function isLikelySku(line) {
  return /^[A-Z0-9][A-Z0-9._/-]*[A-Z0-9]$/i.test(line) && /[-_]/.test(line) && !ASIN.test(line);
}

function isLikelyReason(line) {
  return /reject|damag|return|customer|undeliver|wrong|defect|missing|quality|late|refus|cancel/i.test(line);
}

function parseItemBlock(lines) {
  const data = {
    asin: '',
    sku: '',
    order_quantity: 0,
    return_quantity: 0,
    item: '',
    refund_reason: ''
  };

  const asinIndex = lines.findIndex(line => ASIN.test(line));
  if (asinIndex < 0) return data;

  data.asin = lines[asinIndex];

  const values = [];
  for (let i = asinIndex + 1; i < lines.length && values.length < 12; i++) {
    const line = lines[i];
    if (/^Your seller account will be debited accordingly/i.test(line)) break;
    if (/^You can view your account/i.test(line)) break;
    if (/^Thank you for selling on Amazon/i.test(line)) break;
    if (isHeaderLine(line)) continue;
    values.push(line);
  }

  const skuIndex = values.findIndex(isLikelySku);
  if (skuIndex >= 0) data.sku = values[skuIndex];

  const qtyIndexes = [];
  values.forEach((line, idx) => {
    if (/^\d+$/.test(line)) qtyIndexes.push(idx);
  });
  if (qtyIndexes.length > 0) data.order_quantity = Number(values[qtyIndexes[0]]) || 0;
  if (qtyIndexes.length > 1) data.return_quantity = Number(values[qtyIndexes[1]]) || 0;

  const reasonIndex = values.findIndex(isLikelyReason);
  if (reasonIndex >= 0) data.refund_reason = values[reasonIndex];

  const excluded = new Set([skuIndex, reasonIndex, ...qtyIndexes]);
  const itemCandidates = values.filter((line, idx) => {
    if (excluded.has(idx)) return false;
    if (ASIN.test(line)) return false;
    if (isHeaderLine(line)) return false;
    return line.length > 10;
  });

  if (itemCandidates.length) {
    data.item = itemCandidates.sort((a, b) => b.length - a.length)[0];
  }

  return data;
}

function parseRefundEmail(subject, body) {
  const combined = `${subject}\n${body}`;
  const lines = cleanLines(body);

  const customerMatch = stripHtml(body).match(/refund\s+in\s+the\s+amount\s+of\s+INR\s*[0-9][0-9,]*(?:\.\d{1,2})?\s+to\s+(.+?)\s+for\s+the\s+following\s+items/i);
  const fulfilmentMatch = stripHtml(body).match(/Fulfilment:\s*(.+)/i);
  const itemData = parseItemBlock(lines);

  return {
    order_id: extractOrderId(combined),
    amount: extractAmount(subject) || extractAmount(body),
    customer: customerMatch ? customerMatch[1].trim() : '',
    fulfilment: fulfilmentMatch ? fulfilmentMatch[1].trim() : '',
    ...itemData
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
