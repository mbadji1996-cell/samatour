'use strict';
/*
 * Adaptateur SMS de SAMA TOUR.
 *
 * Par défaut : mode SIMULATION. Les SMS ne sont pas envoyés, ils sont seulement
 * affichés dans la console du serveur et dans la console agent (onglet Statistiques).
 *
 * Pour envoyer de vrais SMS via l'API SMS d'Orange (Sénégal), définir :
 *   ORANGE_CLIENT_ID, ORANGE_CLIENT_SECRET  (identifiants de l'application Orange Developer)
 *   ORANGE_SENDER                           (numéro expéditeur, ex. +2217XXXXXXXX)
 * Cette intégration n'a pas encore été testée avec un vrai compte : à valider pendant le pilote.
 */

const ORANGE = {
  id: process.env.ORANGE_CLIENT_ID,
  secret: process.env.ORANGE_CLIENT_SECRET,
  sender: process.env.ORANGE_SENDER,
};

const mode = ORANGE.id && ORANGE.secret && ORANGE.sender ? 'orange' : 'simulation';

/** Normalise un numéro sénégalais : "77 123 45 67" -> "+221771234567". */
function normalizePhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = '+' + digits.slice(2);
  if (/^\d{9}$/.test(digits)) digits = '+221' + digits;
  if (/^221\d{9}$/.test(digits)) digits = '+' + digits;
  return /^\+\d{8,15}$/.test(digits) ? digits : '';
}

let tokenCache = { value: null, expires: 0 };

async function orangeToken() {
  if (tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;
  const res = await fetch('https://api.orange.com/oauth/v3/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${ORANGE.id}:${ORANGE.secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('Orange OAuth ' + res.status);
  const json = await res.json();
  tokenCache = { value: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 };
  return tokenCache.value;
}

async function sendOrange(to, text) {
  const token = await orangeToken();
  const sender = encodeURIComponent('tel:' + ORANGE.sender);
  const res = await fetch(`https://api.orange.com/smsmessaging/v1/outbound/${sender}/requests`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      outboundSMSMessageRequest: {
        address: 'tel:' + to,
        senderAddress: 'tel:' + ORANGE.sender,
        outboundSMSTextMessage: { message: text },
      },
    }),
  });
  if (!res.ok) throw new Error('Orange SMS ' + res.status);
}

/** Envoie un SMS. Renvoie le statut : "simulé", "envoyé" ou "échec". */
async function send(to, text) {
  if (mode === 'simulation') {
    console.log(`[SMS simulé] -> ${to} : ${text}`);
    return 'simulé';
  }
  try {
    await sendOrange(to, text);
    return 'envoyé';
  } catch (err) {
    console.error('[SMS] échec :', err.message);
    return 'échec';
  }
}

module.exports = { send, normalizePhone, mode };
