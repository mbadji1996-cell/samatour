'use strict';
/*
 * Les trois espaces de SAMA TOUR :
 *   - espace patient      : compte, rendez-vous avec paiement, carte de santé numérique et dossier
 *   - espace soignant     : agenda, accueil des rendez-vous, dossier patient (accès contrôlé et tracé)
 *   - espace administration : personnel, tarifs et créneaux, paiements, tableau de bord
 *
 * Protection du dossier médical :
 *   - un soignant n'ouvre un dossier que si le patient a rendez-vous dans un de ses services,
 *     s'il donne son code de partage (affiché sur sa carte), ou en accès d'urgence motivé ;
 *   - chaque ouverture et chaque modification est inscrite dans le journal d'accès, visible par le patient ;
 *   - l'administration et l'accueil n'ont pas accès au contenu médical.
 */
const store = require('./store');
const payment = require('./payment');

const MIN = 60000;
const PENDING_MINUTES = 15; // délai pour payer avant que le créneau soit libéré
const CANCEL_HOURS = 2; // annulation (et remboursement) possible jusqu'à 2 h avant
const GRANT_HOURS = 12; // durée d'accès d'un soignant à un dossier ouvert

const NO_RDV_CATEGORIES = ['Accueil et administratif', 'Urgences', 'Pharmacie et résultats'];
const PRICE_BY_LEVEL = { 1: 1000, 2: 2000, 3: 3000, 4: 5000 }; // FCFA, tarifs indicatifs
const PRICE_BY_ID = { LAB: 1000, DEP: 500, ECG: 5000, ECH: 10000, RAD: 8000, MAM: 20000, SCA: 40000, IRM: 80000, VAC: 0, CES: 0, CPN: 0, PF: 0, CDV: 0, VIH: 0, TB: 0, NUT: 0 };

const ROLES = { medecin: 'Soignant', accueil: 'Accueil', admin: 'Administration' };

module.exports = function register(ctx) {
  const { route, HttpError, svc, getServices, saveServices, createTicket, changed, broadcast, joinUrl, sms, DEMO_MODE, today } = ctx;
  const S = () => store.data;
  const grants = new Map(); // `${staffId}:${patientId}` -> expiration

  // ---------------------------------------------------------------------------------------------
  // Réglages de rendez-vous d'un service
  // ---------------------------------------------------------------------------------------------
  const RDV = { days: [1, 2, 3, 4, 5, 6], start: '08:00', end: '13:00', horizonDays: 30, ...(ctx.config.rdv || {}) };

  function rdvSettings(s) {
    const roundUp5 = (n) => Math.ceil(n / 5) * 5;
    return {
      rdvEnabled: s.rdvEnabled ?? !NO_RDV_CATEGORIES.includes(s.category),
      price: s.price ?? PRICE_BY_ID[s.id] ?? PRICE_BY_LEVEL[s.level] ?? 2000,
      slotMinutes: s.slotMinutes ?? Math.max(10, roundUp5(s.defaultMinutes || 10)),
      rdvCapacity: s.rdvCapacity ?? 1,
    };
  }
  const bookable = (s) => s.active && rdvSettings(s).rdvEnabled;

  const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const dateTime = (date, time) => new Date(`${date}T${time}:00`).getTime();
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

  // ---------------------------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------------------------
  const clean = (v, n = 80) => String(v ?? '').trim().slice(0, n);
  const list = (v, n = 20) => (Array.isArray(v) ? v : String(v || '').split(/[,;\n]/)).map((x) => clean(x, 80)).filter(Boolean).slice(0, n);
  const fcfa = (n) => `${Number(n).toLocaleString('fr-FR')} FCFA`;

  function requirePatient(req) {
    const s = store.getSession(req);
    if (!s || s.kind !== 'patient') throw new HttpError(401, 'Connectez-vous à votre espace patient');
    const p = S().patients.find((x) => x.id === s.id);
    if (!p) throw new HttpError(401, 'Compte introuvable');
    return p;
  }
  function requireStaff(req, roles) {
    const s = store.getSession(req);
    if (!s || s.kind !== 'staff') throw new HttpError(401, 'Connectez-vous à votre espace professionnel');
    const u = S().staff.find((x) => x.id === s.id && x.active !== false);
    if (!u) throw new HttpError(401, 'Compte désactivé');
    if (roles && !roles.includes(u.role)) throw new HttpError(403, 'Accès réservé : ' + roles.map((r) => ROLES[r]).join(', '));
    return u;
  }

  const fullName = (p) => `${p.firstName} ${p.lastName}`.trim();
  const staffLabel = (u) => `${u.title ? u.title + ' ' : ''}${u.name}`;

  function cleanupPending() {
    const now = Date.now();
    let dirty = false;
    for (const a of S().appointments) {
      if (a.status === 'pending_payment' && now - a.createdAt > PENDING_MINUTES * MIN) {
        a.status = 'expired';
        const pay = S().payments.find((x) => x.id === a.paymentId);
        if (pay && pay.status === 'pending') pay.status = 'failed';
        dirty = true;
      }
    }
    if (dirty) store.save();
  }

  function publicAppointment(a) {
    const s = svc(a.serviceId);
    const pay = S().payments.find((x) => x.id === a.paymentId) || null;
    return {
      id: a.id, serviceId: a.serviceId, serviceName: s.name, room: s.room, date: a.date, time: a.time,
      motif: a.motif, status: a.status, price: a.price, ticketToken: a.ticketToken || null,
      payment: pay && { id: pay.id, status: pay.status, method: pay.method, methodName: payment.METHODS[pay.method], amount: pay.amount, ref: pay.providerRef, paidAt: pay.paidAt },
      canCancel: ['pending_payment', 'confirmed'].includes(a.status) && dateTime(a.date, a.time) - Date.now() > CANCEL_HOURS * 3600e3,
      canCheckin: canCheckin(a),
    };
  }

  function canCheckin(a) {
    if (a.status !== 'confirmed' || a.date !== today()) return false;
    const diff = dateTime(a.date, a.time) - Date.now();
    return diff < 120 * MIN && diff > -90 * MIN; // de 2 h avant à 1 h 30 après l'heure prévue
  }

  function patientView(p) {
    const { pinHash, ...rest } = p;
    return {
      ...rest,
      age: ageOf(p.birthDate),
      appointments: S().appointments.filter((a) => a.patientId === p.id && a.status !== 'expired')
        .sort((a, b) => dateTime(b.date, b.time) - dateTime(a.date, a.time)).map(publicAppointment),
      cardUrl: `${joinUrl()}/pro?carte=${encodeURIComponent(p.cardNumber)}`,
    };
  }
  function ageOf(birth) {
    if (!isDate(birth)) return null;
    const b = new Date(birth), n = new Date();
    return n.getFullYear() - b.getFullYear() - (n < new Date(n.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
  }

  function logAccess(p, u, action, reason) {
    p.dossier.accessLog.unshift({ at: Date.now(), who: staffLabel(u), role: ROLES[u.role], action, reason: reason || null });
    p.dossier.accessLog = p.dossier.accessLog.slice(0, 200);
  }

  function newCardNumber() {
    S().counters.card += 1;
    return `ST-${new Date().getFullYear()}-${String(S().counters.card).padStart(6, '0')}`;
  }
  const newShareCode = () => String(Math.floor(100000 + Math.random() * 900000));

  function emptyDossier() {
    return { bloodGroup: '', allergies: [], conditions: [], treatments: [], vaccinations: [], consultations: [], accessLog: [] };
  }

  function createPatient({ phone, firstName, lastName, birthDate, sex, pin, address, emergencyContact }) {
    const tel = sms.normalizePhone(phone);
    if (!tel) throw new HttpError(400, 'Numéro de téléphone invalide');
    if (S().patients.some((p) => p.phone === tel)) throw new HttpError(409, 'Un compte existe déjà avec ce numéro');
    if (!/^\d{4,6}$/.test(String(pin || ''))) throw new HttpError(400, 'Le code secret doit contenir 4 à 6 chiffres');
    if (!clean(firstName) || !clean(lastName)) throw new HttpError(400, 'Indiquez votre prénom et votre nom');
    const p = {
      id: store.newId('pat'), phone: tel, firstName: clean(firstName, 40), lastName: clean(lastName, 40),
      birthDate: isDate(birthDate) ? birthDate : '', sex: ['F', 'M'].includes(sex) ? sex : '',
      address: clean(address, 100), emergencyContact: { name: clean(emergencyContact?.name, 60), phone: clean(emergencyContact?.phone, 20) },
      pinHash: store.hashSecret(pin), cardNumber: newCardNumber(), shareCode: newShareCode(),
      createdAt: Date.now(), dossier: emptyDossier(),
    };
    S().patients.push(p);
    store.save();
    return p;
  }

  function createStaff({ name, title, role, login, password, serviceIds }) {
    if (!ROLES[role]) throw new HttpError(400, 'Rôle inconnu');
    const lg = clean(login, 40).toLowerCase();
    if (!/^[a-z0-9._-]{3,40}$/.test(lg)) throw new HttpError(400, 'Identifiant : 3 caractères minimum, lettres, chiffres, point ou tiret');
    if (S().staff.some((u) => u.login === lg)) throw new HttpError(409, 'Cet identifiant est déjà utilisé');
    if (String(password || '').length < 8) throw new HttpError(400, 'Mot de passe : 8 caractères minimum');
    const u = {
      id: store.newId('stf'), name: clean(name, 60), title: clean(title, 30), role, login: lg,
      passHash: store.hashSecret(password), serviceIds: list(serviceIds, 100).map((x) => x.toUpperCase()),
      active: true, createdAt: Date.now(),
    };
    if (!u.name) throw new HttpError(400, 'Indiquez le nom');
    S().staff.push(u);
    store.save();
    return u;
  }
  const staffView = ({ passHash, ...u }) => ({ ...u, roleName: ROLES[u.role] });

  function slotsFor(s, date) {
    const st = rdvSettings(s);
    const day = new Date(`${date}T12:00:00`).getDay();
    if (!RDV.days.includes(day)) return [];
    const taken = {};
    for (const a of S().appointments) {
      if (a.serviceId === s.id && a.date === date && ['pending_payment', 'confirmed', 'checked_in', 'done'].includes(a.status)) {
        taken[a.time] = (taken[a.time] || 0) + 1;
      }
    }
    const out = [];
    const minStart = Date.now() + 30 * MIN;
    for (let m = toMin(RDV.start); m + st.slotMinutes <= toMin(RDV.end); m += st.slotMinutes) {
      const time = toHHMM(m);
      if (dateTime(date, time) < minStart) continue;
      out.push({ time, available: (taken[time] || 0) < st.rdvCapacity });
    }
    return out;
  }

  function confirmPaid(pay) {
    pay.status = 'paid';
    pay.paidAt = Date.now();
    const a = S().appointments.find((x) => x.id === pay.appointmentId);
    if (a && a.status === 'pending_payment') a.status = 'confirmed';
    const p = S().patients.find((x) => x.id === pay.patientId);
    if (a && p) {
      const s = svc(a.serviceId);
      sms.send(p.phone, `SAMA TOUR : rendez-vous confirmé, ${s.name}, le ${frDate(a.date)} à ${a.time}. Paiement reçu : ${fcfa(pay.amount)} (réf. ${pay.providerRef}).`);
    }
    store.save();
    broadcast('update');
  }
  const frDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  function checkin(a, p) {
    if (!canCheckin(a)) throw new HttpError(409, 'Le passage à l\'accueil est possible de 2 h avant à 1 h 30 après l\'heure du rendez-vous, le jour même.');
    const t = createTicket({
      serviceId: a.serviceId, name: p.firstName, phone: p.phone, onSite: true, source: 'rdv',
      rdv: { appointmentId: a.id, time: a.time, at: dateTime(a.date, a.time) },
    });
    a.status = 'checked_in';
    a.ticketToken = t.token;
    a.checkedInAt = Date.now();
    store.save();
    changed();
    return t;
  }

  // ---------------------------------------------------------------------------------------------
  // Routes publiques
  // ---------------------------------------------------------------------------------------------
  route('GET', '/api/meta', () => ({
    demo: DEMO_MODE,
    paymentMode: payment.mode,
    methods: payment.METHODS,
    rdv: RDV,
    demoAccounts: DEMO_MODE ? DEMO_ACCOUNTS : null,
  }));

  route('GET', '/api/rdv/services', () =>
    getServices().filter(bookable).map((s) => ({ id: s.id, name: s.name, category: s.category, room: s.room, keywords: s.keywords, ...rdvSettings(s) })));

  route('GET', '/api/rdv/slots', ({ query }) => {
    cleanupPending();
    const s = svc(query.get('service'));
    const date = query.get('date');
    if (!bookable(s)) throw new HttpError(404, 'Ce service ne prend pas de rendez-vous');
    if (!isDate(date)) throw new HttpError(400, 'Date invalide');
    return { service: s.id, date, slots: slotsFor(s, date) };
  });

  // ---------------------------------------------------------------------------------------------
  // Authentification
  // ---------------------------------------------------------------------------------------------
  route('POST', '/api/auth/patient/register', ({ body }) => {
    const p = createPatient(body);
    sms.send(p.phone, `SAMA TOUR : bienvenue ${p.firstName} ! Votre carte de santé n° ${p.cardNumber} est prête dans votre espace.`);
    return { token: store.createSession('patient', p.id), patient: patientView(p) };
  });

  route('POST', '/api/auth/patient/login', ({ body }) => {
    const tel = sms.normalizePhone(body.phone);
    const key = 'pat:' + tel;
    store.checkAttempts(key);
    const p = S().patients.find((x) => x.phone === tel);
    if (!p || !store.checkSecret(body.pin, p.pinHash)) {
      store.failAttempt(key);
      throw new HttpError(401, 'Numéro ou code secret incorrect');
    }
    store.clearAttempts(key);
    return { token: store.createSession('patient', p.id), patient: patientView(p) };
  });

  route('POST', '/api/auth/staff/login', ({ body }) => {
    const lg = clean(body.login, 40).toLowerCase();
    const key = 'stf:' + lg;
    store.checkAttempts(key);
    const u = S().staff.find((x) => x.login === lg && x.active !== false);
    if (!u || !store.checkSecret(body.password, u.passHash)) {
      store.failAttempt(key);
      throw new HttpError(401, 'Identifiant ou mot de passe incorrect');
    }
    store.clearAttempts(key);
    return { token: store.createSession('staff', u.id), user: staffView(u) };
  });

  route('POST', '/api/auth/logout', ({ req }) => {
    const s = store.getSession(req);
    if (s) store.endSession(s.token);
    return { ok: true };
  });

  // ---------------------------------------------------------------------------------------------
  // Espace patient
  // ---------------------------------------------------------------------------------------------
  route('GET', '/api/patient/me', ({ req }) => {
    cleanupPending();
    return patientView(requirePatient(req));
  });

  route('POST', '/api/patient/me', ({ req, body }) => {
    const p = requirePatient(req);
    if (body.firstName !== undefined) p.firstName = clean(body.firstName, 40) || p.firstName;
    if (body.lastName !== undefined) p.lastName = clean(body.lastName, 40) || p.lastName;
    if (body.birthDate !== undefined && (isDate(body.birthDate) || body.birthDate === '')) p.birthDate = body.birthDate;
    if (body.sex !== undefined && ['F', 'M', ''].includes(body.sex)) p.sex = body.sex;
    if (body.address !== undefined) p.address = clean(body.address, 100);
    if (body.emergencyContact) p.emergencyContact = { name: clean(body.emergencyContact.name, 60), phone: clean(body.emergencyContact.phone, 20) };
    store.save();
    return patientView(p);
  });

  route('POST', '/api/patient/share-code', ({ req }) => {
    const p = requirePatient(req);
    p.shareCode = newShareCode();
    // Un nouveau code coupe les accès accordés avec l'ancien.
    for (const k of grants.keys()) if (k.endsWith(':' + p.id)) grants.delete(k);
    store.save();
    return patientView(p);
  });

  route('POST', '/api/patient/appointments', async ({ req, body }) => {
    cleanupPending();
    const p = requirePatient(req);
    const s = svc(body.serviceId);
    if (!bookable(s)) throw new HttpError(400, 'Ce service ne prend pas de rendez-vous');
    if (!isDate(body.date) || !/^\d{2}:\d{2}$/.test(body.time || '')) throw new HttpError(400, 'Choisissez une date et un créneau');
    const slot = slotsFor(s, body.date).find((x) => x.time === body.time);
    if (!slot || !slot.available) throw new HttpError(409, 'Ce créneau n\'est plus disponible, choisissez-en un autre');
    if (!payment.METHODS[body.method]) throw new HttpError(400, 'Choisissez un moyen de paiement');
    const st = rdvSettings(s);
    const a = {
      id: store.newId('rdv'), patientId: p.id, serviceId: s.id, date: body.date, time: body.time,
      motif: clean(body.motif, 200), price: st.price, status: 'pending_payment', createdAt: Date.now(),
    };
    const pay = {
      id: store.newId('pay'), appointmentId: a.id, patientId: p.id, amount: st.price, method: body.method,
      payPhone: sms.normalizePhone(body.payPhone) || p.phone, status: 'pending', createdAt: Date.now(),
    };
    a.paymentId = pay.id;
    let redirectUrl = null;
    if (st.price === 0) {
      pay.method = 'gratuit';
      pay.status = 'free';
      a.status = 'confirmed';
    } else {
      const r = await payment.start(pay, { successUrl: `${joinUrl()}/patient#rdv`, errorUrl: `${joinUrl()}/patient#rdv` });
      pay.providerRef = r.providerRef || null;
      redirectUrl = r.redirectUrl || null;
      if (r.status === 'on_site') {
        pay.status = 'on_site';
        a.status = 'confirmed';
      }
    }
    S().appointments.push(a);
    S().payments.push(pay);
    store.save();
    if (a.status === 'confirmed') {
      sms.send(p.phone, `SAMA TOUR : rendez-vous confirmé, ${s.name}, le ${frDate(a.date)} à ${a.time}.${pay.status === 'on_site' ? ` À régler sur place : ${fcfa(pay.amount)}.` : ''}`);
      broadcast('update');
    }
    return { appointment: publicAppointment(a), redirectUrl, paymentMode: payment.mode };
  });

  // Simulation uniquement : le patient « valide sur son téléphone ».
  route('POST', '/api/patient/payments/:id/confirm', ({ req, params }) => {
    const p = requirePatient(req);
    const pay = S().payments.find((x) => x.id === params.id && x.patientId === p.id);
    if (!pay) throw new HttpError(404, 'Paiement introuvable');
    if (payment.mode !== 'simulation' && pay.method === 'wave') throw new HttpError(400, 'La confirmation se fait sur Wave');
    if (pay.status !== 'pending') throw new HttpError(409, 'Ce paiement n\'est plus en attente');
    const a = S().appointments.find((x) => x.id === pay.appointmentId);
    if (!a || a.status !== 'pending_payment') throw new HttpError(409, 'Délai de paiement dépassé, reprenez un rendez-vous');
    confirmPaid(pay);
    return publicAppointment(a);
  });

  route('POST', '/api/patient/payments/:id/refresh', async ({ req, params }) => {
    const p = requirePatient(req);
    const pay = S().payments.find((x) => x.id === params.id && x.patientId === p.id);
    if (!pay) throw new HttpError(404, 'Paiement introuvable');
    if (pay.status === 'pending') {
      const st = await payment.check(pay);
      if (st === 'paid') confirmPaid(pay);
      if (st === 'failed') pay.status = 'failed';
    }
    return publicAppointment(S().appointments.find((x) => x.id === pay.appointmentId));
  });

  route('POST', '/api/patient/appointments/:id/cancel', ({ req, params }) => {
    const p = requirePatient(req);
    const a = S().appointments.find((x) => x.id === params.id && x.patientId === p.id);
    if (!a) throw new HttpError(404, 'Rendez-vous introuvable');
    if (!publicAppointment(a).canCancel) throw new HttpError(409, `L'annulation est possible jusqu'à ${CANCEL_HOURS} h avant le rendez-vous`);
    a.status = 'cancelled';
    const pay = S().payments.find((x) => x.id === a.paymentId);
    if (pay && pay.status === 'paid') {
      pay.status = 'refunded';
      pay.refundedAt = Date.now();
      sms.send(p.phone, `SAMA TOUR : rendez-vous annulé. Remboursement de ${fcfa(pay.amount)} en cours sur ${payment.METHODS[pay.method]}.`);
    } else if (pay && pay.status === 'pending') pay.status = 'failed';
    store.save();
    broadcast('update');
    return publicAppointment(a);
  });

  route('POST', '/api/patient/appointments/:id/checkin', ({ req, params }) => {
    const p = requirePatient(req);
    const a = S().appointments.find((x) => x.id === params.id && x.patientId === p.id);
    if (!a) throw new HttpError(404, 'Rendez-vous introuvable');
    const t = checkin(a, p);
    return { token: t.token, number: t.number };
  });

  // ---------------------------------------------------------------------------------------------
  // Espace soignant / accueil
  // ---------------------------------------------------------------------------------------------
  route('GET', '/api/pro/me', ({ req }) => staffView(requireStaff(req)));

  route('GET', '/api/pro/agenda', ({ req, query }) => {
    cleanupPending();
    const u = requireStaff(req);
    const date = isDate(query.get('date')) ? query.get('date') : today();
    const mine = (a) => u.role !== 'medecin' || !u.serviceIds.length || u.serviceIds.includes(a.serviceId);
    return {
      date,
      user: staffView(u),
      appointments: S().appointments
        .filter((a) => a.date === date && mine(a) && !['expired', 'pending_payment'].includes(a.status))
        .sort((a, b) => a.time.localeCompare(b.time))
        .map((a) => {
          const p = S().patients.find((x) => x.id === a.patientId) || {};
          return { ...publicAppointment(a), patient: { id: p.id, name: fullName(p), phone: p.phone, age: ageOf(p.birthDate), sex: p.sex, cardNumber: p.cardNumber } };
        }),
    };
  });

  route('POST', '/api/pro/appointments/:id/checkin', ({ req, params }) => {
    requireStaff(req);
    const a = S().appointments.find((x) => x.id === params.id);
    if (!a) throw new HttpError(404, 'Rendez-vous introuvable');
    const p = S().patients.find((x) => x.id === a.patientId);
    const t = checkin(a, p);
    return { token: t.token, number: t.number };
  });

  route('POST', '/api/pro/appointments/:id/status', ({ req, params, body }) => {
    requireStaff(req, ['medecin', 'accueil', 'admin']);
    const a = S().appointments.find((x) => x.id === params.id);
    if (!a) throw new HttpError(404, 'Rendez-vous introuvable');
    if (!['done', 'no_show', 'confirmed'].includes(body.status)) throw new HttpError(400, 'Statut inconnu');
    a.status = body.status;
    store.save();
    broadcast('update');
    return publicAppointment(a);
  });

  route('GET', '/api/pro/patients/search', ({ req, query }) => {
    requireStaff(req, ['medecin', 'accueil']);
    const q = clean(query.get('q'), 40).toUpperCase();
    if (q.length < 4) return [];
    const tel = sms.normalizePhone(q);
    return S().patients
      .filter((p) => p.cardNumber === q || p.cardNumber.endsWith(q) || (tel && p.phone === tel))
      .slice(0, 5)
      .map((p) => ({ id: p.id, name: fullName(p), cardNumber: p.cardNumber, birthYear: (p.birthDate || '').slice(0, 4), sex: p.sex }));
  });

  function hasGrant(u, p) {
    const exp = grants.get(`${u.id}:${p.id}`);
    return exp && exp > Date.now();
  }
  function hasAppointmentWith(u, p) {
    const days = [-1, 0, 1].map((d) => new Date(Date.now() + d * 864e5).toLocaleDateString('sv-SE'));
    return S().appointments.some((a) => a.patientId === p.id && days.includes(a.date) &&
      ['confirmed', 'checked_in', 'done'].includes(a.status) && (!u.serviceIds.length || u.serviceIds.includes(a.serviceId)));
  }
  function dossierView(p) {
    const { pinHash, shareCode, ...rest } = p;
    return { ...rest, age: ageOf(p.birthDate) };
  }
  function openPatient(req, id) {
    const u = requireStaff(req, ['medecin']);
    const p = S().patients.find((x) => x.id === id);
    if (!p) throw new HttpError(404, 'Patient introuvable');
    if (!hasGrant(u, p)) throw new HttpError(403, 'Accès au dossier non autorisé');
    return { u, p };
  }

  route('POST', '/api/pro/dossiers/:id/open', ({ req, params, body }) => {
    const u = requireStaff(req, ['medecin']);
    const p = S().patients.find((x) => x.id === params.id);
    if (!p) throw new HttpError(404, 'Patient introuvable');
    let reason;
    if (hasGrant(u, p)) reason = null;
    else if (body.code && String(body.code) === p.shareCode) reason = 'code de partage du patient';
    else if (hasAppointmentWith(u, p)) reason = 'rendez-vous dans le service';
    else if (body.emergency && clean(body.reason, 200).length >= 10) reason = 'URGENCE : ' + clean(body.reason, 200);
    else throw new HttpError(403, 'Demandez au patient son code de partage (sur sa carte), ou justifiez un accès d\'urgence.');
    grants.set(`${u.id}:${p.id}`, Date.now() + GRANT_HOURS * 3600e3);
    if (reason) logAccess(p, u, 'Ouverture du dossier', reason);
    store.save();
    return dossierView(p);
  });

  route('GET', '/api/pro/dossiers/:id', ({ req, params }) => dossierView(openPatient(req, params.id).p));

  route('POST', '/api/pro/dossiers/:id/consultations', ({ req, params, body }) => {
    const { u, p } = openPatient(req, params.id);
    if (!clean(body.motif)) throw new HttpError(400, 'Indiquez le motif de consultation');
    const c = {
      id: store.newId('cst'), at: Date.now(), serviceId: clean(body.serviceId, 6) || u.serviceIds[0] || '',
      doctor: staffLabel(u), motif: clean(body.motif, 200), notes: clean(body.notes, 2000), diagnostic: clean(body.diagnostic, 300),
      vitals: { tension: clean(body.vitals?.tension, 15), temperature: clean(body.vitals?.temperature, 6), poids: clean(body.vitals?.poids, 6) },
      prescription: (Array.isArray(body.prescription) ? body.prescription : []).slice(0, 15)
        .map((l) => ({ med: clean(l.med, 80), posologie: clean(l.posologie, 120), duree: clean(l.duree, 40) })).filter((l) => l.med),
    };
    p.dossier.consultations.unshift(c);
    logAccess(p, u, 'Ajout d\'une consultation');
    // Le rendez-vous du jour dans ce service est terminé.
    const a = S().appointments.find((x) => x.patientId === p.id && x.date === today() && x.serviceId === c.serviceId && ['confirmed', 'checked_in'].includes(x.status));
    if (a) a.status = 'done';
    store.save();
    broadcast('update');
    return dossierView(p);
  });

  route('POST', '/api/pro/dossiers/:id/medical', ({ req, params, body }) => {
    const { u, p } = openPatient(req, params.id);
    const d = p.dossier;
    if (body.bloodGroup !== undefined) d.bloodGroup = ['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].includes(body.bloodGroup) ? body.bloodGroup : d.bloodGroup;
    if (body.allergies !== undefined) d.allergies = list(body.allergies);
    if (body.conditions !== undefined) d.conditions = list(body.conditions);
    if (body.treatments !== undefined) d.treatments = list(body.treatments);
    logAccess(p, u, 'Mise à jour des informations médicales');
    store.save();
    return dossierView(p);
  });

  route('POST', '/api/pro/dossiers/:id/vaccinations', ({ req, params, body }) => {
    const { u, p } = openPatient(req, params.id);
    if (!clean(body.name)) throw new HttpError(400, 'Indiquez le vaccin');
    p.dossier.vaccinations.unshift({ name: clean(body.name, 60), date: isDate(body.date) ? body.date : today(), lot: clean(body.lot, 30), by: staffLabel(u) });
    logAccess(p, u, 'Ajout d\'une vaccination');
    store.save();
    return dossierView(p);
  });

  // ---------------------------------------------------------------------------------------------
  // Administration
  // ---------------------------------------------------------------------------------------------
  route('GET', '/api/admin/overview', ({ req }) => {
    requireStaff(req, ['admin']);
    cleanupPending();
    const d = today(), month = d.slice(0, 7);
    const paid = S().payments.filter((x) => x.status === 'paid');
    const sum = (xs) => xs.reduce((a, x) => a + x.amount, 0);
    const byMethod = {};
    for (const x of paid.filter((x) => new Date(x.paidAt).toLocaleDateString('sv-SE').startsWith(month))) {
      byMethod[x.method] = (byMethod[x.method] || 0) + x.amount;
    }
    const appts = S().appointments.filter((a) => !['expired'].includes(a.status));
    const byService = {};
    for (const a of appts.filter((a) => a.date.startsWith(month) && a.status !== 'cancelled')) {
      byService[a.serviceId] = byService[a.serviceId] || { name: svc(a.serviceId).name, count: 0 };
      byService[a.serviceId].count += 1;
    }
    return {
      patients: S().patients.length,
      staff: S().staff.filter((u) => u.active !== false).length,
      appointmentsToday: appts.filter((a) => a.date === d && a.status !== 'cancelled').length,
      appointmentsUpcoming: appts.filter((a) => a.date > d && a.status === 'confirmed').length,
      noShowsMonth: appts.filter((a) => a.date.startsWith(month) && a.status === 'no_show').length,
      revenueToday: sum(paid.filter((x) => new Date(x.paidAt).toLocaleDateString('sv-SE') === d)),
      revenueMonth: sum(paid.filter((x) => new Date(x.paidAt).toLocaleDateString('sv-SE').startsWith(month))),
      refundedMonth: sum(S().payments.filter((x) => x.status === 'refunded' && new Date(x.refundedAt).toLocaleDateString('sv-SE').startsWith(month))),
      onSiteToCollect: sum(S().payments.filter((x) => x.status === 'on_site')),
      byMethod: Object.entries(byMethod).map(([m, amount]) => ({ method: payment.METHODS[m] || m, amount })).sort((a, b) => b.amount - a.amount),
      byService: Object.values(byService).sort((a, b) => b.count - a.count).slice(0, 8),
      paymentMode: payment.mode,
      payments: S().payments.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 60).map((x) => {
        const a = S().appointments.find((y) => y.id === x.appointmentId) || {};
        const p = S().patients.find((y) => y.id === x.patientId) || {};
        return { ...x, methodName: payment.METHODS[x.method] || 'Gratuit', patient: fullName(p), serviceName: svc(a.serviceId).name, date: a.date, time: a.time };
      }),
    };
  });

  route('POST', '/api/admin/payments/:id/refund', ({ req, params }) => {
    requireStaff(req, ['admin']);
    const pay = S().payments.find((x) => x.id === params.id);
    if (!pay || pay.status !== 'paid') throw new HttpError(409, 'Seul un paiement réglé peut être remboursé');
    pay.status = 'refunded';
    pay.refundedAt = Date.now();
    const a = S().appointments.find((x) => x.id === pay.appointmentId);
    if (a && ['confirmed', 'pending_payment'].includes(a.status)) a.status = 'cancelled';
    store.save();
    return { ok: true };
  });

  route('POST', '/api/admin/payments/:id/collect', ({ req, params }) => {
    requireStaff(req, ['admin', 'accueil']);
    const pay = S().payments.find((x) => x.id === params.id);
    if (!pay || pay.status !== 'on_site') throw new HttpError(409, 'Ce paiement n\'est pas à encaisser sur place');
    pay.status = 'paid';
    pay.paidAt = Date.now();
    pay.providerRef = 'CAISSE-' + pay.id.slice(-6).toUpperCase();
    store.save();
    return { ok: true };
  });

  route('GET', '/api/admin/staff', ({ req }) => {
    requireStaff(req, ['admin']);
    return S().staff.map(staffView);
  });

  route('POST', '/api/admin/staff', ({ req, body }) => {
    requireStaff(req, ['admin']);
    return staffView(createStaff(body));
  });

  route('POST', '/api/admin/staff/:id/update', ({ req, params, body }) => {
    const me = requireStaff(req, ['admin']);
    const u = S().staff.find((x) => x.id === params.id);
    if (!u) throw new HttpError(404, 'Compte introuvable');
    if (body.name !== undefined) u.name = clean(body.name, 60) || u.name;
    if (body.title !== undefined) u.title = clean(body.title, 30);
    if (body.role !== undefined && ROLES[body.role]) {
      if (u.id === me.id && body.role !== 'admin') throw new HttpError(409, 'Vous ne pouvez pas retirer vos propres droits d\'administration');
      u.role = body.role;
    }
    if (body.serviceIds !== undefined) u.serviceIds = list(body.serviceIds, 100).map((x) => x.toUpperCase());
    if (body.active !== undefined) {
      if (u.id === me.id && !body.active) throw new HttpError(409, 'Vous ne pouvez pas désactiver votre propre compte');
      u.active = !!body.active;
    }
    if (body.password) {
      if (String(body.password).length < 8) throw new HttpError(400, 'Mot de passe : 8 caractères minimum');
      u.passHash = store.hashSecret(body.password);
    }
    store.save();
    return staffView(u);
  });

  route('GET', '/api/admin/rdv-settings', ({ req }) => {
    requireStaff(req, ['admin']);
    return { rdv: RDV, services: getServices().filter((s) => s.active).map((s) => ({ id: s.id, name: s.name, category: s.category, ...rdvSettings(s) })) };
  });

  route('POST', '/api/admin/services/:id/rdv', ({ req, params, body }) => {
    requireStaff(req, ['admin']);
    const s = getServices().find((x) => x.id === params.id);
    if (!s) throw new HttpError(404, 'Service inconnu');
    if (body.rdvEnabled !== undefined) s.rdvEnabled = !!body.rdvEnabled;
    if (body.price !== undefined) s.price = Math.max(0, Math.min(1e6, Math.round(Number(body.price) || 0)));
    if (body.slotMinutes !== undefined) s.slotMinutes = Math.max(5, Math.min(120, Math.round(Number(body.slotMinutes) || 15)));
    if (body.rdvCapacity !== undefined) s.rdvCapacity = Math.max(1, Math.min(20, Math.round(Number(body.rdvCapacity) || 1)));
    saveServices();
    return { id: s.id, ...rdvSettings(s) };
  });

  route('GET', '/api/admin/appointments', ({ req, query }) => {
    requireStaff(req, ['admin', 'accueil']);
    const date = isDate(query.get('date')) ? query.get('date') : today();
    return S().appointments.filter((a) => a.date === date && a.status !== 'expired').sort((a, b) => a.time.localeCompare(b.time)).map((a) => {
      const p = S().patients.find((x) => x.id === a.patientId) || {};
      return { ...publicAppointment(a), patient: { name: fullName(p), phone: p.phone, cardNumber: p.cardNumber } };
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Données de démonstration (comptes fictifs, affichés sur les pages de connexion en mode démo)
  // ---------------------------------------------------------------------------------------------
  const DEMO_ACCOUNTS = {
    patient: { phone: '77 000 00 01', pin: '1234', name: 'Aminata Diallo' },
    staff: [
      { login: 'dr.sow', password: 'demo-sante', label: 'Dr Fatou Sow, médecin (Médecine générale, Pédiatrie)' },
      { login: 'sf.ndiaye', password: 'demo-sante', label: 'Mme Awa Ndiaye, sage-femme (CPN, Planification familiale)' },
      { login: 'accueil', password: 'demo-sante', label: 'Agent d\'accueil' },
      { login: 'admin', password: 'demo-admin', label: 'Administration de la structure' },
    ],
  };

  function seedDemo() {
    if (S().staff.length) return;
    createStaff({ name: 'Fatou Sow', title: 'Dr', role: 'medecin', login: 'dr.sow', password: 'demo-sante', serviceIds: ['MG', 'PED'] });
    createStaff({ name: 'Awa Ndiaye', title: 'Mme', role: 'medecin', login: 'sf.ndiaye', password: 'demo-sante', serviceIds: ['CPN', 'PF', 'GYN'] });
    createStaff({ name: 'Moussa Fall', title: '', role: 'accueil', login: 'accueil', password: 'demo-sante', serviceIds: [] });
    createStaff({ name: 'Direction', title: '', role: 'admin', login: 'admin', password: 'demo-admin', serviceIds: [] });

    const a = createPatient({ phone: '770000001', firstName: 'Aminata', lastName: 'Diallo', birthDate: '1994-03-12', sex: 'F', pin: '1234', address: 'Pikine, Dakar', emergencyContact: { name: 'Ousmane Diallo (frère)', phone: '77 000 00 09' } });
    Object.assign(a.dossier, {
      bloodGroup: 'O+',
      allergies: ['Pénicilline'],
      conditions: ['Asthme léger depuis l\'enfance'],
      treatments: ['Salbutamol inhalé en cas de crise'],
      vaccinations: [
        { name: 'Tétanos (rappel)', date: '2025-06-02', lot: 'TT-2291', by: 'Mme Awa Ndiaye' },
        { name: 'Fièvre jaune', date: '2019-01-15', lot: '', by: 'Institut Pasteur' },
      ],
      consultations: [
        { id: store.newId('cst'), at: Date.now() - 41 * 864e5, serviceId: 'MG', doctor: 'Dr Fatou Sow', motif: 'Fièvre et maux de tête depuis 3 jours', diagnostic: 'Paludisme simple (TDR positif)', notes: 'Bon état général. Hydratation conseillée.', vitals: { tension: '11/7', temperature: '38,6', poids: '62' }, prescription: [{ med: 'Artéméther-luméfantrine 20/120 mg', posologie: '4 comprimés matin et soir', duree: '3 jours' }, { med: 'Paracétamol 1 g', posologie: '1 comprimé si fièvre, max 3/jour', duree: '3 jours' }] },
        { id: store.newId('cst'), at: Date.now() - 160 * 864e5, serviceId: 'MG', doctor: 'Dr Fatou Sow', motif: 'Renouvellement de traitement (asthme)', diagnostic: 'Asthme contrôlé', notes: '', vitals: { tension: '12/7', temperature: '36,8', poids: '61' }, prescription: [{ med: 'Salbutamol 100 µg, inhalateur', posologie: '2 bouffées en cas de gêne', duree: '6 mois' }] },
      ],
    });
    const others = [
      ['770000002', 'Moussa', 'Ba', '1980-07-21', 'M'], ['770000003', 'Khady', 'Sarr', '1999-11-02', 'F'],
      ['770000004', 'Ibrahima', 'Ndoye', '1958-01-30', 'M'], ['770000005', 'Fatou', 'Gueye', '2021-05-14', 'F'],
      ['770000006', 'Mariama', 'Cissé', '1991-09-09', 'F'], ['770000007', 'Cheikh', 'Mbaye', '2018-02-25', 'M'],
    ];
    for (const [phone, firstName, lastName, birthDate, sex] of others) createPatient({ phone, firstName, lastName, birthDate, sex, pin: '1234' });
    refreshDemoDay();
  }

  /** Rendez-vous de démonstration du jour (recréés chaque jour en mode démo). */
  function refreshDemoDay() {
    const d = today();
    S().appointments = S().appointments.filter((a) => !a.demo || a.date < d);
    S().payments = S().payments.filter((x) => !x.demo || S().appointments.some((a) => a.paymentId === x.id));
    const pats = S().patients;
    // Heures placées autour du moment présent : quelle que soit l'heure de la visite du jury,
    // l'agenda montre des rendez-vous passés et à venir, et Aminata peut signaler son arrivée.
    const now = Date.now();
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const at = (offset) => toHHMM(Math.min(23 * 60 + 55, Math.max(0, Math.round((nowMin + offset) / 5) * 5)));
    const plan = [
      [1, 'MG', at(-120), 'wave', 'Toux persistante'], [2, 'MG', at(-75), 'orange_money', 'Contrôle tension'],
      [4, 'PED', at(-45), 'wave', 'Fièvre de l\'enfant'], [5, 'CPN', at(-20), 'gratuit', 'CPN 3e trimestre'],
      [0, 'MG', at(20), 'wave', 'Suivi asthme'], [3, 'MG', at(50), 'sur_place', 'Douleurs articulaires'],
      [6, 'PED', at(80), 'free_money', 'Visite de contrôle'],
    ];
    for (const [i, sid, time, method, motif] of plan) {
      const p = pats[i];
      const s = svc(sid);
      if (!p || !s.active) continue;
      const price = rdvSettings(s).price;
      const past = dateTime(d, time) < now - 30 * MIN;
      const a = { id: store.newId('rdv'), patientId: p.id, serviceId: sid, date: d, time, motif, price, status: past ? 'done' : 'confirmed', createdAt: now - 864e5, demo: true };
      const free = price === 0 || method === 'gratuit';
      const pay = {
        id: store.newId('pay'), appointmentId: a.id, patientId: p.id, amount: free ? 0 : price, method: free ? 'gratuit' : method,
        payPhone: p.phone, status: free ? 'free' : method === 'sur_place' ? (past ? 'paid' : 'on_site') : 'paid',
        providerRef: 'SIM-' + Math.random().toString(36).slice(2, 8).toUpperCase(), createdAt: now - 864e5, paidAt: now - 864e5, demo: true,
      };
      a.paymentId = pay.id;
      S().appointments.push(a);
      S().payments.push(pay);
    }
    // Un rendez-vous à venir pour Aminata
    // Prochain jour de consultation (pas le dimanche)
    let next = new Date(now + 864e5);
    while (!RDV.days.includes(next.getDay())) next = new Date(next.getTime() + 864e5);
    const tomorrow = next.toLocaleDateString('sv-SE');
    if (!S().appointments.some((a) => a.demo && a.patientId === pats[0]?.id && a.date >= tomorrow)) {
      const a = { id: store.newId('rdv'), patientId: pats[0].id, serviceId: 'CAR', date: tomorrow, time: '09:00', motif: 'Palpitations à l\'effort', price: rdvSettings(svc('CAR')).price, status: 'confirmed', createdAt: now, demo: true };
      const pay = { id: store.newId('pay'), appointmentId: a.id, patientId: pats[0].id, amount: a.price, method: 'wave', payPhone: pats[0].phone, status: 'paid', providerRef: 'SIM-CAR001', createdAt: now, paidAt: now, demo: true };
      a.paymentId = pay.id;
      S().appointments.push(a);
      S().payments.push(pay);
    }
    store.save();
  }

  return {
    seedDemo,
    refreshDemoDay,
    /** Le ticket d'un rendez-vous terminé met à jour le rendez-vous. */
    onTicketDone(t) {
      if (!t.rdv) return;
      const a = S().appointments.find((x) => x.id === t.rdv.appointmentId);
      if (a && a.status === 'checked_in') { a.status = t.status === 'absent' ? 'no_show' : 'done'; store.save(); }
    },
    staffFromReq(req) {
      const s = store.getSession(req);
      return s && s.kind === 'staff' ? S().staff.find((u) => u.id === s.id && u.active !== false) : null;
    },
  };
};
