(() => {
  const notice = document.querySelector('#visitor-cookie-note');
  const consentName = 'netrue_visitor_consent';
  const readCookie = name => document.cookie.split('; ').find(item => item.startsWith(`${name}=`))?.split('=').slice(1).join('=');
  const writeCookie = value => {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${consentName}=${value}; Max-Age=15552000; Path=/; SameSite=Lax${secure}`;
  };
  function startTracking() {
    if (!window.crypto?.randomUUID) return;
    let sessionId;
    try {
      sessionId = sessionStorage.getItem('netrue_visit_session');
      if (!sessionId) { sessionId = crypto.randomUUID(); sessionStorage.setItem('netrue_visit_session', sessionId); }
    } catch { sessionId = crypto.randomUUID(); }
    let lastActivity = Date.now();
    let inactive = false;
    let currentPage = location.pathname + location.hash;
    const pulse = async event => {
      try {
        await fetch('/api/visitor/pulse', {
          method: 'POST', credentials: 'same-origin', keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, page: currentPage, event })
        });
      } catch { /* Visitor metrics must never interrupt site use. */ }
    };
    pulse('visit');
    const markActive = () => {
      lastActivity = Date.now();
      if (inactive && document.visibilityState === 'visible') { inactive = false; pulse('resume'); }
    };
    for (const name of ['pointerdown', 'keydown', 'scroll', 'touchstart']) window.addEventListener(name, markActive, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') markActive();
    });
    window.addEventListener('hashchange', () => { currentPage = location.pathname + location.hash; markActive(); pulse('page'); });
    window.addEventListener('popstate', () => { currentPage = location.pathname + location.hash; markActive(); pulse('page'); });
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastActivity >= 120000) {
        if (!inactive) { inactive = true; pulse('inactive'); }
        return;
      }
      pulse('heartbeat');
    }, 20000);
    window.addEventListener('pagehide', () => { if (!inactive) pulse('inactive'); });
  }
  const currentConsent = readCookie(consentName);
  if (notice && !currentConsent) notice.hidden = false;
  if (currentConsent === 'accepted') startTracking();
  notice?.querySelector('[data-visitor-consent]')?.addEventListener('click', () => { writeCookie('accepted'); notice.hidden = true; startTracking(); });
  notice?.querySelector('[data-visitor-decline]')?.addEventListener('click', () => { writeCookie('declined'); notice.hidden = true; });
})();
