# SAMA TOUR — MVP gestion des files d'attente

> *Moins d'attente. Plus de soins.* — Équipe XEL SANTE · PAS Challenge · SALTIS 2026

Ce MVP couvre le cœur de Sama Tour : **la gestion de la file d'attente** d'une structure de santé.
Le patient prend un ticket (sur place ou depuis chez lui), suit sa position en temps réel, et il est prévenu
quand partir de chez lui, quand son tour approche et quand c'est son tour.

## Les 3 écrans

| Écran | Adresse | Pour qui |
|---|---|---|
| **Prendre un ticket / suivre son ticket** | `/` puis `/t/<code>` | Patient, sur son téléphone (rien à installer) |
| **Console agent / médecin** | `/agent` (PIN démo : `1234`) | Accueil, infirmier, médecin |
| **Écran salle d'attente** | `/ecran` | Une TV ou un vieux PC branché dans la salle |

### Fonctionnalités
- **Référentiel de 89 services** couvrant la pyramide sanitaire sénégalaise, du poste de santé aux hôpitaux nationaux (type Fann, Hôpital Principal, Le Dantec, Dalal Jamm), en 14 catégories :
  accueil et administratif (caisse, CMU / mutuelles / IPM, admissions, service social), urgences, consultations générales, mère et enfant,
  spécialités médicales, chirurgie, yeux / oreilles / dents, santé mentale, rééducation et appareillage, laboratoire et sang,
  imagerie, examens spécialisés, programmes de santé publique (VIH, tuberculose, malnutrition…), pharmacie et retrait des résultats.
- **Type de structure en un clic** (onglet **Services**) : poste de santé (11 services), centre de santé (29), hôpital régional ou départemental (58), hôpital national / CHU (89).
  Chaque service indique le niveau à partir duquel on le trouve habituellement. On ajuste ensuite service par service, ou catégorie par catégorie.
- Le patient trouve son service via **« Les plus demandés »**, les **tuiles de catégories**, ou une **recherche avec des mots simples** (« dent », « rein », « vaccin », « prise de sang », « enceinte », « mutuelle »…).
  Pour les urgences, un message rappelle qu'une urgence grave doit se présenter directement, sans ticket.
- **Catalogue modifiable sans toucher au code** (console agent, onglet **Services**) : ajouter un service, le renommer, changer son bureau ou sa durée moyenne, et l'activer ou le désactiver pour la journée (par exemple quand le spécialiste n'est pas là).
  ⚠️ Le référentiel a été établi à partir de l'organisation habituelle des structures sénégalaises, **pas d'une liste officielle** de chaque hôpital. Faites-le valider par la structure pilote. La liste se modifie dans `config.json` ou directement dans la console.
- Ticket numérique par service (`MG-012`, `DEN-004`…), **sans compte et sans donnée médicale**.
- Position et **temps d'attente estimé** en direct. L'estimation apprend des vraies durées de consultation du jour.
- **« Partez maintenant »** : le patient à la maison indique son temps de trajet ; il est prévenu quand l'attente restante rejoint ce trajet (+10 min de marge).
- **« Votre tour approche »** quand il reste 2 patients avant lui, puis **« C'est votre tour, Bureau X »**.
- Alertes par **SMS** (simulés par défaut, API Orange prête à brancher) **et** sur la page du téléphone (son, vibration, notification).
- **Patients prioritaires** (femmes enceintes, personnes âgées, handicap, urgence), servis en premier.
- **Patient sans smartphone** : l'accueil crée le ticket, l'imprime avec un QR code ou le note à la main.
- Gestion des **absents** : « Absent · suivant », puis « Remettre en file » s'il revient.
- **Écran de salle** : numéro appelé en grand, annonce sonore et vocale en français, QR code pour prendre un ticket.
  Il affiche les services qui ont des patients et fait défiler les pages (6 services par page) quand il y en a beaucoup.
  **Un écran par zone** : `/ecran?categorie=Mère et enfant` ou `/ecran?services=MG,PED`. Chaque écran n'annonce alors que les tickets de sa zone. Les liens sont aussi dans l'onglet **Services**.
- **Statistiques** du jour : attente moyenne et maximale, durée des consultations, taux d'absence, part des patients ayant attendu chez eux, satisfaction (note sur 5 après la consultation).
- **Export CSV anonymisé** (sans nom ni téléphone) pour la direction et pour le rapport du pilote.
- Nouvelle journée automatique à minuit, avec archivage de la veille dans `data/archive/`.

## Lancer l'application

Prérequis : [Node.js](https://nodejs.org) version 18 ou plus récente. **Aucune autre installation** (`npm install` n'est pas nécessaire).

Sous Windows, double-cliquez sur **`demarrer.bat`**, ou bien :

```bash
cd samatour
node server.js
```

Le serveur affiche les adresses à utiliser, par exemple :

```
Patient (prendre un ticket) : http://192.168.1.18:3000/
Console agent / médecin     : http://192.168.1.18:3000/agent   (PIN : 1234)
Écran salle d'attente       : http://192.168.1.18:3000/ecran
```

**Pour que les téléphones puissent se connecter** (démo devant le jury), le PC et les téléphones doivent être sur
le **même Wi-Fi** (ou le partage de connexion d'un téléphone). Au premier lancement, Windows demande d'autoriser
Node.js sur le réseau : cochez **« Réseaux privés »** et acceptez.

### Réglages (`config.json`)
- `facilityName` : nom de la structure affiché partout.
- `services` : catalogue **de départ** (code, catégorie, nom, bureau, durée moyenne, mots-clés de recherche).
  Ensuite, les changements se font dans la console (onglet **Services**) et sont enregistrés dans `data/services.json`.
  Un service ajouté plus tard dans `config.json` apparaît automatiquement au prochain démarrage.
- `agentPin` : code PIN de la console (peut aussi être donné par la variable d'environnement `SAMATOUR_PIN`).
- `approachThreshold` : à combien de patients avant son tour on prévient « votre tour approche » (3 par défaut, soit 2 patients devant).
- `leaveMarginMinutes` : marge ajoutée au trajet pour « partez maintenant » (10 min).

Variables d'environnement facultatives : `PORT` (3000 par défaut) et `PUBLIC_URL` (adresse publique si l'application est hébergée en ligne).

### Activer les vrais SMS (Orange Sénégal)
Créez une application sur Orange Developer (offre SMS Sénégal), puis lancez le serveur avec
`ORANGE_CLIENT_ID`, `ORANGE_CLIENT_SECRET` et `ORANGE_SENDER` (votre numéro expéditeur, au format `+221…`).
Voir `lib/sms.js`. Cette intégration est écrite mais **pas encore testée avec un vrai compte** : à valider pendant le pilote.

## Scénario de démo pour le jury (5 minutes)

1. Avant de passer : ouvrez `/agent`, onglet **Statistiques**, cliquez sur **« Charger des données de démonstration »**. La file contient alors des patients et des statistiques réalistes.
2. Affichez **`/ecran`** sur le vidéoprojecteur et cliquez sur « Démarrer l'écran avec le son ».
3. **Invitez le jury à scanner le QR code** de l'écran et à prendre un ticket, par exemple en Pédiatrie. Chacun voit sa position et son temps d'attente sur son téléphone.
4. Sur la console agent (sur un autre PC ou une tablette), cliquez sur **« Terminé · appeler le suivant »** plusieurs fois :
   - l'écran affiche le numéro en grand et l'annonce à voix haute ;
   - les positions avancent en direct sur les téléphones du jury ;
   - « Votre tour approche », puis « C'est votre tour ! » s'affichent.
5. Montrez un patient **prioritaire** (bouton ☆) qui passe devant, et un ticket **imprimé à l'accueil** pour un patient sans smartphone.
6. Terminez sur l'onglet **Statistiques** : attente moyenne, taux d'absence, part des patients qui ont attendu chez eux. Ce sont les indicateurs que vous mesurerez pendant le pilote.

## Architecture

```
samatour/
├── server.js          Serveur HTTP + API + temps réel (Server-Sent Events), sans dépendance
├── config.json        Structure, services, PIN, seuils
├── lib/sms.js         Envoi des SMS (simulation, ou API Orange)
├── public/            Pages web (application installable sur téléphone : PWA)
│   ├── index.html     Prise de ticket
│   ├── ticket.html    Suivi du ticket
│   ├── agent.html     Console agent / médecin + statistiques
│   ├── ecran.html     Écran de la salle d'attente
│   └── app.js, style.css, sw.js, manifest.webmanifest, icon.svg
└── data/              Créé automatiquement : db.json (journée en cours) et archive/
```

Le seul élément chargé depuis Internet est la bibliothèque de QR codes (cdnjs). Sans Internet, l'adresse s'affiche en texte à la place du QR code. Tout le reste fonctionne sur le réseau local.

## Limites actuelles et prochaines étapes

**Avant le pilote**
- Hébergement en ligne (Render, Railway, VPS…) avec HTTPS. Les notifications du téléphone exigent HTTPS en dehors du réseau local.
- Un compte par agent au lieu d'un PIN partagé, et un journal des actions.
- Tester les vrais SMS (Orange) et estimer leur coût par patient.
- Plusieurs médecins par service (plusieurs bureaux qui appellent dans la même file).
- Base de données (SQLite ou PostgreSQL) à la place du fichier JSON si la fréquentation dépasse quelques centaines de patients par jour.

**Après le pilote** (feuille de route du pitch)
- Prise de rendez-vous à l'avance, avec des créneaux.
- Annonces vocales en wolof (fichiers audio enregistrés).
- Suivi par WhatsApp.
- Carte numérique de santé, rappels thérapeutiques, assistant conversationnel. Ces modules manipulent des données de santé et demandent une déclaration à la CDP (loi sénégalaise 2008-12 sur les données personnelles) et un hébergement conforme.

## Données personnelles
Le MVP ne collecte **que** le prénom (facultatif) et le téléphone (facultatif), jamais de donnée médicale.
L'export CSV et les statistiques sont anonymes. Les tickets sont archivés chaque jour dans `data/archive/` : prévoyez
une durée de conservation (par exemple 30 jours) et une mention d'information affichée à l'accueil pendant le pilote.
