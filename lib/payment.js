'use strict';
/*
 * Paiement des rendez-vous.
 *
 * Mode par défaut : SIMULATION. Le paiement est créé « en attente » ; le patient le valide
 * sur un écran qui imite la confirmation mobile money. Aucun argent ne circule.
 *
 * Mode Wave (Sénégal) : définir WAVE_API_KEY. Le patient est redirigé vers la page de paiement
 * Wave (wave_launch_url), puis le statut est vérifié auprès de Wave.
 * Cette intégration suit l'API Checkout de Wave mais n'a PAS encore été testée avec un compte marchand :
 * à valider pendant le pilote. Orange Money / Free Money peuvent passer par un agrégateur
 * (PayDunya, PayTech…) sur le même modèle.
 */

const WAVE_KEY = process.env.WAVE_API_KEY;
const mode = WAVE_KEY ? 'wave' : 'simulation';

const METHODS = {
  wave: 'Wave',
  orange_money: 'Orange Money',
  free_money: 'Free Money',
  carte: 'Carte bancaire',
  sur_place: 'Paiement sur place',
};

/** Démarre un paiement. Renvoie { status, providerRef?, redirectUrl? }. */
async function start(payment, { successUrl, errorUrl }) {
  if (payment.method === 'sur_place') return { status: 'on_site' };
  if (mode === 'simulation' || payment.method !== 'wave') {
    return { status: 'pending', providerRef: 'SIM-' + payment.id.slice(-8).toUpperCase() };
  }
  const res = await fetch('https://api.wave.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + WAVE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: String(payment.amount),
      currency: 'XOF',
      client_reference: payment.id,
      success_url: successUrl,
      error_url: errorUrl,
    }),
  });
  if (!res.ok) throw new Error('Wave : création du paiement impossible (' + res.status + ')');
  const json = await res.json();
  return { status: 'pending', providerRef: json.id, redirectUrl: json.wave_launch_url };
}

/** Interroge le prestataire pour un paiement en attente. Renvoie 'paid', 'failed' ou 'pending'. */
async function check(payment) {
  if (mode !== 'wave' || payment.method !== 'wave' || !payment.providerRef) return payment.status;
  const res = await fetch('https://api.wave.com/v1/checkout/sessions/' + encodeURIComponent(payment.providerRef), {
    headers: { Authorization: 'Bearer ' + WAVE_KEY },
  });
  if (!res.ok) return 'pending';
  const json = await res.json();
  if (json.payment_status === 'succeeded') return 'paid';
  if (json.checkout_status === 'expired' || json.payment_status === 'cancelled') return 'failed';
  return 'pending';
}

module.exports = { mode, METHODS, start, check };
