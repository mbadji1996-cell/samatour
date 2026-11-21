'use strict';
/*
 * Stockage durable de SAMA TOUR (contrairement à la file d'attente, remise à zéro chaque jour) :
 * comptes patients et dossiers, personnel, rendez-vous, paiements, sessions.
 * Fichier : data/store.json (écriture atomique, différée de 150 ms).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'store.json');

function empty() {
  return { patients: [], staff: [], appointments: [], payments: [], sessions: {}, counters: { card: 0 } };
}

let data = empty();
try {
  data = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch {}

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(saveNow, 150);
}
function saveNow() {
  clearTimeout(timer);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, FILE);
}

// --- Secrets (mots de passe, codes PIN) : scrypt + sel aléatoire --------------------------------
function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(secret), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function checkSecret(secret, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(String(secret || ''), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

// --- Sessions -------------------------------------------------------------------------------
const SESSION_DAYS = 7;
function createSession(kind, id) {
  const token = crypto.randomBytes(24).toString('base64url');
  data.sessions[token] = { kind, id, exp: Date.now() + SESSION_DAYS * 864e5 };
  save();
  return token;
}
function getSession(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const s = token && data.sessions[token];
  if (!s) return null;
  if (s.exp < Date.now()) {
    delete data.sessions[token];
    save();
    return null;
  }
  return { ...s, token };
}
function endSession(token) {
  delete data.sessions[token];
  save();
}

// --- Limitation des tentatives de connexion (5 échecs = 5 min de blocage) ---------------------
const attempts = new Map();
function checkAttempts(key) {
  const a = attempts.get(key);
  if (a && a.until > Date.now()) {
    const min = Math.ceil((a.until - Date.now()) / 60000);
    const err = new Error(`Trop d'essais. Réessayez dans ${min} min.`);
    err.status = 429;
    throw err;
  }
}
function failAttempt(key) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= 5) {
    a.until = Date.now() + 5 * 60000;
    a.n = 0;
  }
  attempts.set(key, a);
}
function clearAttempts(key) {
  attempts.delete(key);
}

module.exports = {
  get data() { return data; },
  reset() { data = empty(); save(); },
  save, saveNow, hashSecret, checkSecret, newId,
  createSession, getSession, endSession,
  checkAttempts, failAttempt, clearAttempts,
};
