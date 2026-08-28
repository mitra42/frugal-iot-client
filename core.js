/*
 * Frugal IoT client - core: the MQTT connection, the topic data tree, i18n, and the element builder.
 *
 * Everything a headless consumer needs, and the only one of these modules that imports none of the
 * others - it reaches the display elements by tag name (el('mqtt-bar')), never by class, which is
 * what keeps it loadable on its own. See CARDS_PLAN.md phase 3.
 */

import async from '/node_modules/async/dist/async.mjs'; // https://caolan.github.io/async/v3/docs.html
import { parse } from "csv-parse"; // https://csv.js.org/parse/distributions/browser_esm/
import {EL, GET, HTMLElementExtended, toBool} from '/node_modules/html-element-extended/htmlelementextended.js';
import yaml from '/node_modules/js-yaml/dist/js-yaml.mjs'; // https://www.npmjs.com/package/js-yaml
import mqtt from '/node_modules/mqtt/dist/mqtt.esm.js'; // https://www.npmjs.com/package/mqtt

// Resolved against this module's URL, not the document's, so a page in a subdirectory
// (e.g. test/mock.html) still finds them - a document-relative path 404s from there.
const CssUrl = new URL('./frugaliot.css', import.meta.url).href;
const ImagesUrl = new URL('./images/', import.meta.url).href;
function XXX(args) {
  // Put a breakpoint here for debugging and intersperse XXX() in code.
  if (typeof(args) === 'string') {
    console.log(args);
  } else {
    console.log(...args);
  }
}

// Use this for things you might not want to breakpoint e.g. legacy twigs
function XXY(args) {
  if (typeof(args) === 'string') {
    console.log(args);
  } else {
    console.log(...args);
  }
  return false;
} // Put a breakpoint here for debugging and intersperse XXX() in code.

/* This is copied from the chartjs-adapter-luxon, I could not get it to import - gave me an error every time */
/*
 * chartjs-adapter-luxon v1.3.1
 * https://www.chartjs.org
 * (c) 2023 chartjs-adapter-luxon Contributors
 * Released under the MIT license
 */
let mqtt_client; // MQTT client - talking to server
let mqtt_client_username; // Organization mqtt_client was connected as, so a change of organization can be spotted
// TODO mqtt_subscriptions should be inside the MqttClient class but its non trivial as currently have no way to find that class
let mqtt_subscriptions = [];   // [{topic, cb(message)}]
let unique_id = 1; // Just used as a label for auto-generated elements
// What to assume a node's reporting interval is before it has sent a second message
const DEFAULT_REPORT_INTERVAL_MS = 300000;
// How many chips a summary line falls back to when the device does not declare its own. Enough for
// temperature + humidity + air quality + a control; a declared summary: list is not capped at all.
const SUMMARY_CHIP_LIMIT = 4;
// A label for the next auto-generated element. A function because an imported binding cannot be
// assigned to, and MqttChooseTopic lives in another module.
function nextUniqueId() { return ++unique_id; }
// Shared so MqttWrapper can extend the list without importing MqttReceiver - it does not subclass it,
// it only wants the same attributes observed.
const RECEIVER_ATTRIBUTES = ['value','color','type','label','topic','graphable','wired','wiring'];
let server_config;  // { user, organizations, logger, mqtt, server } - note loaded by MqttWrapper OR MqttAdmin

// This structure defines each of the common Input/Output types included within a sensor or acctuator
// NOTE BELOW COPIED TO SERVER config.d/schema on 20 Feb - append any changes since then

// Copy a single entry from server_config.schema.topics, or return undefined if none
function copyTopicTemplate(io_id) {
  let io;
  let dio = server_config.schema.topics[io_id];
  if (dio) {
    io = {};
    Object.entries(server_config.schema.topics[io_id]).forEach(([key, value]) => {io[key] = value});
  }
  return io;
}
// Helper function to create a new io from a server_config.schema.topics entry, with optional overrides
function expandTopicTemplate(io_id, variants) {
  let io = copyTopicTemplate(io_id);
  if (io && variants) {
    Object.entries(variants).forEach(([key, value]) => {io[key] = value});
  }
  return io;
}

/* Helpers of various kinds */

// Move to a new location by just changing one parameter in the URL
function locationParameterChange(name, value) {
  const url = new URL(window.location.href);
  url.searchParams.set(name, value); // Replace with desired param and value
  window.location = url.toString();
}
// Send client to login then back to this page
function redirectToLogin() {
  // Build login.html's URL fresh, rather than mutating a copy of the current page's URL - otherwise
  // the current page's whole query string leaks onto login.html verbatim alongside the "url" param
  // (which already carries the full target, including that same query string, back through login).
  // Carry over just "lang", so login.html itself still renders in the right language.
  const currentLang = new URL(window.location.href).searchParams.get('lang');
  const url = new URL('/dashboard/login.html', window.location.origin);
  if (currentLang) { url.searchParams.set('lang', currentLang); }
  url.searchParams.set("url", window.location.href); // Come back to same place after login
  window.location = url.toString();
}
// Remove v if present, then unshift to front
/* UNUSED
function unshiftUnique(arr, v) {
  const idx = arr.indexOf(v);
  if (idx !== -1) arr.splice(idx, 1);
  arr.unshift(v);
  return arr;
}
 */

// Subscribe to a topic (no wild cards as topic not passed to cb)
function mqtt_subscribe(topic, cb) { // cb(message)
  console.log("Subscribing to ", topic);
  mqtt_subscriptions.push({topic, cb});
  // There may be no client yet - it only connects once it knows which organization's credentials to use
  if (mqtt_client && mqtt_client.connected) {
    mqtt_client.subscribe(topic, (err) => {
      if (err) console.error(err);
    })
  } else {
    console.log("Delaying till connected"); // It will resubscribe from "subscriptions"
  }
}
// Route a received message to every matching subscription.
// Separate from the client's on('message') so a test or mock can inject messages with no broker.
function mqtt_deliver(topic, msg) {
  // The subscriptions are all going to be MqttNode which will then look at rest of topic
  for (let o of mqtt_subscriptions) {
    if (topicMatches(o.topic, topic)) { // Matches trailing wildcards, but not middle ones
      o.cb(topic, msg);
    }
  }
}
// Drop every subscription belonging to an organization - all its topics start with the organization id.
// Called when switching organization, both to tell the broker (if still connected) and so that the
// connection made for the new organization does not resubscribe to the old organization's topics.
function mqtt_unsubscribe_organization(org) {
  if (!org) { return; }
  const prefix = `${org}/`;
  mqtt_subscriptions = mqtt_subscriptions.filter((s) => {
    if (!s.topic.startsWith(prefix)) { return true; } // e.g. "$SYS/#" belongs to no organization
    console.log("Unsubscribing from ", s.topic);
    if (mqtt_client && mqtt_client.connected) {
      mqtt_client.unsubscribe(s.topic, (err) => {
        if (err) console.error(err);
      });
    }
    return false;
  });
}
// See https://www.chartjs.org/docs/latest/samples/line/segments.html
// Time, behind a seam so a test can decide what "now" is instead of waiting for it.
let _clock = Date.now;
function nowMs() { return _clock(); }
function setClock(fn) { _clock = fn || Date.now; }

// SenML unit codes are not display symbols - "Cel" has to render as "°C". Anything absent from the
// table is shown as it stands, which is right for V, mV, mA, mm, hPa, ppm and most of the rest.
// This is deliberately not the languages table: el() skips values that start with a non-letter or
// contain "/", which is most unit symbols, and a missing entry there renders the bare code.
const unitSymbols = {
  Cel: '°C',
  deg: '°',
  lat: '°',
  lon: '°',
  count: '',   // a count of satellites is "7", not "7 count"
};
function unitSymbol(code) {
  return (code === undefined || code === null) ? '' : (unitSymbols[code] !== undefined ? unitSymbols[code] : code);
}
// A space before a word, none before a symbol: "3.94 V" but "30.1°C" and "38%"
function unitSuffix(code) {
  const sym = unitSymbol(code);
  return sym && /^[a-zA-Z]/.test(sym) ? ` ${sym}` : sym;
}

// "3 min ago". Intl does the plurals and the wording, so none of this needs a languages entry -
// which hand-rolling would, in four languages, for every unit.
function relativeTime(ms) {
  const rtf = new Intl.RelativeTimeFormat(preferedLanguages[0] || 'en', { numeric: 'auto', style: 'narrow' });
  const s = Math.round(ms / 1000);
  if (Math.abs(s) < 60) return rtf.format(-s, 'second');
  const m = Math.round(s / 60);
  if (Math.abs(m) < 60) return rtf.format(-m, 'minute');
  const h = Math.round(m / 60);
  if (Math.abs(h) < 24) return rtf.format(-h, 'hour');
  return rtf.format(-Math.round(h / 24), 'day');
}

function moduleTemplate(groupId) {
  return server_config && server_config.schema && server_config.schema.modules[groupId];
}
// TODO-L4 a name prefix, until modules.yaml carries `control: true`
function isControlModule(groupId) { return groupId.startsWith('control'); }
// insidefrugaliot modules feed the status strip, not the summary; anything else contributes unless
// modules.yaml says summary: false
function contributesToSummary(groupId) {
  const m = moduleTemplate(groupId);
  return !!m && (m.summary !== false) && !m.insidefrugaliot;
}
// Groups in the order modules.yaml declares them, rather than the order their messages happened to
// arrive, so a card looks the same on every load
function moduleOrder(groupId) {
  const modules = (server_config && server_config.schema && server_config.schema.modules) || {};
  const i = Object.keys(modules).indexOf(groupId);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

function topicMatches(subscriptionTopic, messageTopic) {
  if (subscriptionTopic.endsWith('/#')) {
    return (
      messageTopic === (subscriptionTopic.substring(0, subscriptionTopic.length - 2))
      || messageTopic.startsWith(subscriptionTopic.substring(0, subscriptionTopic.length - 1)));
  } else {
    return (subscriptionTopic === messageTopic);
  }
}
function topicTwig(topic) {
  // dev/project/node/module/leaf/paramter -> module/leaf/parameter
  // dev/project/node/set/module/leaf/paramter -> module/leaf/parameter
  let arr = topic.split("/")
  return (arr[3] === "set" ? arr.slice(4) : arr.slice(3)).join("/")
}
function topicLeaf(topic) {
  // dev/project/node/module/leaf/paramter -> leaf/parameter
  // dev/project/node/set/module/leaf/paramter -> leaf/parameter
  let arr = topic.split("/")
  return (arr[3] === "set" ? arr.slice(5) : arr.slice(4)).join("/")
}
function twigAttribute(topic) {
  // "/" is not a valid character in attributes of webcomponents
  return topicTwig(topic).replace(/\//g, '_'); // sht/temperature becomes sht_temperature
}
function leafAttribute(topic) {
  // "/" is not a valid character in attributes of webcomponents
  return topicLeaf(topic).replace(/\//g, '_'); // temperature/max becomes temperature_max
}
// =============================== Languages and Internationalization ===============================
// TODO-L8 move this to config on server
const languages = yaml.load(`
#Language configuration - will be read from files at some point
EN:
  _nameAndFlag: English 🇬🇧
  _thisLanguage: English
  (Max 4MB, .bin only, typically frugal-iot.ino.bin or firmware.bin): (Max 4MB, .bin only, typically frugal-iot.ino.bin or firmware.bin)
  Action: Action
  Action *: Action *
  Add: Add
  Admin: Admin
  Advanced: Advanced
  All: All
  API: API
  AQI: AQI
  AQI500: AQI500
  Auth Token: Auth Token
  Base URL: Base URL
  Battery: Battery
  Board: Board
  Brightness: Brightness
  Built in LED: Built in LED
  buttons: buttons
  Click to change project: Click to change project
  Click to sort: Click to sort
  Climate: Climate
  close: close
  Collapse: Collapse
  Color:  Color
  Connect board: Connect board
  connected: connected
  connecting: connecting
  Control: Control
  Cookie Name: Cookie Name
  Could not read the board - assuming it is already provisioned: Could not read the board - assuming it is already provisioned
  Dashboard: Dashboard
  Data: Data
  Description: Description
  Device: Device
  ds18b20: ds18b20
  e.g. LiteFarm: e.g. LiteFarm
  eCO2: eCO2
  Email: Email
  ENS AHT: ENS AHT
  Enter topic: Enter topic
  Enter value: Enter value
  Existing OTA Files: Existing OTA Files
  Farm ID *: Farm ID *
  Farm registered: Farm registered
  Farms: Farms
  File: File
  Firmware: Firmware
  Firmware file: Firmware file
  Flash: Flash
  Flash over USB: Flash over USB
  Flash size was not detected reliably - flash anyway: Flash size was not detected reliably - flash anyway
  Flash this over USB: Flash this over USB
  Flashing needs the Web Serial API - use Chrome, Edge or Opera on a desktop computer: Flashing needs the Web Serial API - use Chrome, Edge or Opera on a desktop computer
  for node: for node
  From: From
  Frugal-IoT Username *: Frugal-IoT Username *
  Full provision - all configuration on the board will be erased: Full provision - all configuration on the board will be erased
  Greater Than: Greater Than
  heating: heating
  humidifier: humidifier
  Humidity: Humidity
  humidity: humidity
  Humidity control: Humidity control
  Hysteresis: Hysteresis
  Hysterisis: Hysteresis
  id: id
  If this directory is invisible to the file picker, copy the file somewhere else OR make an an alias to the .pio directory without a leading '.': If this directory is invisible to the file picker, copy the file somewhere else OR make an an alias to the .pio directory without a leading '.'
  Input: Input
  Key: Key
  Last Seen: Last Seen
  Last seen: Last seen
  LED: LED
  Limit: Limit
  live: Live
  Load Cell: Load Cell
  Loading schema...: Loading schema...
  Lower-case letters and numbers only, no spaces or punctuation: Lower-case letters and numbers only, no spaces or punctuation
  Manual: Manual
  Monitor: Monitor
  Monitor speed: Monitor speed
  Move down: Move down
  Move up: Move up
  Name: Name
  never: Never seen
  Never seen: Never seen
  No board connected: No board connected
  No farms registered for this organization yet.: No farms registered for this organization yet.
  No nodes found for this farm's project(s).: No nodes found for this farm's project(s).
  No nodes found for this organization: No nodes found for this organization
  No organization: No organization
  No organization selected: No organization selected
  No OTA files uploaded yet.: No OTA files uploaded yet.
  No platforms registered yet.: No platforms registered yet.
  No projects added for this organization yet.: No projects added for this organization yet.
  No projects to display until organization selected: No projects to display until organization selected
  Nobody added for this organization yet.: Nobody added for this organization yet.
  Node Actions: Node Actions
  Node ID:  Node ID
  Node Name:  Node Name
  Nodes: Nodes
  Nodes in Farm: Nodes in Farm
  Nodes in Organization: Nodes in Organization
  Not selected: Not selected
  Note this is your organization - not the organizations whose devices you want to access.: Note this is your organization - not the organizations whose devices you want to access.
  Now: Now
  now: now
  offline: offline
  On: On
  "On ArduinoIDE the file is typically in ": "On ArduinoIDE the file is typically in "
  "On PlatformIO The file is typically in ": "On PlatformIO The file is typically in "
  Organization: Organization
  OTA: OTA
  OTA binary uploaded: OTA binary uploaded
  OTA Key: OTA Key
  OTA Key or Device ID: OTA Key or Device ID
  Out: Out
  out: out
  Output: Output
  Password: Password
  Permissions: Permissions
  Phone or Whatsapp: Phone or Whatsapp
  Platform *: Platform *
  Platform Name *: Platform Name *
  Platform registered: Platform registered
  Please login: Please login
  Project: Project
  Project changed to: Project changed to
  Project ID: Project ID
  Project ID *: Project ID *
  Project Name: Project Name
  Projects: Projects
  Property: Property
  Provision instead (erases config): Provision instead (erases config)
  Publish Message: Publish Message
  "Published to ": "Published to "
  QoS: QoS
  reconnect: reconnect
  Reconnect the board to flash again: Reconnect the board to flash again
  Register: Register
  Register a platform above before adding a farm.: Register a platform above before adding a farm.
  Register Farm: Register Farm
  Register Platform: Register Platform
  Registered Platforms: Registered Platforms
  Relay: Relay
  Reporting every: Reporting every
  Retain: Retain
  Schema: Schema
  Select: Select
  Select a farm above to see its nodes.: Select a farm above to see its nodes.
  Select a node above to see actions.: Select a node above to see actions.
  Select a node above to send an action.: Select a node above to send an action.
  Select an organization to continue.: Select an organization to continue.
  Send: Send
  SEND: SEND
  sent: sent
  server: server
  set: set
  Setpoint: Setpoint
  Settings: Settings
  SHT: SHT
  SHT30: SHT30
  Sign In: Sign In
  Soil: Soil
  Soil Moisture: Soil Moisture
  Soil Temperature: Soil Temperature
  Sonoff R2 switch: Sonoff R2 switch
  Sonoff switch: Sonoff switch
  Speed: Speed
  SSID: SSID
  stale: Not reported recently
  Stop monitor: Stop monitor
  Submit: Submit
  System: System
  Temperature: Temperature
  temperature: temperature
  This field has no invocation URL (forms[0].href) in its schema: This field has no invocation URL (forms[0].href) in its schema
  This node has no actions in its schema.: This node has no actions in its schema.
  Time On (s): Time On (s)
  To: To
  Topic: Topic
  Topic and Value are required: Topic and Value are required
  TVOC: TVOC
  Unable to find node: Unable to find node
  Unable to find project: Unable to find project
  Unauthorized: Unauthorized
  undefined: undefined
  Unknown: Unknown
  Unsupported board: Unsupported board
  Unused: Unused
  Updating the app only: Updating the app only
  Updating the app only - the existing configuration will be preserved: Updating the app only - the existing configuration will be preserved
  Upload: Upload
  Username: Username
  Value: Value
  Value *: Value *
  Voltage: Voltage
  Waiting: Waiting
  When: When
  WiFi: WiFi
FR:
  _nameAndFlag: Français 🇫🇷
  _thisLanguage: Francaise
  (Max 4MB, .bin only, typically frugal-iot.ino.bin or firmware.bin): (Max 4 Mo, .bin uniquement, généralement frugal-iot.ino.bin ou firmware.bin)
  Action: Action
  Action *: Action *
  Add: Ajouter
  Admin: Admin
  Advanced: Avancé
  All: Tous
  API: API
  AQI: IQA  
  AQI500: IQA500  
  Auth Token: Jeton d'authentification
  Base URL: URL de base
  Battery: Batterie
  Board: Carte
  Brightness: Luminosité  
  Built in LED: LED intégrée
  buttons: boutons
  Click to change project: Cliquez pour changer de projet
  Click to sort: Cliquez pour trier
  Climate: Climat
  close: fermer
  Collapse: Réduire
  Color: Couleur  
  Connect board: Connecter la carte
  connected: connecté
  connecting: connexion
  Control: Contrôle
  Cookie Name: Nom du cookie
  Could not read the board - assuming it is already provisioned: Impossible de lire la carte - on suppose qu'elle est déjà provisionnée
  Dashboard: Tableau de bord
  Data: Données
  Description: Description
  Device: Appareil
  ds18b20: ds18b20
  e.g. LiteFarm: par ex. LiteFarm
  eCO2: eCO2
  Email: Email
  ENS AHT: ENS AHT  
  Enter topic: Entrez le sujet
  Enter value: Entrez la valeur
  Existing OTA Files: Fichiers OTA existants
  Farm ID *: ID de la ferme *
  Farm registered: Ferme enregistrée
  Farms: Fermes
  File: Fichier
  Firmware: Micrologiciel
  Firmware file: Fichier micrologiciel
  Flash: Flasher
  Flash over USB: Flasher par USB
  Flash size was not detected reliably - flash anyway: Taille de la mémoire flash non détectée de façon fiable - flasher quand même
  Flash this over USB: Flasher ceci par USB
  Flashing needs the Web Serial API - use Chrome, Edge or Opera on a desktop computer: Le flashage nécessite l'API Web Serial - utilisez Chrome, Edge ou Opera sur un ordinateur de bureau
  for node: pour le nœud
  From: De
  Frugal-IoT Username *: Nom d'utilisateur Frugal-IoT *
  Full provision - all configuration on the board will be erased: Provisionnement complet - toute la configuration de la carte sera effacée
  Greater Than: Supérieur à
  heating: chauffage
  humidifier: humidificateur
  Humidity: Humidité
  humidity: humidité
  Humidity control: Contrôle de l'humidité
  Hysteresis: Hystérésis
  hysteresis: hystérésis
  Hysterisis: Hystérésis
  hysterisis: hystérésis
  id: id
  If this directory is invisible to the file picker, copy the file somewhere else OR make an an alias to the .pio directory without a leading '.': Si ce répertoire est invisible dans le sélecteur de fichiers, copiez le fichier ailleurs OU créez un alias vers le répertoire .pio sans point au début.
  Input: Entrée
  Key: Clé
  Last Seen: Dernière activité
  Last seen: Vu pour la dernière fois
  LED: LED
  Limit: Limite
  live: En ligne
  Load Cell: Cellule de charge
  Loading schema...: Chargement du schéma...
  Lower-case letters and numbers only, no spaces or punctuation: Lettres minuscules et chiffres uniquement, sans espaces ni ponctuation
  Manual: Manuel
  Monitor: Moniteur
  Monitor speed: Vitesse du moniteur
  Move down: Descendre
  Move up: Monter
  Name: Nom 
  never: Jamais vu
  Never seen: Jamais vu
  No board connected: Aucune carte connectée
  No farms registered for this organization yet.: Aucune ferme enregistrée pour cette organisation pour l'instant.
  No nodes found for this farm's project(s).: Aucun nœud trouvé pour le(s) projet(s) de cette ferme.
  No nodes found for this organization: Aucun nœud trouvé pour cette organisation
  No organization: Aucune organisation
  No organization selected: Aucune organisation sélectionnée
  No OTA files uploaded yet.: Aucun fichier OTA téléversé pour l'instant.
  No platforms registered yet.: Aucune plateforme enregistrée pour l'instant.
  No projects added for this organization yet.: Aucun projet ajouté pour cette organisation pour l'instant.
  No projects to display until organization selected: Aucun projet à afficher tant qu'une organisation n'est sélectionnée
  Nobody added for this organization yet.: Personne n'a encore été ajouté pour cette organisation.
  Node Actions: Actions du nœud
  Node Id: ID du nœud
  Node Name: Nom du nœud  
  Nodes: Nœuds
  Nodes in Farm: Nœuds dans la ferme
  Nodes in Organization: Nœuds dans l'organisation
  Not selected: Non sélectionné
  Note this is your organization - not the organizations whose devices you want to access.: Ceci est votre organisation - pas les organisations dont vous voulez accéder aux appareils.
  Now: Maintenant
  now: maintenant
  offline: hors ligne
  On: Allumé
  "On ArduinoIDE the file is typically in ": "Sur ArduinoIDE, le fichier se trouve généralement dans "
  "On PlatformIO The file is typically in ": "Sur PlatformIO, le fichier se trouve généralement dans "
  Organization: Organisation
  OTA: OTA
  OTA binary uploaded: Binaire OTA téléversé
  OTA Key: Clé OTA
  OTA Key or Device ID: Clé OTA ou ID de l’appareil
  Out: Sortie
  out: sortie
  Output: Sortie
  Password: Mot de passe
  Permissions: Autorisations
  Phone or Whatsapp: Téléphone ou Whatsapp
  Platform *: Plateforme *
  Platform Name *: Nom de la plateforme *
  Platform registered: Plateforme enregistrée
  Please login: Veuillez vous connecter
  Project: Projet
  Project changed to: Projet changé en
  Project ID: ID du projet
  Project ID *: ID du projet *
  Project Name: Nom du projet
  Projects: Projets
  Property: Propriété
  Provision instead (erases config): Provisionner plutôt (effacer la configuration)
  Publish Message: Publier un message
  "Published to ": "Publié sur "
  QoS: QoS
  reconnect: reconnecter
  Reconnect the board to flash again: Reconnectez la carte pour flasher à nouveau
  Register: Registre
  Register a platform above before adding a farm.: Enregistrez une plateforme ci-dessus avant d'ajouter une ferme.
  Register Farm: Enregistrer la ferme
  Register Platform: Enregistrer la plateforme
  Registered Platforms: Plateformes enregistrées
  Relay: Relais
  Reporting every: Transmet toutes les
  Retain: Conserver
  Schema: Schéma
  Select: Sélectionner
  Select a farm above to see its nodes.: Sélectionnez une ferme ci-dessus pour voir ses nœuds.
  Select a node above to see actions.: Sélectionnez un nœud ci-dessus pour voir les actions.
  Select a node above to send an action.: Sélectionnez un nœud ci-dessus pour envoyer une action.
  Select an organization to continue.: Sélectionnez une organisation pour continuer.
  Send: Envoyer
  SEND: ENVOYER
  sent: envoyé
  server: serveur
  set: défini
  Setpoint: consigne
  Settings: Réglages
  SHT: SHT
  SHT30: SHT30
  Sign In: Se connecter
  Soil: Sol
  Soil Moisture: Humidité du sol
  Soil Temperature: Température du sol
  Sonoff R2 switch: Interrupteur Sonoff R2
  Sonoff switch: Interrupteur Sonoff
  Speed: Vitesse
  SSID: SSID
  stale: Pas de nouvelles récentes
  Stop monitor: Arrêter moniteur
  Submit: Soumettre
  System: Système
  Temperature: Température
  temperature: température
  This field has no invocation URL (forms[0].href) in its schema: Ce champ n'a pas d'URL d'invocation (forms[0].href) dans son schéma
  This node has no actions in its schema.: Ce nœud n'a aucune action dans son schéma.
  Time On (s): Durée active (s)
  To: À
  Topic: Sujet
  Topic and Value are required: Le sujet et la valeur sont requis
  TVOC: COVT  
  Unable to find node: Impossible de trouver le nœud
  Unable to find project: Impossible de trouver le projet
  Unauthorized: Non autorisé
  undefined: indéfini
  Unknown: Inconnu
  Unsupported board: Carte non prise en charge
  Unused: Inutilisé
  Updating the app only: Mise à jour de l'application uniquement
  Updating the app only - the existing configuration will be preserved: Mise à jour de l'application uniquement - la configuration existante sera conservée
  Upload: Téléverser
  Username: Nom de User
  Value: Valeur
  Value *: Valeur *
  Voltage: Tension
  Waiting: En attente
  When: Quand
  WiFi: WiFi
HI:
  _nameAndFlag: हिंदी 🇮🇳
  _thisLanguage: हिंदी
  (Max 4MB, .bin only, typically frugal-iot.ino.bin or firmware.bin): (अधिकतम 4MB, केवल .bin, सामान्यतः frugal-iot.ino.bin या firmware.bin)
  Action: क्रिया
  Action *: क्रिया *
  Add: जोड़ें
  Admin: एडमिन
  Advanced: उन्नत
  All: सभी
  API: एपीआई
  AQI: वायु गुणवत्ता सूचकांक  
  AQI500: वायु गुणवत्ता सूचकांक 500  
  Auth Token: प्रमाणीकरण टोकन
  Base URL: बेस यूआरएल
  Battery: बैटरी
  Board: बोर्ड
  Brightness: चमक  
  Built in LED: बिल्ट-इन एलईडी
  buttons: बटन
  Click to change project: प्रोजेक्ट बदलने के लिए क्लिक करें
  Click to sort: क्रमबद्ध करने के लिए क्लिक करें
  Climate: जलवायु
  close: बंद करें
  Collapse: छोटा करें
  Color: रंग  
  Connect board: बोर्ड कनेक्ट करें
  connected: जुड़े हुए
  connecting: कनेक्ट हो रहा है
  Control: नियंत्रण
  Cookie Name: कुकी नाम
  Could not read the board - assuming it is already provisioned: बोर्ड पढ़ा नहीं जा सका - मान लिया गया कि यह पहले से प्रोविजन किया हुआ है
  Dashboard: डैशबोर्ड
  Data: डेटा
  Description: विवरण
  Device: उपकरण
  ds18b20: ds18b20
  e.g. LiteFarm: उदाहरण के लिए LiteFarm
  eCO2: ईसीओ2
  Email: ईमेल
  ENS AHT: ईएनएस एएचटी  
  Enter topic: टॉपिक दर्ज करें
  Enter value: मान दर्ज करें
  Existing OTA Files: मौजूदा OTA फ़ाइलें
  Farm ID *: फार्म आईडी *
  Farm registered: फार्म पंजीकृत किया गया
  Farms: फार्म
  File: फ़ाइल
  Firmware: फर्मवेयर
  Firmware file: फर्मवेयर फ़ाइल
  Flash: फ्लैश करें
  Flash over USB: USB से फ्लैश करें
  Flash size was not detected reliably - flash anyway: फ्लैश आकार का विश्वसनीय पता नहीं चला - फिर भी फ्लैश करें
  Flash this over USB: इसे USB से फ्लैश करें
  Flashing needs the Web Serial API - use Chrome, Edge or Opera on a desktop computer: फ्लैश करने के लिए Web Serial API आवश्यक है - डेस्कटॉप कंप्यूटर पर Chrome, Edge या Opera का उपयोग करें
  for node: नोड के लिए
  From: से
  Frugal-IoT Username *: Frugal-IoT उपयोगकर्ता नाम *
  Full provision - all configuration on the board will be erased: पूर्ण प्रोविजनिंग - बोर्ड की सारी कॉन्फ़िगरेशन मिट जाएगी
  Greater Than: इससे बड़ा
  heating: हीटिंग
  humidifier: ह्यूमिडिफ़ायर
  Humidity: आर्द्रता
  humidity: आर्द्रता
  Humidity control: आर्द्रता नियंत्रण
  Hysteresis: हिस्टेरिसिस
  hysteresis: हिस्टेरेसिस
  Hysterisis: हिस्टेरिसिस
  hysterisis: हिस्टेरेसिस
  id: आईडी
  If this directory is invisible to the file picker, copy the file somewhere else OR make an an alias to the .pio directory without a leading '.': यदि यह निर्देशिका फ़ाइल चयनकर्ता में दिखाई नहीं देती है, तो फ़ाइल को किसी अन्य स्थान पर कॉपी करें या बिना अग्रणी बिंदु के .pio निर्देशिका के लिए एक उपनाम बनाएं।
  Input: इनपुट
  Key: कुंजी
  Last Seen: अंतिम बार देखा गया
  Last seen: अंतिम बार देखा
  LED: एलईडी
  Limit: सीमा
  live: चालू
  Load Cell: लोड सेल
  Loading schema...: स्कीमा लोड हो रहा है...
  Lower-case letters and numbers only, no spaces or punctuation: केवल छोटे अक्षर और अंक, कोई स्पेस या विरामचिह्न नहीं
  Manual: मैनुअल
  Monitor: मॉनिटर
  Monitor speed: मॉनिटर गति
  Move down: नीचे ले जाएँ
  Move up: ऊपर ले जाएँ
  Name: नाम
  never: कभी नहीं देखा
  Never seen: कभी नहीं देखा
  No board connected: कोई बोर्ड कनेक्ट नहीं है
  No farms registered for this organization yet.: इस संगठन के लिए अभी तक कोई फार्म पंजीकृत नहीं है।
  No nodes found for this farm's project(s).: इस फार्म के प्रोजेक्ट (प्रोजेक्ट्स) के लिए कोई नोड नहीं मिला।
  No nodes found for this organization: इस संगठन के लिए कोई नोड नहीं मिला
  No organization: कोई संगठन नहीं
  No organization selected: कोई संगठन चयनित नहीं
  No OTA files uploaded yet.: अभी तक कोई OTA फ़ाइल अपलोड नहीं की गई है।
  No platforms registered yet.: अभी तक कोई प्लेटफ़ॉर्म पंजीकृत नहीं है।
  No projects added for this organization yet.: इस संगठन के लिए अभी तक कोई प्रोजेक्ट नहीं जोड़ा गया है।
  No projects to display until organization selected: संगठन चुने जाने तक कोई प्रोजेक्ट प्रदर्शित नहीं होगा
  Nobody added for this organization yet.: इस संगठन के लिए अभी तक कोई नहीं जोड़ा गया है।
  Node Actions: नोड क्रियाएँ
  Node ID: नोड आईडी
  Node Name: नोड नाम 
  Nodes: नोड्स
  Nodes in Farm: फार्म में नोड्स
  Nodes in Organization: संगठन में नोड्स
  Not selected: चयनित नहीं
  Note this is your organization - not the organizations whose devices you want to access.: ध्यान दें यह आपका संगठन है - वे संगठन नहीं जिनके उपकरणों तक आप पहुंचना चाहते हैं।
  Now: अभी
  now: अभी
  offline: ऑफ़लाइन
  On: चालू
  "On ArduinoIDE the file is typically in ": "ArduinoIDE पर फ़ाइल सामान्यतः यहाँ होती है "
  "On PlatformIO The file is typically in ": "PlatformIO पर फ़ाइल सामान्यतः यहाँ होती है "
  Organization: संगठन
  OTA: ओटीए
  OTA binary uploaded: OTA बाइनरी अपलोड की गई
  OTA Key: OTA कुंजी
  OTA Key or Device ID: OTA कुंजी या डिवाइस आईडी
  Out: आउट
  out: आउट
  Output: आउटपुट
  Password: पासवर्ड
  Permissions: अनुमतियाँ
  Phone or Whatsapp: फ़ोन या व्हाट्सएप
  Platform *: प्लेटफ़ॉर्म *
  Platform Name *: प्लेटफ़ॉर्म का नाम *
  Platform registered: प्लेटफ़ॉर्म पंजीकृत किया गया
  Please login: कृपया लॉगिन करें
  Project: परियोजना
  Project changed to: प्रोजेक्ट बदलकर किया गया
  Project ID: प्रोजेक्ट आईडी
  Project ID *: प्रोजेक्ट आईडी *
  Project Name: प्रोजेक्ट का नाम
  Projects: प्रोजेक्ट्स
  Property: प्रॉपर्टी
  Provision instead (erases config): इसके बजाय प्रोविजन करें (कॉन्फ़िगरेशन मिटेगी)
  Publish Message: संदेश प्रकाशित करें
  "Published to ": "पर प्रकाशित किया गया "
  QoS: QoS
  reconnect: पुनः कनेक्ट करें
  Reconnect the board to flash again: फिर से फ्लैश करने के लिए बोर्ड को दोबारा कनेक्ट करें
  Register: पंजीकरण करें
  Register a platform above before adding a farm.: फार्म जोड़ने से पहले ऊपर एक प्लेटफ़ॉर्म पंजीकृत करें।
  Register Farm: फार्म पंजीकृत करें
  Register Platform: प्लेटफ़ॉर्म पंजीकृत करें
  Registered Platforms: पंजीकृत प्लेटफ़ॉर्म
  Relay: रिले
  Reporting every: हर बार रिपोर्ट
  Retain: बनाए रखें
  Schema: स्कीमा
  Select: चुनें
  Select a farm above to see its nodes.: इसके नोड्स देखने के लिए ऊपर एक फार्म चुनें।
  Select a node above to see actions.: क्रियाएँ देखने के लिए ऊपर एक नोड चुनें।
  Select a node above to send an action.: क्रिया भेजने के लिए ऊपर एक नोड चुनें।
  Select an organization to continue.: जारी रखने के लिए एक संगठन चुनें।
  Send: भेजें
  SEND: भेजें
  sent: भेजा गया
  server: सर्वर
  set: सेट किया गया
  Setpoint: सेटपॉइंट
  Settings: सेटिंग्स
  SHT: एसएचटी
  SHT30: एसएचटी30
  Sign In: साइन इन करें
  Soil: मिट्टी
  Soil Moisture: मिट्टी की नमी
  Soil Temperature: मिट्टी का तापमान
  Sonoff R2 switch: सोनऑफ R2 स्विच
  Sonoff switch: सोनऑफ स्विच
  Speed: गति
  SSID: SSID
  stale: हाल में रिपोर्ट नहीं
  Stop monitor: मॉनिटर बंद करें
  Submit: जमा करें
  System: सिस्टम
  Temperature: तापमान
  temperature: तापमान
  This field has no invocation URL (forms[0].href) in its schema: इस फ़ील्ड के स्कीमा में कोई इनवोकेशन यूआरएल (forms[0].href) नहीं है
  This node has no actions in its schema.: इस नोड के स्कीमा में कोई क्रिया नहीं है।
  Time On (s): चालू समय (से)
  To: तक
  Topic: टॉपिक
  Topic and Value are required: टॉपिक और मान आवश्यक हैं
  TVOC: टीवीओसी  
  Unable to find node: नोड नहीं मिल सका
  Unable to find project: प्रोजेक्ट नहीं मिल सका
  Unauthorized: अनधिकृत
  undefined: अपरिभाषित
  Unknown: अज्ञात
  Unsupported board: असमर्थित बोर्ड
  Unused: अप्रयुक्त
  Updating the app only: केवल ऐप अपडेट हो रहा है
  Updating the app only - the existing configuration will be preserved: केवल ऐप अपडेट हो रहा है - मौजूदा कॉन्फ़िगरेशन सुरक्षित रहेगी
  Upload: अपलोड
  Username: उपयोगकर्ता नाम
  Value: मान
  Value *: मान *
  Voltage: वोल्टेज
  Waiting: प्रतीक्षा में
  When: कब
  WiFi: वाई-फ़ाई
ID:
  _nameAndFlag: Bahasa Indonesia 🇮🇩
  _thisLanguage: Bahasa Indonesia
  (Max 4MB, .bin only, typically frugal-iot.ino.bin or firmware.bin): (Maks 4MB, hanya .bin, biasanya frugal-iot.ino.bin atau firmware.bin)
  Action: Aksi
  Action *: Aksi *
  Add: Tambah
  Admin: Admin
  Advanced: Lanjutan
  All: Semua
  API: API
  AQI: Indeks Kualitas Udara  
  AQI500: Indeks Kualitas Udara 500  
  Auth Token: Token Autentikasi
  Base URL: URL Dasar
  Battery: Baterai
  Board: Papan
  Brightness: Kecerahan  
  Built in LED: LED bawaan
  buttons: tombol
  Click to change project: Klik untuk mengubah proyek
  Click to sort: Klik untuk mengurutkan
  Climate: Iklim
  close: tutup
  Collapse: Ciutkan
  Color: Warna  
  Connect board: Hubungkan papan
  connected: terhubung
  connecting: menghubungkan
  Control: Kontrol
  Cookie Name: Nama Cookie
  Could not read the board - assuming it is already provisioned: Tidak dapat membaca papan - dianggap sudah diprovisioning
  Dashboard: Dasbor
  Data: Data
  Description: Deskripsi
  Device: Perangkat
  ds18b20: ds18b20
  e.g. LiteFarm: misalnya LiteFarm
  eCO2: eCO2  
  Email: Email
  ENS AHT: ENS AHT  
  Enter topic: Masukkan topik
  Enter value: Masukkan nilai
  Existing OTA Files: Berkas OTA yang Ada
  Farm ID *: ID Farm *
  Farm registered: Farm terdaftar
  Farms: Farm
  File: Berkas
  Firmware: Firmware
  Firmware file: Berkas firmware
  Flash: Flash
  Flash over USB: Flash melalui USB
  Flash size was not detected reliably - flash anyway: Ukuran flash tidak terdeteksi dengan pasti - flash saja
  Flash this over USB: Flash ini melalui USB
  Flashing needs the Web Serial API - use Chrome, Edge or Opera on a desktop computer: Flashing memerlukan Web Serial API - gunakan Chrome, Edge atau Opera di komputer desktop
  for node: untuk node
  From: Dari
  Frugal-IoT Username *: Nama Pengguna Frugal-IoT *
  Full provision - all configuration on the board will be erased: Provisioning penuh - semua konfigurasi pada papan akan dihapus
  Greater Than: Lebih dari
  heating: pemanas
  humidifier: pelembap
  Humidity: Kelembapan
  humidity: kelembapan
  Humidity control: Kontrol kelembapan
  Hysteresis: Histeresis
  hysteresis: histeresis
  Hysterisis: Histeresis
  hysterisis: histeresis
  id: id
  If this directory is invisible to the file picker, copy the file somewhere else OR make an an alias to the .pio directory without a leading '.': Jika direktori ini tidak terlihat di pemilih berkas, salin berkas ke tempat lain ATAU buat alias ke direktori .pio tanpa titik di awal.
  Input: Masukan
  Key: Kunci
  Last Seen: Terakhir Dilihat
  Last seen: Terakhir terlihat
  LED: LED
  Limit: Batas
  live: Aktif
  Load Cell: Sel Beban
  Loading schema...: Memuat skema...
  Lower-case letters and numbers only, no spaces or punctuation: Hanya huruf kecil dan angka, tanpa spasi atau tanda baca
  Manual: Manual
  Monitor: Monitor
  Monitor speed: Kecepatan monitor
  Move down: Turunkan
  Move up: Naikkan
  Name: Nama
  never: Belum pernah terlihat
  Never seen: Belum pernah terlihat
  No board connected: Tidak ada papan terhubung
  No farms registered for this organization yet.: Belum ada farm yang terdaftar untuk organisasi ini.
  No nodes found for this farm's project(s).: Tidak ada node ditemukan untuk proyek farm ini.
  No nodes found for this organization: Tidak ada node ditemukan untuk organisasi ini
  No organization: Tidak ada organisasi
  No organization selected: Tidak ada organisasi yang dipilih
  No OTA files uploaded yet.: Belum ada berkas OTA yang diunggah.
  No platforms registered yet.: Belum ada platform yang terdaftar.
  No projects added for this organization yet.: Belum ada proyek yang ditambahkan untuk organisasi ini.
  No projects to display until organization selected: Tidak ada proyek untuk ditampilkan sampai organisasi dipilih
  Nobody added for this organization yet.: Belum ada yang ditambahkan untuk organisasi ini.
  Node Actions: Aksi Node
  Node ID: ID Node
  Node Name: Nama Node  
  Nodes: Node
  Nodes in Farm: Node dalam Farm
  Nodes in Organization: Node dalam Organisasi
  Not selected: Tidak dipilih
  Note this is your organization - not the organizations whose devices you want to access.: Ini adalah organisasi Anda - bukan organisasi yang perangkatnya ingin Anda akses.
  Now: Sekarang
  now: sekarang
  offline: offline
  On: Hidup
  "On ArduinoIDE the file is typically in ": "Di ArduinoIDE berkas biasanya ada di "
  "On PlatformIO The file is typically in ": "Di PlatformIO berkas biasanya ada di "
  Organization: Organisasi
  OTA: OTA
  OTA binary uploaded: Biner OTA diunggah
  OTA Key: Kunci OTA
  OTA Key or Device ID: Kunci OTA atau ID Perangkat
  Out: Keluar
  out: keluar
  Output: Keluaran
  Password: Kata Sandi
  Permissions: Izin
  Phone or Whatsapp: Telepon atau Whatsapp
  Platform *: Platform *
  Platform Name *: Nama Platform *
  Platform registered: Platform terdaftar
  Please login: Silakan masuk
  Project: Proyek
  Project changed to: Proyek diubah menjadi
  Project ID: ID Proyek
  Project ID *: ID Proyek *
  Project Name: Nama Proyek
  Projects: Proyek
  Property: Properti
  Provision instead (erases config): Provisioning saja (menghapus konfigurasi)
  Publish Message: Publikasikan Pesan
  "Published to ": "Dipublikasikan ke "
  QoS: QoS
  reconnect: sambungkan kembali
  Reconnect the board to flash again: Hubungkan kembali papan untuk flash lagi
  Register: Daftar
  Register a platform above before adding a farm.: Daftarkan platform di atas sebelum menambahkan farm.
  Register Farm: Daftarkan Farm
  Register Platform: Daftarkan Platform
  Registered Platforms: Platform Terdaftar
  Relay: Relay
  Reporting every: Melapor setiap
  Retain: Simpan
  Schema: Skema
  Select: Pilih
  Select a farm above to see its nodes.: Pilih farm di atas untuk melihat node-nodenya.
  Select a node above to see actions.: Pilih node di atas untuk melihat aksi.
  Select a node above to send an action.: Pilih node di atas untuk mengirim aksi.
  Select an organization to continue.: Pilih organisasi untuk melanjutkan.
  Send: Kirim
  SEND: KIRIM
  sent: terkirim
  server: server
  set: diatur
  Setpoint: titik setel
  Settings: Pengaturan
  SHT: SHT
  SHT30: SHT30
  Sign In: Masuk
  Soil: Tanah
  Soil Moisture: Kelembapan Tanah
  Soil Temperature: Suhu Tanah
  Sonoff R2 switch: Saklar Sonoff R2
  Sonoff switch: Saklar Sonoff
  Speed: Kecepatan
  SSID: SSID
  stale: Belum melapor baru-baru ini
  Stop monitor: Hentikan monitor
  Submit: Kirim
  System: Sistem
  Temperature: Suhu
  temperature: suhu
  This field has no invocation URL (forms[0].href) in its schema: Bidang ini tidak memiliki URL pemanggilan (forms[0].href) dalam skemanya
  This node has no actions in its schema.: Node ini tidak memiliki aksi dalam skemanya.
  Time On (s): Waktu Nyala (d)
  To: Sampai
  Topic: Topik
  Topic and Value are required: Topik dan Nilai wajib diisi
  TVOC: TVOC  
  Unable to find node: Tidak dapat menemukan node
  Unable to find project: Tidak dapat menemukan proyek
  Unauthorized: Tidak sah
  undefined: tidak ditentukan
  Unknown: Tidak diketahui
  Unsupported board: Papan tidak didukung
  Unused: Tidak digunakan
  Updating the app only: Hanya memperbarui aplikasi
  Updating the app only - the existing configuration will be preserved: Hanya memperbarui aplikasi - konfigurasi yang ada akan dipertahankan
  Upload: Unggah
  Username: Nama Pengguna
  Value: Nilai
  Value *: Nilai *
  Voltage: Tegangan
  Waiting: Menunggu
  When: Ketika
  WiFi: WiFi
`);

// Initialise from ?lang= immediately so language-picker renders with the correct selection
// before any element connects. mqtt-wrapper.changeAttribute("lang") will reinforce this later.
const _langInit = new URL(window.location.href).searchParams.get('lang');
let preferedLanguages = _langInit ? _langInit.split(',').map(l => l.toUpperCase()) : [];
function languageNamesAndFlags() {
  //noinspection JSUnresolvedVariable
  return Object.entries(languages).map(([k,v]) => [k,v._nameAndFlag]);
}
function addVocabulary(langs) {
  // Accepts an object in the same format as `languages` e.g. { FR: { word: 'mot' } },
  // or a YAML string in the same format. Merges into existing language entries; adds new languages wholesale.
  if (typeof langs === 'string') langs = yaml.load(langs);
  for (const [lang, words] of Object.entries(langs)) {
    if (languages[lang]) {
      Object.assign(languages[lang], words);
    } else {
      languages[lang] = words;
    }
  }
}
function getStringFrom(langs, tag) {
  for (let lang of preferedLanguages) {
    let foo
    // noinspection JSAssignmentUsedAsCondition
    if (foo = langs[lang] && langs[lang][tag]) {
      return foo;
    }
    if (tag.includes(' ')) {
      let tags = tag.split(' ');
      return tags.map((t) => getString(t)).join(' '); // At worst it will be English parts concatenated
    }
    XXX(["Cannot translate ", tag, ' into ', lang]);
  }
  //noinspection JSUnresolvedVariable
  return undefined;
}
function getString(tag) {
  return getStringFrom(languages, tag) || languages.EN[tag] || tag;
}

// server_config is assigned from /config.json in normal use; funnelled through here so a mock or
// test can supply the same shape without a server.
function configSet(json) {
  server_config = json;
}
// List of tags to try and translate
const i8ntags = {
  label: ["textContent"],
  button: ["textContent"],
  span: ["textContent"],
  option: ["textContent"],
  p: ["textContent"],
  h1: ["textContent"],
  h2: ["textContent"],
  h3: ["textContent"],
  h4: ["textContent"],
  h5: ["textContent"],
  th: ["textContent", "title"],
  td: ["textContent", "title"],
  input: ["title", "placeholder"],
  section: ["title"],
  button: ["textContent"],
}
// Local version of EL
function el(tag, attributes = {}, children) {
  //console.log(attributes);
  if (attributes['i8n'] !== false) { // Add i8n: false if know the field is untranslatable (e.g. a name)
    // noinspection JSUnusedLocalSymbols
    Object.entries(attributes)
      .filter(([k, unused]) => i8ntags[tag] && i8ntags[tag].includes(k))
      .filter(([unused, v]) => (
        v && typeof v === 'string' &&
        !v.includes(':') &&  // e.g.  dev: Development
        !v.includes('/') && // e.g. dev/developers
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.includes(v[0])
      ))
      .forEach(([k, v]) => {
        attributes[k] = getString(v)
      });
  }
  return EL(tag, attributes, children);
}

async function requestJSONp(method, httpurl, body) {
  /**
   *  Asynchronous function to send a JSON body via POST/PUT/etc - returns promise that resolves to the
   *  JSON response or rejects an error
   **/
  const response = await fetch(httpurl, {
    method,
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((json && json.message) || `${httpurl} ${response.status}`);
  }
  return json;
}
function POST(httpurl, body, cb) {
  /**
   * POST a JSON body to a URL and cb(err, json)
   */
  requestJSONp('POST', httpurl, body)
    .then((json) => cb(null, json))
    .catch((err) => cb(err));
}
function PUT(httpurl, body, cb) {
  /**
   * PUT a JSON body to a URL and cb(err, json)
   */
  requestJSONp('PUT', httpurl, body)
    .then((json) => cb(null, json))
    .catch((err) => cb(err));
}

// Set v as prefered language, but remove if already there
// Note this does not redraw anything, that is a function of the caller
function preferedLanguageSet(v) {
  const idx = preferedLanguages.indexOf(v);
  if (idx !== -1) preferedLanguages.splice(idx, 1);
  preferedLanguages.unshift(v);
}
class LanguagePicker extends HTMLElementExtended {

  constructor() {
    super();
    this.state={};
  }
  // TODO-34 (maybe) pull language files from server
  onchange(ev) {
    preferedLanguageSet(ev.target.value);
    locationParameterChange("lang", preferedLanguages.join(','));
  }
  render() {
    return [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('select', {class: "language-picker", onchange: this.onchange.bind(this)},
        languageNamesAndFlags().map(([k,v]) =>
          EL('option', {value: k, textContent: v, selected: k === preferedLanguages[0]}))
      ),
    ];
  }
}
customElements.define('language-picker', LanguagePicker);

// The watchdog is looking at individual nodes, noticing how often they tend to report, then marking offline if they don't
// show up as expected.
class Watchdog {
  constructor(elx) {
    this.elx = elx;
    this.latest = Date.now();
    this.offlineAfter = undefined;
    this.count = 3; // How many times latest before consider offline
  }
  tickle(now) {
    let delta = now-this.latest;
    this.latest = now;
    if (!this.offlineAfter) { this.offlineAfter = delta * this.count; }
    this.offlineAfter = ((this.offlineAfter) * (this.count-1)/this.count)+delta; // Smoothed
    clearTimeout(this.timer);
    this.timer = setTimeout(this.offline.bind(this), this.offlineAfter);
  }
  offline() {
    this.elx.offline();
  }
}
class MqttTopic {
  // Manages a single topic - keeps track of data it has seen, and can create UI element or graphdataset for it
  // Note this intentionally does NOT extend HtmlElement or MqttElement etc
  // Encapsulate a single topic, mostly this will be built during the discovery process,
  // but could also be built by hard coded UI if doesn't exist
  // Should be indexed in MqttNode

  // Creation & initialization =========
  constructor() {
    this.data = []; // Tracks previous values of this topic - used for graphing
    this.qos = 0; // Default to send and not care if received
    this.retain = false; // Default to not retain
    this.state = {}; // Dynamic state: value, groupMt roll-up fields (now_wired, out_wired, on, etc.)
  }

  initialize(o) {
    // topic, name, type, display, rw, min, max, color, options, node
    Object.keys(o).forEach((k) => {
      if (!["leaf"].includes(k)) { // Dont override getters
        this[k] = o[k];
      }
    });
  }
  fromTemplate(topicTemplate, twig, group, node) {
    // topic, name, type, display, rw, min, max, color, options,
    this.initialize(topicTemplate);
    this.group = group // e.g. "sht"
    this.twig = twig;  // e.g. "sht/temperature"
    // getters defined for leaf
    this.node = node; // Instance of MqttNode
  }

  // Gets and related fields ========

  // The MqttTopicGroup for this leaf's group — always via the data tree.
  // nodeMt is set on all leaf topics by MqttTopicNode.addTopicFromTemplate.
  get groupMt() {
    return this.nodeMt && this.nodeMt.groups[this.group];
  }
  get groupName() {
    const gmt = this.groupMt;
    return (gmt && gmt.state.name) || this.group;
  }
  // usableName qualified by which device it is on, e.g. "Greenhouse North:SHT:Temperature".
  // Goes through nodeMt, not node - the latter is the MqttNode element, which does not exist on a
  // headless page such as the cards.
  get fullName() {
    const owner = this.nodeMt;
    return owner ? `${owner.usableName}:${this.usableName}` : this.usableName;
  }
  // Suitable name to refer to this, e,g. on a graph etc. for groups with a single value (e.g. relay) this is the name of the group, rather than the name of the leaf
  get usableName() {
    switch (this.name) {
      case "On":
        return `${this.groupName}`;
      default:
        return `${this.groupName}:${this.name}`;
    }
  }

  // instance of MqttProject element — still needed by element-side callers
  get project() {
    return this.node.project;
  }
  // Project-level MqttTopicProject. Reached via nodeMt._projectMt, which is set on all MqttTopicNode
  // objects — by MqttProject.addNode in normal mode and MqttTopicProject.addNode in headless mode.
  get projectMt() {
    return this._projectMt || (this.nodeMt && this.nodeMt._projectMt);
  }
  get leaf() { // e.g. temperature
    return this.twig.split("/").pop();
  }
  // e.g. org/project/node/group/leaf; for node/project topics nodeMt is absent and twig is the full path.
  // nodeMt is set on all leaf topics by MqttTopicNode.addTopicFromTemplate in both normal and headless mode.
  get topicPath() {
    return (this.nodeMt ? this.nodeMt.topicPath + "/" : "") + this.twig;
  }
  // e.g. org/project/node/set/group/leaf
  get topicSetPath() {
    return this.nodeMt.topicPath + "/set/" + this.twig;
  }
  // e.g. /dev/project/node/set/module/leaf/wired
  get topicWiredPath() {
    return this.topicSetPath + "/wired"; // Path to set wired value
  }
  // e.g. or for node /dev/project/node/# and should not be used at element level as subscribe at node level.
  get topicSubscribePath() {
    if (this.element && this.element.isNode) {
      return this.topicPath + "/#"; // Subscribe to all subtopics
    } else {
      //noinspection JSUnresolvedVariable
      // should only happen for embedded as normally subscribe to wildcard at topic level
      switch (this.rw) { // Note for project this will be undefined
        case 'w': // Note should not be happening as subscribing at node level
          return this.topicSetPath;
        default:
          return this.topicPath;
      }
    }
  }
  // How many decimals to show. Derived from width and the declared range rather than from the
  // current value, so the count does not change as the value moves across a power of ten.
  get decimals() {
    if (this.width === undefined) return (this.type === 'int') ? 0 : 1;
    const intWidth = Math.max(String(Math.trunc(this.min || 0)).length,
                              String(Math.trunc(this.max || 0)).length);
    return Math.max(0, this.width - intWidth - 1);
  }
  // The value as a card shows it: rounded per width, with its unit. Never truncated - a sensor
  // reporting -999 into a width of 4 overflows the field rather than being shown as -99.
  get formatted() {
    const v = this.state.value;
    if (v === undefined || v === null || v === '') return '';
    if (typeof v !== 'number') return String(v);
    return v.toFixed(this.decimals) + unitSuffix(this.units);
  }
  // Outside its declared range - a broken sensor, or a range that needs revisiting
  get outOfRange() {
    const v = this.state.value;
    if (typeof v !== 'number') return false;
    return ((this.min !== undefined) && (v < this.min)) || ((this.max !== undefined) && (v > this.max));
  }
  // Return the topic this is wired to or undefined
  get wiredTopic() {
    const projMt = this.projectMt;
    return this.wired && projMt ? projMt.findTopic(this.wired) : undefined;
  }

  // Navigate project → node → group → topic purely via the data tree.
  // Only meaningful when called on a project-level MqttTopic (i.e. one with a nodes map).
  findTopic(topicPath) {
    const parts = topicPath.split("/");
    if (parts[3] === "set") parts.splice(3, 1); // Normalise read and write paths
    const nodeMt = this.nodes[parts[2]];
    const groupMt = nodeMt && nodeMt.groups[parts[3]];
    return groupMt && groupMt.topics[parts[4]];
  }

  // Lazy-initialised map of nodeId → node-level MqttTopic.
  // Only meaningful when this topic represents a project; populated by MqttProject.addNode.
  get nodes() { return this._nodes || (this._nodes = {}); }

  // Lazy-initialised map of leaf → MqttTopic.
  // Used by MqttTopicGroup to hold its leaf topics; not meaningful on node-level topics.
  get topics() { return this._topics || (this._topics = {}); }

  // Lazy-initialised map of groupId → MqttTopicGroup for this node.
  // Only meaningful when this topic represents a node; populated via MqttNode.topicGroups.
  get groups() { return this._groups || (this._groups = {}); }

  // For node-level topics: the subset of groups whose id starts with 'control'.
  // Returns { groupId: MqttTopicGroup }
  get controlGroups() {
    return Object.fromEntries(
      Object.entries(this.groups).filter(([id]) => id.startsWith('control'))
    );
  }

  // For project-level topics: flat list of all control groups across all nodes.
  // Each entry: { nodeMt, groupId, groupMt, topics: [MqttTopic] }
  get controlGroupList() {
    return Object.values(this.nodes).flatMap(nodeMt =>
      Object.entries(nodeMt.controlGroups)
        .map(([groupId, groupMt]) => ({ nodeMt, groupId, groupMt, topics: Object.values(groupMt.topics) }))
    );
  }

  // Create the UX element that displays this
  createElement() {
    // TO-ADD-ELEMENT expand this switch statement (also create new class)
    if (!this.element) {
      // noinspection JSUnresolvedReference
      // let name = this.name; // comes from discovery
      let elx;
      // noinspection JSUnresolvedReference
      switch (this.display) {
        case 'toggle':
          //noinspection JSUnresolvedVariable
          elx = el('mqtt-toggle', {color: this.color, graphable: this.graphable });
          this.retain = true;
          this.qos = 1;
          break;
        case 'bar':
          // noinspection JSUnresolvedReference
          elx = el('mqtt-bar', {max: this.max, min: this.min, color: this.color, graphable: this.graphable, type: this.type}, []);
          break;
        case 'gauge':
          //noinspection JSUnresolvedVariable
          elx = el('mqtt-gauge', {max: this.max, min: this.min, color: this.color, graphable: this.graphable, type: this.type}, []);
          break;
        case 'text':
          // noinspection JSUnresolvedVariable
          elx = el('mqtt-text', {max: this.max, min: this.min, color: this.color, graphable: this.graphable}, []);
          break;
        case 'color':
          // noinspection JSUnresolvedVariable
          elx = el('mqtt-color', {color: this.color}, []);
          break;
        case 'slider':
          // Not currently being used, UI for controls works better as mqtt-text, this should still work though.
          // TODO possibly deprecate this
          // noinspection JSUnresolvedVariable
          elx = el('mqtt-slider', {min: this.min, max: this.max, value: (this.max + this.min) / 2, graphable: this.graphable, type: this.type}, [
            el('span', {textContent: "△"}, []),
          ]);
          break;
        default:
          // noinspection JSUnresolvedReference
          XXX(["do not know how to display a ", this.display]);
      }
      if (elx) elx.mt = this;
      this.element = elx;
    }
    return this.element;
  }

  // Set new wired value, and subscribe to topic if wired is true
  // Ignoring duplication if subscribing to something on own node - could fix if need to.
  setWired(v) {
    // Note will still get messages from old "wired" but these will be ignored
    this.wired = v;
    if (v) {
      mqtt_subscribe(v, this.message_received.bind(this));
    }
  }
  // Subscribe to a topic. note should (mostly) not do this except at Node level, or for wired
  subscribe() {
    if (!mqtt_client) {
      XXX("Trying to subscribe before connected")
    }
    if (!this.subscribed) {
      this.subscribed = true;
      mqtt_subscribe(this.topicSubscribePath, this.message_received.bind(this));
    }
  }

  // Get input type, so can build a form
  get inputType() {
    // Valid responses for <input type=> are: USED text, number, checkbox or UNUSED password, checkbox, radio, submit, file, date, email, , url, color, range, search, tel, time, week, month
    // noinspection JSUnresolvedReference
    switch (this.type) {
      case "text":
        return "text"
      case "bool":
        return "checkbox";
      case "float":
      case "int":
      case "exponential":
        return "number"
      default: // e.g. topic, yaml
        XXX("Unsupported type - if called from MqttText")
        return "undefined";
    }
  }
  // Called by MqttReceiver.parameterSet to make sure topic updated
  // Convert and set parameter, return converted value.
  parameterSet(parameter, message, typeOfParameter) {
    switch (typeOfParameter) {
      case "float":
      case "integer":
        return this[parameter] = Number(message);
      case "boolean":
        return this[parameter] = toBool(message);
      case "string":
        return this[parameter] = message;
      default:
        switch (typeof(this[parameter])) {
          case "string":
            return this[parameter] = message;
          case "number":
            return this[parameter] = Number(message);
          case "boolean":
            return this[parameter] = toBool(message);
          default:
            XXX(['Setting parameter of MqttTopic of unknown type', this.topic, parameter, message]);
        }
    }
  }
  // Convert from text to value based on type
  // TODO add opposite - return string or int based on argument, then look at valueGet subclassed many places
  // NOTE same function in frugal-iot-logger and frugal-iot-client if change here, change there
  valueFromText(message) {
    try {
      // noinspection JSUnresolvedReference
      switch (this.type) {
        case "bool":
          return toBool(message);
        case "float":
        case "int":
        case "exponential":
          return Number(message)
        case "text":
        case "topic":
        case "color":
          return message;
        case "yaml":
          // noinspection JSUnusedGlobalSymbols
          return yaml.loadAll(message, {onWarning: (warn) => console.log('Yaml warning:', warn)});
        default:
          // noinspection JSUnresolvedReference
          XXX([`Unrecognized message type: ${this.type}`]);
      }
    } catch (e) {
      XXX(["Error parsing message", message, e]);
      return null;  // TODO its unclear how this error will be handled - catch specific cases (like unparseable yaml)
    }
  }

  // Note sometimes called from MqttClient and sometimes from node.topicValueSet
  // Note pathway MqttTopic (for node) -> MqttNode -> MqttTopic for module
  message_received(topic, message) {
    if (this.element) {
      if (this.element.topicValueSet(topic, message)) {
        //XXX(["rerendering - possibly unnecessarily - on",topic,message]); // Should only be on MqttTopic (ok) and MqttSlider (needs work)
        this.element.renderAndReplace(); // TODO note gradually replacing need to rerender by smarter valueSet() on different subclasses
      }
    } else {
      // Headless path: update the data tree directly (also reached by detached MqttGraphDataset topics).
      // topicSetPath throws if nodeMt is null, so guard the startsWith call with nodeMt.
      const isParam = this.nodeMt && topic.startsWith(this.topicSetPath + '/');
      if (isParam) {
        // Parameter subtopic arriving (e.g. now/wired, temperature/max).
        if (topic.split('/').pop() === 'wired') this.setWired(message);
      } else {
        // Value arriving on this topic's own path, its set-path, or its wired source.
        const value = this.valueFromText(message);
        this.data.push({value, time: Date.now()});
        this.state.value = value; // Keep state.value current so usableName, wiredTopic, etc. work headlessly
      }
      // Mirror to the data-tree group and notify dashboard listeners, matching what the element path does.
      // groupMt is null for graph-dataset topics (no nodeMt), so this block is skipped for those.
      const groupMt = this.groupMt;
      if (groupMt && this.nodeMt) {
        const leafAttr = leafAttribute(topic);
        groupMt.state[leafAttr] = isParam ? message : this.state.value;
        document.dispatchEvent(new CustomEvent('frugaliot:groupchanged', {
          detail: { nodeMt: this.nodeMt, groupId: this.group, groupMt, changed: [leafAttr] }
        }));
      }
    }
    if (this.graphdataset) { // instance of MqttGraphdataset
      this.graphdataset.dataChanged();
    }
  }

  /// Get an y-axis id for the graph, the idea is to make it easy to have multiple traces on same y-axis.
  get yaxisid() {
    const scaleNames = Object.keys(this.graph.state.scales);
    // noinspection JSUnresolvedReference
    let n = this.name.toLowerCase().replace(/[0-9]+$/,'');
    let t = this.leaf.toLowerCase().replace(/[0-9]+$/,'');
    if (scaleNames.includes(n)) { return n; }
    if (scaleNames.includes(t)) { return t; }
    // noinspection JSAssignmentUsedAsCondition
    let yaxisid;
    if (yaxisid = scaleNames.find(tt => tt.includes(n) || n.includes(tt))) {
      return yaxisid;
    }
    // noinspection JSAssignmentUsedAsCondition
    if (yaxisid = scaleNames.find(tt => tt.includes(n) || n.includes(tt))) {
      return yaxisid;
    }
    // Not found - lets make one
    // noinspection JSUnresolvedReference
    this.graph.addScale(t, {
      type: this.type === 'exponential' ? 'logarithmic' : 'linear',
      display: this.type !== 'bool',
      title: {
        // noinspection JSUnresolvedReference
        color: this.color,  // May need to vary so not all e.g. humidity same color
        // noinspection JSUnresolvedReference
        text: getString(this.name.replace(/[0-9]+$/,'')),
      },
      // 0 is not valid on a logarithmic axis, so fall back to auto-scaling (undefined) rather than 0
      // noinspection JSUnresolvedReference
      min: ((this.type === 'bool') ? false : (this.type === 'exponential' ? (this.min || undefined) : (this.min || 0))),
      // noinspection JSUnresolvedReference
      max: ((this.type === 'bool') ? true : undefined),
    });
    return t;
  }
  // ==========TODO-44 === CODE REVIEW ABOVE DONE: getters#26; const vs let; globals;TODO's; Problems; Comments; Set thru attributes not state from yaxisid; rollups from yaxisid


  get graph() {
    if (this.graphdataset) {
      return this.graphdataset.graph;
    }
    // By tag name rather than by import, the same way createElement reaches the widgets: graphing
    // depends on the data tree, so the data tree must not depend on graphing.
    const GraphClass = customElements.get('mqtt-graph');
    return GraphClass && GraphClass.graph; // Default (global) graph, created on first use
  }
  // Event gets called when graph icon is clicked - adds a line to the graph (which it creates if needed)
  // It links the datasets of the topic to the dataset.
  createGraph() {
    // Figure out which scale to use, or build it
    let yaxisid = this.yaxisid;

    // Make sure there is a graph to work with,
    // Must do before partially create the graphdataset which breaks this.graph temporarily
    let graphEl = this.graph; // Not "graph" - that is the module-level default, in graph.js
    
    // Create a graphdataset to put in the chart
    if (!this.graphdataset) {
      let nodename = this.node ? this.node.usableName : "";
      // noinspection JSUnresolvedReference
      this.graphdataset = el('mqtt-graphdataset', {
        // noinspection JSUnresolvedReference
        name: this.name,
        type: this.type,
        color: this.color,
        // TODO-46 yaxis should depend on type of graph BUT cant use name as that may end up language dependent
        // noinspection JSUnresolvedReference
        min: this.min,
        max: this.max,
        yaxisid: yaxisid,
        label: `${nodename}:${this.name}`
      });
      this.graphdataset.mt = this;
    }
    // If it is a new graphdataset or this topic was created by an embedded mqtt-chartdataset, there will not yet be a chartdataset
    if (!this.graphdataset.chartdataset) {
      this.graphdataset.makeChartDataset(); // Links to data above
    }
    // Note this is happening after makeChartDataset
    if (!graphEl.contains(this.graphdataset)) {
      graphEl.append(this.graphdataset); // calls GDS.loadContent which adds dataset to Graph and sets GDS.graph (enabling this.graph to work)
    }
    this.graphdataset.addDataLeft(); // Populate with any back data
  }

  removeFromGraph() {
    // Removes this topic's line from the graph and resets state so createGraph() can re-add it.
    // Call before switching to a different sensor to keep the graph uncluttered.
    if (!this.graphdataset) return;
    const gds = this.graphdataset;
    if (gds.chartdataset && gds.graph) {
      gds.graph.removeDataset(gds.chartdataset);
    }
    if (gds.parentElement) gds.parentElement.removeChild(gds);
    this.graphdataset = null;
  }

  publish(val) {
    // super.onChange(e);
    console.log("Publishing ", this.topicSetPath, val, this.retain ? "retain" : "", this.qos ? `qos=${this.qos}` : "");
    if (typeof val === 'number') { val = val.toString(); } // Convert to string if number
    mqtt_client.publish(this.topicSetPath, val, {retain: this.retain, qos: this.qos});
  }
  publishWired(val) {
    console.log("Publishing ", this.topicWiredPath, val, this.retain ? "retain" : "", this.qos ? `qos=${this.qos}` : "");
    mqtt_client.publish(this.topicWiredPath, val, {retain: true, qos: 1});
  }
  // Adds historical data to the chart - typically chart updates data for each line, then updates the chart.
  addDataFrom(filename, first, cb) {
    //TODO this location may change
    // noinspection JSUnresolvedReference
    let filepath = `${server_config.logger.url}/${this.topicPath}/${filename}`;
    console.log("Adding from", filepath);
    //let self = this; // if needed in Promise
    fetch(filepath)
      .then(response => {
        if (response.ok) {
          return response.text(); // A promise
        } else {
          throw new Error(`${filepath} ${response.status}: ${response.statusText}`);
        }
      })
      .then(csvData => {
        // The server appends to these files as readings arrive, so one can end mid-line if the
        // power was cut while it was being written - a truncated number, a missing column, or an
        // opening quote with nothing after it. These options make the parser drop whatever is
        // damaged and return the rest, instead of rejecting the whole file, which would lose a
        // day of readings over one bad byte at the end.
        // noinspection JSCheckFunctionSignatures
        parse(csvData, {relax_quotes: true, relax_column_count: true, skip_records_with_error: true}, (err, newdata) => {
          if (err) {
            console.error("Could not read", filepath, err.message);
            this.markNoDataForDay();
            cb(null); // Not an error to the caller - one unreadable day should not stop the rest
          } else {
            // A record can survive the parse but still be unusable - a torn last line often leaves
            // just a timestamp, or half of one
            let newprocdata = newdata
              .filter(r => (r.length >= 2) && !isNaN(parseInt(r[0])))
              .map(r => {
                return {
                  time: parseInt(r[0]),
                  value: this.valueFromText(r[1])  // TODO-72 need function for this as presuming its float
                };
              });
            if (newdata.length !== newprocdata.length) {
              console.warn(`ignored ${newdata.length - newprocdata.length} damaged record(s) in ${filepath}`);
            }
            if (newprocdata.length === 0) {
              XXX(["No data in", filepath]);
              this.markNoDataForDay();
              cb(null); // Nothing to add, but the caller still has to be told this one is finished
              return;
            }
            console.log(`retrieved ${newprocdata.length} records for ${this.topicPath}`);
            let olddata = this.data.splice(0, Infinity);
            for (let dd of newprocdata) {
              this.data.push(dd);
            }// Cant splice as ...newprocdata blows stack
            // Put back the newer data, unless "first" in which case only put back if newer than olddata
            // TODO-46 TODO-72 this is also good place to trim total number data points if >1000
            let lastdate = newprocdata[newprocdata.length - 1].time;
            for (let dd of olddata) {
              if (!first || (dd.time > lastdate)) {
                this.data.push(dd);
              }
            }
            if (this.data.length > 1000) {
              this.graph.chart.options.animations = false; // Disable animations get slow at scale
            }
            cb();
          }
        })
      })
      .catch(ignored => {
        // Did not get any data, draw dotted line from beginning of day to now (and end of prev data to start this day)
        this.markNoDataForDay();
        //console.error(err); - dont need error - the fetch will also report it, so it is just a repeat.
        cb(null); // Dont break caller
      }); // May want to report filename here
  }

  // Nothing usable for this day, whether the file was missing, empty or damaged. A null point at
  // the start of the day makes the graph draw a dotted line across the gap rather than joining the
  // days either side as though nothing were missing.
  markNoDataForDay() {
    let t = new Date(this.graph.state.dateFrom) // Have to explicitly copy it else pointer
      .setUTCHours(0,0,0,0)
      .valueOf();
    this.data.splice(0, 0, {
      time: t,
      value: null,
    });
  }

  removeDataBefore(date) { // note date may be null
    let i;
    if (date) {
      i = this.data.findIndex(d => d.time >= date); // -1 if all older
    } else {
      i = -1;
    }
    if (i > 0) {
      this.data.splice(0, i);
    } else { // No date, or all older
      this.data.splice(0, Infinity); // delete all
    }
  }
}

// Group-level data node in the topic tree. Holds the leaf MqttTopics for one module group.
// Subclass of MqttTopic so it can be stored in and navigated via the same tree.
// topics: { leaf → MqttTopic } — inherited lazy map via get topics().
// Paired with an optional MqttGroup element via this.element.
class MqttTopicGroup extends MqttTopic {
  // Values roll up here as they arrive - see the groupMt.state[leafAttr] assignments in
  // MqttTopic.message_received and MqttReceiver.topicValueSet - so a summary can be built with no
  // DOM at all. That is why this lives on the data tree and not on the group element.
  summaryText() {
    return null; // Most modules have no summary of their own
  }
  // The chip form, for the one-line summary. Same as summaryText for a sensor, but a control's
  // rule is a sentence and a summary wants "Relay ✓", not "Relay = SHT:Temperature > 32 +/- 3 ✓".
  summaryShort() {
    return this.summaryText();
  }
  trueFalseSymbol(val) {
    return (val === undefined) ? '?' : (val ? '✓' : '✗');
  }
}
class MqttTopicGroupRelay extends MqttTopicGroup {
  // Named, because a lone ✓ on a summary line does not say what is on
  summaryText() {
    return `${this.state.name} ${this.trueFalseSymbol(this.state.on)}`
  }
}
class MqttTopicGroupSoil extends MqttTopicGroup {
  summaryText() {
    return this.topics.soil.formatted;
  }
}
class MqttTopicGroupOta extends MqttTopicGroup {
  summaryText() {
    return `${this.state.key}`
  }
}
class MqttTopicGroupBattery extends MqttTopicGroup {
  summaryText() {
    return this.topics.battery.formatted;
  }
}
class MqttTopicGroupDS18B20 extends MqttTopicGroup {
  summaryText() {
    return this.topics.ds18b20.formatted;
  }
}
class MqttTopicGroupHt extends MqttTopicGroup {
  summaryText() {
    return `${this.topics.temperature.formatted} ${this.topics.humidity.formatted}`;
  }
}
class MqttTopicGroupControlHysteresis extends MqttTopicGroup {
  // A wired input shows the name of what it is wired to, rather than the value copied from it
  nameOrValue(val, wired) {
    const projMt = this.projectMt;
    return wired && projMt && projMt.findTopic(wired) && projMt.findTopic(wired).usableName || val;
  }
  summaryText() {
    let hysteresis = this.state.hysteresis || this.state.hysterisis || 0
    // "out", not "on": a control's output leaf is "out" (Control_Hysteresis publishes an OUTbool
    // named "out"), and no control module declares an "on" - that is an actuator's leaf. Reading
    // "on" here meant this symbol was always "?".
    return this.state.manual
      ? getString('Manual')
      : `${this.nameOrValue("",this.state.out_wired)} = ${this.nameOrValue(this.state.now,this.state.now_wired)} ${this.state.greater ? ">" : "<"} ${this.nameOrValue(this.state.limit,this.state.limit_wired)} ${hysteresis ? "+/-" : ""} ${hysteresis ? hysteresis : ""} ${this.trueFalseSymbol(this.state.out)}`;
  }
  summaryShort() {
    if (this.state.manual) return getString('Manual');
    // A control whose output is wired to nothing is not doing anything. Plenty of devices carry a
    // control they never wired up, and it should not take a place on the summary line. The front
    // still shows it, because that is where you would go to wire it.
    if (!this.state.out_wired) return null;
    // Named by what it drives; fall back to the module name if that topic has not arrived yet
    const what = this.nameOrValue("", this.state.out_wired) || this.state.name;
    return `${what} ${this.trueFalseSymbol(this.state.out)}`;
  }
}
// Which MqttTopicGroup subclass a module gets - the data-tree counterpart of looking up
// `mqtt-group${groupId}` as a custom element. A module with no entry gets the plain MqttTopicGroup
// and so has no summary. TODO-D20 these hand-written summaries are to be replaced by a
// `summary: [leaves]` list in modules.yaml; the entries here go as each module gains one.
const topicGroupClasses = {
  relay: MqttTopicGroupRelay,
  soil: MqttTopicGroupSoil,
  ota: MqttTopicGroupOta,
  battery: MqttTopicGroupBattery,
  ds18b20: MqttTopicGroupDS18B20,
  ht: MqttTopicGroupHt,
  sht: MqttTopicGroupHt,
  dht: MqttTopicGroupHt,
  controlhysteresis: MqttTopicGroupControlHysteresis,
  controlhysterisis: MqttTopicGroupControlHysteresis, // TODO-legacy-hysterisis
};

// Project-level data node in the topic tree. Receives discovery messages and creates nodes.
// Created by MqttWrapper.addProject; paired with MqttProject element via this.element.
class MqttTopicProject extends MqttTopic {
  // Route directly on the data-tree object rather than through the element.
  // base MqttTopic.message_received routes through this.element.topicValueSet, which is wrong at project level.
  message_received(topicPath, message) {
    this.topicValueSet(topicPath, message);
    if (this.graphdataset) this.graphdataset.dataChanged(); //TODO-73 cant think why project has a dataset?
  }
  // Handle a discovery message. Creates a new node if not yet seen.
  // In headless mode: calls this.addNode directly (no MqttProject element or watchdog).
  topicValueSet(topicPath, message) {
    const val = this.valueFromText(message);
    if (this.headless) {
      if (!this.nodes[val]) this.addNode(val);
    } else if (this.element && this.element.state.discover) {
      if (this.nodes[val]) {
        this.nodes[val].element?.tickle();
      } else {
        this.element.addNode(val);
      }
    }
  }
  // Creates the MqttTopicNode for a node id. Works in both headless and normal mode.
  // In normal mode, MqttProject.addNode calls this and then does the DOM layer on top.
  // _groups starts as {} and is replaced by MqttProject.addNode with elNode.topicGroups.
  addNode(id) {
    const topicPath = `${this.topicPath}/${id}`;
    const mt = new MqttTopicNode();
    mt.initialize({ type: "yaml", twig: topicPath });
    if (this.headless) mt.headless = true;
    mt._groups = {};
    mt._projectMt = this;
    mt.nodeId = id;
    this.nodes[id] = mt;
    mt.subscribe();
    // In headless mode only — normal mode fires via MqttProject.rebuildTopicDropdowns
    if (this.headless) {
      document.dispatchEvent(new CustomEvent('frugaliot:topicschanged', { detail: { project: this } }));
    }
    return mt;
  }
}

// Node-level data node in the topic tree. Routes incoming MQTT messages to the correct leaf MqttTopic.
// Always created by MqttTopicProject.addNode. In normal mode MqttProject.addNode then adds the paired
// MqttNode element (this.element) and replaces _groups with elNode.topicGroups.
class MqttTopicNode extends MqttTopic {
  // Route directly on the data-tree object rather than through the element.
  message_received(topicPath, message) {
    this.noteMessage();
    this.topicValueSet(topicPath, message);
    if (this.graphdataset) this.graphdataset.dataChanged();
  }
  // Route an incoming MQTT message to the correct leaf MqttTopic.
  // Element-specific operations (group/topic DOM creation, dropdown rebuild) are guarded with if (this.element).
  topicValueSet(topicPath, message) {
    let twig = topicPath.substring(this.topicPath.length + 1);
    if (twig.startsWith("set/")) { twig = twig.substring(4); }
    // TODO-37 ignore some legacy and/or buggy topics
    if (
      (topicPath === this.topicPath)
      || ["relay"].includes(twig)
      || twig.startsWith("set")
      || twig.startsWith("soil1")
      || twig.startsWith("control/")
      || twig.startsWith("humidity/")
      || twig.startsWith("led/")
      || twig.endsWith('/wire')
      || !twig.includes('/')
    ) {
      XXX(["legacy twig thought this was gone!", twig]);
      return false;
    }
    if (["frugal_iot/project"].some(s => s === twig || twig.includes(s + "/"))) return false;
    if (["frugal_iot/device_name"].some(s => s === twig || twig.includes(s + "/"))) return false;
    if (["wifistrength", "climate/temp_now", "climate/temp_out", "climate/temp_hysteresis", "climate/temp_setpoint", "climate/temperature", "climate/humidity", "controlhysterisis/auto", "frugal-iot/reboot", "buttons", "messages", "now/now"].some(s => s === twig || twig.includes(s + "/"))) {
      XXY(["legacy twig will go away after reboot", twig]);
      return false;
    }
    const parts = twig.split("/");
    const groupId = parts[0];
    // Auto-create group from template if it hasn't been seen yet
    if (!this.groups[groupId]) {
      if (this.element) {
        if (this.element.addGroupFromTemplate(groupId)) {
          this.element.project?.rebuildTopicDropdowns();
        }
      } else if (this.headless) {
        if (this.addGroupFromTemplate(groupId)) {
          document.dispatchEvent(new CustomEvent('frugaliot:topicschanged', { detail: { project: this._projectMt } }));
        }
      }
    }
    let matched = this.sendMessageToMatchingTopics(topicPath, twig, message);
    if (["frugal_iot/name"].some(s => s === twig || twig.includes(s + "/"))) {
      this.element?.project?.rebuildTopicDropdowns();
    }
    // No match — try to add the topic from a template and route again
    if (!matched) {
      const leaf = parts[1];
      let t = server_config.schema.topics[leaf];
      const guessName = leaf.replace("_", " ");
      if (
        (!t && ["_now", "_setpoint", "_limit", "_hysteresis", "_hysterisis", "_hyst"].some(suffix => leaf.endsWith(suffix)))
        || (t && groupId.startsWith("control") && t.type === "float")
      ) {
        t = expandTopicTemplate('controlfloat', {leaf, name: guessName});
      }
      if (
        (!t && ["_xxx"].some(suffix => leaf.endsWith(suffix)))
        || (t && groupId.startsWith("control") && t.type === "int")
      ) {
        t = expandTopicTemplate('controlint', {leaf, name: guessName});
      }
      if (!t && ["_out"].some(suffix => leaf.endsWith(suffix))) {
        t = expandTopicTemplate('controlouttoggle', {leaf, name: guessName});
      }
      if (!t && ["_in"].some(suffix => leaf.endsWith(suffix))) {
        t = expandTopicTemplate('controlouttoggle', {leaf, name: guessName});
      }
      if (t) {
        if (this.element) {
          if (this.element.addTopicFromTemplate(t, groupId)) {
            this.element.project?.rebuildTopicDropdowns();
          }
        } else if (this.headless) {
          if (this.addTopicFromTemplate(t, groupId)) {
            document.dispatchEvent(new CustomEvent('frugaliot:topicschanged', { detail: { project: this._projectMt } }));
          }
        }
        if (!this.sendMessageToMatchingTopics(topicPath, twig, message)) {
          XXX(["Even after adding topic from template, no destination for", twig]);
        }
      } else {
        XXX(["Unrecognized twig at ", topicPath]);
      }
    }
  }
  // ===== What the cards read. All of this works with no DOM, which is the point. =====

  // Learn the reporting interval as messages arrive, the way Watchdog does for the old UI, but with
  // no timer, so status can be reasoned about and tested.
  noteMessage() {
    const now = nowMs();
    if (this.lastMessageAt) {
      const delta = now - this.lastMessageAt;
      this.expectedInterval = this.expectedInterval ? (this.expectedInterval * 2 / 3) + (delta / 3) : delta;
    }
    this.lastMessageAt = now;
  }
  get age() { return this.lastMessageAt ? nowMs() - this.lastMessageAt : null; }
  // live | stale | offline | never. A device that has never said anything is not the same as one
  // that has gone quiet, and a card shows them differently.
  get status() {
    if (!this.lastMessageAt) return 'never';
    const expected = this.expectedInterval || DEFAULT_REPORT_INTERVAL_MS;
    const age = this.age;
    if (age <= expected * 1.5) return 'live';
    if (age <= expected * 4) return 'stale';
    return 'offline';
  }

  // The battery reading and where it sits in its declared range, for the status strip. Percent is
  // null when the range is not declared, rather than a made-up number.
  get battery() {
    const g = this.groups.battery;
    const mt = g && g.topics.battery;
    if (!mt || (typeof mt.state.value !== 'number')) return null;
    const { min, max } = mt;
    const percent = ((min === undefined) || (max === undefined) || (max <= min)) ? null
      : Math.max(0, Math.min(100, Math.round(((mt.state.value - min) / (max - min)) * 100)));
    // images/Battery0.png .. Battery6.png - the icon says "battery" so the number does not have to
    const level = (percent === null) ? null : Math.min(6, Math.round((percent / 100) * 6));
    return { mt, percent, level };
  }

  get otaKey() {
    const ota = this.groups.ota;
    return ota && ota.topics.key && ota.topics.key.state.value;
  }
  // The devices.yaml entry: this device's own id first, then its exact OTA key, then the longest
  // key the OTA key starts with - see CARDS_UX.md 4.6.
  get deviceConfig() {
    const devices = (server_config && server_config.schema && server_config.schema.devices) || {};
    if (devices[this.nodeId]) return devices[this.nodeId];
    const key = this.otaKey;
    if (!key) return undefined;
    if (devices[key]) return devices[key];
    const prefixes = Object.keys(devices).filter((k) => key.startsWith(k));
    if (!prefixes.length) return undefined;
    return devices[prefixes.sort((a, b) => b.length - a.length)[0]];
  }

  // battery, health, ota and the like feed the header and footer rather than getting a section
  isStatusStripGroup(groupId) {
    const m = moduleTemplate(groupId);
    return !!m && !!m.insidefrugaliot;
  }
  // Group ids in the order modules.yaml declares them, not the order messages happened to arrive,
  // so a card looks the same on every load
  get orderedGroupIds() {
    return Object.keys(this.groups).sort((a, b) => moduleOrder(a) - moduleOrder(b));
  }

  // A reading's label: its own name, unless another front row carries the same one, in which case
  // the module name says what is actually being measured - "Soil Temperature", not
  // "Temperature (DS18B20)". See CARDS_UX.md 4.3.
  labelFor(mt, allMts) {
    const clash = allMts.some((other) => (other !== mt) && (other.name === mt.name));
    return clash ? (mt.groupName || mt.name) : mt.name;
  }

  // One entry of a front/summary list: "sht/temperature", or a bare control module id
  resolveEntry(entry) {
    if (entry.includes('/')) {
      const [groupId, leaf] = entry.split('/');
      const groupMt = this.groups[groupId];
      const mt = groupMt && groupMt.topics[leaf];
      if (!mt) return null; // check-schema catches a typo; a device simply lacking that sensor is normal
      return { kind: (mt.rw === 'w') ? 'actuator' : 'reading', mt, groupMt };
    }
    const groupMt = this.groups[entry];
    return groupMt ? { kind: 'control', groupMt } : null;
  }

  // The front of the card, in order: the device's declared list, or the default of graphable
  // readings, then actuators, then one row per control.
  get frontRows() {
    const cfg = this.deviceConfig;
    const entries = (cfg && cfg.front) || this.defaultFrontEntries;
    const rows = entries.map((e) => this.resolveEntry(e)).filter(Boolean);
    const mts = rows.filter((r) => r.mt).map((r) => r.mt);
    rows.forEach((r) => {
      r.label = r.mt ? this.labelFor(r.mt, mts) : (r.groupMt.state.name || r.groupMt.group);
    });
    return rows;
  }
  get defaultFrontEntries() {
    const readings = [], actuators = [], controls = [];
    this.orderedGroupIds.forEach((groupId) => {
      const m = moduleTemplate(groupId);
      if (!m || m.insidefrugaliot || (groupId === 'frugal_iot')) return; // these feed the status strip
      if (isControlModule(groupId)) { controls.push(groupId); return; }
      (m.topics || []).forEach((t) => {
        const mt = this.groups[groupId].topics[t.leaf];
        if (!mt) return;
        if (mt.rw === 'w') actuators.push(`${groupId}/${t.leaf}`);
        else if (mt.graphable) readings.push(`${groupId}/${t.leaf}`);
      });
    });
    return readings.concat(actuators, controls);
  }

  // The one-line summary: the device's summary list, else the first two of its front list, else the
  // contributing modules' own summaries - capped at two either way. See CARDS_UX.md 4.7.
  get summaryChips() {
    const cfg = this.deviceConfig;
    const fromList = (list) => list.map((e) => this.resolveEntry(e)).filter(Boolean)
      .map((r) => ({ text: r.mt ? r.mt.formatted : r.groupMt.summaryShort(), row: r }))
      .filter((c) => (c.text !== null) && (c.text !== ''));
    if (cfg && cfg.summary) return fromList(cfg.summary);   // declared: however many were asked for
    if (cfg && cfg.front) return fromList(cfg.front.slice(0, SUMMARY_CHIP_LIMIT));
    return this.orderedGroupIds
      .filter((groupId) => contributesToSummary(groupId))
      .map((groupId) => ({ text: this.groups[groupId].summaryShort(),
                           row: { kind: 'control', groupMt: this.groups[groupId] } }))
      .filter((c) => (c.text !== null) && (c.text !== ''))
      .slice(0, SUMMARY_CHIP_LIMIT);
  }

  // Data-tree group creation: builds MqttTopicGroup and its template topics with no paired DOM element.
  // MqttNode.addGroupFromTemplate delegates here and then adds the DOM element on top.
  addGroupFromTemplate(groupId) {
    if (this.groups[groupId]) return false;
    const moduleTemplate = server_config.schema.modules[groupId];
    const groupName = moduleTemplate ? moduleTemplate.name : groupId;
    const GroupClass = topicGroupClasses[groupId] || MqttTopicGroup;
    const groupMt = new GroupClass();
    groupMt.name = groupName;
    groupMt.state.name = groupName;
    groupMt.group = groupId;
    groupMt.twig = groupId;   // So topicPath resolves to org/project/node/group
    groupMt.nodeMt = this;    // So projectMt works, which a control summary needs to name its wiring
    this._groups[groupId] = groupMt;
    if (!moduleTemplate) {
      XXX(["Unknown group - no template found", groupId]);
    } else {
      moduleTemplate.topics.forEach(topicUnexpandedTemplate => {
        const topicExpandedTemplate = expandTopicTemplate(topicUnexpandedTemplate.leaf_from || topicUnexpandedTemplate.leaf, topicUnexpandedTemplate) || topicUnexpandedTemplate;
        this.addTopicFromTemplate(topicExpandedTemplate, groupId);
      });
    }
    if (groupId.startsWith('control')) {
      const groupMtReady = this.groups[groupId];
      document.dispatchEvent(new CustomEvent('frugaliot:controlgroup', {
        detail: { nodeMt: this, groupId, groupMt: groupMtReady, topics: Object.values(groupMtReady ? groupMtReady.topics : {}) }
      }));
    }
    return true;
  }
  // Data-tree topic creation: builds a MqttTopic with no paired DOM element.
  // Sets mt.nodeMt so topicPath, groupMt, and projectMt getters work via the data tree.
  // MqttNode.addTopicFromTemplate delegates here and then adds the DOM element on top.
  addTopicFromTemplate(topicTemplate, groupId) {
    const groupMt = this.groups[groupId];
    if (groupMt && !groupMt.topics[topicTemplate.leaf]) {
      const mt = new MqttTopic();
      mt.fromTemplate(topicTemplate, groupId + "/" + topicTemplate.leaf, groupId, null);
      mt.nodeMt = this; // Back-reference so data-tree getters resolve without traversing the DOM
      groupMt.topics[topicTemplate.leaf] = mt;
      return true;
    }
    return false;
  }
  // Node-level topics always subscribe to the wildcard path so all subtopics route through topicValueSet.
  // Overrides the base getter which checked this.element.isNode (unreliable when element is absent).
  get topicSubscribePath() { return this.topicPath + "/#"; }
  // Human-readable node label: the value of the frugal_iot/name topic, or the raw nodeId as fallback.
  get usableName() {
    const frugaliot = this.groups["frugal_iot"];
    const nameTopic = frugaliot && frugaliot.topics["name"];
    return (nameTopic && nameTopic.state.value) || this.nodeId;
  }
  // Flat list of topics on this node matching the given types and rw, in choosetopic format.
  // Uses the data-tree groups/topics rather than MqttNode.state.topics flat index.
  topicsByType(types, rw) {
    const usableName = this.usableName;
    return Object.values(this.groups)
      .flatMap(groupMt => Object.values(groupMt.topics))
      .filter(t => types.includes(t.type) && t.rw && t.rw.includes(rw))
      .map(t => ({ name: `${usableName}:${t.usableName}`, topic: t.topicPath, setTopic: t.topicSetPath }));
  }
  // Route to the leaf MqttTopic via the data tree — O(1) lookup, no wildcard scan needed.
  // parts[0] is the groupId, parts[1] is the leaf (e.g. "temperature"); sub-paths are handled by MqttTopic.
  sendMessageToMatchingTopics(topicPath, twig, message) {
    const parts = twig.split("/");
    const groupMt = this.groups[parts[0]];
    if (!groupMt) return false;
    const leafMt = groupMt.topics[parts[1]];
    if (!leafMt) return false;
    leafMt.message_received(topicPath, message);
    return true;
  }
}

/* Manages a connection to a MQTT broker
   The broker credentials are per-organization - username is the organization id and password its
   mqtt_password, both from /config.json (or given as attributes, e.g. by an embedded page).
   Nothing is connected until they are known, which for the dashboard means until an organization
   has been chosen - see MqttWrapper.setClientCredentials.
   TODO-security this gives anyone with READ on an organization its full broker credentials, i.e. the
   ability to publish, so web-level read-only is not broker-level read-only.
*/
class MqttClient extends HTMLElementExtended {
  // This appears to be reconnecting properly, but if not see mqtt (library I think)'s README
  static get observedAttributes() { return ['server', 'username', 'password']; }

  setStatus(text) {
    this.state.status = text;
    this.renderAndReplace();
    // TODO Could maybe just sent textContent of a <span> sitting in a slot ?
  }
  /* Only load when know the server and which organization's credentials to use */
  shouldLoadWhenConnected() { return !!(this.state.server && this.state.username && this.state.password); }

  // Called from connectedCallBack when MqttWrapper.appendClient called to add MqttClient,
  // and again from attributeChangedCallback when the credentials arrive or the organization changes.
  loadContent() {
    if (mqtt_client && (mqtt_client_username !== this.state.username)) {
      // Organization changed, and each has its own broker credentials, so the connection cannot be reused.
      console.log("Reconnecting to broker as", this.state.username);
      mqtt_unsubscribe_organization(mqtt_client_username); // Leave the old organization's topics behind
      mqtt_client.end(true);
      mqtt_client = undefined;
    }
    if (!mqtt_client) {
      // See https://stackoverflow.com/questions/69709461/mqtt-websocket-connection-failed
      this.setStatus("connecting");
      mqtt_client_username = this.state.username;
      mqtt_client = mqtt.connect(this.state.server, {
        connectTimeout: 5000,
        username: this.state.username, // Organization id
        password: this.state.password, // That organization's mqtt_password
        // Remainder do not appear to be needed
        //hostname: "127.0.0.1",
        //port: 9012, // Has to be configured in mosquitto configuration
        //path: "/wss",
        // resubscribe: true // seems to be default
      });
      for (let k of ['disconnect','reconnect','close','offline','end']) {
        mqtt_client.on(k, () => {
          this.setStatus(k);
        });
      }
      mqtt_client.on('connect', () => {
        // TODO - can be smarter about this - dont want to re-subscribe as will do this automatically, BUT do want to subscribe if didn't because not connected
        // Looks like client ignores subscription BECAUSE in mqtt_client._resubscribeTopics
        this.setStatus('connected');
        if (mqtt_subscriptions.length > 0) {
          mqtt_subscriptions.forEach((s) => {
            if (!mqtt_client._resubscribeTopics[s.topic]) { // Not really public interface but cleaner console as not needed
              console.log("Now connected, subscribing to", s.topic);
              mqtt_client.subscribe(s.topic, (err) => {
                if (err) console.error(err);
              });
            }
          })
        } else {
          /* Can use for debugging - not really that useful, and it is verbose.
          mqtt_subscribe("$SYS/#", (msg) => {
            console.log("SYS", msg);
          })
           */
        }
      })
      mqtt_client.on('error', function (error) {
        console.log(error);
        this.setStatus("Error:" + error.message);
      }.bind(this));
      // Message received, iterate over mqtt_subscriptions and call cb of subscription if matches
      mqtt_client.on('message', (topic, message) => {
        // message is Buffer
        // TODO - check whether topic is string or buffer.
        let msg = message.toString();
        console.log("Received", topic, " ", msg);
        mqtt_deliver(topic, msg);
      });
    } else {
      // console.log("XXX already started connection") // We expect this, probably one time
    }
  }
  // TODO-86 display some more about the client and its status, but probably under an "i"nfo button on Org
  render() {
    return [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('details', {class: 'mqtt-client'},[
        el('summary', {}, [
          el('span', {class: 'status', textContent: this.state.status}),
            ]),
        el('span',{textContent: "server", i8n: false}),
        el('span',{textContent: ": "}),
        el('span',{textContent: this.state.server, i8n: false}),
        el('br'),
        el('span',{textContent: "organization", i8n: false}),
        el('span',{textContent: ": "}),
        el('span',{textContent: this.state.username, i8n: false}), // Username on the broker is the organization id
      ]),
    ];
  }
}
customElements.define('mqtt-client', MqttClient);
function nodeId2OrgProject(nodeid) {
  // noinspection JSUnresolvedReference
  for ( let [oid, o] of Object.entries(server_config.organizations)) {
    // noinspection JSUnresolvedReference
    for (let [pid, p] of o.projects) {
      if (p.nodes[nodeid]) {
        return [oid, pid];
      }
    }
  }
  return [null, null];
}
class MqttWrapper extends HTMLElementExtended {
  constructor() {
    super();
    this.state.elements = {}; // Pointer to specific child elements for targeted updates
  }
  static get observedAttributes() { return RECEIVER_ATTRIBUTES.concat(['organization','project','node','lang','headless']); }
  static get boolAttributes() { return ['headless']; }
  // Maybe add 'discover' but think thru interactions

  // Note this is not using the standard connectedCallBack which loads content and re-renders,
  // it is going to instead add things to the slot

  message(msg) {
    console.error(msg);
    this.append(el('div', {class: 'message', textContent: msg}));
  }
  onOrganization(e) {
    this.state.organization = e.target.value;
    this.setAttribute('organization', this.state.organization);
    this.setClientCredentials(); // Different organization means different broker credentials
    this.state.project = null;
    if (this.state.projectEl) {
      this.removeChild(this.state.projectEl);
    }
    if (this.state.organization) { // Will be false if set to "Not selected"
      this.appender();
    }
  }
  onProject(e) {
    this.state.project = e.target.value;
    if (this.state.project) { // Will be false if choose "Not selected"
      if (!this.querySelector(`mqtt-project[id="${this.state.project}"]`)) {
        this.appender();
      }
    }
  }
  appendClient() {
    // The client does not connect until setClientCredentials tells it which organization to connect as,
    // so append it whether or not an organization has been chosen yet - it also shows connection status.
    // noinspection JSUnresolvedReference
    this.state.elements.client = el('mqtt-client', {slot: 'client', server: server_config.mqtt.broker}); // typically "wss://frugaliot.naturalinnovation.org/wss"
    this.append(this.state.elements.client);
    this.setClientCredentials(); // In case the organization was already known, e.g. from the URL or a markup attribute
  }
  // Give mqtt-client the broker credentials of the currently selected organization - each organization
  // has its own account on the broker. Called whenever the organization is or becomes known; connecting
  // (or reconnecting as another organization) is then up to MqttClient.loadContent.
  setClientCredentials() {
    const org = this.state.organization;
    const clientEl = this.state.elements.client;
    if (!clientEl || !org) { return; }
    // noinspection JSUnresolvedReference
    const orgConfig = server_config.organizations[org];
    if (!orgConfig || !orgConfig.mqtt_password) {
      this.message(`No broker password for organization ${org}`); // Cannot subscribe to anything without it
      return;
    }
    // Password first: each setAttribute reconsiders connecting, and it is the change of username that
    // triggers a reconnect, so the new password must already be in place when that happens.
    clientEl.setAttribute('password', orgConfig.mqtt_password);
    clientEl.setAttribute('username', org);
  }
  // Creates the MqttTopicProject and (unless headless) its paired MqttProject DOM element.
  // Always returns the MqttTopicProject. appender() accesses the element via mt.element when needed.
  addProject(discover) {
    const twig = `${this.state.organization}/${this.state.project}`;
    const mt = new MqttTopicProject();
    if (this.state.headless) {
      mt.initialize({ type: "text", twig, headless: true });
    } else {
      // noinspection JSUnresolvedReference
      const elProject = el('mqtt-project', {discover, id: this.state.project, name: server_config.organizations[this.state.organization].projects[this.state.project].name }, []);
      mt.initialize({ type: "text", twig, element: elProject });
      elProject.mt = mt;
      this.append(elProject);
    }
    mt.subscribe();
    this.state.elements["project"] = mt; // Store MqttTopicProject directly
    return mt;
  }

  // Returns the MqttTopicProject for the currently active project.
  get projectMt() { return this.state.elements["project"]; }
  appender() {
    // At this point could have any combination of org project or node
    if (this.state.node) { // n
      if (!this.state.organization || !this.state.project) {   // n, !(o,p)
        let [o,p] = nodeId2OrgProject(this.state.node);
        if (!o) {
          this.message(`${getString("Unable to find node")}=${this.state.node}`);
          return;
        } else {
          this.state.organization = o;
          this.state.project = p;
        }
      } // Drop through with n & o & p
      const mt = this.addProject(false);
      if (this.state.headless) {
        mt.addNode(this.state.node);
      } else {
        mt.element.valueSet(this.state.node, true); // Create node on project along with its MqttNode
      }
    } else { // !n
      if (!this.state.project)  { // !n !p ?o
        if (!this.state.organization) { // !n !p !o
          // noinspection JSUnresolvedReference
          this.append( // TODO-14 merge with organization dropdown in mqtt-admin and add to mqtt-login and mqtt-register
            el('div', {class: 'dropdown'}, [
              el('label', {for: 'organizations', textContent: "Organization"}),
              el('select', {id: 'organizations', onchange: this.onOrganization.bind(this)}, [
                el('option', {value: "", textContent: "Not selected", selected: !this.state.value}),
                Object.entries(server_config.organizations).map( ([oid, o]) =>
                  el('option', {value: oid, textContent: `${oid}: ${o.name}`, selected: false}),
                ),
              ]),
            ]));
        } else { // !n !p o
          // noinspection JSUnresolvedReference
          this.append( this.state.projectEl =
            el('div', {class: 'dropdown'}, [
              el('label', {for: 'projects', textContent: "Project"}),
              el('select', {id: 'projects', onchange: this.onProject.bind(this)}, [
                el('option', {value: "", textContent: "Not selected", selected: !this.state.value}),
                Object.entries(server_config.organizations[this.state.organization].projects).map(([pid,p]) =>
                  el('option', {value: pid, textContent: (p.name ? `${pid}: ${p.name}` : pid), selected: false})
                ),
              ]),
            ]));
        }
      } else { // !n p ?o
        // noinspection JSUnresolvedReference
        if (!this.state.organization) {
          // noinspection JSUnresolvedReference
          let o = Object.entries(server_config.organizations).find( o => o[1].projects[this.state.project]);
          if (!o) {
            this.message(`${getString("Unable to find project")}=${this.state.project}`, false);
            return;
          } else {
            this.state.organization = o[0];
          }
        } // drop through with !n p o
        const mt = this.addProject(true);
        // noinspection JSUnresolvedReference
        const nodes = Object.entries(server_config.organizations[this.state.organization].projects[this.state.project].nodes || {});
        if (this.state.headless) {
          nodes.filter(([id, nc]) => id !== '+' && nc.lastseen)
            .forEach(([id]) => { if (!mt.nodes[id]) mt.addNode(id); });
        } else {
          mt.element.nodesFromConfig(nodes);
        }
      }
    }
  }
  connectedCallback() {
    // TODO-22 security this will be replaced by a subset of config.yaml,
    //  that is public, but in the same format, so safe to build on this for now
    // This should always succeed because index.html would have redirected to login.html if not logged in
    GET("/config.json", {}, (err, json) => {
      if (err) {
        //if (err.message.includes("401")) { // This can happen if accessing from service worker which has /dashboard cached
          redirectToLogin();
        //} else {
        //  this.message(err);
        //}
        return;
      } else { // got config
        configSet(json);
        this.loadAttributesFromURL();
        this.appendClient();
        this.appender();
        this.state.ready = true;
        if (this.state.pendingOrganization) { // setOrganization() was called before we were ready to act on it
          const org = this.state.pendingOrganization;
          this.state.pendingOrganization = null;
          this.setOrganization(org);
        }
      }
      this.renderAndReplace(); // TODO check, but should not need to renderAndReplace as render is (currently) fully static
    });
    //super.connectedCallback(); // Not doing as finishes with a re-render.
  }
  // Public entry point for other components (e.g. mqtt-admin's shared organization dropdown) to drive
  // this wrapper's organization from outside, without waiting on its own connectedCallback race.
  // TODO-14 merge with organization dropdown in mqtt-admin and add to mqtt-login and mqtt-register
  setOrganization(org) {
    if (!this.state.ready) {
      this.state.pendingOrganization = org;
      return;
    }
    if (!org || (this.state.organization === org)) { return; }
    const orgSelect = this.querySelector('#organizations');
    if (orgSelect) { orgSelect.value = org; }
    this.onOrganization({target: {value: org}});
  }
  changeAttribute(name, value) {
    if (name === "lang") {
      if (value.includes(',')) {
        preferedLanguages = (value.split(',')).map(v => v.toUpperCase());
      } else if(!value) {
        preferedLanguageSet('EN');
        locationParameterChange("lang", preferedLanguages.join(','));
      } else {
        preferedLanguageSet(value.toUpperCase());
      }
    }
    super.changeAttribute(name, value);
  }
  render() {
    return [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: 'outer mqtt-wrapper'}, [
        el('slot', {name: 'client'}),
        el('slot'),
      ]),
    ];

  }
}
customElements.define('mqtt-wrapper', MqttWrapper);

export {
  CssUrl,
  DEFAULT_REPORT_INTERVAL_MS,
  ImagesUrl,
  MqttTopic,
  MqttTopicGroup,
  MqttTopicNode,
  MqttTopicProject,
  POST,
  RECEIVER_ATTRIBUTES,
  Watchdog,
  XXX,
  addVocabulary,
  configSet,
  el,
  getString,
  getStringFrom,
  leafAttribute,
  locationParameterChange,
  mqtt_client,
  mqtt_deliver,
  mqtt_subscribe,
  mqtt_unsubscribe_organization,
  nextUniqueId,
  nowMs,
  preferedLanguageSet,
  preferedLanguages,
  redirectToLogin,
  relativeTime,
  SUMMARY_CHIP_LIMIT,
  server_config,
  setClock,
  topicMatches,
  unitSuffix,
  unitSymbol,
};
