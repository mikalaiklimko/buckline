(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  // Google Analytics event, if analytics loaded (blockers may prevent it).
  const track = (name, params) => {
    try { if (typeof window.gtag === 'function') window.gtag('event', name, params || {}); } catch { /* ignore */ }
  };
  const maxLength = Number(document.body.dataset.maxLength) || 80;

  const line = $('line');
  const cta = $('cta');
  const form = $('edit-form');
  const paid = $('paid');
  const input = $('line-input');
  const count = $('count');
  const payBtn = $('pay-btn');
  const formError = $('form-error');
  const live = $('live-status');
  const liveLabel = $('live-label');

  function show(view) {
    cta.hidden = view !== 'cta';
    form.hidden = view !== 'edit';
    paid.hidden = view !== 'paid';
    if (view === 'edit') {
      input.value = '';
      updateCount();
      hideError();
      input.focus();
    }
  }

  function updateCount() {
    count.textContent = String([...input.value].length);
  }

  function showError(msg) {
    formError.textContent = msg;
    formError.hidden = false;
  }

  function hideError() {
    formError.hidden = true;
    formError.textContent = '';
  }

  const shareBtn = $('share-btn');
  const shareNote = $('share-note');
  const price = document.body.dataset.price || '$1';
  const money = {
    currency: document.body.dataset.currency || 'USD',
    value: Number(document.body.dataset.amount) || 1,
  };
  let myLink = null;

  // One is picked at random each time the buyer shares.
  const SHARE_TEXTS = [
    `Hey, I spent ${price} to tell you something. Look:`,
    `I paid ${price} so you'd see this. Worth it?`,
    `Hey, I just spent ${price} to put this on the internet:`,
    `This cost me ${price}. You're welcome.`,
    `I spent ${price} to say this. See it before someone replaces it:`,
    `Hey, I bought the internet's one line for ${price}. Look:`,
    `${price}, one line, and it's mine (for now):`,
    `I paid ${price} to say this to you and everyone else:`,
    `Hey, my ${price} line is up right now. Quick, look:`,
    `Spent a buck. Said my piece. Catch it before it's gone:`,
  ];

  function showShare(slug) {
    if (!slug) return;
    myLink = `${window.location.origin}/l/${encodeURIComponent(slug)}`;
    shareBtn.hidden = false;
    try { localStorage.setItem('buckline.myLine.v2', slug); } catch { /* storage unavailable */ }
  }

  let currentSlug = null;

  /** Asks the server which line this checkout session created (the webhook may lag). */
  async function findMyLine(sessionId, attempt = 0) {
    try {
      const res = await fetch(`/api/my-line?session_id=${encodeURIComponent(sessionId)}`);
      if (res.ok) {
        const { slug, current } = await res.json();
        try { localStorage.setItem('buckline.myLine.v2', slug); } catch { /* storage unavailable */ }
        if (current || slug === currentSlug) {
          $('paid-msg').textContent = 'The line is yours. For now.';
          showShare(slug);
          track('purchase', { transaction_id: sessionId, ...money });
        }
        return;
      }
      if (res.status !== 404) return;
    } catch { /* network hiccup: retry */ }
    if (attempt < 30) setTimeout(() => findMyLine(sessionId, attempt + 1), 2000);
  }

  function savedSlug() {
    try { return localStorage.getItem('buckline.myLine.v2'); } catch { return null; }
  }

  function hideShare() {
    myLink = null;
    shareBtn.hidden = true;
    shareNote.textContent = '';
  }

  shareBtn.addEventListener('click', async () => {
    if (!myLink) return;
    const text = SHARE_TEXTS[Math.floor(Math.random() * SHARE_TEXTS.length)];
    if (navigator.share) {
      try {
        await navigator.share({ title: 'OneBuckLine', text, url: myLink });
        track('share', { method: 'share_sheet', content_type: 'line' });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user closed the share sheet
      }
    }
    try {
      await navigator.clipboard.writeText(`${text} ${myLink}`);
      track('share', { method: 'copy_link', content_type: 'line' });
      shareNote.textContent = 'Copied. Paste it anywhere.';
    } catch {
      shareNote.textContent = myLink;
    }
    setTimeout(() => { shareNote.textContent = ''; }, 4000);
  });

  function setLine(text) {
    if (line.textContent === text) return;
    line.textContent = text;
    line.classList.remove('flash');
    void line.offsetWidth; // restart the animation
    line.classList.add('flash');
  }

  $('open-btn').addEventListener('click', () => show('edit'));
  $('again-btn').addEventListener('click', () => show('edit'));
  $('cancel-btn').addEventListener('click', () => show('cta'));
  input.addEventListener('input', () => {
    updateCount();
    hideError();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !form.hidden) show('cta');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return showError('Write something first.');
    if ([...text].length > maxLength) return showError(`Keep it to ${maxLength} characters or fewer.`);

    payBtn.disabled = true;
    hideError();
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.error || 'Could not start checkout.');
      track('begin_checkout', money);
      window.location.assign(data.url);
    } catch (err) {
      showError(err.message);
      payBtn.disabled = false;
    }
  });

  // Returning from checkout.
  const params = new URLSearchParams(window.location.search);
  if (params.has('paid')) {
    show('paid');
    if (document.body.dataset.demo !== 'true') {
      $('paid-msg').textContent = 'Payment received. Your line goes up in a moment.';
    }
    const sessionId = params.get('session_id');
    if (sessionId) findMyLine(sessionId);
    history.replaceState(null, '', '/');
  } else if (params.has('cancelled')) {
    history.replaceState(null, '', '/');
  }

  // Live updates via Server-Sent Events.
  if ('EventSource' in window) {
    const es = new EventSource('/api/events');
    es.addEventListener('line', (ev) => {
      try {
        const state = JSON.parse(ev.data);
        setLine(state.text);
        currentSlug = state.slug;
        // The share button belongs to the buyer, and only while their line is up.
        if (state.slug && state.slug === savedSlug()) showShare(state.slug);
        else if (myLink) hideShare();
      } catch { /* ignore malformed event */ }
    });
    es.addEventListener('open', () => {
      live.classList.remove('offline');
      liveLabel.textContent = 'Live';
    });
    es.addEventListener('error', () => {
      live.classList.add('offline');
      liveLabel.textContent = 'Reconnecting…';
    });
  }
})();
