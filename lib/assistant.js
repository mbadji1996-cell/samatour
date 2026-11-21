'use strict';
/*
 * Assistant conversationnel de SAMA TOUR.
 *
 * Deux modes :
 *   - « claude » : réponses rédigées par Claude (SDK officiel Anthropic) quand une clé est configurée
 *     (variable d'environnement ANTHROPIC_API_KEY). L'assistant reçoit, à chaque question, les données
 *     réelles de l'application : services, attente du moment, tarifs, et les rendez-vous du patient connecté.
 *   - « base » : sans clé, un assistant à règles répond aux questions courantes (trouver un service,
 *     attente, rendez-vous, paiement, carte de santé, urgences). La démonstration fonctionne donc toujours.
 *
 * Garde-fous (dans les deux modes) : pas de diagnostic ni de prescription, orientation immédiate
 * vers les urgences (SAMU 1515) devant un signe de gravité, pas de collecte de données de santé dans le chat.
 */

let Anthropic = null;
try {
  Anthropic = require('@anthropic-ai/sdk');
  Anthropic = Anthropic.default || Anthropic;
} catch {
  // SDK absent (npm install pas lancé) : l'assistant reste en mode de base.
}

const MODEL = process.env.ASSISTANT_MODEL || 'claude-opus-5-5';
const hasKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const mode = Anthropic && hasKey ? 'claude' : 'base';
const client = mode === 'claude' ? new Anthropic() : null;

const EMERGENCY = 'En cas d\'urgence grave, appelez le **SAMU au 1515** ou rendez-vous immédiatement aux urgences les plus proches, sans attendre de ticket.';

// Consignes stables (mises en cache côté API) : rôle, ton, limites.
const SYSTEM = `Tu es l'assistant de SAMA TOUR, une application qui aide les patients au Sénégal à s'orienter dans les structures de santé : prendre un ticket et suivre la file d'attente à distance, prendre rendez-vous et payer (Wave, Orange Money, Free Money, carte, ou sur place), consulter sa carte de santé numérique et son dossier.

Ton rôle :
- Orienter le patient vers le bon service à partir de ce qu'il décrit, en t'appuyant uniquement sur la liste des services et les données fournies dans le message système « Données de l'application ».
- Expliquer comment utiliser l'application (ticket, rendez-vous, paiement, annulation et remboursement jusqu'à 2 h avant, « Je suis arrivé(e) » le jour J, carte de santé, code de partage du dossier).
- Donner l'attente estimée et le tarif d'un service quand ils figurent dans les données.

Règles de sécurité, à respecter sans exception :
- Tu n'es pas médecin : ne pose pas de diagnostic, ne propose ni médicament, ni dose, ni changement de traitement. Pour toute question médicale, oriente vers une consultation.
- Si la personne décrit un signe de gravité (douleur dans la poitrine, difficulté à respirer, perte de connaissance, convulsions, saignement important, signes d'AVC comme une bouche déviée ou un bras qui ne répond plus, forte fièvre chez un nourrisson, femme enceinte qui saigne ou perd les eaux, idées suicidaires), commence ta réponse par : « ${EMERGENCY} »
- Ne demande jamais de données de santé détaillées, de mot de passe, de code secret ou de code de partage dans la conversation.
- N'invente jamais un service, un tarif, une attente ou un rendez-vous absent des données.

Style :
- Réponds en français simple, chaleureux et bref (5 phrases au maximum). Si l'on te salue en wolof, réponds d'abord par une courte salutation en wolof puis continue en français.
- Quand c'est utile, termine par un lien Markdown vers la bonne page : [Prendre un ticket](/), [Prendre un rendez-vous](/patient#rdv), [Ma carte de santé](/patient#card), [Mon dossier](/patient#dossier).
- N'utilise ni titres ni tableaux ; du gras avec **…** au besoin.`;

// ------------------------------------------------------------------------------------------------
// Données de l'application transmises à l'assistant
// ------------------------------------------------------------------------------------------------

/** Contexte : services actifs (attente et tarif) + rendez-vous du patient connecté. */
function buildContext({ services, patient, now = new Date() }) {
  const lines = services.map((s) =>
    `${s.id} | ${s.name} | ${s.category} | ${s.room} | ${s.waiting} en attente, attente ≈ ${s.estimateNewMin} min | ` +
    `${s.rdvEnabled ? `RDV en ligne ${s.price ? s.price + ' FCFA' : 'gratuit'}` : 'sans RDV'} | mots-clés : ${s.keywords || '—'}`);
  let ctx = `Données de l'application (à jour au ${now.toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' })}) :\n` +
    `Services ouverts (code | nom | catégorie | salle | file d'attente | rendez-vous | mots-clés) :\n${lines.join('\n')}`;
  if (patient) {
    const rdv = patient.appointments.filter((a) => ['confirmed', 'pending_payment', 'checked_in'].includes(a.status));
    ctx += `\n\nPatient connecté : ${patient.firstName}. ` + (rdv.length
      ? 'Ses rendez-vous à venir : ' + rdv.map((a) => `${a.serviceName} le ${a.date} à ${a.time} (${a.status === 'pending_payment' ? 'paiement en attente' : a.status === 'checked_in' ? 'arrivé, en file' : 'confirmé'})`).join(' ; ') + '.'
      : 'Aucun rendez-vous à venir.');
  } else {
    ctx += '\n\nLa personne n\'est pas connectée à son espace patient.';
  }
  return ctx;
}

// ------------------------------------------------------------------------------------------------
// Mode « claude »
// ------------------------------------------------------------------------------------------------

async function askClaude(history, context) {
  // Les 12 derniers échanges suffisent ; le premier message doit venir de l'utilisateur.
  const msgs = history.slice(-12);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000, // réponses volontairement courtes (chat)
    // Pour une conversation, un effort faible suffit et répond plus vite.
    output_config: { effort: 'low' },
    // Si un filtre de sécurité refuse la demande, l'API la relance sur un autre modèle (choix automatique).
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      ...msgs.map((m) => ({ role: m.role, content: m.content })),
      // Données du moment : message système placé après la dernière question (ne casse pas le cache).
      { role: 'system', content: context },
    ],
  });
  if (response.stop_reason === 'refusal') {
    return 'Je ne peux pas répondre à cette demande. Pour toute question médicale, consultez un soignant. ' + EMERGENCY;
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return text || 'Je n\'ai pas compris, pouvez-vous reformuler ?';
}

// ------------------------------------------------------------------------------------------------
// Mode « base » (sans clé) : règles simples sur les données réelles
// ------------------------------------------------------------------------------------------------

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const has = (t, words) => words.some((w) => t.includes(w));

const RED_FLAGS = ['douleur poitrine', 'mal a la poitrine', 'douleur thoracique', 'respire mal', 'respirer', 'etouffe', 'inconscient',
  'perte de connaissance', 'evanoui', 'convulsion', 'saigne beaucoup', 'hemorragie', 'beaucoup de sang', 'avc', 'paralys', 'bouche deviee',
  'perd les eaux', 'enceinte et saigne', 'suicide', 'me tuer', 'en finir', 'empoisonn', 'brule grave', 'accident grave'];

const STOP = new Set(['pour', 'avec', 'dans', 'depuis', 'hier', 'aujourd', 'demain', 'matin', 'soir', 'mais', 'plus', 'tres', 'beaucoup',
  'rendez', 'vous', 'ticket', 'service', 'attente', 'combien', 'temps', 'prendre', 'faire', 'avoir', 'besoin', 'veux', 'voudrais',
  'comment', 'quel', 'quelle', 'quels', 'bonjour', 'bonsoir', 'nanga', 'salam', 'merci', 'aide', 'aider', 'peux', 'puis', 'suis',
  'avoir', 'fait', 'mal', 'douleur', 'douleurs', 'probleme', 'souci', 'consulter', 'consultation', 'voir', 'medecin', 'docteur']);
const tokens = (s) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);

/** Services dont le nom ou les mots-clés contiennent les mots de la question (mots entiers ou même racine). */
function findServices(t, services) {
  // Quelques formes courantes ramenées au mot-clé du référentiel.
  const SYN = { tousse: 'toux', tousser: 'toux', toussez: 'toux', oreilles: 'oreille', grossesse: 'grossesse', accoucher: 'accouchement', vaccins: 'vaccin', vacciner: 'vaccin', enceinte: 'enceinte', diabetique: 'diabete', lunette: 'lunettes', cassee: 'fracture', casse: 'fracture' };
  const words = tokens(t).map((w) => SYN[w] || w).filter((w) => w.length >= 4 && !STOP.has(w));
  if (!words.length) return [];
  const match = (w, hay) => hay.some((h) => h === w || (h.length >= 4 && w.length >= 4 && (h.startsWith(w) || w.startsWith(h)) && Math.min(h.length, w.length) >= 4));
  const scored = services.map((s) => {
    const name = tokens(s.name), keys = tokens(s.keywords);
    let score = 0;
    for (const w of words) {
      if (match(w, name)) score += 3;
      else if (match(w, keys)) score += 2;
    }
    return { s, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  // On ne garde que les meilleurs résultats (pas de services faiblement liés).
  const best = scored[0].score;
  return scored.filter((x) => x.score >= Math.max(2, best - 1)).slice(0, 3).map((x) => x.s);
}

function serviceLine(s) {
  const wait = s.waiting ? `${s.waiting} personne${s.waiting > 1 ? 's' : ''} en attente (≈ ${s.estimateNewMin} min)` : 'personne en attente en ce moment';
  const rdv = s.rdvEnabled ? `, rendez-vous en ligne ${s.price ? s.price.toLocaleString('fr-FR') + ' FCFA' : 'gratuit'}` : '';
  return `**${s.name}** (${s.room}) : ${wait}${rdv}.`;
}

function askBase(history, { services, patient }) {
  const last = [...history].reverse().find((m) => m.role === 'user');
  const t = norm(last ? last.content : '');

  if (has(t, RED_FLAGS)) {
    return `${EMERGENCY}\n\nSi la situation n'est pas grave, je peux vous aider à trouver le bon service : décrivez-moi simplement ce qui vous amène.`;
  }
  if (has(t, ['diagnostic', 'quel medicament', 'quel traitement', 'posologie', 'combien de comprime', 'dose', 'antibiotique', 'est ce grave'])) {
    return 'Je ne peux pas donner d\'avis médical, de diagnostic ou de traitement : seul un soignant peut le faire après vous avoir examiné. Je peux en revanche vous orienter vers le bon service et vous aider à prendre rendez-vous. ' +
      'Que ressentez-vous, en quelques mots ? [Prendre un rendez-vous](/patient#rdv)';
  }

  const found = findServices(t, services);
  const greet = has(t, ['nanga def', 'salam', 'assalamou', 'jamm nga']) ? 'Jamm rek ! ' : has(t, ['bonjour', 'bonsoir', 'salut', 'hello']) ? 'Bonjour ! ' : '';

  if (has(t, ['annul', 'rembours'])) {
    return 'Vous pouvez annuler un rendez-vous jusqu\'à **2 h avant** depuis votre espace, onglet Rendez-vous : le remboursement est automatique sur le moyen de paiement utilisé. Pour un ticket sans rendez-vous, touchez « Je ne viens plus » sur la page du ticket. [Mes rendez-vous](/patient#rdv)';
  }
  const priceQuestion = has(t, ['prix', 'tarif', 'cout', 'combien ca coute', 'combien coute']);
  if (has(t, ['payer', 'paiement', 'wave', 'orange money', 'free money', 'carte bancaire', 'mobile money']) || (priceQuestion && !found.length)) {
    return 'Le paiement se fait au moment de la réservation : **Wave, Orange Money, Free Money, carte bancaire**, ou sur place à la caisse. Certains services sont gratuits (vaccination, CPN, planification familiale…). Vous recevez la confirmation par SMS. Dites-moi le service qui vous intéresse et je vous donne son tarif. [Prendre un rendez-vous](/patient#rdv)';
  }
  if (has(t, ['carte', 'dossier', 'code de partage', 'qr'])) {
    return 'Votre **carte de santé numérique** est dans votre espace : groupe sanguin, allergies, personne à prévenir et un QR code. Le soignant la scanne pour ouvrir votre dossier ; donnez-lui votre code de partage si vous n\'avez pas rendez-vous dans son service. Vous voyez dans votre dossier qui l\'a consulté. [Ma carte de santé](/patient#card)';
  }
  if (has(t, ['arrive', 'je suis la', 'sur place']) && patient) {
    return 'Le jour de votre rendez-vous, ouvrez l\'onglet Rendez-vous et touchez **« Je suis arrivé(e) »** : vous entrez dans la file à l\'heure de votre rendez-vous. C\'est possible de 2 h avant à 1 h 30 après l\'heure prévue. [Mes rendez-vous](/patient#rdv)';
  }
  if (has(t, ['mon rendez', 'mes rendez', 'mon rdv', 'mes rdv']) && patient) {
    const rdv = patient.appointments.filter((a) => ['confirmed', 'pending_payment', 'checked_in'].includes(a.status));
    return rdv.length
      ? `${patient.firstName}, vos prochains rendez-vous : ` + rdv.map((a) => `**${a.serviceName}** le ${new Date(a.date + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${a.time}`).join(' ; ') + '. [Mes rendez-vous](/patient#rdv)'
      : `${patient.firstName}, vous n'avez pas de rendez-vous à venir. [Prendre un rendez-vous](/patient#rdv)`;
  }
  if (found.length) {
    const intro = found.length === 1 ? 'Voici le service qui correspond :' : 'Voici les services qui peuvent correspondre :';
    const book = found.some((s) => s.rdvEnabled) ? ' · [Prendre un rendez-vous](/patient#rdv)' : '';
    return `${greet}${intro}\n${found.map((s) => '• ' + serviceLine(s)).join('\n')}\nVous pouvez prendre un ticket maintenant et attendre chez vous : l'application vous dira quand partir. [Prendre un ticket](/)${book}`;
  }
  if (has(t, ['rendez', 'rdv', 'reserver'])) {
    return `${greet}Pour prendre rendez-vous : ouvrez votre espace, touchez « Prendre un rendez-vous », choisissez le service, la date, l'heure, puis payez. Vous recevez la confirmation par SMS. Quel service cherchez-vous ? [Prendre un rendez-vous](/patient#rdv)`;
  }
  if (has(t, ['ticket', 'file', 'attente', 'mon tour', 'quand partir'])) {
    return `${greet}Prenez un ticket depuis la page d'accueil, même depuis chez vous : vous suivez votre position en direct et l'application vous prévient quand partir, puis quand votre tour approche. Pour quel service ? [Prendre un ticket](/)`;
  }
  return `${greet}Je suis l'assistant de Sama Tour. Je peux vous aider à **trouver le bon service**, connaître **l'attente** du moment, **prendre rendez-vous et payer**, ou utiliser votre **carte de santé**. Dites-moi par exemple « j'ai mal aux dents » ou « vaccin pour mon bébé ».`;
}

// ------------------------------------------------------------------------------------------------

async function reply({ history, services, patient }) {
  const clean = (history || [])
    .filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }))
    .slice(-12);
  if (!clean.length || clean[clean.length - 1].role !== 'user') throw Object.assign(new Error('Message vide'), { status: 400 });
  if (mode === 'claude') {
    try {
      return { reply: await askClaude(clean, buildContext({ services, patient })), mode };
    } catch (err) {
      // Incident côté API (clé invalide, quota, réseau) : on répond quand même avec le mode de base.
      const label = Anthropic && err instanceof Anthropic.APIError ? `API ${err.status}` : err.message;
      console.error('[assistant] repli sur le mode de base :', label);
      return { reply: askBase(clean, { services, patient }), mode: 'base', degraded: true };
    }
  }
  return { reply: askBase(clean, { services, patient }), mode };
}

module.exports = { reply, mode, model: MODEL, buildContext };
