/* SAMA TOUR — assistant conversationnel : bouton flottant rond + fenêtre de discussion (s'ajoute seul à la page). */
(function () {
  'use strict';
  if (window.__samaAssistant) return;
  window.__samaAssistant = true;

  const KEY = 'samatour-chat';
  const SUGGESTIONS = ['J\'ai mal aux dents', 'Vaccin pour mon bébé', 'Comment payer avec Wave ?', 'Annuler mon rendez-vous', 'Mes rendez-vous'];
  let history = [];
  try { history = JSON.parse(sessionStorage.getItem(KEY)) || []; } catch {}
  let busy = false;

  const css = `
  /* Bouton flottant rond, toujours visible en bas à droite */
  .sa-btn { position: fixed; right: 20px; bottom: 20px; z-index: 62; width: 62px; height: 62px; padding: 0; border: 0; border-radius: 50%;
    background: #2b3fbf; color: #fff; cursor: pointer; display: grid; place-items: center;
    box-shadow: 0 10px 28px rgba(31, 46, 143, .45), 0 0 0 4px rgba(255, 255, 255, .9); transition: transform .2s, background .2s; }
  .sa-btn:hover { transform: scale(1.07); }
  .sa-btn:focus-visible { outline: 3px solid #3ddc97; outline-offset: 3px; }
  .sa-btn svg { grid-area: 1 / 1; width: 30px; height: 30px; transition: transform .25s, opacity .2s; }
  .sa-btn .sa-x { opacity: 0; transform: rotate(-90deg); }
  .sa-btn.open { background: #16203a; }
  .sa-btn.open .sa-ico { opacity: 0; transform: rotate(90deg); }
  .sa-btn.open .sa-x { opacity: 1; transform: rotate(0); }
  .sa-btn .sa-badge { position: absolute; top: 3px; right: 3px; width: 14px; height: 14px; border-radius: 50%; background: #3ddc97; border: 2px solid #fff; }
  .sa-btn.open .sa-badge, .sa-btn.seen .sa-badge { display: none; }
  .sa-btn:not(.seen):not(.open) { animation: sa-pulse 2.4s ease-out 3; }
  @keyframes sa-pulse {
    0% { box-shadow: 0 10px 28px rgba(31, 46, 143, .45), 0 0 0 4px rgba(255, 255, 255, .9), 0 0 0 4px rgba(61, 220, 151, .7); }
    100% { box-shadow: 0 10px 28px rgba(31, 46, 143, .45), 0 0 0 4px rgba(255, 255, 255, .9), 0 0 0 24px rgba(61, 220, 151, 0); } }
  @media (prefers-reduced-motion: reduce) { .sa-btn, .sa-btn svg, .sa-panel, .sa-tip { animation: none !important; transition: none !important; } }
  /* Bulle d'invitation, affichée une fois par visite */
  .sa-tip { position: fixed; right: 94px; bottom: 30px; z-index: 61; background: #fff; color: #16203a; border-radius: 14px; padding: 10px 14px;
    box-shadow: 0 8px 24px rgba(15, 26, 74, .22); font: 500 14px/1.35 system-ui, 'Segoe UI', sans-serif; max-width: 230px; cursor: pointer;
    animation: sa-in .3s ease-out; }
  .sa-tip::after { content: ""; position: absolute; right: -6px; bottom: 16px; width: 12px; height: 12px; background: #fff; transform: rotate(45deg); }
  @keyframes sa-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  /* Fenêtre de discussion, juste au-dessus du bouton */
  .sa-panel { position: fixed; right: 20px; bottom: 96px; z-index: 61; width: min(400px, calc(100vw - 24px)); height: min(600px, calc(100vh - 120px));
    background: #fff; border-radius: 18px; box-shadow: 0 16px 50px rgba(15, 26, 74, .35); display: flex; flex-direction: column; overflow: hidden;
    font: 15px/1.45 system-ui, 'Segoe UI', sans-serif; color: #16203a; animation: sa-in .2s ease-out; }
  .sa-panel[hidden] { display: none; }
  @media (max-width: 480px) {
    .sa-panel { right: 0; bottom: 0; width: 100vw; height: 100dvh; border-radius: 0; }
    .sa-btn.open { display: none; } /* sur téléphone, la fenêtre est plein écran et garde sa propre croix */
    .sa-tip { right: 92px; max-width: calc(100vw - 116px); }
  }
  .sa-head { background: #2b3fbf; color: #fff; padding: 12px 14px; display: flex; align-items: center; gap: 10px; }
  .sa-head b { display: block; }
  .sa-head span { font-size: 12px; opacity: .85; }
  .sa-head .sa-close { margin-left: auto; background: none; border: 0; color: #fff; font-size: 22px; cursor: pointer; padding: 4px 8px; }
  .sa-log { flex: 1; overflow-y: auto; padding: 14px; background: #f4f6fb; display: flex; flex-direction: column; gap: 10px; }
  .sa-msg { max-width: 86%; padding: 10px 12px; border-radius: 14px; white-space: normal; word-wrap: break-word; }
  .sa-msg.user { align-self: flex-end; background: #2b3fbf; color: #fff; border-bottom-right-radius: 4px; }
  .sa-msg.assistant { align-self: flex-start; background: #fff; border: 1px solid #dde2ee; border-bottom-left-radius: 4px; }
  .sa-msg a { color: #2b3fbf; font-weight: 600; }
  .sa-msg.user a { color: #fff; }
  .sa-typing { align-self: flex-start; color: #5f6b85; font-size: 13px; }
  .sa-sugg { display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 14px 0; background: #f4f6fb; }
  .sa-sugg button { border: 1px solid #b9c2e6; background: #fff; color: #1f2e8f; border-radius: 999px; padding: 6px 10px; font: inherit; font-size: 13px; cursor: pointer; }
  .sa-form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #dde2ee; background: #fff; }
  .sa-form input { flex: 1; padding: 11px 12px; border: 1px solid #dde2ee; border-radius: 10px; font: inherit; }
  .sa-form button { border: 0; background: #12805c; color: #fff; border-radius: 10px; padding: 0 14px; font: 600 15px system-ui, sans-serif; cursor: pointer; }
  .sa-form button:disabled { opacity: .5; }
  .sa-note { font-size: 11.5px; color: #5f6b85; padding: 0 12px 8px; background: #fff; }
  @media print { .sa-btn, .sa-panel, .sa-tip { display: none !important; } }`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** Mise en forme minimale et sûre : gras, liens internes, retours à la ligne. */
  function format(text) {
    return esc(text)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\((\/[^)\s]*|https:\/\/samatour\.onrender\.com[^)\s]*)\)/g, '<a href="$2">$1</a>')
      .replace(/\n/g, '<br>');
  }

  // ---- Bouton flottant ----
  const btn = document.createElement('button');
  btn.className = 'sa-btn';
  btn.type = 'button';
  btn.title = 'Assistant SAMA TOUR';
  btn.setAttribute('aria-label', 'Ouvrir l\'assistant');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = `
    <svg class="sa-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" fill="rgba(255,255,255,.14)"/>
      <circle cx="8.5" cy="12" r=".9" fill="currentColor"/><circle cx="12" cy="12" r=".9" fill="currentColor"/><circle cx="15.5" cy="12" r=".9" fill="currentColor"/>
    </svg>
    <svg class="sa-x" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
    <span class="sa-badge" aria-hidden="true"></span>`;
  try { if (sessionStorage.getItem(KEY + '-seen')) btn.classList.add('seen'); } catch {}
  document.body.appendChild(btn);

  // ---- Fenêtre de discussion ----
  const panel = document.createElement('div');
  panel.className = 'sa-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Assistant SAMA TOUR');
  panel.innerHTML = `
    <div class="sa-head"><img src="/logo/samatour-symbole-blanc.svg" alt="" width="32" height="32" style="border-radius:8px">
      <div><b>Assistant SAMA TOUR</b><span id="sa-mode">Orientation, rendez-vous, paiement, carte de santé</span></div>
      <button class="sa-close" type="button" aria-label="Fermer">×</button></div>
    <div class="sa-log" id="sa-log" aria-live="polite"></div>
    <div class="sa-sugg" id="sa-sugg"></div>
    <form class="sa-form" id="sa-form"><input id="sa-input" autocomplete="off" maxlength="600" placeholder="Posez votre question…" aria-label="Votre message"><button>Envoyer</button></form>
    <div class="sa-note">L'assistant ne remplace pas un avis médical. Urgence : <b>SAMU 1515</b>.</div>`;
  document.body.appendChild(panel);

  const log = panel.querySelector('#sa-log');
  const input = panel.querySelector('#sa-input');
  const form = panel.querySelector('#sa-form');

  // ---- Bulle d'invitation : une fois par visite, quelques secondes après l'arrivée ----
  let tip = null;
  function hideTip() { if (tip) { tip.remove(); tip = null; } }
  if (!btn.classList.contains('seen') && !history.length) {
    setTimeout(() => {
      if (!panel.hidden || btn.classList.contains('seen')) return;
      tip = document.createElement('div');
      tip.className = 'sa-tip';
      tip.setAttribute('role', 'status');
      tip.textContent = 'Une question ? Je vous oriente vers le bon service.';
      tip.addEventListener('click', () => open());
      document.body.appendChild(tip);
      setTimeout(hideTip, 7000);
    }, 2500);
  }

  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(history.slice(-20))); } catch {} }

  function render() {
    log.innerHTML = '';
    const welcome = history.length ? [] : [{ role: 'assistant', content: 'Bonjour, je suis l\'assistant de Sama Tour. Dites-moi ce qui vous amène : je vous oriente vers le bon service, je vous donne l\'attente du moment et je vous aide à prendre rendez-vous.' }];
    for (const m of [...welcome, ...history]) {
      const d = document.createElement('div');
      d.className = 'sa-msg ' + m.role;
      d.innerHTML = format(m.content);
      log.appendChild(d);
    }
    if (busy) {
      const t = document.createElement('div');
      t.className = 'sa-typing';
      t.textContent = 'L\'assistant écrit…';
      log.appendChild(t);
    }
    panel.querySelector('#sa-sugg').innerHTML = history.length ? '' : SUGGESTIONS.map((s) => `<button type="button">${esc(s)}</button>`).join('');
    log.scrollTop = log.scrollHeight;
  }

  async function send(text) {
    text = text.trim();
    if (!text || busy) return;
    history.push({ role: 'user', content: text });
    busy = true;
    form.querySelector('button').disabled = true;
    render();
    try {
      const headers = { 'Content-Type': 'application/json' };
      try { const tok = JSON.parse(localStorage.getItem('samatour-patient-token')); if (tok) headers.Authorization = 'Bearer ' + tok; } catch {}
      const res = await fetch('/api/assistant', { method: 'POST', headers, body: JSON.stringify({ messages: history }) });
      const data = await res.json().catch(() => ({}));
      history.push({ role: 'assistant', content: res.ok ? data.reply : (data.error || 'Je n\'arrive pas à répondre pour le moment. Réessayez dans un instant.') });
    } catch {
      history.push({ role: 'assistant', content: 'Connexion impossible. Vérifiez votre réseau et réessayez.' });
    }
    busy = false;
    form.querySelector('button').disabled = false;
    save();
    render();
    input.focus();
  }

  function open() {
    hideTip();
    panel.hidden = false;
    btn.classList.add('open', 'seen');
    btn.setAttribute('aria-expanded', 'true');
    btn.setAttribute('aria-label', 'Fermer l\'assistant');
    try { sessionStorage.setItem(KEY + '-seen', '1'); } catch {}
    render();
    input.focus();
    fetch('/api/assistant/info').then((r) => r.json()).then((i) => {
      if (i.mode === 'claude') panel.querySelector('#sa-mode').textContent = 'Assistant IA · Claude';
    }).catch(() => {});
  }
  function close() {
    panel.hidden = true;
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Ouvrir l\'assistant');
    btn.focus();
  }

  btn.addEventListener('click', () => (panel.hidden ? open() : close()));
  panel.querySelector('.sa-close').addEventListener('click', close);
  form.addEventListener('submit', (e) => { e.preventDefault(); const v = input.value; input.value = ''; send(v); });
  panel.querySelector('#sa-sugg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) send(b.textContent); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) close(); });
  if (location.hash === '#assistant') open();
})();
