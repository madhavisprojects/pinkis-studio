// Drop-in Express routes on top of ./cashfree.js. No DB dependency: you pass
// three small storage hooks (works with Mongo, SQLite, anything).
//
//   const express = require('express');
//   const { createCashfreeRouter } = require('./cashfree-routes');
//   app.use('/api/cashfree', createCashfreeRouter({
//     publicBaseUrl: process.env.PUBLIC_BASE_URL,        // e.g. https://pay.example.com (public HTTPS)
//     returnPath: '/pay/return',                          // page you serve; gets ?order_id=...
//     // Decide WHO is paying and HOW MUCH -- server-side only, never trust the client amount.
//     resolvePayment: async (req) => ({ amount: 99, customerId: 'u1', customerPhone: '9XXXXXXXXX',
//                                       customerEmail: 'a@b.com', note: 'ProTalk fee', meta: { plan: 'pro' } }),
//     saveOrder:  async (order) => {},                    // persist { orderId, amount, customerId, meta, status:'CREATED' }
//     findOrder:  async (orderId) => null,                // return the saved record or null
//     markPaid:   async (orderId, cfOrder) => {},         // set status 'PAID'; MUST be idempotent
//     onPaid:     async (order) => {},                    // grant access / activate subscription
//   }));
//
// The webhook route needs the raw body, so mount this router BEFORE app.use(express.json()),
// or keep the router on its own path as above (its json parsing is scoped per-route here).

const express = require('express');
const cashfree = require('./cashfree');

function createCashfreeRouter(opts) {
  const { publicBaseUrl, returnPath = '/pay/return', resolvePayment, saveOrder, findOrder, markPaid, onPaid } = opts;
  for (const [k, v] of Object.entries({ publicBaseUrl, resolvePayment, saveOrder, findOrder, markPaid })) {
    if (!v) throw new Error(`createCashfreeRouter: "${k}" is required`);
  }
  const router = express.Router();

  // Idempotent: safe to call from webhook AND status polling, in any order or repeatedly.
  async function settle(orderId) {
    const saved = await findOrder(orderId);
    if (!saved) return { paid: false, reason: 'unknown order' };
    if (saved.status === 'PAID') return { paid: true, order: saved };
    const paid = await cashfree.isOrderPaid(orderId, saved.amount); // amount checked against OUR record
    if (!paid) return { paid: false, order: saved };
    await markPaid(orderId, await cashfree.getOrder(orderId));
    const fresh = (await findOrder(orderId)) || saved;
    if (onPaid) await onPaid(fresh);
    return { paid: true, order: fresh };
  }

  // Client asks to start a payment. Amount/customer come from resolvePayment, not the request body.
  router.post('/create', express.json(), async (req, res) => {
    try {
      const p = await resolvePayment(req);
      const orderId = `cf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      // Cashfree production rejects non-HTTPS return/notify URLs. On plain-http (localhost) we
      // omit them and the client uses the popup checkout + /status polling instead of a redirect.
      const redirect = publicBaseUrl.startsWith('https://');
      const out = await cashfree.createOrder({
        orderId,
        amount: p.amount,
        customerId: p.customerId,
        customerPhone: p.customerPhone,
        customerEmail: p.customerEmail,
        note: p.note,
        returnUrl: redirect ? `${publicBaseUrl}${returnPath}?order_id={order_id}` : undefined,
        notifyUrl: redirect ? `${publicBaseUrl}${req.baseUrl}/webhook` : undefined,
      });
      await saveOrder({ orderId, amount: Number(p.amount), customerId: p.customerId, meta: p.meta || {}, status: 'CREATED' });
      res.json({ orderId, paymentSessionId: out.paymentSessionId, mode: out.env, redirect });
    } catch (e) {
      console.error('[cashfree] create failed:', e.message);
      res.status(400).json({ error: e.message });
    }
  });

  // Return page / polling calls this. Asks Cashfree; never trusts the browser.
  router.get('/status/:orderId', async (req, res) => {
    try {
      const r = await settle(req.params.orderId);
      res.json({ paid: r.paid });
    } catch (e) {
      console.error('[cashfree] status failed:', e.message);
      res.status(500).json({ error: 'status check failed' });
    }
  });

  // Cashfree -> server. Raw body required for signature verification.
  router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    let event;
    try {
      event = cashfree.verifyWebhook(req.headers, req.body);
    } catch (e) {
      console.warn('[cashfree] rejected webhook:', e.message);
      return res.sendStatus(401);
    }
    try {
      if (event.type === 'PAYMENT_SUCCESS_WEBHOOK') {
        await settle(event.data && event.data.order && event.data.order.order_id);
      }
      res.sendStatus(200);
    } catch (e) {
      console.error('[cashfree] webhook handling failed:', e.message);
      res.sendStatus(500); // Cashfree will retry
    }
  });

  return router;
}

module.exports = { createCashfreeRouter };
