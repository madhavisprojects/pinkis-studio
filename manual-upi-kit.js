// manual-upi-kit.js — reusable manual UPI (deep-link + UTR) payment flow.
//
// Copy this file as-is into any app, then call mountManualUpiKit(app, {...}).
// Same copy-paste-per-app pattern as paddle-kit.js / paypal-kit.js — no
// shared package, each app gets its own copy wired to its own model.
//
// Unlike a payment gateway (Paddle, Razorpay, FamGateway...), there's no
// callback/webhook and no third-party account, KYC, or fees: the payer
// opens their own UPI app via a deep link to your own UPI ID, then pastes
// the UTR/reference number back into your form. A human verifies it in the
// admin panel (approve/reject) before anything is marked paid/activated.
// This is deliberately the fallback when a real gateway isn't available or
// wanted — see the FamGateway saga (2026-09-07) for why: it required a
// separate FamPay account + KYC just to get a payable UPI handle, and even
// then routed through a bank we didn't want to depend on. Manual UPI keeps
// you dealing directly with your own bank, no intermediary to trust.
//
// IMPORTANT — the `am` (amount) param is deliberately left out of the UPI
// deep link: some UPI apps misparse a prefilled amount as an "exceeding
// limit" error even at small amounts (confirmed in testing on ILoveU
// Premium). The quoted amount is shown as plain text next to the link
// instead, and the payer types it into their own UPI app.
//
// Usage:
//   const { mountManualUpiKit } = require('./manual-upi-kit');
//   mountManualUpiKit(app, {
//     upiId: process.env.ADMIN_UPI_ID,
//     upiName: process.env.ADMIN_UPI_NAME,
//     adminAuth: yourAdminAuthMiddleware,
//
//     // Validate/derive the amount from the request. Throw (or return a
//     // non-finite/out-of-range number) to reject the submission.
//     getAmount: async (req) => Number(req.body?.amount),
//
//     // Persist a new 'pending' record for this submission. Runs after
//     // getAmount() and UTR validation both pass.
//     onSubmit: async (req, { amount, utr }) => {
//       await Payment.create({ ...fields, amount, utr, status: 'pending' });
//     },
//
//     // req.params.key is whatever identifies the record in your URL
//     // (e.g. a Mongo _id, or a mobile number). Return the updated record,
//     // or null/undefined if nothing matched (kit responds 404).
//     onApprove: async (req) => Payment.findByIdAndUpdate(req.params.key, { status: 'completed' }, { new: true }),
//     onReject:  async (req) => Payment.findByIdAndUpdate(req.params.key, { status: 'rejected' }, { new: true }),
//   });
//
// Routes added (override prefixes via routePrefix / adminRoutePrefix):
//   GET  /api/payments/upi-info              -> { upiId, upiName }  (public)
//   POST /api/payments/submit                -> body: whatever getAmount() reads, plus `utr` (required)
//   POST /api/admin/payments/:key/approve    (adminAuth) -> runs onApprove(req)
//   POST /api/admin/payments/:key/reject     (adminAuth) -> runs onReject(req)
//
// Client side: see manual-upi-widget.js for the matching frontend piece
// (two-step modal: quote details -> UPI link + UTR entry -> submitted).

function mountManualUpiKit(app, {
  routePrefix = '/api/payments',
  adminRoutePrefix = '/api/admin/payments',
  upiId,
  upiName,
  adminAuth,
  getAmount,
  onSubmit,
  onApprove,
  onReject,
} = {}) {
  if (!upiId) {
    console.error('manual-upi-kit: upiId not set — upi-info will return an empty UPI ID and the client will refuse to proceed.');
  }
  if (typeof getAmount !== 'function') {
    throw new Error('manual-upi-kit: getAmount(req) is required — never trust a client-supplied amount without validating it.');
  }
  if (typeof onSubmit !== 'function') {
    throw new Error('manual-upi-kit: onSubmit(req, { amount, utr }) is required.');
  }
  if (typeof onApprove !== 'function' || typeof onReject !== 'function') {
    throw new Error('manual-upi-kit: onApprove(req) and onReject(req) are required.');
  }
  if (typeof adminAuth !== 'function') {
    throw new Error('manual-upi-kit: adminAuth middleware is required to protect approve/reject.');
  }

  app.get(`${routePrefix}/upi-info`, (req, res) => {
    res.json({ upiId: upiId || '', upiName: upiName || '' });
  });

  app.post(`${routePrefix}/submit`, async (req, res) => {
    try {
      const amount = await getAmount(req);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Invalid payment amount' });
      }
      const utr = req.body?.utr;
      if (!utr || typeof utr !== 'string' || !utr.trim()) {
        return res.status(400).json({ error: 'Payment UTR is required' });
      }
      await onSubmit(req, { amount, utr: utr.trim().slice(0, 40) });
      res.json({ success: true, message: 'Submitted — we verify payments manually, usually within a few hours.' });
    } catch (err) {
      console.error('manual-upi-kit submit error:', err.message);
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

module.exports = { mountManualUpiKit };
