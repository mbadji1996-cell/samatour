'use strict';
/*
 * SAMA TOUR — simulation d'une matinée de consultation (méthode de Monte-Carlo).
 *
 * But : mesurer, avant le pilote, ce que change Sama Tour pour une file d'attente typique.
 *   Scénario A (aujourd'hui) : chaque patient attend sur place, du moment où il arrive jusqu'à son appel.
 *   Scénario B (Sama Tour)   : même file, mais les patients équipés d'un téléphone peuvent attendre chez eux
 *                              et partent quand l'application l'indique (règle « partez maintenant » du MVP).
 *
 * L'estimateur de temps d'attente et la règle de départ sont exactement ceux de server.js.
 * Toutes les hypothèses sont regroupées dans HYP ; elles sont à remplacer par les mesures du pilote.
 *
 * Utilisation : node analyse/simulation.js   (résultats dans analyse/resultats.json et analyse/figures/)
 */
const fs = require('fs');
const path = require('path');

const HYP = {
  jours: 1000, // nombre de matinées simulées
  patients: [30, 40], // patients par matinée et par médecin (min, max)
  ouvertureMin: 120, // le médecin commence à 8 h (t = 0 à 6 h)
  partAube: 0.55, // part des patients qui arrivent entre 6 h et 7 h 45 (« dès l'aube »)
  consultMoy: 10, // durée moyenne d'une consultation (min)
  consultEcart: 4, // écart-type (min)
  dureeParDefaut: 10, // durée par défaut configurée dans le service (comme dans config.json)
  partTelephone: 0.7, // part des patients qui ont un téléphone et reçoivent les alertes
  partChoisitMaison: 0.8, // parmi eux, part qui choisit d'attendre chez soi
  trajet: [10, 60], // temps de trajet annoncé (min)
  aleaTrajet: 0.25, // variabilité réelle du trajet (embouteillages) : écart-type log-normal
  marge: 15, // marge ajoutée au trajet pour « partez maintenant » (leaveMarginMinutes, fixée à 15 min d'après cette simulation)
  attenteAvantAbsent: 2, // le médecin attend 2 min avant de déclarer un patient absent
  estimateurOuverture: true, // l'estimation tient compte de l'heure d'ouverture (false = première version du MVP)
};

// --- Générateur aléatoire reproductible (mulberry32) --------------------------------------
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uni = (r, a, b) => a + (b - a) * r();
function normal(r) {
  const u = 1 - r(), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function lognormalMoy(r, moy, ecart) {
  const s2 = Math.log(1 + (ecart * ecart) / (moy * moy));
  return Math.exp(Math.log(moy) - s2 / 2 + Math.sqrt(s2) * normal(r));
}

// --- Estimateur du MVP (copie conforme de avgMinutes / positionInfo dans server.js) ----------
function moyenneLissee(durees, def) {
  const dix = durees.slice(-10);
  return (def * 2 + dix.reduce((a, b) => a + b, 0)) / (2 + dix.length);
}
// + temps restant avant l'ouverture du service (ajouté au MVP après une première simulation, voir le document technique)
const estimation = (devant, occupe, moy, avantOuverture = 0) => Math.ceil(avantOuverture + (devant + (occupe ? 0.5 : 0)) * moy);

// --- Une matinée ---------------------------------------------------------------------------
function genererMatinee(r, h) {
  const n = Math.round(uni(r, h.patients[0], h.patients[1]));
  const patients = [];
  for (let i = 0; i < n; i++) {
    const ticket = r() < h.partAube ? uni(r, 0, 105) : uni(r, 105, 300);
    const telephone = r() < h.partTelephone;
    patients.push({
      ticket,
      maison: telephone && r() < h.partChoisitMaison,
      trajet: Math.round(uni(r, h.trajet[0], h.trajet[1])),
      alea: Math.exp(h.aleaTrajet * normal(r)),
      duree: Math.max(3, lognormalMoy(r, h.consultMoy, h.consultEcart)),
    });
  }
  return patients.sort((a, b) => a.ticket - b.ticket);
}

/**
 * Simule une matinée. avecSamaTour = false : tout le monde attend sur place dès son ticket.
 * Renvoie, pour chaque patient : heure d'arrivée sur place, heure d'appel, estimation initiale, absent ou non.
 */
function simuler(patientsSource, h, avecSamaTour) {
  const P = patientsSource.map((p, id) => ({
    ...p, id,
    maisonPossible: p.maison,
    maison: avecSamaTour && p.maison,
    arrivee: avecSamaTour && p.maison ? null : p.ticket, // null = pas encore parti de chez lui
    appel: null, absent: false, estInit: null, estDepart: null,
  }));
  let t = 0;
  let medecinLibre = h.ouvertureMin;
  let occupe = false;
  const durees = [];
  const file = []; // ordre de passage (FIFO, les absents revenus repassent en tête)
  let prochainTicket = 0;
  const pasDeTemps = 1; // pas de 1 minute

  function devant(p) { return file.indexOf(p); }
  function estimer(p) {
    const avantOuverture = h.estimateurOuverture ? Math.max(0, h.ouvertureMin - t) : 0;
    return estimation(devant(p), occupe, moyenneLissee(durees, h.dureeParDefaut), avantOuverture);
  }

  function verifierDeparts() {
    for (const p of file) {
      if (p.maison && p.arrivee === null && p.depart === undefined) {
        const e = estimer(p);
        if (e <= p.trajet + h.marge) {
          p.depart = t;
          p.estDepart = e;
          p.arriveePrevue = t + p.trajet * p.alea;
        }
      }
    }
  }

  let attenteHead = 0;
  let enConsultationJusqua = -1;
  const occupationSalle = new Array(Math.ceil(600 / pasDeTemps)).fill(0);

  for (t = 0; t < 600; t += pasDeTemps) {
    // nouveaux tickets
    while (prochainTicket < P.length && P[prochainTicket].ticket <= t) {
      const p = P[prochainTicket++];
      file.push(p);
      p.estInit = estimer(p);
    }
    // arrivées des patients partis de chez eux
    for (const p of P) {
      if (p.arrivee === null && p.depart !== undefined && p.arriveePrevue <= t) {
        p.arrivee = p.arriveePrevue;
        if (p.absent && p.appel === null) {
          // absent revenu : l'agent le remet en tête de file
          p.absent = false;
          p.reintegre = true;
          file.unshift(p);
        }
      }
    }
    occupe = t < enConsultationJusqua;
    verifierDeparts();

    // le médecin appelle
    if (t >= medecinLibre && !occupe && file.length) {
      const tete = file[0];
      if (tete.arrivee !== null && tete.arrivee <= t) {
        file.shift();
        tete.appel = t;
        enConsultationJusqua = t + tete.duree;
        medecinLibre = enConsultationJusqua;
        durees.push(tete.duree);
        attenteHead = 0;
        occupe = true;
        verifierDeparts();
      } else if (++attenteHead > h.attenteAvantAbsent) {
        // patient pas encore arrivé : déclaré absent, on passe au suivant
        file.shift();
        tete.absent = true;
        tete.nbAbsences = (tete.nbAbsences || 0) + 1;
        attenteHead = 0;
      }
    }
    // occupation de la salle d'attente : présents sur place et pas encore appelés
    occupationSalle[t / pasDeTemps] = P.filter((p) => p.arrivee !== null && p.arrivee <= t && p.appel === null).length;
    if (prochainTicket >= P.length && !file.length && P.every((p) => p.appel !== null || (p.absent && p.arrivee === null && p.depart === undefined))) break;
  }
  // Les patients restés absents et jamais revenus (cas rare) sont comptés à part.
  return { patients: P, occupationSalle };
}

// --- Statistiques --------------------------------------------------------------------------
const moy = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};
const r1 = (x) => Math.round(x * 10) / 10;

function campagne(h, graine = 2026) {
  const r = rng(graine);
  const res = { A: [], B: [], occA: new Array(600).fill(0), occB: new Array(600).fill(0), jours: 0,
    erreurInit: [], erreurDepart: [], absents: 0, patientsMaison: 0, totalPatients: 0, finA: [], finB: [], pointeA: [], pointeB: [] };
  for (let j = 0; j < h.jours; j++) {
    const m = genererMatinee(r, h);
    const A = simuler(m, h, false);
    const B = simuler(m, h, true);
    res.jours++;
    for (const p of A.patients) if (p.appel !== null) res.A.push({ surPlace: p.appel - p.arrivee, maison: p.maisonPossible });
    for (const p of B.patients) {
      if (p.appel === null) continue;
      res.B.push({ surPlace: p.appel - p.arrivee, maison: p.maison, attenteTotale: p.appel - p.ticket });
      if (p.estInit !== null) res.erreurInit.push(p.estInit - (p.appel - p.ticket));
      if (p.estDepart != null) res.erreurDepart.push(p.estDepart - (p.appel - p.depart));
    }
    res.absents += B.patients.filter((p) => p.nbAbsences).length;
    res.patientsMaison += B.patients.filter((p) => p.maison).length;
    res.totalPatients += m.length;
    A.occupationSalle.forEach((v, i) => (res.occA[i] += v));
    B.occupationSalle.forEach((v, i) => (res.occB[i] += v));
    res.pointeA.push(Math.max(...A.occupationSalle));
    res.pointeB.push(Math.max(...B.occupationSalle));
    res.finA.push(Math.max(...A.patients.map((p) => (p.appel ?? 0) + p.duree)));
    res.finB.push(Math.max(...B.patients.map((p) => (p.appel ?? 0) + p.duree)));
  }
  const sA = res.A.map((x) => x.surPlace), sB = res.B.map((x) => x.surPlace);
  const maisonA = res.A.filter((x) => x.maison).map((x) => x.surPlace);
  const maisonB = res.B.filter((x) => x.maison).map((x) => x.surPlace);
  const absErr = res.erreurInit.map(Math.abs), absDep = res.erreurDepart.map(Math.abs);
  return {
    jours: res.jours,
    patientsParMatinee: r1(res.totalPatients / res.jours),
    partAttenteMaison: r1((100 * res.patientsMaison) / res.totalPatients),
    surPlace: {
      A: { moyenne: r1(moy(sA)), mediane: r1(quantile(sA, 0.5)), p90: r1(quantile(sA, 0.9)) },
      B: { moyenne: r1(moy(sB)), mediane: r1(quantile(sB, 0.5)), p90: r1(quantile(sB, 0.9)) },
      reductionPct: r1(100 * (1 - moy(sB) / moy(sA))),
    },
    patientsMaison: {
      A: r1(moy(maisonA)), B: r1(moy(maisonB)), reductionPct: r1(100 * (1 - moy(maisonB) / moy(maisonA))),
      p90B: r1(quantile(maisonB, 0.9)),
    },
    salle: {
      pointeA: r1(moy(res.pointeA)), pointeB: r1(moy(res.pointeB)),
      reductionPct: r1(100 * (1 - moy(res.pointeB) / moy(res.pointeA))),
      courbeA: res.occA.map((v) => r1(v / res.jours)), courbeB: res.occB.map((v) => r1(v / res.jours)),
    },
    retards: { tauxAbsentPct: r1((100 * res.absents) / res.patientsMaison) },
    finMatinee: { A: r1(moy(res.finA)), B: r1(moy(res.finB)) },
    estimation: {
      erreurMoyenneAbsolueInit: r1(moy(absErr)),
      dans15minInitPct: r1((100 * absErr.filter((e) => e <= 15).length) / absErr.length),
      erreurMoyenneAbsolueDepart: r1(moy(absDep)),
      dans10minDepartPct: r1((100 * absDep.filter((e) => e <= 10).length) / absDep.length),
      biaisDepart: r1(moy(res.erreurDepart)),
    },
  };
}

// --- Exécution -----------------------------------------------------------------------------
const principal = campagne(HYP);
const versionInitiale = campagne({ ...HYP, estimateurOuverture: false, jours: 400 });
const sensibilite = [0.3, 0.5, 0.7, 0.9].map((part) => {
  const r = campagne({ ...HYP, partTelephone: part, jours: 400 });
  return { partTelephone: part * 100, reductionSurPlacePct: r.surPlace.reductionPct, reductionPointePct: r.salle.reductionPct, tauxAbsentPct: r.retards.tauxAbsentPct };
});
const margeTest = [0, 5, 10, 15, 20].map((marge) => {
  const r = campagne({ ...HYP, marge, jours: 400 });
  return { marge, attenteSurPlaceMaison: r.patientsMaison.B, tauxAbsentPct: r.retards.tauxAbsentPct };
});

const resume = (r) => ({ reductionSurPlacePct: r.surPlace.reductionPct, tauxAbsentPct: r.retards.tauxAbsentPct, estimation: r.estimation });
const out = { hypotheses: HYP, principal, versionInitiale: resume(versionInitiale), sensibilite, margeTest };
const dir = path.join(__dirname);
fs.writeFileSync(path.join(dir, 'resultats.json'), JSON.stringify(out, null, 1));

const { courbeA, courbeB, ...salleSansCourbes } = principal.salle;
console.log(JSON.stringify({ ...principal, salle: salleSansCourbes }, null, 1));
console.log('Version initiale (sans heure d’ouverture) :', JSON.stringify(resume(versionInitiale)));
console.log('Sensibilité (équipement téléphone) :', JSON.stringify(sensibilite));
console.log('Marge « partez maintenant » :', JSON.stringify(margeTest));
