(() => {
  const list = document.querySelector('#thread-list');
  const detail = document.querySelector('#thread-detail');
  const filter = document.querySelector('#status-filter');
  const count = document.querySelector('#inbox-count');
  let chats = [];
  let selectedReference = null;

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  function dateLabel(value) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function statusLabel(value) { return value.replace('_', ' '); }
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, ...options });
    const result = response.headers.get('content-type')?.includes('application/json') ? await response.json() : {};
    if (!response.ok) throw new Error(result.error || 'The inbox request failed.');
    return result;
  }
  function renderList() {
    count.textContent = `${chats.length} conversation${chats.length === 1 ? '' : 's'}`;
    list.replaceChildren();
    if (!chats.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-list';
      empty.textContent = 'No conversations match this filter yet.';
      list.append(empty);
      return;
    }
    for (const chat of chats) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'thread-row';
      button.setAttribute('aria-current', String(chat.reference === selectedReference));
      const last = chat.messages?.[chat.messages.length - 1];
      button.innerHTML = `<span class="thread-row-top"><span class="thread-name">${escapeHtml(chat.name || 'Visitor')}</span><span class="status-chip ${escapeHtml(chat.status)}">${escapeHtml(statusLabel(chat.status))}</span></span><span class="thread-excerpt">${escapeHtml(last?.text || 'No message')}</span><span class="thread-meta"><span>${escapeHtml(chat.reference)}</span><span>${escapeHtml(dateLabel(chat.updatedAt))}</span></span>`;
      button.addEventListener('click', () => { selectedReference = chat.reference; renderList(); renderDetail(); });
      list.append(button);
    }
  }
  function renderDetail() {
    const chat = chats.find(item => item.reference === selectedReference);
    if (!chat) {
      detail.innerHTML = '<div class="empty-state"><span>✳</span><h2>Select a conversation</h2><p>Choose a message from the inbox to view its details and reply.</p></div>';
      return;
    }
    const messages = (chat.messages || []).map(message => `<div><div class="message-bubble ${message.sender === 'admin' ? 'admin' : ''}"><span class="message-label">${message.sender === 'admin' ? 'Netrue team' : 'Visitor'}</span>${escapeHtml(message.text)}</div><div class="message-time ${message.sender === 'admin' ? 'admin-time' : ''}">${escapeHtml(dateLabel(message.sentAt))}</div></div>`).join('');
    const latestAdmin = [...(chat.messages || [])].reverse().find(message => message.sender === 'admin');
    const mailto = `mailto:${encodeURIComponent(chat.email)}?subject=${encodeURIComponent(`Re: Netrue quick chat ${chat.reference}`)}${latestAdmin ? `&body=${encodeURIComponent(`${latestAdmin.text}\n\nReference: ${chat.reference}`)}` : ''}`;
    detail.innerHTML = `<div class="detail-header"><div><h2 class="detail-name">${escapeHtml(chat.name || 'Visitor')}</h2><div class="detail-contact"><a href="mailto:${encodeURIComponent(chat.email)}">${escapeHtml(chat.email)}</a></div></div><label class="detail-status" for="thread-status">${escapeHtml(statusLabel(chat.status))} <select id="thread-status"><option value="new" ${chat.status === 'new' ? 'selected' : ''}>New</option><option value="in_progress" ${chat.status === 'in_progress' ? 'selected' : ''}>In progress</option><option value="resolved" ${chat.status === 'resolved' ? 'selected' : ''}>Resolved</option></select></label></div><p class="detail-reference">REFERENCE / ${escapeHtml(chat.reference)}</p><div class="message-stack">${messages}</div><div class="visitor-card"><span>Received ${escapeHtml(dateLabel(chat.createdAt))}</span><span>Source: website quick chat</span></div><form class="reply-form" id="reply-form"><label for="reply-text">Add a reply to the thread</label><textarea id="reply-text" maxlength="1200" required placeholder="Write a reply to save to this conversation…"></textarea><p class="admin-error" id="reply-error" hidden></p><div class="reply-actions"><a class="email-reply" id="email-reply" href="${escapeHtml(mailto)}">${latestAdmin ? 'Email latest reply ↗' : 'Open email ↗'}</a><button type="submit">Save reply <span aria-hidden="true">↗</span></button></div></form>`;
    detail.querySelector('#thread-status').addEventListener('change', async event => {
      try { await api(`/api/admin/quick-chats/${encodeURIComponent(chat.reference)}`, { method: 'PATCH', body: JSON.stringify({ status: event.target.value }) }); await load(); }
      catch (error) { window.alert(error.message); }
    });
    detail.querySelector('#reply-form').addEventListener('submit', async event => {
      event.preventDefault();
      const text = detail.querySelector('#reply-text').value.trim();
      const error = detail.querySelector('#reply-error');
      const button = event.currentTarget.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        await api(`/api/admin/quick-chats/${encodeURIComponent(chat.reference)}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
        const link = detail.querySelector('#email-reply');
        link.href = `mailto:${encodeURIComponent(chat.email)}?subject=${encodeURIComponent(`Re: Netrue quick chat ${chat.reference}`)}&body=${encodeURIComponent(`${text}\n\nReference: ${chat.reference}`)}`;
        link.textContent = 'Open email reply ↗';
        await load();
      } catch (errorValue) {
        error.textContent = errorValue.message;
        error.hidden = false;
        button.disabled = false;
      }
    });
  }
  async function load() {
    list.innerHTML = '<p class="loading">Loading inbox…</p>';
    try {
      const query = filter.value === 'all' ? '' : `?status=${encodeURIComponent(filter.value)}`;
      chats = await api(`/api/admin/quick-chats${query}`);
      if (!chats.some(chat => chat.reference === selectedReference)) selectedReference = chats[0]?.reference || null;
      renderList();
      renderDetail();
    } catch (error) {
      list.innerHTML = `<p class="admin-error">${escapeHtml(error.message)}</p>`;
      count.textContent = 'Inbox unavailable';
    }
  }
  const quoteDialog = document.querySelector('#quote-dialog');
  const quoteForm = document.querySelector('#quote-form');
  const quoteFeedback = document.querySelector('#quote-feedback');
  const quoteCurrency = document.querySelector('#quote-currency-admin');
  const quoteService = document.querySelector('#quote-service');
  const projectDialog = document.querySelector('#project-dialog');
  const projectForm = document.querySelector('#project-form');
  const projectList = document.querySelector('#project-list');
  const projectFeedback = document.querySelector('#project-feedback');
  const projectPreview = document.querySelector('#project-preview');
  const chatView = document.querySelector('#chat-management');
  const projectsView = document.querySelector('#project-management');
  let projects = [];
  document.querySelectorAll('[data-admin-view]').forEach(button => button.addEventListener('click', () => {
    const showingProjects = button.dataset.adminView === 'projects';
    document.querySelectorAll('[data-admin-view]').forEach(tab => tab.classList.toggle('is-active', tab === button));
    chatView.hidden = showingProjects; projectsView.hidden = !showingProjects;
    document.querySelector('#admin-heading').textContent = showingProjects ? 'Project stories' : 'Quick conversations';
    document.querySelector('#new-quote-button').hidden = showingProjects;
    document.querySelector('#refresh-button').hidden = showingProjects;
    if (showingProjects) loadProjects(); else load();
  }));
  document.querySelector('#new-quote-button').addEventListener('click', async () => {
    try {
      const services = await api('/api/admin/services');
      quoteService.replaceChildren(...services.map(service => { const option = document.createElement('option'); option.value = service.id; option.textContent = service.name; return option; }));
      quoteForm.reset(); quoteCurrency.value = 'USD'; quoteFeedback.textContent = ''; quoteFeedback.classList.remove('quote-success');
      const button = quoteForm.querySelector('[type="submit"]'); button.textContent = 'Create quote'; button.disabled = false;
      quoteDialog.showModal();
    } catch (error) { window.alert(error.message); }
  });
  document.querySelector('#close-quote').addEventListener('click', () => quoteDialog.close());
  quoteForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = quoteForm.querySelector('[type="submit"]'); button.disabled = true; quoteFeedback.textContent = 'Creating quote…';
    try {
      const data = await api('/api/admin/payment-quotes', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(quoteForm))) });
      const link = `${location.origin}/payment.html?quote=${encodeURIComponent(data.reference)}`;
      quoteFeedback.innerHTML = `Quote <strong>${escapeHtml(data.reference)}</strong> created for ${escapeHtml(data.amount)}. Expires in 14 days. <a href="mailto:${encodeURIComponent(data.customerEmail)}?subject=${encodeURIComponent(`Netrue payment quote ${data.reference}`)}&body=${encodeURIComponent(`Hello${data.customerName ? ` ${data.customerName}` : ''},\n\nYour agreed quote for ${data.serviceName} is ${data.amount}. Use the link below to pay.\n\n${link}\n\nQuote reference: ${data.reference}`)}">Open email draft ↗</a>`;
      quoteFeedback.classList.add('quote-success'); button.textContent = 'Create another quote'; button.disabled = false;
    } catch (error) { quoteFeedback.textContent = error.message; button.disabled = false; }
  });
  function renderProjects() {
    projectList.replaceChildren();
    if (!projects.length) { const empty = document.createElement('p'); empty.className = 'empty-list'; empty.textContent = 'No projects added yet. Add a title, description and image link to publish the first project.'; projectList.append(empty); return; }
    for (const project of projects) {
      const card = document.createElement('article'); card.className = 'project-admin-card';
      const image = document.createElement('img'); image.src = project.imageUrl; image.alt = ''; image.loading = 'lazy';
      const info = document.createElement('div'); info.className = 'project-admin-info';
      const title = document.createElement('h3'); title.textContent = project.title;
      const description = document.createElement('p'); description.textContent = project.description;
      const url = document.createElement('small'); url.textContent = project.imageUrl;
      const actions = document.createElement('div'); actions.className = 'project-admin-actions';
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit'; edit.addEventListener('click', () => openProject(project));
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete'; remove.addEventListener('click', async () => { if (!window.confirm(`Delete “${project.title}” from the website?`)) return; try { await api(`/api/admin/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' }); await loadProjects(); } catch (error) { window.alert(error.message); } });
      actions.append(edit, remove); info.append(title, description, url, actions); card.append(image, info); projectList.append(card);
    }
  }
  async function loadProjects() {
    projectList.innerHTML = '<p class="loading">Loading projects…</p>';
    try { projects = await api('/api/admin/projects'); renderProjects(); }
    catch (error) { projectList.innerHTML = `<p class="admin-error">${escapeHtml(error.message)}</p>`; }
  }
  function openProject(project = null) {
    projectForm.reset(); projectFeedback.textContent = ''; projectFeedback.classList.remove('quote-success');
    projectForm.elements.id.value = project?.id || '';
    projectForm.elements.title.value = project?.title || '';
    projectForm.elements.description.value = project?.description || '';
    projectForm.elements.imageUrl.value = project?.imageUrl || '';
    document.querySelector('#project-dialog-title').textContent = project ? 'Edit project' : 'Add project';
    projectForm.querySelector('[type="submit"]').textContent = project ? 'Save changes' : 'Save project';
    if (project?.imageUrl) { projectPreview.innerHTML = `<img src="${escapeHtml(project.imageUrl)}" alt="Project image preview">`; projectPreview.hidden = false; } else { projectPreview.replaceChildren(); projectPreview.hidden = true; }
    projectDialog.showModal();
  }
  document.querySelector('#new-project-button').addEventListener('click', () => openProject());
  document.querySelector('#close-project').addEventListener('click', () => projectDialog.close());
  projectForm.elements.imageUrl.addEventListener('input', () => { const value = projectForm.elements.imageUrl.value.trim(); if (value.startsWith('https://')) { projectPreview.innerHTML = `<img src="${escapeHtml(value)}" alt="Project image preview">`; projectPreview.hidden = false; } else { projectPreview.replaceChildren(); projectPreview.hidden = true; } });
  projectForm.addEventListener('submit', async event => {
    event.preventDefault(); const button = projectForm.querySelector('[type="submit"]'); button.disabled = true; projectFeedback.textContent = 'Saving project…';
    try {
      const data = Object.fromEntries(new FormData(projectForm)); const id = data.id; delete data.id;
      await api(id ? `/api/admin/projects/${encodeURIComponent(id)}` : '/api/admin/projects', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(data) });
      projectDialog.close(); await loadProjects();
    } catch (error) { projectFeedback.textContent = error.message; button.disabled = false; }
  });  document.querySelector('#refresh-button').addEventListener('click', load);
  filter.addEventListener('change', load);
  load();
})();
