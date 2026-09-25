// Drop this file into any Express app's root and require it for Cashfree
// Payment Gateway checkout. No dependencies (uses Node 18+ fetch + crypto).
//
// Env (put in the app's .env yourself -- never commit or paste these):
//   CASHFREE_APP_ID=...
//   CASHFREE_SECRET_KEY=...
//   CASHFREE_ENV=sandbox        # "sandbox" while testing, "production" when live
//
// Flow:
//   1. Server: createOrder() -> returns { orderId, paymentSessionId }
//   2. Browser: Cashfree JS SDK opens checkout with that paymentSessionId
//        <script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
//        const cf = Cashfree({ mode: 'sandbox' });   // 'production' when live
//        cf.checkout({ paymentSessionId, redirectTarget: '_self' });
//   3. Cashfree redirects to your returnUrl AND calls your webhook.
//      Never trust the redirect: confirm with isOrderPaid(orderId) or the webhook.
//
// Usage:
//   const cashfree = require('./cashfree');
//   const { orderId, paymentSessionId } = await cashfree.createOrder({
//     orderId: 'sub_' + Date.now(),      // your unique id (a-z A-Z 0-9 _ -, max 50)
//     amount: 99,                        // rupees, decided by YOUR server, never the client
//     customerId: String(user._id),
//     customerPhone: '9XXXXXXXXX',       // 10-digit Indian mobile (required by Cashfree)
//     customerEmail: 'a@b.com',          // optional
//     returnUrl: 'https://yourapp/pay/return?order_id={order_id}',
//     notifyUrl: 'https://yourapp/api/cashfree/webhook',   // must be public HTTPS
//   });
//
//   // Webhook route: needs the RAW body, so mount express.raw for this route only
//   app.post('/api/cashfree/webhook', express.raw({ type: '*/*' }), (req, res) => {
//     const event = cashfree.verifyWebhook(req.headers, req.body); // throws if forged
//     if (event.type === 'PAYMENT_SUCCESS_WEBHOOK') { /* mark order paid (idempotently) */ }
//     res.sendStatus(200);
//   });
//
//   // Return page / polling: ask Cashfree, don't believe the browser
//   const paid = await cashfree.isOrderPaid(orderId, expectedAmount);

const crypto = require('crypto');

const API_VERSION = '2023-08-01';
const BASES = {
  sandbox: 'https://sandbox.cashfree.com/pg',
  production: 'https://api.cashfree.com/pg',
};
const ORDER_ID_RE = /^[A-Za-z0-9_-]{1,50}$/;
const MOBILE_RE = /^[6-9]\d{9}$/;

function config() {
  const appId = process.env.CASHFREE_APP_ID;
  const secret = process.env.CASHFREE_SECRET_KEY;
  if (!appId || !secret) throw new Error('CASHFREE_APP_ID / CASHFREE_SECRET_KEY are not set in .env');
  const env = process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox';
  return { appId, secret, env, base: BASES[env] };
}

async function call(method, path, body) {
  const { appId, secret, base } = config();
  const res = await fetch(base + path, {
    method,
    headers: {
      'x-client-id': appId,
      'x-client-secret': secret,
      'x-api-version': API_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Cashfree returns { message, code, type }; never include our keys in the error.
    throw new Error(`Cashfree ${res.status}: ${data.message || data.code || 'request failed'}`);
  }
  return data;
}

async function createOrder({ orderId, amount, customerId, customerPhone, customerEmail, returnUrl, notifyUrl, note }) {
  if (!ORDER_ID_RE.test(orderId || '')) throw new Error('orderId must be 1-50 chars of letters, digits, _ or -');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 1) throw new Error('amount must be a number of rupees, at least 1');
  if (!customerId) throw new Error('customerId is required');
  if (!MOBILE_RE.test(String(customerPhone || ''))) throw new Error('customerPhone must be a 10-digit Indian mobile');

  const data = await call('POST', '/orders', {
    order_id: orderId,
    order_amount: Math.round(amt * 100) / 100,
    order_currency: 'INR',
    customer_details: {
      customer_id: String(customerId).slice(0, 50),
      customer_phone: String(customerPhone),
      ...(customerEmail ? { customer_email: customerEmail } : {}),
    },
    order_meta: {
      ...(returnUrl ? { return_url: returnUrl } : {}),
      ...(notifyUrl ? { notify_url: notifyUrl } : {}),
    },
    ...(note ? { order_note: String(note).slice(0, 200) } : {}),
  });
  return { orderId: data.order_id, paymentSessionId: data.payment_session_id, status: data.order_status, env: config().env };
}

async function getOrder(orderId) {
  if (!ORDER_ID_RE.test(orderId || '')) throw new Error('invalid orderId');
  return call('GET', `/orders/${encodeURIComponent(orderId)}`);
}

// True only when Cashfree says PAID and (if given) the amount matches what YOU expected.
async function isOrderPaid(orderId, expectedAmount) {
  const order = await getOrder(orderId);
  if (order.order_status !== 'PAID') return false;
  if (expectedAmount != null && Number(order.order_amount) !== Number(expectedAmount)) return false;
  return true;
}

// Verifies x-webhook-signature = base64(HMAC-SHA256(timestamp + rawBody, secretKey)).
// `rawBody` must be the untouched Buffer/string (express.raw), not parsed JSON.
function verifyWebhook(headers, rawBody) {
  const { secret } = config();
  const signature = headers['x-webhook-signature'];
  const timestamp = headers['x-webhook-timestamp'];
  if (!signature || !timestamp) throw new Error('missing Cashfree webhook headers');
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = crypto.createHmac('sha256', secret).update(timestamp + body).digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('invalid Cashfree webhook signature');
  return JSON.parse(body);
}

module.exports = { createOrder, getOrder, isOrderPaid, verifyWebhook };
