(() => {
  const form = document.querySelector('#payment-form');
  if (!form) return;
  const options = document.querySelector('#service-options');
  const otherServices = document.querySelector('#other-services');
  const stages = [...document.querySelectorAll('.payment-stage')];
  const selected = new Set();
  const result = document.querySelector('#payment-result');
  const panel = document.querySelector('#bank-payment-panel');
  const error = document.querySelector('#confirm-error');
  const amountInput = document.querySelector('#agreed-price');
  const emailInput = document.querySelector('#customer-email');
  const consent = document.querySelector('#payment-consent');
  const continueButton = document.querySelector('#continue-payment');
  let services = [];
  let stage = 1;
  let sessionReference = null;
  let pollTimer = null;
  const money = (value, currency) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
  function updateProgress(step) {
    stage = step;
    stages.forEach(item => { item.hidden = Number(item.dataset.stage) !== step; });
    document.querySelectorAll('[data-progress]').forEach(item => { const value = Number(item.dataset.progress); item.classList.toggle('is-current', value === step); item.classList.toggle('is-complete', value < step); });
    document.querySelector('#progress-fill').style.width = `${((step - 1) / 2) * 100}%`;
  }
  function selectedServices() { return services.filter(item => selected.has(item.id)); }
  function updateSelection() {
    options.querySelectorAll('[data-service-id]').forEach(button => button.setAttribute('aria-pressed', String(selected.has(button.dataset.serviceId))));
    const names = selectedServices().map(item => item.name);
    document.querySelector('#service-description').textContent = names.length ? `${names.length} selected: ${names.join(', ')}` : 'Choose all services on your agreement.';
    document.querySelector('#to-overview').disabled = !names.length;
  }
  function serviceButton(service) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'service-option'; button.dataset.serviceId = service.id; button.setAttribute('aria-pressed', 'false');
    const icon = document.createElement('span'); icon.className = 'service-option-icon'; icon.textContent = '✦';
    const label = document.createElement('span'); label.className = 'service-option-text'; const name = document.createElement('strong'); name.textContent = service.name; const note = document.createElement('small'); note.textContent = service.description || 'Netrue service'; label.append(name, note);
    const mark = document.createElement('span'); mark.className = 'service-option-mark'; mark.textContent = '✓'; button.append(icon, label, mark);
    button.addEventListener('click', () => { selected.has(service.id) ? selected.delete(service.id) : selected.add(service.id); updateSelection(); });
    return button;
  }
  async function loadServices() {
    const response = await fetch('/api/services'); if (!response.ok) throw new Error('Services could not be loaded. Please refresh.');
    const paymentSettings = await fetch('/api/payment-settings').then(item => item.json()).catch(() => ({ bankTransferEnabled: false, paystackEnabled: false }));
    const bankOption = document.querySelector('#bank-method-option'); const paystackOption = document.querySelector('#paystack-method-option');
    bankOption.hidden = !paymentSettings.bankTransferEnabled; bankOption.querySelector('input').disabled = !paymentSettings.bankTransferEnabled;
    paystackOption.hidden = !paymentSettings.paystackEnabled; paystackOption.querySelector('input').disabled = !paymentSettings.paystackEnabled;
    if (!paymentSettings.bankTransferEnabled && paymentSettings.paystackEnabled) paystackOption.querySelector('input').checked = true;
    if (!paymentSettings.bankTransferEnabled && !paymentSettings.paystackEnabled) throw new Error('Payments are not available right now. Please contact info@netrue.io.');
    services = await response.json(); options.replaceChildren(); otherServices.replaceChildren();
    const popularIds = ['ai-systems','iot-connected-systems','embedded-engineering','smart-agriculture','digital-products','research-prototyping'];
    const popular = services.filter(item => popularIds.includes(item.id));
    const extra = services.filter(item => !popularIds.includes(item.id));
    popular.forEach(item => options.append(serviceButton(item)));
    if (!popular.length) options.append(Object.assign(document.createElement('p'), { className: 'service-loading', textContent: 'No popular services yet.' }));
    for (const service of extra) { const option = document.createElement('option'); option.value = service.id; option.textContent = service.name; otherServices.append(option); }
    if (!extra.length) { const option = document.createElement('option'); option.textContent = 'No additional services yet'; option.disabled = true; otherServices.append(option); }
    otherServices.addEventListener('change', () => { [...otherServices.options].forEach(item => { if (item.value) item.selected ? selected.add(item.value) : selected.delete(item.value); }); updateSelection(); });
    const quote = new URLSearchParams(location.search).get('quote');
    if (quote) { try { const response = await fetch('/api/payment-quotes/lookup', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ reference: quote }) }); const data = await response.json(); if (response.ok) { selected.add(data.serviceId); amountInput.value = data.agreedPrice; document.querySelector('#payment-currency').value = data.currency; const option = [...otherServices.options].find(item => item.value === data.serviceId); if (option) option.selected = true; } } catch {} }
    updateSelection();
  }
  function amountFormatted() { const n = Number(amountInput.value); return Number.isFinite(n) && n > 0 ? money(n, document.querySelector('#payment-currency').value) : '—'; }
  function updateContinue() { continueButton.disabled = !(selected.size && Number(amountInput.value) > 0 && emailInput.checkValidity() && consent.checked); document.querySelector('#summary-amount').textContent = amountFormatted(); }
  document.querySelector('#to-overview').addEventListener('click', () => { document.querySelector('#summary-service').textContent = selectedServices().map(item => item.name).join(', '); updateProgress(2); updateContinue(); });
  document.querySelectorAll('[data-back="1"]').forEach(button => button.addEventListener('click', () => updateProgress(1)));
  document.querySelectorAll('[data-progress]').forEach(button => button.addEventListener('click', () => { const step = Number(button.dataset.progress); if (step < stage) updateProgress(step); }));
  [amountInput, emailInput, consent, document.querySelector('#payment-currency')].forEach(input => input.addEventListener('input', updateContinue));
  consent.addEventListener('change', updateContinue);
  async function api(url, body) { const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type':'application/json', Accept:'application/json' } : { Accept:'application/json' }, body: body ? JSON.stringify(body) : undefined, cache:'no-store' }); const data = response.status === 204 ? null : await response.json(); if (!response.ok) throw new Error(data?.error || 'Payment request failed.'); return data; }
  function checkoutPayload() { return { serviceIds: [...selected], agreedPrice: amountInput.value, currency: document.querySelector('#payment-currency').value, email: emailInput.value.trim(), name: document.querySelector('#customer-name').value.trim() }; }
  function receiptView(data) {
    clearInterval(pollTimer); form.hidden = true; result.hidden = false; result.className = 'payment-result payment-result-success';
    result.innerHTML = `<div class="receipt-brand"><span class="receipt-mark" aria-hidden="true"><i></i><i></i><i></i><b></b></span><strong>netrue<span>.</span></strong></div><span class="result-icon">✓</span><span class="result-eyebrow">PAYMENT CONFIRMED</span><h2>Thank you.</h2><p>Your payment for <strong>${escapeHtml((data.serviceNames || [data.serviceName || 'your Netrue service']).join(', '))}</strong> was approved.</p><div class="receipt-ready"><span>AMOUNT PAID</span><strong>${escapeHtml(data.amount || '')}</strong><small>Receipt ${escapeHtml(data.receiptNumber)}</small></div><a class="button button-primary receipt-download" href="${escapeHtml(data.receiptUrl || '/api/receipt/download')}">Download your receipt <span aria-hidden="true">↓</span></a><p class="receipt-note">Your receipt is saved in this browser for 48 hours.</p><a class="payment-result-home" href="/">Return to Netrue</a>`;
  }
  function renderBank(data) {
    sessionReference = data.reference; updateProgress(3); form.querySelector('[data-stage="3"]').hidden = false;
    if (data.status === 'denied' || data.status === 'cancelled') { panel.innerHTML = `<div class="stage-heading"><span>PAYMENT REVIEW</span><h2>Transfer not approved</h2><p>Netrue could not approve this transfer. Contact us with reference <strong>${escapeHtml(data.reference)}</strong> for help.</p></div><a class="button button-primary" href="mailto:info@netrue.io?subject=${encodeURIComponent(`Transfer review ${data.reference}`)}">Contact Netrue</a><button class="button button-quiet" id="return-to-checkout" type="button">Return to checkout</button>`; panel.querySelector('#return-to-checkout').addEventListener('click', () => { sessionReference = null; form.hidden = false; result.hidden = true; updateProgress(1); }); return; }
    const isWaiting = ['awaiting_approval','pending_review'].includes(data.status);
    const accountText = data.bankAccountDetails || '';
    panel.innerHTML = `<div class="stage-heading"><span>STEP 03</span><h2>${isWaiting ? 'Payment is being verified' : 'Send your payment'}</h2><p>${isWaiting ? 'Please wait while Netrue checks your transfer.' : 'Send the agreed amount to this account, then let us know.'}</p></div>${isWaiting ? '<div class="verification-wait"><span class="verification-spinner"></span><strong>Payment is being verified</strong><p>Please wait. We will update this page as soon as Netrue reviews your transfer.</p></div>' : `<div class="bank-transfer-card"><div class="bank-transfer-amount"><span>AMOUNT TO SEND</span><strong>${escapeHtml(data.amount)}</strong></div><div class="bank-account-name"><span>ACCOUNT NAME</span><strong>${escapeHtml(data.bankAccountName || '')}</strong></div><div class="bank-account-details"><span>ACCOUNT DETAILS</span><pre id="copy-account-details">${escapeHtml(accountText)}</pre><button id="copy-account-button" type="button">Copy account details</button></div><small>Payment reference: ${escapeHtml(data.reference)}</small></div><p class="checkout-error" id="bank-error" role="alert" hidden></p><div class="bank-actions"><button class="button button-quiet" id="cancel-bank-payment" type="button">Cancel payment</button><button class="button button-primary" id="mark-paid-button" type="button">I have paid</button></div><p class="checkout-fineprint">Your checkout will be saved in this browser for 48 hours.</p>`}`;
    if (isWaiting) { pollTimer = setInterval(checkManualStatus, 4000); return; }
    panel.querySelector('#copy-account-button').addEventListener('click', async event => { try { await navigator.clipboard.writeText(accountText); event.currentTarget.textContent = 'Copied'; } catch { const range = document.createRange(); range.selectNodeContents(panel.querySelector('#copy-account-details')); getSelection().removeAllRanges(); getSelection().addRange(range); event.currentTarget.textContent = 'Select and copy'; } });
    panel.querySelector('#mark-paid-button').addEventListener('click', async event => { event.currentTarget.disabled = true; try { await api(`/api/payments/bank-transfer/${encodeURIComponent(data.reference)}/paid`, {}); renderBank({ ...data, status: 'awaiting_approval' }); } catch (e) { panel.querySelector('#bank-error').textContent = e.message; panel.querySelector('#bank-error').hidden = false; event.currentTarget.disabled = false; } });
    panel.querySelector('#cancel-bank-payment').addEventListener('click', async () => { try { await api(`/api/payments/bank-transfer/${encodeURIComponent(data.reference)}/cancel`, {}); clearInterval(pollTimer); sessionReference = null; form.hidden = false; result.hidden = true; updateProgress(1); } catch (e) { window.alert(e.message); } });
  }
  async function checkManualStatus() {
    if (!sessionReference) return;
    try { const data = await api(`/api/payments/bank-transfer/${encodeURIComponent(sessionReference)}/status`); if (data.status === 'paid') { const resume = await api('/api/payments/resume'); receiptView({ ...resume, receiptUrl: data.receiptUrl || '/api/receipt/download' }); } else if (data.status === 'denied' || data.status === 'cancelled') { clearInterval(pollTimer); renderBank({ reference: sessionReference, status: 'denied' }); panel.insertAdjacentHTML('beforeend', '<p class="checkout-error">This transfer was not approved. Contact Netrue for help.</p>'); } } catch {}
  }
  continueButton.addEventListener('click', async () => {
    error.hidden = true; if (!consent.checked) { consent.reportValidity(); return; } if (!emailInput.reportValidity()) return;
    continueButton.disabled = true; continueButton.textContent = 'Preparing payment…';
    try {
      const method = document.querySelector('[name="payment-method"]:checked').value; const payload = checkoutPayload();
      if (method === 'paystack') { const data = await api('/api/payments/initialize-multi', payload); location.assign(data.authorizationUrl); return; }
      const data = await api('/api/payments/bank-transfer', payload); renderBank(data);
    } catch (e) { error.textContent = e.message; error.hidden = false; }
    finally { continueButton.textContent = 'Continue to payment →'; updateContinue(); }
  });
  async function restoreSession() {
    const params = new URLSearchParams(location.search); const paystackRef = params.get('reference') || params.get('trxref');
    if (paystackRef) { form.hidden = true; result.hidden = false; result.innerHTML = '<span class="result-icon result-wait">…</span><span class="result-eyebrow">PAYMENT STATUS</span><h2>Confirming your payment</h2><p>We are checking your transaction with Paystack.</p>'; try { const data = await api(`/api/payments/verify/${encodeURIComponent(paystackRef)}`); receiptView(data); } catch (e) { result.innerHTML = `<span class="result-eyebrow">PAYMENT STATUS</span><h2>We could not confirm this yet.</h2><p>${escapeHtml(e.message)}</p><a href="mailto:info@netrue.io">Contact info@netrue.io</a><a class="payment-result-home" href="/payment.html">Return to checkout</a>`; } return; }
    try { const data = await api('/api/payments/resume'); if (!data) return; if (data.status === 'paid') { receiptView(data); return; } if (data.method === 'bank_transfer' && ['awaiting_approval','awaiting_customer_payment','denied'].includes(data.status)) renderBank(data); } catch {}
  }
  loadServices().then(restoreSession).catch(error => { options.textContent = error.message; });
})();
