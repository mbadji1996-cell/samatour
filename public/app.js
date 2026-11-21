/* SAMA TOUR — utilitaires partagés par toutes les pages */
(function () {
  'use strict';

  const Sama = {};

  /** Appel à l'API JSON. Ajoute le code PIN agent si présent. */
  Sama.api = async function (path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const pin = Sama.getPin();
    if (pin) headers['x-pin'] = pin;
    // Session de l'espace courant (patient ou professionnel), définie par la page.
    if (Sama.authKey) {
      const tok = Sama.store.get(Sama.authKey);
      if (tok) headers.Authorization = 'Bearer ' + tok;
    }
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Erreur ' + res.status);
      err.status = res.status;
      throw err;
    }
    return data;
  };

  Sama.getPin = function () {
    try { return sessionStorage.getItem('samatour-pin') || ''; } catch { return ''; }
  };
  Sama.setPin = function (pin) {
    try { pin ? sessionStorage.setItem('samatour-pin', pin) : sessionStorage.removeItem('samatour-pin'); } catch {}
  };

  Sama.store = {
    get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
    del(key) { try { localStorage.removeItem(key); } catch {} },
  };

  /** Écoute les événements temps réel du serveur. */
  Sama.live = function (handlers) {
    const es = new EventSource('/events');
    Object.entries(handlers).forEach(([ev, fn]) =>
      es.addEventListener(ev, (e) => {
        let data = {};
        try { data = JSON.parse(e.data); } catch {}
        fn(data);
      })
    );
    // Après une coupure réseau, on recharge l'état dès la reconnexion.
    es.addEventListener('open', () => handlers.update && handlers.update({}));
    return es;
  };

  /** "≈ 25 min", "≈ 1 h 10", "Moins de 5 min". */
  Sama.duration = function (min) {
    if (min == null) return '—';
    if (min < 5) return 'moins de 5 min';
    const m = Math.round(min / 5) * 5;
    if (m < 60) return `≈ ${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return `≈ ${h} h${r ? ' ' + String(r).padStart(2, '0') : ''}`;
  };

  Sama.since = function (ts) {
    const min = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (min < 60) return `${min} min`;
    return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
  };

  Sama.time = function (ts) {
    return ts ? new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
  };

  Sama.fcfa = function (n) {
    return Number(n || 0) === 0 ? 'Gratuit' : `${Number(n).toLocaleString('fr-FR')} FCFA`;
  };

  /** "2026-11-22" -> "dimanche 22 novembre" */
  Sama.date = function (d, opts) {
    return new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', opts || { weekday: 'long', day: 'numeric', month: 'long' });
  };

  Sama.isoDay = function (offsetDays = 0) {
    return new Date(Date.now() + offsetDays * 864e5).toLocaleDateString('sv-SE');
  };

  Sama.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  };

  Sama.maskPhone = function (p) {
    if (!p) return '';
    const d = p.replace('+221', '');
    return d.length >= 9 ? `${d.slice(0, 2)} *** ** ${d.slice(-2)}` : p;
  };

  /** Dessine un QR code (bibliothèque qrcodejs). Sans Internet, affiche l'adresse en clair. */
  Sama.qr = function (el, text, size = 160) {
    el.innerHTML = '';
    if (window.QRCode) {
      new window.QRCode(el, { text, width: size, height: size, correctLevel: window.QRCode.CorrectLevel.M });
    } else {
      el.innerHTML = `<div class="small" style="max-width:${size}px;word-break:break-all">${Sama.esc(text)}</div>`;
    }
  };

  /** Petit signal sonore (Web Audio, aucun fichier nécessaire). */
  Sama.chime = function () {
    try {
      const ctx = Sama._audio || (Sama._audio = new (window.AudioContext || window.webkitAudioContext)());
      const now = ctx.currentTime;
      [880, 660, 990].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, now + i * 0.28);
        g.gain.exponentialRampToValueAtTime(0.35, now + i * 0.28 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.28 + 0.5);
        o.connect(g).connect(ctx.destination);
        o.start(now + i * 0.28);
        o.stop(now + i * 0.28 + 0.55);
      });
    } catch {}
  };

  /** Annonce vocale en français : "Ticket M G, numéro 12. Rendez-vous : Bureau 1." */
  Sama.speak = function (number, room) {
    if (!('speechSynthesis' in window)) return;
    const [prefix, num] = String(number).split('-');
    const text = `Ticket ${prefix.split('').join(' ')}, numéro ${parseInt(num, 10)}. Rendez-vous : ${room}.`;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    u.rate = 0.9;
    const fr = speechSynthesis.getVoices().find((v) => v.lang && v.lang.startsWith('fr'));
    if (fr) u.voice = fr;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  };

  /** Notification système du téléphone (si autorisée). */
  Sama.notify = function (title, body) {
    try {
      if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 500]);
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, { body, icon: '/icon.svg', tag: 'samatour' }))
          .catch(() => new Notification(title, { body }));
      } else {
        new Notification(title, { body });
      }
    } catch {}
  };

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  window.Sama = Sama;
})();
