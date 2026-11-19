(() => {
  const form = document.querySelector('#payment-form');
  if (!form) return;
  const serviceOptions = document.querySelector('#service-options');
  const quoteReference = form.elements.quoteReference;
  const agreedPrice = form.elements.agreedPrice;
  const email = form.elements.email;
  const name = form.elements.name;
  const consent = document.querySelector('#payment-consent');
  const applyButton = document.querySelector('#apply-quote');
  const quoteStatus = document.querySelector('#quote-status');
  const quoteCurrency = document.querySelector('#quote-currency');
  const currencySymbol = document.querySelector('#currency-symbol');
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
  function minorFor(value, currency) {
    if (!value || !/^\d+(?:\.\d{1,3})?$/.test(String(value))) return null;
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    const [whole, fraction = ''] = String(value).split('.');
    if (fraction.length > digits) return null;
    const minor = Number(whole) * (10 ** digits) + Number((fraction + '0'.repeat(digits)).slice(0, digits) || 0);
    return Number.isSafeInteger(minor) ? minor : null;
  }
  function money(minor, currency) {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / (10 ** digits));
  }
  function symbol(currency) {
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0).find(part => part.type === 'currency')?.value || currency; }
    catch { return currency; }
  }
  function updateControls() {
    const selected = services.find(service => service.id === selectedServiceId);
    document.querySelector('#to-quote').disabled = !selected;
    const priceMatches = activeQuote && minorFor(agreedPrice.value, activeQuote.currency) === activeQuote.amountMinor;
    const quoteMatches = activeQuote && selected?.id === activeQuote.serviceId && email.value.trim().toLowerCase() === activeQuote.customerEmail && priceMatches;
    document.querySelector('#to-confirm').disabled = !quoteMatches;
    payButton.disabled = !(name.value.trim().length >= 2 && consent.checked && quoteMatches);
    if (activeQuote) amountDue.textContent = money(activeQuote.amountMinor, activeQuote.currency);
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
      document.querySelector('#summary-email').textContent = email.value.trim();
      document.querySelector('#summary-amount').textContent = activeQuote ? money(activeQuote.amountMinor, activeQuote.currency) : '—';
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
      if (quoteFromLink) { quoteReference.value = quoteFromLink; goTo(2); }
      updateControls();
    } catch (error) { serviceOptions.textContent = error.message; }
  }
  async function applyCurrentQuote() {
    errorBox.hidden = true;
    const ref = quoteReference.value.trim(); const mail = email.value.trim().toLowerCase();
    if (!/^NTRQ-[A-F0-9]{12}$/i.test(ref)) { errorBox.textContent = 'Enter the quote reference from Netrue.'; errorBox.hidden = false; quoteReference.focus(); return; }
    if (!email.checkValidity() || !mail) { errorBox.textContent = 'Enter the email address used for this quote.'; errorBox.hidden = false; email.focus(); return; }
    applyButton.disabled = true; applyButton.textContent = 'Checking…';
    try {
      const response = await fetch('/api/payment-quotes/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ reference: ref, email: mail }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Quote could not be applied.');
      activeQuote = { ...data, customerEmail: mail }; selectedServiceId = data.serviceId;
      const service = services.find(item => item.id === data.serviceId); if (service) serviceOptions.querySelector(`[data-service-id="${CSS.escape(data.serviceId)}"]`)?.setAttribute('aria-pressed', 'true');
      agreedPrice.value = data.agreedPrice; quoteCurrency.textContent = data.currency; currencySymbol.textContent = symbol(data.currency);
      quoteStatus.textContent = `Quote applied for ${data.serviceName}. Check the agreed amount, then continue.`; quoteStatus.classList.remove('is-error'); quoteStatus.classList.add('is-success');
      updateControls();
    } catch (error) { activeQuote = null; quoteStatus.textContent = error.message; quoteStatus.classList.remove('is-success'); quoteStatus.classList.add('is-error'); errorBox.textContent = error.message; errorBox.hidden = false; }
    finally { applyButton.disabled = false; applyButton.textContent = 'Apply quote'; }
  }
  applyButton.addEventListener('click', applyCurrentQuote);
  document.querySelector('#to-quote').addEventListener('click', () => goTo(2));
  document.querySelector('#to-confirm').addEventListener('click', () => goTo(3));
  document.querySelectorAll('[data-back]').forEach(button => button.addEventListener('click', () => goTo(Number(button.dataset.back))));
  document.querySelectorAll('[data-progress]').forEach(button => button.addEventListener('click', () => { const step = Number(button.dataset.progress); if (step < currentStage) goTo(step); }));
  [quoteReference, email].forEach(input => input.addEventListener('input', () => { if (activeQuote) { activeQuote = null; quoteStatus.textContent = 'Quote or email changed. Apply your quote again.'; quoteStatus.classList.remove('is-success'); } updateControls(); }));
  [agreedPrice, name, consent].forEach(input => input.addEventListener('input', updateControls)); consent.addEventListener('change', updateControls);
  form.addEventListener('submit', async event => {
    event.preventDefault(); confirmError.hidden = true;
    if (!name.checkValidity()) { name.reportValidity(); return; }
    if (!consent.checked) { consent.reportValidity(); return; }
    if (!activeQuote || !selectedServiceId || minorFor(agreedPrice.value, activeQuote.currency) !== activeQuote.amountMinor) { confirmError.textContent = 'Reapply your quote and confirm the agreed amount.'; confirmError.hidden = false; return; }
    payButton.disabled = true; payButton.innerHTML = 'Connecting securely…';
    try {
      const response = await fetch('/api/payments/initialize', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ serviceId: selectedServiceId, email: email.value.trim(), name: name.value.trim(), quoteReference: quoteReference.value.trim(), agreedPrice: agreedPrice.value }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Checkout could not start. Please try again.');
      location.assign(data.authorizationUrl);
    } catch (error) { confirmError.textContent = error.message; confirmError.hidden = false; payButton.innerHTML = 'Pay securely <span aria-hidden="true">↗</span>'; updateControls(); }
  });
  async function verifyReturn() {
    const params = new URLSearchParams(location.search); const reference = params.get('reference') || params.get('trxref'); if (!reference) return;
    form.hidden = true; result.hidden = false; result.innerHTML = '<span class="result-icon result-wait">…</span><span class="result-eyebrow">PAYMENT STATUS</span><h2>Confirming your payment</h2><p>We are checking your transaction with Paystack.</p>';
    try {
      const response = await fetch(`/api/payments/verify/${encodeURIComponent(reference)}`, { headers: { Accept: 'application/json' } }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Payment confirmation is not available yet.');
      result.innerHTML = `<span class="result-icon">✓</span><span class="result-eyebrow">PAYMENT CONFIRMED</span><h2>Thank you.</h2><p>Receipt <strong>${escapeHtml(data.receiptNumber)}</strong> is ready. This browser can download it again for 30 days.</p><a class="button button-primary receipt-download" href="${escapeHtml(data.receiptUrl)}">Download receipt ↓</a><a class="payment-result-home" href="/">Return to Netrue</a>`;
      setTimeout(() => result.querySelector('.receipt-download')?.click(), 350);
    } catch (error) { result.innerHTML = `<span class="result-icon result-pending">!</span><span class="result-eyebrow">PAYMENT STATUS</span><h2>We could not confirm this yet.</h2><p>${escapeHtml(error.message)}</p><a href="mailto:info@netrue.io">Contact info@netrue.io</a><a class="payment-result-home" href="/payment.html">Return to checkout</a>`; }
  }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  loadServices(); verifyReturn();
})();
