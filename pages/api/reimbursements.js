import { gmailClient, listMessages, loadMessage, extractBody, headerValue } from './_gmail';

const ORDER_ID = /^([0-9]{3}-[0-9]{7}-[0-9]{7})$/;
const REFUND_TZ = process.env.REFUND_TZ || 'Asia/Kolkata';

function addDays(dateString, days) {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function ymd(date, tz = REFUND_TZ) {
  const d = new Date(date);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return fmt.format(d);
}

function timestampInTZ(date, tz = REFUND_TZ) {
  const d = new Date(date);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(d).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function isWithinSelectedIndiaDates(internalDate, start, end) {
  const dateKey = ymd(internalDate, REFUND_TZ);
  return dateKey >= start && dateKey <= end;
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '\t')
    .replace(/<\/th>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function parseAmount(value) {
  const n = Number(String(value || '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function parseReimbursementRows(body) {
  const plain = stripHtml(body).replace(/\r/g, '');
  const lines = plain
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

  const rows = [];

  for (const line of lines) {
    const match = line.match(/\b([0-9]{3}-[0-9]{7}-[0-9]{7})\b\s+([0-9][0-9,]*(?:\.\d{1,2})?)/);
    if (match) {
      rows.push({ order_id: match[1], amount_reimbursed: parseAmount(match[2]) });
    }
  }

  // Some HTML emails may split order ID and amount into adjacent logical cells/lines.
  if (!rows.length) {
    for (let i = 0; i < lines.length; i++) {
      if (ORDER_ID.test(lines[i])) {
        const next = lines[i + 1] || '';
        const amountMatch = next.match(/^([0-9][0-9,]*(?:\.\d{1,2})?)$/);
        if (amountMatch) {
          rows.push({ order_id: lines[i], amount_reimbursed: parseAmount(amountMatch[1]) });
        }
      }
    }
  }

  return rows;
}

export default async function handler(req, res) {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: 'Pass start and end as YYYY-MM-DD' });
    }

    const gmail = gmailClient();
    const startQ = addDays(start, -1).replaceAll('-', '/');
    const endQ = addDays(end, 2).replaceAll('-', '/');
    const q = `after:${startQ} before:${endQ} subject:"A reimbursement has been posted to your account"`;

    const messages = await listMessages(gmail, q, 1000);
    const rows = [];
    let skippedOutsideIndiaDateRange = 0;

    for (const { id } of messages) {
      const msg = await loadMessage(gmail, id);
      const internalDate = Number(msg.internalDate);
      if (!isWithinSelectedIndiaDates(internalDate, start, end)) {
        skippedOutsideIndiaDateRange += 1;
        continue;
      }

      const subject = headerValue(msg.payload?.headers, 'Subject') || '';
      const from = headerValue(msg.payload?.headers, 'From') || '';
      const body = extractBody(msg.payload);
      const parsedRows = parseReimbursementRows(body);
      const reimbursement_timestamp = timestampInTZ(internalDate, REFUND_TZ);

      parsedRows.forEach((row, idx) => {
        rows.push({
          id,
          row_key: `${id}-${idx}`,
          reimbursement_timestamp,
          date: ymd(internalDate, REFUND_TZ),
          subject,
          from,
          ...row
        });
      });
    }

    rows.sort((a, b) => a.reimbursement_timestamp.localeCompare(b.reimbursement_timestamp) || a.order_id.localeCompare(b.order_id));

    const total = rows.reduce((sum, row) => sum + (row.amount_reimbursed || 0), 0);

    res.status(200).json({
      tz: REFUND_TZ,
      start,
      end,
      count: rows.length,
      total_reimbursed: total,
      rows,
      debug: {
        messages: messages.length,
        query: q,
        skipped_outside_india_date_range: skippedOutsideIndiaDateRange
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Unexpected error' });
  }
}
