// manual-intl-widget.js — frontend half of manual-intl-kit.js (manual
// PayPal send-money link + transaction-id payment flow, for customers
// outside India). Copy this file as-is into any app's static folder,
// include it with a plain <script src="/manual-intl-widget.js"> (no build
// step, matches manual-upi-widget.js), then call ManualIntlWidget.init({...})
// once the DOM is ready.
//
// Drives a two-step modal that must already exist in your HTML — same
// shape as manual-upi-widget.js:
//   Step 1 (details form) -> collects whatever fields you need (name,
//     email, amount, ...) and a submit button. Can be the SAME form
//     manual-upi-widget.js uses; just call whichever widget's .open()
//     matches the payer's chosen method.
//   Step 2 (transaction-id form, starts `hidden`) -> a "Pay with PayPal"
//     link, the amount shown as text, a transaction-id input, and a
//     submit button.
//   A "done" element (starts `hidden`) shown after successful submission.
//
// Usage:
//   <script src="/manual-intl-widget.js"></script>
//   <script>
//     const intlPayWidget = ManualIntlWidget.init({
//       modalOverlayId: 'payModalOverlay',
//       modalCloseId: 'payModalClose',
//       detailsFormId: 'payDetailsForm',
//       amountFieldName: 'amount',
//       txnFormId: 'payIntlTxnForm',
//       txnFieldName: 'txnId',
//       payLinkId: 'payIntlLink',
//       paypalNameSpanId: 'payIntlName',
//       amountSpanId: 'payIntlAmount',
//       doneMsgId: 'payDoneMsg',
//       // Optional — customize what gets sent to /api/intl-payments/submit.
//       // Defaults to { ...detailsFormFields, txnId }.
//       buildSubmitBody: (fields, txnId) => ({ ...fields, txnId }),
//     });
//     document.getElementById('payProjectPaypalBtn').addEventListener('click', () => {
//       intlPayWidget.open({ name: mainFormName, email: mainFormEmail }); // optional prefill
//     });
//
// Server side: mount manual-intl-kit.js's routes at the default
// /api/intl-payments/info and /api/intl-payments/submit (or pass infoUrl /
// submitUrl here to match a different prefix).

(function (global) {
  function ManualIntlWidgetInit(config) {
    const {
      modalOverlayId, modalCloseId,
      detailsFormId, amountFieldName = 'amount',
      txnFormId, txnFieldName = 'txnId',
      payLinkId, paypalNameSpanId, amountSpanId, doneMsgId,
      infoUrl = '/api/intl-payments/info',
      submitUrl = '/api/intl-payments/submit',
      buildSubmitBody,
    } = config;

    const overlay = document.getElementById(modalOverlayId);
    const detailsForm = document.getElementById(detailsFormId);
    const txnForm = document.getElementById(txnFormId);
    const doneMsg = doneMsgId ? document.getElementById(doneMsgId) : null;
    const detailsBtn = detailsForm.querySelector('button[type="submit"]');
    const txnBtn = txnForm.querySelector('button[type="submit"]');
    const detailsStatus = detailsForm.querySelector('.manual-upi-status') || detailsForm.querySelector('p:last-child');
    const txnStatus = txnForm.querySelector('.manual-upi-status') || txnForm.querySelector('p:last-child');

    let lastFields = null;

    function reset() {
      detailsForm.hidden = false;
      txnForm.hidden = true;
      if (doneMsg) doneMsg.hidden = true;
    }

    function open(prefill) {
      reset();
      if (prefill) {
        Object.entries(prefill).forEach(([name, value]) => {
          const field = detailsForm.querySelector(`[name="${name}"]`);
          if (field && value) field.value = value;
        });
      }
      overlay.classList.add('open');
    }

    function close() {
      overlay.classList.remove('open');
    }

    if (modalCloseId) {
      document.getElementById(modalCloseId).addEventListener('click', close);
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    detailsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fields = {};
      new FormData(detailsForm).forEach((value, key) => { fields[key] = String(value).trim(); });
      lastFields = fields;

      if (detailsBtn) detailsBtn.disabled = true;
      if (detailsStatus) detailsStatus.textContent = '';

      const info = await fetch(infoUrl).then(r => r.json()).catch(() => null);
      if (!info?.paypalMeLink) {
        if (detailsStatus) detailsStatus.textContent = 'Payments are temporarily unavailable — please try again shortly or contact us directly.';
        if (detailsBtn) detailsBtn.disabled = false;
        return;
      }
      if (detailsBtn) detailsBtn.disabled = false;

      const amount = fields[amountFieldName] || '';
      if (paypalNameSpanId) document.getElementById(paypalNameSpanId).textContent = info.paypalName || '';
      if (amountSpanId) document.getElementById(amountSpanId).textContent = amount;
      // paypal.me supports the amount directly in the URL (unlike UPI deep
      // links, which misparse a prefilled amount on some apps) — safe to
      // append here.
      const base = info.paypalMeLink.replace(/\/$/, '');
      const payUrl = amount ? `${base}/${encodeURIComponent(amount)}${info.currency || ''}` : base;
      if (payLinkId) document.getElementById(payLinkId).href = payUrl;

      detailsForm.hidden = true;
      txnForm.hidden = false;
    });

    txnForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const txnId = txnForm.querySelector(`[name="${txnFieldName}"]`)?.value.trim() || '';
      if (txnBtn) txnBtn.disabled = true;
      if (txnStatus) txnStatus.textContent = 'Submitting…';
      try {
        const body = buildSubmitBody ? buildSubmitBody(lastFields, txnId) : { ...lastFields, [txnFieldName]: txnId };
        const res = await fetch(submitUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          if (txnStatus) txnStatus.textContent = 'Could not submit: ' + (data.error || res.status);
          if (txnBtn) txnBtn.disabled = false;
          return;
        }
        txnForm.hidden = true;
        if (doneMsg) doneMsg.hidden = false;
      } catch (err) {
        if (txnStatus) txnStatus.textContent = 'Connection error — please try again.';
      } finally {
        if (txnBtn) txnBtn.disabled = false;
      }
    });

    return { open, close };
  }

  global.ManualIntlWidget = { init: ManualIntlWidgetInit };
})(window);
