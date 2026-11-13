(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
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

  const permalink = $('permalink');
  const share = $('share');
  const shareLink = $('share-link');
  let awaitingPaid = false;

  function setLink(slug) {
    if (!slug) return;
    permalink.href = `/l/${encodeURIComponent(slug)}`;
    permalink.hidden = false;
  }

  function showShare(slug) {
    if (!slug) return;
    const href = `/l/${encodeURIComponent(slug)}`;
    shareLink.href = href;
    shareLink.textContent = window.location.origin + href;
    share.hidden = false;
  }

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
    awaitingPaid = document.body.dataset.demo !== 'true';
    if (document.body.dataset.demo !== 'true') {
      $('paid-msg').textContent = 'Payment received. Your line goes up in a moment.';
    }
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
        const changed = line.textContent !== state.text;
        setLine(state.text);
        setLink(state.slug);
        if (awaitingPaid && changed) {
          // After paying, the first change that arrives is the buyer's line.
          $('paid-msg').textContent = 'The line is yours. For now.';
          showShare(state.slug);
          awaitingPaid = false;
        } else if (document.body.dataset.demo === 'true' && !paid.hidden && share.hidden) {
          showShare(state.slug);
        }
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
