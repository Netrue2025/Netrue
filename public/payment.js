(() => {
  const form = document.querySelector('#payment-form');
  if (!form) return;
  const serviceOptions = document.querySelector('#service-options');
  const quoteReference = form.elements.quoteReference;
  const email = form.elements.email;
  const name = form.elements.name;
  const consent = document.querySelector('#payment-consent');
  const applyButton = document.querySelector('#apply-quote');
  const quoteStatus = document.querySelector('#quote-status');
  const amountDue = document.querySelector('#summary-amount');
  const payButton = document.querySelector('#pay-button');
  const errorBox = document.querySelector('#checkout-error');
  const confirmError = document.querySelector('#confirm-error');
  const result = document.querySelector('#payment-result');
  const stages = [...document.querySelectorAll('.payment-stage')];
  let currentStage = 1;
  let services = [];
  let selectedServiceId = null;
  let activeQuote = null;
  const icons = {
    'ai-systems': '<path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1"/><circle cx="12" cy="12" r="4"/>',
    'iot-connected-systems': '<circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="12" r="7"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2"/>',
    'embedded-engineering': '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/>',
    'smart-agriculture': '<path d="M12 21v-9m0 4c-5 0-8-3-8-8 5 0 8 3 8 8Zm0-3c0-5 3-8 8-8 0 5-3 8-8 8Z"/>',
    'digital-products': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18m-12 0v11"/>',
    'research-prototyping': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5m-10-14v7m-3.5-3.5h7"/>'
  };
  function money(minor, currency) {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / (10 ** digits));
  }
  function updateControls() {
    const selected = services.find(service => service.id === selectedServiceId);
    document.querySelector('#to-quote').disabled = !selected;
    const quoteMatches = activeQuote && selected?.id === activeQuote.serviceId;
    document.querySelector('#to-confirm').disabled = !quoteMatches;
    const emailValid = activeQuote?.requiresEmail ? email.checkValidity() && email.value.trim() : true;
    payButton.disabled = !(consent.checked && quoteMatches && emailValid);
    if (activeQuote) amountDue.textContent = money(activeQuote.amountMinor, activeQuote.currency);
    if (activeQuote && currentStage === 3 && activeQuote.requiresEmail) document.querySelector('#summary-email').textContent = email.value.trim() || 'Email required for receipt';
  }
  function goTo(step) {
    if (step > currentStage && step === 2 && !selectedServiceId) return;
    if (step > currentStage && step === 3 && document.querySelector('#to-confirm').disabled) return;
    currentStage = step;
    stages.forEach(stage => { stage.hidden = Number(stage.dataset.stage) !== step; });
    document.querySelectorAll('.progress-step').forEach(item => {
      const value = Number(item.dataset.progress); item.classList.toggle('is-current', value === step); item.classList.toggle('is-complete', value < step);
    });
    document.querySelector('#progress-fill').style.width = `${((step - 1) / 2) * 100}%`;
    if (step === 3) {
      document.querySelector('#summary-service').textContent = activeQuote?.serviceName || '—';
      document.querySelector('#summary-email').textContent = activeQuote?.requiresEmail ? (email.value.trim() || 'Email required for receipt') : 'Email provided with quote';
      document.querySelector('#summary-amount').textContent = activeQuote ? money(activeQuote.amountMinor, activeQuote.currency) : '—';
      document.querySelector('#checkout-email-field').hidden = !activeQuote?.requiresEmail;
      email.required = Boolean(activeQuote?.requiresEmail);
      confirmError.hidden = true;
    }
    updateControls();
  }
  function selectService(service) {
    selectedServiceId = service.id;
    serviceOptions.querySelectorAll('.service-option').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.serviceId === service.id)));
    document.querySelector('#service-description').textContent = service.description || 'Netrue service';
    if (activeQuote && activeQuote.serviceId !== service.id) {
      activeQuote = null; quoteStatus.textContent = 'This quote belongs to a different service. Apply the matching quote.'; quoteStatus.classList.remove('is-success');
    }
    updateControls();
  }
  function renderService(service) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'service-option'; button.dataset.serviceId = service.id; button.setAttribute('aria-pressed', 'false');
    const icon = document.createElement('span'); icon.className = 'service-option-icon'; icon.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.6'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.innerHTML = icons[service.id] || '<circle cx="12" cy="12" r="8"/>'; icon.append(svg);
    const info = document.createElement('span'); info.className = 'service-option-text'; const title = document.createElement('strong'); title.textContent = service.name; const price = document.createElement('small'); price.textContent = service.active ? money(service.amountMinor, service.currency) : 'Quoted price'; info.append(title, price);
    const mark = document.createElement('span'); mark.className = 'service-option-mark'; mark.textContent = '✓'; mark.setAttribute('aria-hidden', 'true'); button.append(icon, info, mark); button.addEventListener('click', () => selectService(service)); serviceOptions.append(button);
  }
  async function loadServices() {
    try {
      const response = await fetch('/api/services'); if (!response.ok) throw new Error('Services could not be loaded. Please refresh the page.');
      services = await response.json(); serviceOptions.replaceChildren(); services.forEach(renderService);
      if (!services.length) serviceOptions.innerHTML = '<p class="service-loading">No services found. Contact info@netrue.io for a quote.</p>';
      const quoteFromLink = new URLSearchParams(location.search).get('quote');
      if (quoteFromLink) { quoteReference.value = quoteFromLink; goTo(2); await applyCurrentQuote(true); }
      updateControls();
    } catch (error) { serviceOptions.textContent = error.message; }
  }
  async function applyCurrentQuote(fromLink = false) {
    errorBox.hidden = true;
    const ref = quoteReference.value.trim();
    if (!/^NTRQ-[A-F0-9]{12}$/i.test(ref)) { errorBox.textContent = 'Enter the quote reference from Netrue.'; errorBox.hidden = false; quoteReference.focus(); return; }
    applyButton.disabled = true; applyButton.textContent = 'Checking…';
    try {
      const response = await fetch('/api/payment-quotes/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ reference: ref }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Quote could not be applied.');
      activeQuote = data; selectedServiceId = data.serviceId;
      const service = services.find(item => item.id === data.serviceId); if (service) serviceOptions.querySelector(`[data-service-id="${CSS.escape(data.serviceId)}"]`)?.setAttribute('aria-pressed', 'true');
      document.querySelector('#quote-service-name').textContent = data.serviceName;
      document.querySelector('#quote-agreed-amount').textContent = money(data.amountMinor, data.currency);
      document.querySelector('#quote-preview').hidden = false;
      quoteStatus.textContent = `Quote loaded for ${data.serviceName}. The agreed amount is confirmed.`; quoteStatus.classList.remove('is-error'); quoteStatus.classList.add('is-success');
      updateControls();
      if (fromLink) goTo(3);
    } catch (error) { activeQuote = null; quoteStatus.textContent = error.message; quoteStatus.classList.remove('is-success'); quoteStatus.classList.add('is-error'); errorBox.textContent = error.message; errorBox.hidden = false; }
    finally { applyButton.disabled = false; applyButton.textContent = 'Apply quote'; }
  }
  applyButton.addEventListener('click', applyCurrentQuote);
  document.querySelector('#to-quote').addEventListener('click', () => goTo(2));
  document.querySelector('#to-confirm').addEventListener('click', () => goTo(3));
  document.querySelectorAll('[data-back]').forEach(button => button.addEventListener('click', () => goTo(Number(button.dataset.back))));
  document.querySelectorAll('[data-progress]').forEach(button => button.addEventListener('click', () => { const step = Number(button.dataset.progress); if (step < currentStage) goTo(step); }));
  quoteReference.addEventListener('input', () => { if (activeQuote) { activeQuote = null; document.querySelector('#quote-preview').hidden = true; quoteStatus.textContent = 'Quote reference changed. Load it again.'; quoteStatus.classList.remove('is-success'); } updateControls(); });
  [email, name, consent].forEach(input => input.addEventListener('input', updateControls)); consent.addEventListener('change', updateControls);
  form.addEventListener('submit', async event => {
    event.preventDefault(); confirmError.hidden = true;
    if (!consent.checked) { consent.reportValidity(); return; }
    if (!activeQuote || !selectedServiceId) { confirmError.textContent = 'Load a valid Netrue quote before continuing.'; confirmError.hidden = false; return; }
    if (activeQuote.requiresEmail && !email.checkValidity()) { email.reportValidity(); return; }
    payButton.disabled = true; payButton.innerHTML = 'Connecting securely…';
    try {
      const response = await fetch('/api/payments/initialize', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ serviceId: selectedServiceId, email: email.value.trim(), name: name.value.trim(), quoteReference: quoteReference.value.trim(), agreedPrice: activeQuote.agreedPrice }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Checkout could not start. Please try again.');
      location.assign(data.authorizationUrl);
    } catch (error) { confirmError.textContent = error.message; confirmError.hidden = false; payButton.innerHTML = 'Pay securely <span aria-hidden="true">↗</span>'; updateControls(); }
  });
  async function verifyReturn() {
    const params = new URLSearchParams(location.search); const reference = params.get('reference') || params.get('trxref'); if (!reference) return;
    form.hidden = true; result.hidden = false; result.innerHTML = '<span class="result-icon result-wait">…</span><span class="result-eyebrow">PAYMENT STATUS</span><h2>Confirming your payment</h2><p>We are checking your transaction with Paystack.</p>';
    try {
      let data;
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await fetch(`/api/payments/verify/${encodeURIComponent(reference)}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        data = await response.json().catch(() => ({}));
        if (response.ok) break;
        const mayStillSettle = response.status === 402 || response.status >= 500 || (response.status === 409 && /processing/i.test(data.error || ''));
        if (!mayStillSettle || attempt === 4) throw new Error(data.error || 'Payment confirmation is not available yet.');
        result.querySelector('p').textContent = 'Your payment is settling. We will check again in a moment.';
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
      result.classList.add('payment-result-success');
      result.innerHTML = `<div class="receipt-brand"><span class="receipt-mark" aria-hidden="true"><i></i><i></i><i></i><b></b></span><strong>netrue<span>.</span></strong></div><span class="result-icon">✓</span><span class="result-eyebrow">PAYMENT CONFIRMED</span><h2>Thank you.</h2><p>Your payment for <strong>${escapeHtml(data.serviceName || 'your Netrue service')}</strong> was received.</p><div class="receipt-ready"><span>AMOUNT PAID</span><strong>${escapeHtml(data.amount || '')}</strong><small>Receipt ${escapeHtml(data.receiptNumber)}</small></div><a class="button button-primary receipt-download" href="${escapeHtml(data.receiptUrl)}">Download your receipt <span aria-hidden="true">↓</span></a><p class="receipt-note">Your receipt is saved in this browser for 30 days.</p><a class="payment-result-home" href="/">Return to Netrue</a>`;
    } catch (error) { result.classList.add('payment-result-failed'); result.innerHTML = `<span class="result-icon result-pending">!</span><span class="result-eyebrow">PAYMENT STATUS</span><h2>We could not confirm this yet.</h2><p>${escapeHtml(error.message)}</p><p class="payment-reference-note">Reference: <strong>${escapeHtml(reference)}</strong></p><a class="button button-primary" href="/payment.html?reference=${encodeURIComponent(reference)}">Check payment again</a><a href="mailto:info@netrue.io?subject=${encodeURIComponent(`Payment verification ${reference}`)}&body=${encodeURIComponent(`Please check payment reference ${reference}.`)}">Contact info@netrue.io</a><a class="payment-result-home" href="/">Return to Netrue</a>`; }
  }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  loadServices(); verifyReturn();
})();
