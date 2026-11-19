(() => {
  const menuButton = document.querySelector('.menu-toggle');
  const nav = document.querySelector('.primary-nav');
  menuButton?.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') !== 'true';
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    nav.classList.toggle('open', open);
  });
  nav?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => {
    nav.classList.remove('open');
    menuButton?.setAttribute('aria-expanded', 'false');
    menuButton?.setAttribute('aria-label', 'Open menu');
  }));

  const themeButton = document.querySelector('.theme-toggle');
  let savedTheme = null;
  try { savedTheme = localStorage.getItem('netrue-theme'); } catch {}
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches || false;
  const initialTheme = savedTheme || (prefersDark ? 'dark' : 'light');
  document.documentElement.dataset.theme = initialTheme;
  function updateThemeButton(theme) {
    if (!themeButton) return;
    themeButton.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
    themeButton.querySelector('.theme-icon').textContent = theme === 'dark' ? '☼' : '☾';
    themeButton.querySelector('.theme-text').textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  }
  updateThemeButton(initialTheme);
  themeButton?.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('netrue-theme', theme); } catch {}
    updateThemeButton(theme);
  });

  const quickChatDialog = document.querySelector('#quick-chat-dialog');
  document.querySelectorAll('[data-open-quick-chat]').forEach(button => button.addEventListener('click', () => quickChatDialog?.showModal()));
  document.querySelector('[data-close-quick-chat]')?.addEventListener('click', () => quickChatDialog?.close());
  quickChatDialog?.addEventListener('click', event => { if (event.target === quickChatDialog) quickChatDialog.close(); });
  quickChatDialog?.addEventListener('close', () => {
    const form = document.querySelector('#quick-chat-form');
    const success = document.querySelector('#quick-chat-success');
    const error = document.querySelector('#quick-error');
    if (form) { form.reset(); form.hidden = false; }
    if (success) { success.hidden = true; success.replaceChildren(); }
    if (error) error.hidden = true;
    const button = form?.querySelector('[type="submit"]');
    if (button) { button.disabled = false; button.querySelector('span:first-child').textContent = 'Send to the team'; }
    const message = form?.querySelector('#quick-message');
    if (message) message.placeholder = typingPhrases[0];
  });

  const typingPhrases = ["What's on your mind?", 'Can you help me create a website?', 'I have an idea for a connected product.'];
  function typePlaceholder(element, speed = 62) {
    if (!element) return;
    const write = value => {
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) element.placeholder = value;
      else element.textContent = value;
    };
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { write(typingPhrases[0]); return; }
    let phraseIndex = 0;
    let characterIndex = 0;
    let deleting = false;
    let active = true;
    element.addEventListener('focus', () => { active = false; }, { once: true });
    const tick = () => {
      if (!active) return;
      const phrase = typingPhrases[phraseIndex];
      characterIndex += deleting ? -1 : 1;
      write(phrase.slice(0, characterIndex));
      let delay = deleting ? 27 : speed;
      if (!deleting && characterIndex === phrase.length) { deleting = true; delay = 1500; }
      else if (deleting && characterIndex === 0) { deleting = false; phraseIndex = (phraseIndex + 1) % typingPhrases.length; delay = 350; }
      window.setTimeout(tick, delay);
    };
    tick();
  }
  typePlaceholder(document.querySelector('#quick-typing-text'), 54);
  typePlaceholder(document.querySelector('#quick-message'), 54);

  const quickChatForm = document.querySelector('#quick-chat-form');
  quickChatForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const sendButton = form.querySelector('[type="submit"]');
    const error = document.querySelector('#quick-error');
    const success = document.querySelector('#quick-chat-success');
    error.hidden = true;
    sendButton.disabled = true;
    sendButton.querySelector('span:first-child').textContent = 'Sending your message…';
    const payload = {
      message: form.elements.message.value.trim(),
      name: form.elements.name.value.trim(),
      email: form.elements.email.value.trim(),
      consent: form.elements.consent.checked
    };
    try {
      const response = await fetch('/api/quick-chats', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Your message could not be sent. Please try again.');
      form.hidden = true;
      success.hidden = false;
      success.innerHTML = `<span class="quick-success-icon" aria-hidden="true">✓</span><p class="quick-dialog-kicker">SENT TO THE NETRUE TEAM</p><h3>Thanks for reaching out.</h3><p>Your message is in the team inbox. Keep this reference for follow-up:</p><strong class="quick-reference">${escapeText(result.reference)}</strong><a class="quick-success-email" href="mailto:info@netrue.io?subject=${encodeURIComponent(`Quick chat ${result.reference}`)}">Email Netrue ↗</a>`;
    } catch (submissionError) {
      error.textContent = submissionError.message;
      error.hidden = false;
      sendButton.disabled = false;
      sendButton.querySelector('span:first-child').textContent = 'Send to the team';
    }
  });

  const year = document.querySelector('#year');
  if (year) year.textContent = new Date().getFullYear();

  const panel = document.querySelector('#chat-panel');
  if (!panel) return;
  const content = panel.querySelector('.chat-content');
  const next = panel.querySelector('.chat-next');
  const count = panel.querySelector('.chat-count');
  const data = {};
  const categories = ['AI', 'IoT & connected systems', 'Embedded systems', 'Smart agriculture', 'Web or app development', 'Other'];

  function updateCount(step) { count.innerHTML = `${String(step).padStart(2, '0')} <b>/</b> 04`; }
  function selectIntent(intent) {
    data.intent = intent;
    content.querySelector('.chat-options').hidden = true;
    next.hidden = false;
    updateCount(2);
    next.innerHTML = `<p class="chat-welcome">Great. Which area best describes your request?</p><label for="request-category">Area of interest</label><select id="request-category" required><option value="">Choose an area</option>${categories.map(item => `<option>${item}</option>`).join('')}</select><button class="send-button" type="button" id="to-details">Continue <span aria-hidden="true"> →</span></button>`;
    next.querySelector('#to-details').addEventListener('click', () => {
      const category = next.querySelector('select').value;
      if (!category) { next.querySelector('select').focus(); next.querySelector('select').reportValidity(); return; }
      data.category = category;
      showDetails();
    });
  }
  function showDetails() {
    updateCount(3);
    next.innerHTML = `<p class="chat-welcome">Tell us a little about what you want to achieve.</p><label for="project-message">A few details about your project</label><textarea id="project-message" placeholder="What are you hoping to build or solve?" required maxlength="1500"></textarea><div class="form-row"><div><label for="project-budget">Expected budget</label><select id="project-budget"><option>Prefer to discuss</option><option>Not sure yet</option><option>Under $1,000</option><option>$1,000–$5,000</option><option>$5,000+</option></select></div><div><label for="project-timeline">When would you like to start?</label><select id="project-timeline"><option>Exploring</option><option>Immediately</option><option>Within 1 month</option><option>1–3 months</option></select></div></div><button class="send-button" type="button" id="to-contact">Continue <span aria-hidden="true"> →</span></button>`;
    next.querySelector('#to-contact').addEventListener('click', () => {
      const message = next.querySelector('textarea').value.trim();
      if (!message) { next.querySelector('textarea').focus(); next.querySelector('textarea').reportValidity(); return; }
      data.message = message;
      data.budget = next.querySelector('#project-budget').value;
      data.timeline = next.querySelector('#project-timeline').value;
      showContact();
    });
  }
  function showContact() {
    updateCount(4);
    next.innerHTML = `<p class="chat-welcome">Where should we reach you?</p><form id="enquiry-form"><div class="form-row"><div><label for="visitor-name">Your name</label><input id="visitor-name" name="name" autocomplete="name" required maxlength="100"></div><div><label for="visitor-email">Email address</label><input id="visitor-email" name="email" type="email" autocomplete="email" placeholder="you@example.com"></div></div><label for="visitor-whatsapp">WhatsApp number (optional)</label><input id="visitor-whatsapp" name="whatsapp" autocomplete="tel" placeholder="Include country code"><label class="consent-label"><input id="visitor-consent" type="checkbox" required> I agree that Netrue may securely store these details to respond to my enquiry.</label><button class="send-button" type="submit">Send enquiry <span aria-hidden="true">↗</span></button><p class="form-note">Your enquiry is saved securely. You can also continue directly on WhatsApp.</p></form>`;
    next.querySelector('#enquiry-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      if (!form.reportValidity()) return;
      const email = form.querySelector('#visitor-email').value.trim();
      const whatsappField = form.querySelector('#visitor-whatsapp');
      const whatsapp = whatsappField.value.trim();
      if (!email && !whatsapp) {
        const emailField = form.querySelector('#visitor-email');
        const clearContactError = () => {
          if (emailField.value.trim() || whatsappField.value.trim()) {
            emailField.setCustomValidity('');
            emailField.removeEventListener('input', clearContactError);
            whatsappField.removeEventListener('input', clearContactError);
          }
        };
        emailField.setCustomValidity('Add an email address or WhatsApp number so Netrue can reply.');
        emailField.reportValidity();
        emailField.addEventListener('input', clearContactError);
        whatsappField.addEventListener('input', clearContactError);
        return;
      }
      data.name = form.querySelector('#visitor-name').value.trim();
      data.email = email;
      data.whatsapp = whatsapp;
      const sendButton = form.querySelector('[type="submit"]');
      sendButton.disabled = true;
      sendButton.textContent = 'Saving enquiry…';
      let reference;
      try {
        const response = await fetch('/api/enquiries', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ intent: data.intent, category: data.category, message: data.message, budget: data.budget, timeline: data.timeline, name: data.name, email: data.email, whatsapp: data.whatsapp, consent: true })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'We could not save your enquiry. Please try again.');
        reference = result.reference;
      } catch (error) {
        sendButton.disabled = false;
        sendButton.textContent = 'Send enquiry';
        const note = form.querySelector('.form-note');
        note.textContent = error.message;
        note.setAttribute('role', 'alert');
        return;
      }
      const message = [`Netrue website enquiry`, `Reference: ${reference}`, `Name: ${data.name}`, `Email: ${data.email || 'Not provided'}`, `WhatsApp: ${data.whatsapp || 'Not provided'}`, `Enquiry: ${data.intent}`, `Area: ${data.category}`, `Project details: ${data.message}`, `Expected budget: ${data.budget}`, `Timeline: ${data.timeline}`].join('\n');
      const subject = `${data.intent} — ${data.name}`;
      const mailto = `mailto:info@netrue.io?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message)}`;
      const wa = `https://wa.me/447786527366?text=${encodeURIComponent(message)}`;
      next.innerHTML = `<p class="chat-welcome">Thanks, ${escapeText(data.name)}. Your enquiry has been saved.</p><p class="form-note">Reference: <strong>${escapeText(reference)}</strong>. Continue on WhatsApp for a direct conversation, or email Netrue a copy of your enquiry.</p><a class="send-button" href="${mailto}">Email Netrue a copy ↗</a><a class="whatsapp-link" href="${wa}" target="_blank" rel="noopener noreferrer">Continue on WhatsApp ↗</a>`;
    });
  }
  function escapeText(value) { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  content.querySelectorAll('[data-intent]').forEach(button => button.addEventListener('click', () => selectIntent(button.dataset.intent)));
  const projectGrid = document.querySelector('.project-grid');
  if (projectGrid) fetch('/api/projects', { headers: { Accept: 'application/json' } }).then(response => response.ok ? response.json() : []).then(projects => {
    if (!Array.isArray(projects) || !projects.length) return;
    projectGrid.replaceChildren();
    projects.forEach(project => {
      const article = document.createElement('article'); article.className = 'project-card managed-project-card';
      const visual = document.createElement('a'); visual.className = 'project-visual managed-project-visual'; visual.href = '#contact'; visual.setAttribute('aria-label', `Ask about ${project.title}`);
      const image = document.createElement('img'); image.src = project.imageUrl; image.alt = project.title; image.loading = 'lazy'; visual.append(image);
      const label = document.createElement('span'); label.className = 'visual-label'; label.textContent = 'NETRUE PROJECT'; visual.append(label);
      const meta = document.createElement('div'); meta.className = 'project-meta';
      const type = document.createElement('span'); type.textContent = 'PROJECT EXPLORATION';
      const status = document.createElement('span'); status.className = 'status'; status.textContent = 'FEATURED'; meta.append(type, status);
      const title = document.createElement('h3'); title.textContent = project.title;
      const description = document.createElement('p'); description.textContent = project.description;
      const link = document.createElement('a'); link.className = 'arrow-link'; link.href = '#contact'; link.textContent = 'Discuss a similar project ↗';
      article.append(visual, meta, title, description, link); projectGrid.append(article);
    });
  }).catch(() => {});})();
