'use strict';
/*
 * SAMA TOUR — serveur du MVP (aucune dépendance externe, Node.js >= 18).
 *
 *   Patient          : /            prendre un ticket
 *                      /t/<jeton>   suivre son ticket en temps réel
 *   Agent / médecin  : /agent       console (code PIN)
 *   Salle d'attente  : /ecran       écran d'affichage (TV / PC)
 *
 * Les données sont stockées dans data/db.json. Chaque jour, la file est remise à zéro
 * et la journée précédente est archivée dans data/archive/AAAA-MM-JJ.json.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sms = require('./lib/sms');
const config = require('./config.json');

const PORT = Number(process.env.PORT) || 3000;
const PIN = String(process.env.SAMATOUR_PIN || config.agentPin || '1234');
const DATA_DIR = path.join(__dirname, 'data');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIN = 60 * 1000;
const THRESHOLD = config.approachThreshold || 3;
const LEAVE_MARGIN = config.leaveMarginMinutes || 15;
const OPENING_TIME = config.openingTime || '08:00'; // heure de début des consultations

const SERVICES_FILE = path.join(DATA_DIR, 'services.json');

// ---------------------------------------------------------------------------
// Services (catalogue modifiable depuis la console agent)
// ---------------------------------------------------------------------------
// Le catalogue de départ vient de config.json. Les modifications faites dans la console
// (activer, désactiver, renommer, ajouter) sont enregistrées dans data/services.json.

// Niveau de structure où l'on trouve habituellement le service :
// 1 poste de santé, 2 centre de santé, 3 hôpital régional/départemental, 4 hôpital national / CHU.
const LEVELS = config.levels || { 1: 'Poste de santé', 2: 'Centre de santé', 3: 'Hôpital régional', 4: 'Hôpital national / CHU' };
const CATALOG_VERSION = config.catalogVersion || 1;
const DEFAULT_LEVEL = Number(config.defaultLevel) || 4;
const categoryOrder = [...new Set(config.services.map((s) => s.category))];

function cleanService(s) {
  const level = Number(s.level);
  return {
    id: String(s.id).toUpperCase(),
    name: String(s.name || s.id).trim().slice(0, 60),
    category: String(s.category || 'Autres').trim().slice(0, 40) || 'Autres',
    room: String(s.room || '').trim().slice(0, 40),
    defaultMinutes: Math.max(1, Math.min(120, Math.round(Number(s.defaultMinutes) || 10))),
    keywords: String(s.keywords || '').trim().slice(0, 200),
    level: level >= 1 && level <= 4 ? level : null, // null = service ajouté par la structure
    active: s.active !== false,
    // Réglages des rendez-vous (null = valeur par défaut calculée dans lib/portals.js)
    rdvEnabled: typeof s.rdvEnabled === 'boolean' ? s.rdvEnabled : null,
    price: Number.isFinite(Number(s.price)) && s.price !== null && s.price !== '' ? Math.max(0, Math.round(Number(s.price))) : null,
    slotMinutes: Number(s.slotMinutes) > 0 ? Math.round(Number(s.slotMinutes)) : null,
    rdvCapacity: Number(s.rdvCapacity) > 0 ? Math.round(Number(s.rdvCapacity)) : null,
  };
}

/** Tri : ordre des catégories du référentiel, puis ordre du référentiel, puis services ajoutés. */
function sortServices(list) {
  const rank = (s) => {
    const c = categoryOrder.indexOf(s.category);
    const i = config.services.findIndex((x) => x.id === s.id);
    return [c < 0 ? 999 : c, i < 0 ? 999 : i];
  };
  return list.sort((a, b) => {
    const [ca, ia] = rank(a), [cb, ib] = rank(b);
    return ca - cb || ia - ib || a.name.localeCompare(b.name, 'fr');
  });
}

function loadServices() {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  let saved = { version: 0, list: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(SERVICES_FILE, 'utf8'));
    saved = Array.isArray(raw) ? { version: 1, list: raw } : raw;
  } catch {}
  const fromConfig = new Map(config.services.map((s) => [s.id, s]));
  const list = saved.list.map((s) => {
    const ref = fromConfig.get(s.id);
    // Nouveau référentiel : on met à jour nom, catégorie, mots-clés et niveau,
    // mais on garde ce que la structure a réglé (actif ou non, salle, durée).
    if (ref && saved.version !== CATALOG_VERSION) {
      return cleanService({ ...ref, room: s.room || ref.room, defaultMinutes: s.defaultMinutes, active: s.active });
    }
    return cleanService({ ...s, level: ref ? ref.level : s.level });
  });
  // Services du référentiel pas encore connus : actifs s'ils correspondent au niveau de la structure.
  for (const s of config.services) {
    if (!list.some((x) => x.id === s.id)) list.push(cleanService({ ...s, active: (s.level || 1) <= DEFAULT_LEVEL }));
  }
  return sortServices(list);
}

let services = loadServices();
saveServices();

function saveServices() {
  fs.writeFileSync(SERVICES_FILE, JSON.stringify({ version: CATALOG_VERSION, list: services }, null, 1));
}

function svc(id) {
  return (
    services.find((s) => s.id === id) || {
      id, name: id, category: 'Autres', room: '', defaultMinutes: 10, keywords: '', active: false,
    }
  );
}

function activeServices() {
  return services.filter((s) => s.active);
}

/** Génère un code court et unique à partir du nom : "Néphrologie" -> "NEP". */
function makeServiceId(wanted, name) {
  const base = String(wanted || name || 'SRV')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '')
    .slice(0, wanted ? 5 : 3) || 'SRV';
  let id = base;
  for (let i = 2; services.some((s) => s.id === id); i++) id = base.slice(0, 4) + i;
  return id;
}

// ---------------------------------------------------------------------------
// Stockage
// ---------------------------------------------------------------------------

function today() {
  return new Date().toLocaleDateString('sv-SE'); // AAAA-MM-JJ (heure locale)
}

function freshDb() {
  return { day: today(), counters: {}, tickets: [], sms: [] };
}

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return freshDb();
  }
}

let db = loadDb();
let saveTimer = null;

function saveNow() {
  clearTimeout(saveTimer);
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db), (err) => {
      if (err) return console.error('Sauvegarde impossible :', err.message);
      fs.rename(tmp, DB_FILE, (e) => e && console.error('Sauvegarde impossible :', e.message));
    });
  }, 150);
}

function archiveDay() {
  if (db.tickets.length) {
    fs.writeFileSync(path.join(ARCHIVE_DIR, `${db.day}.json`), JSON.stringify(db, null, 1));
  }
}

// Mode démonstration (version en ligne pour le jury) : chaque journée démarre avec des données
// réalistes, pour que l'application ne soit jamais vide. Activé par DEMO_MODE=1.
const DEMO_MODE = process.env.DEMO_MODE === '1';

function ensureDay() {
  if (db.day === today()) return;
  archiveDay();
  db = freshDb();
  if (DEMO_MODE) {
    seedDemo();
    if (portals) portals.refreshDemoDay();
  }
  save();
}

// ---------------------------------------------------------------------------
// Logique de file d'attente
// ---------------------------------------------------------------------------

/**
 * File d'un service : prioritaires médicaux d'abord, puis les patients avec rendez-vous dont l'heure
 * est arrivée (à 10 min près), puis les autres par ordre d'arrivée.
 */
function queueRank(t, now) {
  if (t.priority) return [0, t.createdAt];
  if (t.rdv && t.rdv.at <= now + 10 * MIN) return [1, t.rdv.at];
  return [2, t.createdAt];
}
function waitingQueue(sid) {
  const now = Date.now();
  return db.tickets
    .filter((t) => t.serviceId === sid && t.status === 'waiting')
    .sort((a, b) => {
      const [ra, ka] = queueRank(a, now), [rb, kb] = queueRank(b, now);
      return ra - rb || ka - kb;
    });
}

function currentTicket(sid) {
  return db.tickets.find((t) => t.serviceId === sid && t.status === 'called') || null;
}

/** Durée moyenne de consultation (min) : valeur par défaut lissée avec les 10 dernières consultations. */
function avgMinutes(sid) {
  const def = svc(sid).defaultMinutes || 10;
  const samples = db.tickets
    .filter((t) => t.serviceId === sid && t.status === 'done' && t.calledAt && t.doneAt)
    .sort((a, b) => b.doneAt - a.doneAt)
    .slice(0, 10)
    .map((t) => (t.doneAt - t.calledAt) / MIN)
    .filter((m) => m >= 1 && m <= 90);
  const weight = 2;
  return (def * weight + samples.reduce((a, b) => a + b, 0)) / (weight + samples.length);
}

/**
 * Minutes restantes avant l'ouverture du service (0 s'il a déjà commencé).
 * Indispensable quand les patients prennent leur ticket dès l'aube : sans cela, le premier
 * patient de 6 h se verrait annoncer « 0 min » alors que le médecin arrive à 8 h.
 */
function minutesBeforeOpening(sid) {
  const started = db.tickets.some((t) => t.serviceId === sid && t.calledAt);
  if (started) return 0;
  const [h, m] = String(svc(sid).openingTime || OPENING_TIME).split(':').map(Number);
  const now = new Date();
  const opening = new Date(now);
  opening.setHours(h || 0, m || 0, 0, 0);
  return Math.max(0, Math.ceil((opening - now) / MIN));
}

function positionInfo(t, queue = waitingQueue(t.serviceId)) {
  const ahead = queue.indexOf(t);
  const busy = currentTicket(t.serviceId) ? 0.5 : 0;
  const estimateMin = Math.ceil(minutesBeforeOpening(t.serviceId) + (ahead + busy) * avgMinutes(t.serviceId));
  return { ahead, position: ahead + 1, estimateMin };
}

function serviceSummary(sid) {
  const s = svc(sid);
  const q = waitingQueue(sid);
  const cur = currentTicket(sid);
  const avg = avgMinutes(sid);
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    room: s.room,
    keywords: s.keywords,
    current: cur ? cur.number : null,
    currentPriority: cur ? cur.priority : false,
    next: q.slice(0, 3).map((t) => t.number),
    waiting: q.length,
    avgMin: Math.round(avg),
    estimateNewMin: Math.ceil(minutesBeforeOpening(sid) + (q.length + (cur ? 0.5 : 0)) * avg),
  };
}

function publicTicket(t) {
  const s = svc(t.serviceId);
  const out = {
    token: t.token,
    number: t.number,
    serviceId: t.serviceId,
    serviceName: s.name,
    room: s.room,
    name: t.name,
    status: t.status,
    priority: t.priority,
    onSite: t.onSite,
    travelMin: t.travelMin,
    createdAt: t.createdAt,
    calledAt: t.calledAt,
    doneAt: t.doneAt,
    rating: t.rating,
    rdvTime: t.rdv ? t.rdv.time : null,
  };
  if (t.status === 'waiting') {
    Object.assign(out, positionInfo(t));
    out.approaching = out.ahead < THRESHOLD;
    out.leaveNow = !t.onSite && t.travelMin > 0 && out.estimateMin <= t.travelMin + LEAVE_MARGIN;
  }
  return out;
}

function agentTicket(t) {
  return { ...publicTicket(t), phone: t.phone, source: t.source };
}

function newToken() {
  return crypto.randomBytes(9).toString('base64url');
}

function createTicket({ serviceId, name, phone, travelMin, onSite, priority, source, createdAt, rdv }) {
  if (!svc(serviceId).active) throw new HttpError(400, 'Ce service n’est pas disponible aujourd’hui');
  db.counters[serviceId] = (db.counters[serviceId] || 0) + 1;
  const t = {
    token: newToken(),
    number: `${serviceId}-${String(db.counters[serviceId]).padStart(3, '0')}`,
    serviceId,
    name: String(name || '').trim().slice(0, 40),
    phone: sms.normalizePhone(phone),
    travelMin: onSite ? 0 : Math.max(0, Math.min(240, Number(travelMin) || 0)),
    onSite: !!onSite,
    priority: !!priority,
    source: source || 'patient',
    status: 'waiting',
    createdAt: createdAt || Date.now(),
    calledAt: null,
    doneAt: null,
    rating: null,
    notified: { approach: false, leave: false },
    rdv: rdv || null, // { appointmentId, time, at } si le patient vient sur rendez-vous
  };
  db.tickets.push(t);
  // Pas de SMS "votre tour approche" si le patient est déjà parmi les premiers à son arrivée.
  t.notified.approach = positionInfo(t).ahead < THRESHOLD;
  return t;
}

function notify(t, text) {
  if (!t.phone) return;
  const entry = { at: Date.now(), to: t.phone, number: t.number, text, status: 'en cours' };
  db.sms.push(entry);
  if (db.sms.length > 200) db.sms.splice(0, db.sms.length - 200);
  sms.send(t.phone, text).then((status) => {
    entry.status = status;
    save();
    broadcast('update');
  });
}

/** Envoie les SMS "partez maintenant" et "votre tour approche" quand c'est le moment. */
function runNotifications() {
  for (const s of services) {
    const q = waitingQueue(s.id);
    for (const t of q) {
      const info = positionInfo(t, q);
      if (!t.onSite && t.travelMin > 0 && !t.notified.leave && info.estimateMin <= t.travelMin + LEAVE_MARGIN) {
        t.notified.leave = true;
        notify(
          t,
          `SAMA TOUR : partez maintenant ! Ticket ${t.number} (${s.name}). ` +
            `Attente estimée ~${info.estimateMin} min, votre trajet ~${t.travelMin} min.`
        );
      }
      if (info.ahead < THRESHOLD && !t.notified.approach) {
        t.notified.approach = true;
        const who = info.ahead === 0 ? 'vous êtes le prochain' : `${info.ahead} personne(s) avant vous`;
        notify(t, `SAMA TOUR : votre tour approche (${t.number}), ${who}. Merci de rejoindre la salle d'attente.`);
      }
    }
  }
}

/** Clôture le patient en cours (terminé ou absent) puis appelle le suivant. */
function callNext(sid, outcome = 'done', { silent = false, at = Date.now() } = {}) {
  const cur = currentTicket(sid);
  if (cur) {
    cur.status = outcome === 'absent' ? 'absent' : 'done';
    cur.doneAt = at;
    if (portals) portals.onTicketDone(cur);
  }
  const next = waitingQueue(sid)[0];
  if (next) {
    next.status = 'called';
    next.calledAt = at;
    const s = svc(sid);
    if (!silent) {
      notify(next, `SAMA TOUR : c'est votre tour ! Ticket ${next.number}, rendez-vous : ${s.room} (${s.name}).`);
      broadcast('announce', { number: next.number, room: s.room, serviceName: s.name });
    }
  }
  return next || null;
}

function changed() {
  runNotifications();
  save();
  broadcast('update');
}

// ---------------------------------------------------------------------------
// Statistiques
// ---------------------------------------------------------------------------

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

function statsFor(list) {
  const done = list.filter((t) => t.status === 'done');
  const absent = list.filter((t) => t.status === 'absent');
  const waits = list.filter((t) => t.calledAt).map((t) => (t.calledAt - t.createdAt) / MIN);
  const consults = done.filter((t) => t.calledAt && t.doneAt).map((t) => (t.doneAt - t.calledAt) / MIN);
  const ratings = list.filter((t) => t.rating).map((t) => t.rating);
  const closed = done.length + absent.length;
  return {
    total: list.length,
    waiting: list.filter((t) => t.status === 'waiting').length,
    done: done.length,
    absent: absent.length,
    cancelled: list.filter((t) => t.status === 'cancelled').length,
    avgWaitMin: round1(avg(waits)),
    maxWaitMin: waits.length ? Math.round(Math.max(...waits)) : null,
    avgConsultMin: round1(avg(consults)),
    noShowRate: closed ? round1((absent.length / closed) * 100) : null,
    remoteShare: list.length ? round1((list.filter((t) => !t.onSite).length / list.length) * 100) : null,
    avgRating: round1(avg(ratings)),
    ratings: ratings.length,
  };
}

function computeStats() {
  return {
    total: statsFor(db.tickets),
    services: services
      .map((s) => ({ id: s.id, name: s.name, category: s.category, ...statsFor(db.tickets.filter((t) => t.serviceId === s.id)) }))
      .filter((s) => s.total > 0),
  };
}

const STATUS_FR = { waiting: 'en attente', called: 'en consultation', done: 'vu', absent: 'absent', cancelled: 'annulé' };

function exportCsv() {
  const fmt = (ms) => (ms ? new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');
  const mins = (a, b) => (a && b ? Math.round((b - a) / MIN) : '');
  const rows = [
    ['date', 'ticket', 'service', 'statut', 'prioritaire', 'origine', 'trajet_min', 'arrivee', 'appel', 'fin', 'attente_min', 'consultation_min', 'note'],
  ];
  for (const t of db.tickets) {
    rows.push([
      db.day,
      t.number,
      svc(t.serviceId).name,
      STATUS_FR[t.status] || t.status,
      t.priority ? 'oui' : 'non',
      t.onSite ? 'sur place' : 'à distance',
      t.travelMin || '',
      fmt(t.createdAt),
      fmt(t.calledAt),
      fmt(t.doneAt),
      mins(t.createdAt, t.calledAt),
      mins(t.calledAt, t.doneAt),
      t.rating || '',
    ]);
  }
  // Pas de nom ni de téléphone : l'export est anonymisé.
  return '﻿' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
}

// ---------------------------------------------------------------------------
// Données de démonstration
// ---------------------------------------------------------------------------

function seedDemo() {
  const now = Date.now();
  const names = ['Awa', 'Moussa', 'Fatou', 'Ibrahima', 'Aïssatou', 'Cheikh', 'Mariama', 'Ousmane', 'Khady',
    'Mamadou', 'Ndeye', 'Abdoulaye', 'Coumba', 'Babacar', 'Seynabou', 'Modou', 'Astou', 'Pape'];
  const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  const pick = () => names[rand(0, names.length - 1)];
  let phoneN = 1;
  const phone = () => `+22177000${String(phoneN++).padStart(4, '0')}`;

  // Une dizaine de services animés (les plus fréquentés en général), les autres restent vides.
  const busy = ['MG', 'PED', 'CPN', 'VAC', 'CAI', 'LAB', 'DEN', 'OPH', 'DIA', 'PHA', 'CAR', 'URG'];
  const act = activeServices();
  let demoServices = act.filter((s) => busy.includes(s.id));
  if (demoServices.length < 3) demoServices = act.slice(0, 10);

  for (const s of demoServices) {
    // Patients déjà vus ce matin (pour remplir les statistiques)
    let doctorFreeAt = now - 170 * MIN;
    const seen = rand(3, 6);
    for (let k = 0; k < seen; k++) {
      const t = createTicket({ serviceId: s.id, name: pick(), onSite: k % 3 !== 0, travelMin: 20, source: 'demo', createdAt: now - (200 - k * 12) * MIN });
      t.notified = { approach: true, leave: true };
      t.status = k === 4 ? 'absent' : 'done';
      t.calledAt = Math.max(doctorFreeAt, t.createdAt + rand(20, 50) * MIN);
      t.doneAt = t.calledAt + (t.status === 'absent' ? 2 : rand(7, 16)) * MIN;
      doctorFreeAt = t.doneAt;
      if (t.status === 'done' && k % 2 === 0) t.rating = rand(3, 5);
    }
    // Patients en attente
    const n = rand(2, 7);
    for (let k = 0; k < n; k++) {
      const onSite = k % 3 !== 2;
      createTicket({
        serviceId: s.id,
        name: pick(),
        phone: k % 2 === 0 ? phone() : '',
        onSite,
        travelMin: onSite ? 0 : [20, 30, 45][k % 3],
        priority: s.id === 'CPN' ? k === 1 : k === 4,
        source: 'demo',
        createdAt: now - (60 - k * 8) * MIN,
      });
    }
    // Un patient en consultation
    callNext(s.id, 'done', { silent: true, at: now - rand(2, 6) * MIN });
  }
  // Pas de SMS rétroactifs pour les patients de démo : on considère qu'ils ont déjà été prévenus.
  for (const s of demoServices) {
    const q = waitingQueue(s.id);
    q.forEach((t, i) => {
      if (i < THRESHOLD) t.notified.approach = true;
      if (!t.onSite && positionInfo(t, q).estimateMin <= t.travelMin + LEAVE_MARGIN) t.notified.leave = true;
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP : utilitaires
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) {
        reject(new HttpError(413, 'Requête trop volumineuse'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

function pinOk(pin) {
  const a = crypto.createHash('sha256').update(String(pin || '')).digest();
  const b = crypto.createHash('sha256').update(PIN).digest();
  return crypto.timingSafeEqual(a, b);
}

function lanIp() {
  const candidates = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) candidates.push(i.address);
  }
  return candidates.find((a) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a)) || candidates[0] || 'localhost';
}

function joinUrl() {
  // RENDER_EXTERNAL_URL est fourni automatiquement par l'hébergeur Render.
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://${lanIp()}:${PORT}`).replace(/\/$/, '');
}

function findTicket(token) {
  const t = db.tickets.find((x) => x.token === token);
  if (!t) throw new HttpError(404, 'Ticket introuvable (peut-être un ticket d’un autre jour)');
  return t;
}

// ---------------------------------------------------------------------------
// Temps réel (Server-Sent Events)
// ---------------------------------------------------------------------------

const clients = new Set();

function broadcast(event, data = {}) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 25_000).unref();

// Change de jour automatiquement à minuit, même sans requête.
setInterval(() => {
  if (db.day !== today()) {
    ensureDay();
    broadcast('update');
  }
}, MIN).unref();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, agent: pattern.startsWith('/api/agent/') && pattern !== '/api/agent/login' });
}

// --- Public ---------------------------------------------------------------

route('GET', '/api/public', () => ({
  facilityName: config.facilityName,
  joinUrl: joinUrl(),
  services: activeServices().map((s) => serviceSummary(s.id)),
}));

route('POST', '/api/tickets', async ({ body }) => {
  const t = createTicket({
    serviceId: body.serviceId,
    name: body.name,
    phone: body.phone,
    onSite: body.onSite !== false,
    travelMin: body.travelMin,
    source: 'patient',
  });
  changed();
  return publicTicket(t);
});

route('GET', '/api/tickets/:token', ({ params }) => publicTicket(findTicket(params.token)));

route('POST', '/api/tickets/:token/cancel', ({ params }) => {
  const t = findTicket(params.token);
  if (t.status !== 'waiting') throw new HttpError(409, 'Ce ticket ne peut plus être annulé');
  t.status = 'cancelled';
  t.doneAt = Date.now();
  changed();
  return publicTicket(t);
});

route('POST', '/api/tickets/:token/rating', ({ params, body }) => {
  const t = findTicket(params.token);
  const score = Number(body.score);
  if (t.status !== 'done') throw new HttpError(409, 'Vous pourrez noter après la consultation');
  if (!(score >= 1 && score <= 5)) throw new HttpError(400, 'Note entre 1 et 5');
  t.rating = Math.round(score);
  changed();
  return publicTicket(t);
});

// --- Agent ----------------------------------------------------------------

route('POST', '/api/agent/login', ({ body }) => {
  if (!pinOk(body.pin)) throw new HttpError(401, 'Code PIN incorrect');
  return { ok: true };
});

route('GET', '/api/agent/state', () => ({
  facilityName: config.facilityName,
  joinUrl: joinUrl(),
  smsMode: sms.mode,
  // Services actifs, plus les services désactivés qui ont encore des patients aujourd'hui.
  services: services
    .filter((s) => s.active || db.tickets.some((t) => t.serviceId === s.id && ['waiting', 'called', 'absent'].includes(t.status)))
    .map((s) => ({
      ...serviceSummary(s.id),
      active: s.active,
      currentTicket: currentTicket(s.id) ? agentTicket(currentTicket(s.id)) : null,
      queue: waitingQueue(s.id).map(agentTicket),
      absent: db.tickets.filter((t) => t.serviceId === s.id && t.status === 'absent').map(agentTicket),
    })),
  catalog: services.map((s) => ({ ...s, ticketsToday: db.tickets.filter((t) => t.serviceId === s.id).length })),
  levels: LEVELS,
  stats: computeStats(),
  sms: db.sms.slice(-40).reverse(),
}));

// --- Gestion du catalogue de services ----------------------------------------

function servicesChanged() {
  saveServices();
  broadcast('update');
}

route('POST', '/api/agent/catalog', ({ body }) => {
  if (!String(body.name || '').trim()) throw new HttpError(400, 'Donnez un nom au service');
  const s = cleanService({ ...body, id: makeServiceId(body.id, body.name), level: null, active: true });
  services.push(s);
  sortServices(services);
  servicesChanged();
  return s;
});

/**
 * Active d'un coup les services d'un type de structure :
 * { level: 1..4 } = référentiel jusqu'à ce niveau ; { all: true|false } = tout activer / désactiver.
 * Les services ajoutés par la structure elle-même ne sont pas touchés par un profil.
 */
route('POST', '/api/agent/catalog/profile', ({ body }) => {
  const level = Number(body.level);
  if (typeof body.all === 'boolean') {
    // Avec { category }, seule cette catégorie est concernée.
    services.forEach((s) => { if (!body.category || s.category === body.category) s.active = body.all; });
  } else if (level >= 1 && level <= 4) {
    services.forEach((s) => { if (s.level) s.active = s.level <= level; });
  } else {
    throw new HttpError(400, 'Profil inconnu');
  }
  servicesChanged();
  return { active: activeServices().length, total: services.length };
});

route('POST', '/api/agent/catalog/:id/update', ({ params, body }) => {
  const i = services.findIndex((s) => s.id === params.id);
  if (i < 0) throw new HttpError(404, 'Service inconnu');
  services[i] = cleanService({ ...services[i], ...body, id: params.id, level: services[i].level });
  servicesChanged();
  return services[i];
});

route('POST', '/api/agent/catalog/:id/delete', ({ params }) => {
  const i = services.findIndex((s) => s.id === params.id);
  if (i < 0) throw new HttpError(404, 'Service inconnu');
  if (db.tickets.some((t) => t.serviceId === params.id)) {
    throw new HttpError(409, 'Ce service a des tickets aujourd’hui : désactivez-le plutôt.');
  }
  services.splice(i, 1);
  servicesChanged();
  return { ok: true };
});

route('POST', '/api/agent/tickets', ({ body }) => {
  const t = createTicket({
    serviceId: body.serviceId,
    name: body.name,
    phone: body.phone,
    onSite: true,
    priority: !!body.priority,
    source: 'accueil',
  });
  changed();
  return { ...agentTicket(t), url: `${joinUrl()}/t/${t.token}` };
});

route('POST', '/api/agent/services/:id/next', ({ params, body }) => {
  if (!services.some((s) => s.id === params.id)) throw new HttpError(404, 'Service inconnu');
  const next = callNext(params.id, body.outcome === 'absent' ? 'absent' : 'done');
  changed();
  return { called: next ? next.number : null };
});

route('POST', '/api/agent/services/:id/finish', ({ params }) => {
  const cur = currentTicket(params.id);
  if (cur) {
    cur.status = 'done';
    cur.doneAt = Date.now();
  }
  changed();
  return { ok: true };
});

route('POST', '/api/agent/services/:id/recall', ({ params }) => {
  const cur = currentTicket(params.id);
  if (!cur) throw new HttpError(409, 'Aucun patient appelé');
  const s = svc(params.id);
  notify(cur, `SAMA TOUR : rappel, ticket ${cur.number}, rendez-vous : ${s.room} (${s.name}).`);
  broadcast('announce', { number: cur.number, room: s.room, serviceName: s.name, recall: true });
  return { ok: true };
});

route('POST', '/api/agent/tickets/:token/priority', ({ params }) => {
  const t = findTicket(params.token);
  t.priority = !t.priority;
  changed();
  return agentTicket(t);
});

route('POST', '/api/agent/tickets/:token/requeue', ({ params }) => {
  const t = findTicket(params.token);
  if (t.status !== 'absent') throw new HttpError(409, 'Seul un patient absent peut être remis en file');
  t.status = 'waiting';
  t.calledAt = null;
  t.doneAt = null;
  changed();
  return agentTicket(t);
});

route('POST', '/api/agent/tickets/:token/remove', ({ params }) => {
  const t = findTicket(params.token);
  if (t.status !== 'waiting') throw new HttpError(409, 'Seul un patient en attente peut être retiré');
  t.status = 'cancelled';
  t.doneAt = Date.now();
  changed();
  return { ok: true };
});

route('POST', '/api/agent/demo/seed', () => {
  archiveDay();
  db = freshDb();
  seedDemo();
  changed();
  return { ok: true };
});

route('POST', '/api/agent/reset', () => {
  archiveDay();
  db = freshDb();
  changed();
  return { ok: true };
});

route('GET', '/api/agent/export.csv', ({ res }) => {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="samatour-${db.day}.csv"`,
  });
  res.end(exportCsv());
  return undefined;
});

// --- Espaces patient, soignant et administration (lib/portals.js) -----------

const store = require('./lib/store');
const portals = require('./lib/portals')({
  route, HttpError, svc, config, sms, DEMO_MODE, today, joinUrl, broadcast, changed, createTicket, serviceSummary,
  getServices: () => services,
  saveServices,
});

// --- Fichiers statiques -----------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.srt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
};

const PAGES = {
  '/': 'index.html', '/agent': 'agent.html', '/ecran': 'ecran.html',
  '/patient': 'patient.html', '/pro': 'pro.html', '/admin': 'admin.html',
  '/videos': 'videos.html',
};

function serveVideo(full, res, req) {
  fs.stat(full, (err, st) => {
    if (err) return sendJson(res, 404, { error: 'Vidéo introuvable' });
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (!m) {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(full).pipe(res);
    }
    const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1,
    });
    fs.createReadStream(full, { start, end }).pipe(res);
  });
}

function serveStatic(pathname, res, req) {
  let file = PAGES[pathname];
  if (!file && /^\/t\/[\w-]+$/.test(pathname)) file = 'ticket.html';
  if (!file) file = pathname.slice(1);
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Interdit' });
  const ext = path.extname(full);
  // Vidéos : lecture progressive avec avance rapide (en-tête Range).
  if (ext === '.mp4') return serveVideo(full, res, req);
  fs.readFile(full, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Page introuvable' });
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // no-cache : le navigateur revalide à chaque fois, donc les mises à jour (logo, styles) apparaissent tout de suite.
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Serveur
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  try {
    ensureDay();

    if (pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        if (r.agent && !pinOk(req.headers['x-pin'] || url.searchParams.get('pin')) && !(portals && portals.staffFromReq(req))) {
          throw new HttpError(401, 'Code PIN requis');
        }
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const body = req.method === 'POST' ? await readBody(req) : {};
        const result = await r.handler({ req, res, params, body, query: url.searchParams });
        if (result !== undefined) sendJson(res, 200, result);
        return;
      }
      throw new HttpError(404, 'Route inconnue');
    }

    if (req.method !== 'GET') throw new HttpError(405, 'Méthode non autorisée');
    serveStatic(pathname, res, req);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'Erreur serveur' });
  }
});

if (DEMO_MODE) {
  if (!db.tickets.length) seedDemo();
  portals.seedDemo();
  portals.refreshDemoDay();
  saveNow();
}

server.listen(PORT, '0.0.0.0', () => {
  const base = joinUrl();
  console.log('\n  SAMA TOUR — MVP gestion des files d’attente');
  console.log('  ------------------------------------------');
  console.log(`  Patient (prendre un ticket) : ${base}/`);
  console.log(`  Console agent / médecin     : ${base}/agent   (PIN : ${PIN === '1234' ? '1234' : '••••'})`);
  console.log(`  Écran salle d’attente       : ${base}/ecran`);
  console.log(`  Sur ce PC                   : http://localhost:${PORT}/`);
  console.log(`  SMS                         : mode ${sms.mode}`);
  console.log(`  Assistant                   : mode ${require('./lib/assistant').mode}\n`);
});

function shutdown() {
  try {
    saveNow();
    store.saveNow();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
