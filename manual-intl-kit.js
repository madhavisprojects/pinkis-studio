// manual-intl-kit.js — reusable manual PayPal (send-money link + transaction
// ID) payment flow, for customers OUTSIDE India where UPI doesn't apply.
//
// Copy this file as-is into any app, then call mountManualIntlKit(app, {...}).
// Same copy-paste-per-app pattern as manual-upi-kit.js / paddle-kit.js /
// paypal-kit.js — no shared package, each app gets its own copy wired to
// its own model.
//
// Deliberately NOT paypal-kit.js (Orders API, instant capture) and NOT
// paddle-kit.js (Merchant of Record, handles everything for a cut): the
// payer sends money to your own PayPal (via a plain paypal.me link or your
// PayPal email), then pastes the transaction ID back into your form. A
// human verifies it in PayPal's own dashboard and approves/rejects in the
// admin panel before anything is marked paid/activated — same trust model
// as manual-upi-kit.js, just for payers who can't use UPI.
//
// Usage:
//   const { mountManualIntlKit } = require('./manual-intl-kit');
//   mountManualIntlKit(app, {
//     paypalMeLink: process.env.ADMIN_PAYPAL_ME_LINK, // e.g. 'https://paypal.me/pinkisappstudio'
//     paypalName: process.env.ADMIN_PAYPAL_NAME,       // shown as plain text, not required
//     currency: 'USD',                                  // default 'USD'
//     adminAuth: yourAdminAuthMiddleware,
//
//     // Validate/derive the amount from the request. Throw (or return a
//     // non-finite/out-of-range number) to reject the submission.
//     getAmount: async (req) => Number(req.body?.amount),
//
//     // Persist a new 'pending' record for this submission. Runs after
//     // getAmount() and transaction-id validation both pass.
//     onSubmit: async (req, { amount, currency, txnId }) => {
//       await Payment.create({ ...fields, amount, currency, txnId, method: 'paypal', status: 'pending' });
//     },
//
//     // req.params.key is whatever identifies the record in your URL
//     // (e.g. a Mongo _id). Return the updated record, or null/undefined
//     // if nothing matched (kit responds 404).
//     onApprove: async (req) => Payment.findByIdAndUpdate(req.params.key, { status: 'completed' }, { new: true }),
//     onReject:  async (req) => Payment.findByIdAndUpdate(req.params.key, { status: 'rejected' }, { new: true }),
//   });
//
// Routes added (override prefixes via routePrefix / adminRoutePrefix):
//   GET  /api/intl-payments/info              -> { paypalMeLink, paypalName, currency }  (public)
//   POST /api/intl-payments/submit            -> body: whatever getAmount() reads, plus `txnId` (required)
//   POST /api/admin/intl-payments/:key/approve  (adminAuth) -> runs onApprove(req)
//   POST /api/admin/intl-payments/:key/reject   (adminAuth) -> runs onReject(req)
//
// Client side: see manual-intl-widget.js for the matching frontend piece
// (two-step modal: quote details -> PayPal link + transaction-id entry -> submitted).

function mountManualIntlKit(app, {
  routePrefix = '/api/intl-payments',
  adminRoutePrefix = '/api/admin/intl-payments',
  paypalMeLink,
  paypalName,
  currency = 'USD',
  adminAuth,
  getAmount,
  onSubmit,
  onApprove,
  onReject,
} = {}) {
  if (!paypalMeLink) {
    console.error('manual-intl-kit: paypalMeLink not set — info will return an empty link and the client will refuse to proceed.');
  }
  if (typeof getAmount !== 'function') {
    throw new Error('manual-intl-kit: getAmount(req) is required — never trust a client-supplied amount without validating it.');
  }
  if (typeof onSubmit !== 'function') {
    throw new Error('manual-intl-kit: onSubmit(req, { amount, currency, txnId }) is required.');
  }
  if (typeof onApprove !== 'function' || typeof onReject !== 'function') {
    throw new Error('manual-intl-kit: onApprove(req) and onReject(req) are required.');
  }
  if (typeof adminAuth !== 'function') {
    throw new Error('manual-intl-kit: adminAuth middleware is required to protect approve/reject.');
  }

  app.get(`${routePrefix}/info`, (req, res) => {
    res.json({ paypalMeLink: paypalMeLink || '', paypalName: paypalName || '', currency });
  });

  app.post(`${routePrefix}/submit`, async (req, res) => {
    try {
      const amount = await getAmount(req);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Invalid payment amount' });
      }
      const txnId = req.body?.txnId;
      if (!txnId || typeof txnId !== 'string' || !txnId.trim()) {
        return res.status(400).json({ error: 'PayPal transaction ID is required' });
      }
      await onSubmit(req, { amount, currency, txnId: txnId.trim().slice(0, 40) });
      res.json({ success: true, message: 'Submitted — we verify payments manually, usually within a few hours.' });
    } catch (err) {
      console.error('manual-intl-kit submit error:', err.message);
      res.status(400).json({ error: err.message || 'Could not submit payment' });
    }
  });

  app.post(`${adminRoutePrefix}/:key/approve`, adminAuth, async (req, res) => {
    const record = await onApprove(req);
    if (!record) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, record });
  });

  app.post(`${adminRoutePrefix}/:key/reject`, adminAuth, async (req, res) => {
    const record = await onReject(req);
    if (!record) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, record });
  });
}

module.exports = { mountManualIntlKit };
