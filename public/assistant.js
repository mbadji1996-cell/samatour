/* SAMA TOUR — assistant conversationnel : bouton flottant + fenêtre de discussion (s'ajoute seul à la page). */
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
  .sa-btn { position: fixed; right: 18px; bottom: 18px; z-index: 60; display: flex; align-items: center; gap: 8px; padding: 12px 16px 12px 12px;
    border: 0; border-radius: 999px; background: #2b3fbf; color: #fff; font: 600 15px system-ui, 'Segoe UI', sans-serif; cursor: pointer;
    box-shadow: 0 8px 24px rgba(31, 46, 143, .35); }
  .sa-btn .sa-dot { width: 30px; height: 30px; border-radius: 50%; background: #3ddc97; display: grid; place-items: center; font-size: 17px; }
  .sa-panel { position: fixed; right: 18px; bottom: 18px; z-index: 61; width: min(400px, calc(100vw - 24px)); height: min(620px, calc(100vh - 36px));
    background: #fff; border-radius: 18px; box-shadow: 0 16px 50px rgba(15, 26, 74, .35); display: flex; flex-direction: column; overflow: hidden;
    font: 15px/1.45 system-ui, 'Segoe UI', sans-serif; color: #16203a; }
  @media (max-width: 480px) { .sa-panel { right: 0; bottom: 0; width: 100vw; height: 100dvh; border-radius: 0; } }
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
  @media print { .sa-btn, .sa-panel { display: none !important; } }`;
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

  const btn = document.createElement('button');
  btn.className = 'sa-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Ouvrir l\'assistant');
  btn.innerHTML = '<span class="sa-dot">💬</span>Assistant';
  document.body.appendChild(btn);

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
    panel.hidden = false;
    btn.hidden = true;
    render();
    input.focus();
    fetch('/api/assistant/info').then((r) => r.json()).then((i) => {
      if (i.mode === 'claude') panel.querySelector('#sa-mode').textContent = 'Assistant IA · Claude';
    }).catch(() => {});
  }
  function close() { panel.hidden = true; btn.hidden = false; }

  btn.addEventListener('click', open);
  panel.querySelector('.sa-close').addEventListener('click', close);
  form.addEventListener('submit', (e) => { e.preventDefault(); const v = input.value; input.value = ''; send(v); });
  panel.querySelector('#sa-sugg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) send(b.textContent); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) close(); });
  if (location.hash === '#assistant') open();
})();
