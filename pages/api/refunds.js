import { gmailClient, listMessages, loadMessage, extractBody, headerValue, getTZ } from './_gmail';

const AMOUNT_INR = /(?:INR\s*([0-9][0-9,]*(?:\.\d{1,2})?)|([0-9][0-9,]*(?:\.\d{1,2})?)\s*INR)/i;
const ORDER_ID = /order\s+([0-9]{3}-[0-9]{7}-[0-9]{7})/i;
const ASIN = /^B[A-Z0-9]{9}$/i;
const REFUND_TZ = process.env.REFUND_TZ || 'Asia/Kolkata';

const num = s => (s ? Number(String(s).replace(/,/g, '')) : 0);

function ymd(date, tz = REFUND_TZ) {
  const d = new Date(date);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
  return fmt.format(d);
}

function timestampInTZ(date, tz = REFUND_TZ) {
  const d = new Date(date);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
    hour12: false
  }).formatToParts(d).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function addDays(dateString, days) {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function gmailDateQuery(start, end) {
  return {
    // Gmail after/before uses date-only boundaries that can behave differently around timezone edges.
    // Search one extra day on both sides, then filter precisely by India date after loading messages.
    startQ: addDays(start, -1).replaceAll('-', '/'),
    endQ: addDays(end, 2).replaceAll('-', '/')
  };
}

function isWithinSelectedIndiaDates(internalDate, start, end) {
  const dateKey = ymd(internalDate, REFUND_TZ);
  return dateKey >= start && dateKey <= end;
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
  return /reject|damag|return|customer|undeliver|wrong|defect|missing|quality|late|refus|cancel|product|described|different|not as described|unsellable|sellable|no longer needed|performance|style|size|fit|address/i.test(line);
}

function emptyItem() {
  return {
    asin: '',
    sku: '',
    order_quantity: 0,
    return_quantity: 0,
    item: '',
    refund_reason: ''
  };
}

function parseOneItem(values, asin) {
  const data = emptyItem();
  data.asin = asin;

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

  // In the common Amazon table order, reason is the last meaningful value after item.
  // This catches reasons that do not contain our keywords.
  if (!data.refund_reason && itemCandidates.length) {
    const itemIdx = values.indexOf(data.item);
    const laterValues = values.slice(itemIdx + 1).filter(line => !isHeaderLine(line) && !/^\d+$/.test(line));
    if (laterValues.length) data.refund_reason = laterValues[laterValues.length - 1];
  }

  return data;
}

function parseItemBlocks(lines) {
  const items = [];
  const asinIndexes = [];

  lines.forEach((line, idx) => {
    if (ASIN.test(line)) asinIndexes.push(idx);
  });

  for (let a = 0; a < asinIndexes.length; a++) {
    const start = asinIndexes[a];
    const nextAsin = asinIndexes[a + 1] || lines.length;
    const values = [];

    for (let i = start + 1; i < nextAsin && values.length < 20; i++) {
      const line = lines[i];
      if (/^Your seller account will be debited accordingly/i.test(line)) break;
      if (/^You can view your account/i.test(line)) break;
      if (/^Thank you for selling on Amazon/i.test(line)) break;
      if (isHeaderLine(line)) continue;
      values.push(line);
    }

    items.push(parseOneItem(values, lines[start]));
  }

  return items.length ? items : [emptyItem()];
}

function shouldUseOpenAiFallback(items) {
  return items.some(item => !item.asin || !item.sku || !item.item || !item.refund_reason || !item.return_quantity);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (e) { return null; }
  }
}

async function openAiFallbackParse({ subject, body }) {
  if (!process.env.OPENAI_API_KEY) return null;

  const prompt = `Extract Amazon seller refund initiated email details as JSON only.
Return this exact shape:
{
  "order_id": "",
  "amount": 0,
  "customer": "",
  "fulfilment": "",
  "items": [
    {
      "asin": "",
      "sku": "",
      "order_quantity": 0,
      "return_quantity": 0,
      "item": "",
      "refund_reason": ""
    }
  ]
}

Rules:
- Do not invent missing values.
- Keep amounts numeric.
- Include every refunded item if multiple items are present.
- Output valid JSON only.

Subject:\n${subject}\n\nEmail body:\n${stripHtml(body).slice(0, 12000)}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You extract structured data from Amazon seller refund emails. Return JSON only.' },
        { role: 'user', content: prompt }
      ]
    })
  });

  if (!response.ok) return null;
  const json = await response.json();
  return safeJsonParse(json.choices?.[0]?.message?.content);
}

function normalizeOpenAiResult(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const items = Array.isArray(parsed.items) && parsed.items.length ? parsed.items : [emptyItem()];
  return {
    order_id: parsed.order_id || '',
    amount: Number(parsed.amount) || 0,
    customer: parsed.customer || '',
    fulfilment: parsed.fulfilment || '',
    items: items.map(item => ({
      ...emptyItem(),
      asin: item.asin || '',
      sku: item.sku || '',
      order_quantity: Number(item.order_quantity) || 0,
      return_quantity: Number(item.return_quantity) || 0,
      item: item.item || '',
      refund_reason: item.refund_reason || ''
    }))
  };
}

async function parseRefundEmail(subject, body) {
  const combined = `${subject}\n${body}`;
  const plainBody = stripHtml(body);
  const lines = cleanLines(body);

  const customerMatch = plainBody.match(/refund\s+in\s+the\s+amount\s+of\s+INR\s*[0-9][0-9,]*(?:\.\d{1,2})?\s+to\s+(.+?)\s+for\s+the\s+following\s+items/i);
  const fulfilmentMatch = plainBody.match(/Fulfilment:\s*(.+)/i);

  let parsed = {
    order_id: extractOrderId(combined),
    amount: extractAmount(subject) || extractAmount(body),
    customer: customerMatch ? customerMatch[1].trim() : '',
    fulfilment: fulfilmentMatch ? fulfilmentMatch[1].trim() : '',
    items: parseItemBlocks(lines),
    parsed_by: 'regex'
  };

  if (shouldUseOpenAiFallback(parsed.items)) {
    const aiParsed = normalizeOpenAiResult(await openAiFallbackParse({ subject, body }));
    if (aiParsed) {
      parsed = {
        order_id: aiParsed.order_id || parsed.order_id,
        amount: aiParsed.amount || parsed.amount,
        customer: aiParsed.customer || parsed.customer,
        fulfilment: aiParsed.fulfilment || parsed.fulfilment,
        items: aiParsed.items?.length ? aiParsed.items : parsed.items,
        parsed_by: 'openai_fallback'
      };
    }
  }

  return parsed;
}

function buildAnalytics(rows, totalRefundAmount) {
  const bySku = new Map();
  const byReason = new Map();

  for (const row of rows) {
    const sku = row.sku || 'Unknown SKU';
    const reason = row.refund_reason || 'Unknown reason';
    const returnQty = Number(row.return_quantity) || 0;

    if (!bySku.has(sku)) bySku.set(sku, { sku, refund_items: 0, return_quantity: 0 });
    bySku.get(sku).refund_items += 1;
    bySku.get(sku).return_quantity += returnQty;

    if (!byReason.has(reason)) byReason.set(reason, { reason, refund_items: 0, return_quantity: 0 });
    byReason.get(reason).refund_items += 1;
    byReason.get(reason).return_quantity += returnQty;
  }

  const sortMetric = x => (x.return_quantity || 0) * 100000 + (x.refund_items || 0);

  return {
    total_refund_amount: totalRefundAmount,
    total_refund_emails: new Set(rows.map(r => r.id)).size,
    total_refund_items: rows.length,
    total_return_quantity: rows.reduce((sum, row) => sum + (Number(row.return_quantity) || 0), 0),
    top_skus: Array.from(bySku.values()).sort((a, b) => sortMetric(b) - sortMetric(a)).slice(0, 10),
    top_reasons: Array.from(byReason.values()).sort((a, b) => sortMetric(b) - sortMetric(a)).slice(0, 10)
  };
}

export default async function handler(req, res) {
  try {
    const tz = REFUND_TZ;
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: 'Pass start and end as YYYY-MM-DD' });
    }

    const gmail = gmailClient();
    const { startQ, endQ } = gmailDateQuery(start, end);
    const qRefunds = `after:${startQ} before:${endQ} subject:"refund initiated" subject:order`;

    const messages = await listMessages(gmail, qRefunds, 1000);
    const rows = [];
    let totalRefundAmount = 0;
    let openAiFallbackCount = 0;
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
      const date = ymd(internalDate, tz);
      const refund_initiated_timestamp = timestampInTZ(internalDate, tz);
      const body = extractBody(msg.payload);
      const parsed = await parseRefundEmail(subject, body);
      const items = parsed.items?.length ? parsed.items : [emptyItem()];

      totalRefundAmount += parsed.amount || 0;
      if (parsed.parsed_by === 'openai_fallback') openAiFallbackCount += 1;

      items.forEach((item, idx) => {
        rows.push({
          id,
          row_key: `${id}-${idx}`,
          item_index: idx + 1,
          item_count: items.length,
          date,
          refund_initiated_timestamp,
          subject,
          from,
          order_id: parsed.order_id,
          amount: parsed.amount,
          customer: parsed.customer,
          fulfilment: parsed.fulfilment,
          parsed_by: parsed.parsed_by,
          ...item
        });
      });
    }

    rows.sort((a, b) => a.refund_initiated_timestamp.localeCompare(b.refund_initiated_timestamp) || a.order_id.localeCompare(b.order_id) || a.item_index - b.item_index);

    res.status(200).json({
      tz,
      start,
      end,
      count: rows.length,
      total_refund_amount: totalRefundAmount,
      analytics: buildAnalytics(rows, totalRefundAmount),
      rows,
      debug: { messages: messages.length, query: qRefunds, openai_fallback_count: openAiFallbackCount, skipped_outside_india_date_range: skippedOutsideIndiaDateRange }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Unexpected error' });
  }
}
