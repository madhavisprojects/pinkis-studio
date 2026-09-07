// manual-upi-widget.js — frontend half of manual-upi-kit.js (manual UPI
// deep link + UTR payment flow). Copy this file as-is into any app's static
// folder, include it with a plain <script src="/manual-upi-widget.js">
// (no build step, no bundler — matches this project's vanilla-JS pages),
// then call ManualUpiWidget.init({...}) once the DOM is ready.
//
// Drives a two-step modal that must already exist in your HTML:
//   Step 1 (details form) -> collects whatever fields you need (name,
//     email, amount, ...) and a submit button.
//   Step 2 (UTR form, starts `hidden`) -> a "Pay via UPI app" link, the
//     UPI ID + amount shown as text, a UTR input, and a submit button.
//   A "done" element (starts `hidden`) shown after successful submission.
//
// IMPORTANT: if your CSS sets `form { display: ... }` anywhere (grid/flex),
// it will override the native `[hidden]` attribute's `display:none` — add
// `form[hidden]{display:none}` to your stylesheet, or step 2 will show
// alongside step 1 instead of replacing it. (Real bug hit building this.)
//
// Usage:
//   <script src="/manual-upi-widget.js"></script>
//   <script>
//     const payWidget = ManualUpiWidget.init({
//       modalOverlayId: 'payModalOverlay',
//       modalCloseId: 'payModalClose',
//       detailsFormId: 'payDetailsForm',   // fields: whatever you need + one holding the amount
//       amountFieldName: 'amount',
//       utrFormId: 'payUtrForm',
//       utrFieldName: 'utr',
//       upiLinkId: 'payUpiLink',
//       upiIdSpanId: 'payUpiId',
//       upiAmountSpanId: 'payUpiAmount',
//       doneMsgId: 'payDoneMsg',
//       transactionNote: 'Project Payment',
//       // Optional — customize what gets sent to /api/payments/submit.
//       // Defaults to { ...detailsFormFields, utr }.
//       buildSubmitBody: (fields, utr) => ({ ...fields, utr }),
//     });
//     document.getElementById('payProjectBtn').addEventListener('click', () => {
//       payWidget.open({ name: mainFormName, email: mainFormEmail }); // optional prefill
//     });
//
// Server side: mount manual-upi-kit.js's routes at the default
// /api/payments/upi-info and /api/payments/submit (or pass upiInfoUrl /
// submitUrl here to match a different prefix).

(function (global) {
  function ManualUpiWidgetInit(config) {
    const {
      modalOverlayId, modalCloseId,
      detailsFormId, amountFieldName = 'amount',
      utrFormId, utrFieldName = 'utr',
      upiLinkId, upiIdSpanId, upiAmountSpanId, doneMsgId,
      upiInfoUrl = '/api/payments/upi-info',
      submitUrl = '/api/payments/submit',
      transactionNote = 'Payment',
      buildSubmitBody,
    } = config;

    const overlay = document.getElementById(modalOverlayId);
    const detailsForm = document.getElementById(detailsFormId);
    const utrForm = document.getElementById(utrFormId);
    const doneMsg = doneMsgId ? document.getElementById(doneMsgId) : null;
    const detailsBtn = detailsForm.querySelector('button[type="submit"]');
    const utrBtn = utrForm.querySelector('button[type="submit"]');
    const detailsStatus = detailsForm.querySelector('.manual-upi-status') || detailsForm.querySelector('p:last-child');
    const utrStatus = utrForm.querySelector('.manual-upi-status') || utrForm.querySelector('p:last-child');

    let lastFields = null;

    function reset() {
      detailsForm.hidden = false;
      utrForm.hidden = true;
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

      const info = await fetch(upiInfoUrl).then(r => r.json()).catch(() => null);
      if (!info?.upiId) {
        if (detailsStatus) detailsStatus.textContent = 'Payments are temporarily unavailable — please try again shortly or contact us directly.';
        if (detailsBtn) detailsBtn.disabled = false;
        return;
      }
      if (detailsBtn) detailsBtn.disabled = false;

      if (upiIdSpanId) document.getElementById(upiIdSpanId).textContent = info.upiId;
      if (upiAmountSpanId) document.getElementById(upiAmountSpanId).textContent = fields[amountFieldName] || '';
      if (upiLinkId) {
        // No `am` param — some UPI apps misparse a prefilled amount as an
        // "exceeding limit" error; the visible amount text covers it instead.
        document.getElementById(upiLinkId).href =
          `upi://pay?pa=${encodeURIComponent(info.upiId)}&pn=${encodeURIComponent(info.upiName || '')}&tn=${encodeURIComponent(transactionNote)}`;
      }

      detailsForm.hidden = true;
      utrForm.hidden = false;
    });

    utrForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const utr = utrForm.querySelector(`[name="${utrFieldName}"]`)?.value.trim() || '';
      if (utrBtn) utrBtn.disabled = true;
      if (utrStatus) utrStatus.textContent = 'Submitting…';
      try {
        const body = buildSubmitBody ? buildSubmitBody(lastFields, utr) : { ...lastFields, [utrFieldName]: utr };
        const res = await fetch(submitUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) {
          if (utrStatus) utrStatus.textContent = 'Could not submit: ' + (data.error || res.status);
          if (utrBtn) utrBtn.disabled = false;
          return;
        }
        utrForm.hidden = true;
        if (doneMsg) doneMsg.hidden = false;
      } catch (err) {
        if (utrStatus) utrStatus.textContent = 'Connection error — please try again.';
      } finally {
        if (utrBtn) utrBtn.disabled = false;
      }
    });

    return { open, close };
  }

  global.ManualUpiWidget = { init: ManualUpiWidgetInit };
})(window);
