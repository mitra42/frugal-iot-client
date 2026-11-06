/*
 * Frugal IoT client - core: the MQTT connection, the topic data tree, i18n, and the element builder.
 *
 * Everything a page needs to build and read the data tree, and the only one of these modules that imports none of the
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
// Messages closer together than this are one report arriving, not two reports
const REPORT_BURST_MS = 2000;
// However chatty a node is, do not call it stale for a gap shorter than this
const MIN_REPORT_INTERVAL_MS = 60000;
// How many chips a summary line falls back to when the device does not declare its own. Enough for
// temperature + humidity + air quality + a control; a declared summary: list is not capped at all.
const SUMMARY_CHIP_LIMIT = 4;
// How many of a module's own readings its summary shows, when it has no better idea
const SUMMARY_READINGS_PER_MODULE = 2;
// A label for the next auto-generated element. A function because an imported binding cannot be
// assigned to, and MqttChooseTopic lives in another module.
function nextUniqueId() { return ++unique_id; }
// Shared so MqttWrapper can extend the list without importing MqttReceiver - it does not subclass it,
// it only wants the same attributes observed.
const RECEIVER_ATTRIBUTES = ['value','color','type','label','topic','graphable','wired','wiring'];
let server_config;  // { user, organizations, logger, mqtt, server } - note loaded by MqttWrapper OR MqttAdmin

// An embedded page loads no /config.json, so assume the logger is on the server these modules came from
function loggerUrl() {
  return server_config?.logger?.url ?? new URL('/data', import.meta.url).href;
}

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

/*
 * Say what the broker made of a subscription.
 *
 * A broker that REFUSES one does not report an error: MQTT 3.1.1 answers with SUBACK return code
 * 0x80, which mqtt.js hands back as granted qos 128 in the second argument. Checking only `err`
 * therefore made a refusal completely silent - "Subscribing to X" and then nothing, for ever,
 * looking exactly like a topic nobody publishes to. That is the difference between "no permission"
 * and "no data", and it is the first thing you want to know.
 */
function subscribeResult(topic, err, granted) {
  if (err) { console.error("Subscribe failed", topic, err); return; }
  const refused = (granted || []).filter((g) => g.qos === 128);
  if (refused.length) {
    console.error(`Subscribe REFUSED by the broker: ${topic} - this login's broker account has no `
      + `permission for it. Its rights are set when it logs in; a permission added since then `
      + `needs a fresh login, or "frugal-iot-rebuild-dynsec" on the server.`);
  }
}

/*
 * Subscribe to a topic.  cb(topic, message, retained) - see mqtt_deliver, which passes all three.
 *
 * A trailing "/#" works. A "+" anywhere does NOT: topicMatches understands only the trailing form,
 * so the broker would deliver the messages and none of them would reach cb. Subscribe to each
 * concrete topic instead, or teach topicMatches about "+".
 */
function mqtt_subscribe(topic, cb) { // cb(topic, message, retained)
  console.log("Subscribing to ", topic);
  mqtt_subscriptions.push({topic, cb});
  // There may be no client yet - it only connects once it knows which organization's credentials to use
  if (mqtt_client && mqtt_client.connected) {
    mqtt_client.subscribe(topic, (err, granted) => subscribeResult(topic, err, granted))
  } else {
    console.log("Delaying till connected"); // It will resubscribe from "subscriptions"
  }
}
// A second, short-lived connection to the broker, with a clean session.
//
// Retained messages are delivered when a subscription is made, so collecting them needs a
// subscription the page does not already hold - and making it on the page's own connection would
// feed every retained value back through the data tree as though it had just arrived, adding
// duplicate points to graphs. This is also the only place the retain flag on an incoming packet is
// visible: mqtt_deliver below drops it, because nothing else needs it.
//
// The caller owns the returned client and must end() it.
// Uses this user's own credential, the same one the page's main connection uses - the organization
// is no longer part of authenticating, only of the topic pattern the caller asks for.
function mqttTempConnect() {
  const me = server_config && server_config.user;
  if (!me || !me.mqtt_username || !me.mqtt_password || !server_config.mqtt) return null;
  return mqtt.connect(server_config.mqtt.broker, {
    username: me.mqtt_username, password: me.mqtt_password,
    clean: true,          // a fresh session, so the broker replays what it holds
    reconnectPeriod: 0,   // one attempt: this is a question, not a subscription to keep
  });
}

// Everything an organization holds is under its own name, so a pattern is written relative to it -
// "lotus/+/sht30" rather than "dev/lotus/+/sht30". Empty means everything.
function retainedPattern(org, relative) {
  const rest = (relative || '#').trim().replace(/^\/+/, '');
  return `${org}/${rest || '#'}`;
}

/*
 * The broker's host name, out of the URL a browser connects with.
 *
 * They are not the same thing and a node needs the host. A browser is given something like
 * "wss://frugaliot.naturalinnovation.org/wss" - a WebSocket URL, through the reverse proxy - while
 * firmware opens a plain TCP connection to the host on 1883 and resolves that string as a DNS name.
 * Handing the URL to configure_mqtt_enrolled() gets "DNS Failed ... error -54" and a node that
 * enrols and then never connects, which is how this was found.
 */
function brokerHost(url) {
  return String(url || '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')   // scheme
    .replace(/\/.*$/, '')                      // path
    .replace(/:\d+$/, '');                     // port
}

// Route a received message to every matching subscription.
// Separate from the client's on('message') so a test or mock can inject messages with no broker.
function mqtt_deliver(topic, msg, retained) {
  // Mostly MqttTopicNode wildcards, which route the rest of the topic down their tree
  for (let o of mqtt_subscriptions) {
    if (topicMatches(o.topic, topic)) { // Matches trailing wildcards, but not middle ones
      o.cb(topic, msg, retained);
    }
  }
}
// Drop one subscription, made with mqtt_subscribe, that was only wanted for a while.
function mqtt_unsubscribe(topic) {
  mqtt_subscriptions = mqtt_subscriptions.filter((s) => s.topic !== topic);
  if (mqtt_client && mqtt_client.connected) {
    mqtt_client.unsubscribe(topic, (err) => { if (err) console.error(err); });
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
  if (!Number.isFinite(ms)) return ''; // Intl throws rather than returning anything for NaN
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'narrow' });
  const s = Math.round(ms / 1000);
  if (Math.abs(s) < 60) return rtf.format(-s, 'second');
  const m = Math.round(s / 60);
  if (Math.abs(m) < 60) return rtf.format(-m, 'minute');
  const h = Math.round(m / 60);
  if (Math.abs(h) < 24) return rtf.format(-h, 'hour');
  return rtf.format(-Math.round(h / 24), 'day');
}

// What this user may do in an organization, or in one project of it, from the permissions the server
// sent with the config.
//
// This USED to be no kind of boundary: every user of an organization connected to the broker with
// the same credentials, so anyone without WRITE still held working publish credentials. It is now
// backed by the broker - each user has their own account, in a group per capability - so hiding a
// control here and the broker refusing the publish are two expressions of the same permission
// rather than a hope and a fact. This is still the wrong place to rely on: the broker is what
// enforces it, and this only decides what to show.
//
// A permission row with no project covers the whole organization, so it answers yes for any project.
function hasCapability(org, capability, project) {
  const perms = (server_config && server_config.user && server_config.user.permissions) || [];
  return perms.some((p) => (p.capability === capability) && (p.org === org)
    && (!project || !p.project || (p.project === project)));
}

/* Resolve a module id to its schema entry in modules.yaml.
 *
 * An exact match wins. Failing that, a numbered or suffixed INSTANCE falls back to its base
 * module: a node with several probes or several irrigation sectors publishes `soil1`, `soil2`,
 * `sector1`... and modules.yaml should not have to carry a near-duplicate entry for each one.
 * Without this, every such reading landed in the card's "Not in the schema" section with no name,
 * units, colour or range - and `soil1` in particular was on the legacy-drop list in
 * topicValueSet(), so its readings were discarded outright.
 *
 * The suffix must be all digits (`soil1`) or start with a separator (`soil_north`, `soil-2`).
 * A bare-word suffix is NOT accepted, so a module genuinely called `door` does not silently
 * resolve to the `do` (dissolved oxygen) template. Longest prefix wins, so `soilmodbus1` finds
 * `soilmodbus` rather than `soil`.
 */
function moduleBaseId(groupId) {
  const modules = (server_config && server_config.schema && server_config.schema.modules) || {};
  if (modules[groupId]) return groupId;
  let best = null;
  for (const key of Object.keys(modules)) {
    if ((groupId.length > key.length) && groupId.startsWith(key)
        && (best === null || key.length > best.length)) {
      const suffix = groupId.substring(key.length);
      if (/^[0-9]+$/.test(suffix) || /^[-_]/.test(suffix)) best = key;
    }
  }
  return best;
}
function moduleTemplate(groupId) {
  const base = moduleBaseId(groupId);
  return base && server_config && server_config.schema && server_config.schema.modules[base];
}
// The part that distinguishes one instance from another - "1" for soil1, "north" for soil_north,
// "" for an exact match. Used to tell the instances apart by name in the UX.
function moduleInstanceSuffix(groupId) {
  const base = moduleBaseId(groupId);
  return (base && (base !== groupId)) ? groupId.substring(base.length).replace(/^[-_]/, '') : '';
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
  // Order by the BASE module, so soil1/soil2/soil3 sort together where `soil` sits rather than
  // scattering to the end of the card as unknowns
  const i = Object.keys(modules).indexOf(moduleBaseId(groupId));
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
// A widget's input lives in a shadow root, so the event a card sees has been retargeted to the
// host - composedPath()[0] is the only way back to the real input.
function isEditableTarget(e) {
  const t = (e.composedPath && e.composedPath()[0]) || e.target;
  if (!t || !t.tagName) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable;
}
// =============================== Languages and Internationalization ===============================
// Every language the picker offers. Each but English has a file in languages/; a key is its own
// English text, so English needs none. No flag where the language belongs to no one country.
const languageIndex = {
  en: { name: 'English', flag: '🇬🇧' },
  fr: { name: 'Français', flag: '🇫🇷' },
  hi: { name: 'हिंदी', flag: '🇮🇳' },
  id: { name: 'Bahasa Indonesia', flag: '🇮🇩' },
  ar: { name: 'العربية', dir: 'rtl' },
  es: { name: 'Español', flag: '🇪🇸' },
  pt: { name: 'Português', flag: '🇧🇷' },
  sw: { name: 'Kiswahili' },
  de: { name: 'Deutsch', flag: '🇩🇪' },
  tl: { name: 'Tagalog', flag: '🇵🇭' },
  zh: { name: '中文', flag: '🇨🇳' }, // Simplified - zh-TW and zh-HK get it too until there is a Traditional file
};
// Other codes browsers send for a language the index has under one name: Chrome and Safari call
// Tagalog "fil", Filipino.
const languageAliases = { fil: 'tl' };
// Vocabulary by language code: the one in use, and whatever a dashboard adds with addVocabulary.
const languages = {};

function browserLanguages() {
  return (navigator.languages && navigator.languages.length) ? [...navigator.languages] : [navigator.language].filter(Boolean);
}
// A code from ?lang= or a browser, as the index has it: exact first, then just the language, so
// fr-CA finds fr. Null when the index has neither.
function languageMatch(code) {
  if (!code) return null;
  const c = code.trim().toLowerCase();
  if (languageIndex[c]) return c;
  const primary = c.split('-')[0];
  const known = languageAliases[primary] || primary;
  return languageIndex[known] ? known : null;
}
// The picker's choice, so it survives a link without ?lang=. A convenience only: localStorage throws
// in some private modes, and losing it just falls back to the browser's languages.
const LanguageKey = 'frugaliot:language';
function storedLanguage() {
  try { return localStorage.getItem(LanguageKey); } catch (e) { return null; }
}
// Fixed for the life of the page - its file has to be loaded before anything renders, so a change
// reloads with a new ?lang=. That comes first, then the picker's last choice, then the browser's own
// preferences in order; a legacy list (?lang=FR,EN) takes its first.
const language = languageMatch((new URL(window.location.href).searchParams.get('lang') || '').split(',')[0])
  || languageMatch(storedLanguage())
  || browserLanguages().map(languageMatch).find(Boolean)
  || 'en';
const languageDir = languageIndex[language].dir || 'ltr';
document.documentElement.lang = language;
document.documentElement.dir = languageDir;
// A number with its unit, or a name, reads left to right even inside Arabic: without the isolate
// "23.5 °C" in a right-to-left sentence shows as "C° 23.5". Left-to-right pages get the string as is.
function bidiIsolate(s) {
  return (languageDir === 'rtl') ? `\u2066${s}\u2069` : s;
}
function addVocabulary(langs) {
  // Accepts an object e.g. { FR: { word: 'mot' } }, or a YAML string in the same format. Merges into
  // existing language entries; adds new languages wholesale.
  if (typeof langs === 'string') langs = yaml.load(langs);
  for (const [lang, words] of Object.entries(langs)) {
    const code = lang.toLowerCase();
    if (languages[code]) {
      Object.assign(languages[code], words);
    } else {
      languages[code] = words;
    }
  }
}
// Top-level await, so the vocabulary is complete before any module importing this one renders. A
// file that fails to load leaves every string as its key, which is English, rather than no page.
if (language !== 'en') {
  try {
    const response = await fetch(new URL(`languages/${language}.yaml`, import.meta.url));
    if (!response.ok) throw new Error(`${response.status} ${response.url}`);
    addVocabulary({ [language]: yaml.load(await response.text()) });
  } catch (err) {
    XXX(["Cannot load language", language, err]);
  }
}
function hasTranslation(tag) {
  const words = languages[language];
  return !!words && Object.hasOwn(words, tag);
}
// A miss shows the tag, which is English. A phrase is tried word by word first, because some reach
// here by routes the client does not control - schema names, values from a node.
function getString(tag) {
  if (typeof tag !== 'string') { XXX(["getString given a non-string", tag]); return tag; }
  if (hasTranslation(tag)) return languages[language][tag];
  // Logged whole, before the words are tried, so a missing sentence shows as itself
  if (language !== 'en') XXX(["Cannot translate ", tag, ' into ', language]);
  if (tag.includes(' ')) return tag.split(' ').map(getString).join(' ');
  return tag;
}
// A name dropped into translated prose. The placeholder rather than concatenation, because where
// the name falls in the sentence is the translation's decision, not this caller's.
function getStringWith(tag, value) {
  return getString(tag).replace('%s', bidiIsolate(String(value)));
}

// server_config is assigned from /config.json in normal use; funnelled through here so a mock or
// test can supply the same shape without a server.
function configSet(json) {
  server_config = json;
}
// List of tags to try and translate
const i8ntags = {
  a: ["textContent", "title"],
  label: ["textContent"],
  button: ["textContent", "title"],
  span: ["textContent", "title"],
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
  img: ["alt"],
}
// Local version of EL
function el(tag, attributes = {}, children) {
  //console.log(attributes);
  if (attributes['i8n'] !== false) { // Add i8n: false if know the field is untranslatable (e.g. a name)
    // noinspection JSUnusedLocalSymbols
    Object.entries(attributes)
      .filter(([k, unused]) => i8ntags[tag] && i8ntags[tag].includes(k))
      // An exact key always translates. The rest only keep non-prose away from the word-by-word fallback
      .filter(([unused, v]) => v && typeof v === 'string' && (
        hasTranslation(v) || (
          !v.includes(':') &&  // e.g.  dev: Development
          !v.includes('/') && // e.g. dev/developers
          'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.includes(v[0])
        )
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
function DELETE(httpurl, body, cb) {
  /**
   * DELETE, with a JSON body saying which one, and cb(err, json)
   */
  requestJSONp('DELETE', httpurl, body)
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

class LanguagePicker extends HTMLElementExtended {

  constructor() {
    super();
    this.state={};
  }
  // compact: show just the flag. The name is nice to have, but on a narrow header it is the first
  // thing that can go - a flag still says which language is selected.
  static get observedAttributes() { return ['compact']; }
  static get boolAttributes() { return ['compact']; }

  onchange(ev) {
    try { localStorage.setItem(LanguageKey, ev.target.value); } catch (e) { XXX(`language save: ${e.message}`); }
    locationParameterChange("lang", ev.target.value);
  }
  // Compact is the flag alone, or the code where there is no flag to stand for the language
  labelFor(code, {name, flag}) {
    if (this.state.compact) return flag || code.toUpperCase();
    return flag ? `${name} ${flag}` : name;
  }
  render() {
    return [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('select', {class: "language-picker", onchange: this.onchange.bind(this)},
        Object.entries(languageIndex).map(([k,v]) =>
          EL('option', {value: k, textContent: this.labelFor(k, v), selected: k === language}))
      ),
    ];
  }
}
customElements.define('language-picker', LanguagePicker);

class MqttTopic {
  // Manages a single topic - keeps track of data it has seen, and can create UI element or graphdataset for it
  // Note this intentionally does NOT extend HtmlElement or MqttElement etc
  // Encapsulate a single topic, mostly this will be built during the discovery process,
  // but could also be built by hard coded UI if doesn't exist

  // Creation & initialization =========
  constructor() {
    this.data = []; // Tracks previous values of this topic - used for graphing
    /* For what this publishes - "set/..." commands to a node. QoS 1 so the broker holds them for a
     * node that is asleep, until it reconnects to its persistent session; QoS 0 is dropped for anyone
     * not connected at that moment. Not retained: the node writes a set value to its own flash, and
     * a retained command would be replayed at every fresh subscribe, e.g. each reboot.
     */
    this.qos = 1;
    this.retain = false;
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
  fromTemplate(topicTemplate, twig, group) {
    // topic, name, type, display, rw, min, max, color, options,
    this.initialize(topicTemplate);
    this.group = group // e.g. "sht"
    this.twig = twig;  // e.g. "sht/temperature"
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

  // Project-level MqttTopicProject. Reached via nodeMt._projectMt, which is set on all MqttTopicNode
  // objects by MqttTopicProject.addNode.
  get projectMt() {
    return this._projectMt || (this.nodeMt && this.nodeMt._projectMt);
  }
  get leaf() { // e.g. temperature
    return this.twig.split("/").pop();
  }
  // e.g. org/project/node/group/leaf; for node/project topics nodeMt is absent and twig is the full path.
  // nodeMt is set on all leaf topics by MqttTopicNode.addTopicFromTemplate.
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
    //noinspection JSUnresolvedVariable
    // should only happen for embedded as normally subscribe to wildcard at topic level
    switch (this.rw) { // Note for project this will be undefined
      case 'w': // Note should not be happening as subscribing at node level
        return this.topicSetPath;
      default:
        return this.topicPath;
    }
  }
  // The organization this topic belongs to - the first segment of its path
  get organization() {
    const path = this.topicPath;
    return path && path.split('/')[0];
  }
  // The project this topic belongs to - the second segment of its path. Needed because a permission
  // can be scoped to one project of an organization.
  get project() {
    const path = this.topicPath;
    return path && path.split('/')[1];
  }
  // Whether this user may change this topic. One question, asked in one place, so a control cannot
  // end up editable on one screen and not another - see CARDS_PLAN.md section 3.2.
  get canWrite() {
    // An embedded widget has no server config and so no permission list - the MQTT credentials on
    // the page are the only gate, and the broker is what enforces those.
    if (this.standalone) return true;
    return hasCapability(this.organization, 'WRITE', this.project);
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
    // null is "the sensor reported that it has no reading" - worth showing as such, and
    // different from never having reported at all, which stays blank.
    if (v === null) return '\u2014'; // em dash
    if (v === undefined || v === '') return '';
    // A bool is a state, not a word: "true" in a summary reads as a bug rather than as a relay
    // being on, and ✓/✗ is what the rest of the UI already uses for one
    if (typeof v === 'boolean') return v ? '✓' : '✗';
    if (typeof v !== 'number') return String(v);
    return bidiIsolate(v.toFixed(this.decimals) + unitSuffix(this.units));
  }
  // The sensor said it has no reading, by publishing "nan" - see valueFromText. Distinct from
  // outOfRange below, which is a real reading that falls outside its declared min/max: a sensor
  // may legitimately report an extreme value and that value is information, not an error.
  // Never-reported topics are not invalid - state.value is undefined then, not null.
  get invalid() {
    return this.state.value === null;
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
  // Only meaningful when this topic represents a project; populated by MqttTopicProject.addNode.
  get nodes() { return this._nodes || (this._nodes = {}); }

  // Lazy-initialised map of leaf → MqttTopic.
  // Used by MqttTopicGroup to hold its leaf topics; not meaningful on node-level topics.
  get topics() { return this._topics || (this._topics = {}); }

  // Lazy-initialised map of groupId → MqttTopicGroup for this node.
  // Only meaningful when this topic represents a node; populated by MqttTopicNode.addGroupFromTemplate.
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
        case "exponential": {
          // "nan" is Frugal-IoT's on-the-wire form for "this sensor currently has no reading" -
          // a failed read, an absent device, a validate() that rejected the value. See "Invalid
          // readings" in the node library's CLAUDE.md. null rather than NaN, so that it can be
          // tested for: every comparison against NaN is false, and toFixed(NaN) renders the
          // literal string "NaN" into the card.
          const n = Number(message);
          return Number.isNaN(n) ? null : n;
        }
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

  // Called by a subscription, or by MqttTopicNode routing a message down to this topic
  message_received(topic, message) {
    if (this.element) {
      if (this.element.topicValueSet(topic, message)) {
        //XXX(["rerendering - possibly unnecessarily - on",topic,message]); // Should only be on MqttTopic (ok) and MqttSlider (needs work)
        this.element.renderAndReplace(); // TODO note gradually replacing need to rerender by smarter valueSet() on different subclasses
      }
    } else {
      // No element bound - the usual case: update the data tree directly (also reached by detached MqttGraphDataset topics).
      // topicSetPath throws if nodeMt is null, so guard the startsWith call with nodeMt.
      // The node publishes its own wired paths on the read path, the UX writes them on the set path.
      const isParam = this.nodeMt
        && (topic.startsWith(this.topicPath + '/') || topic.startsWith(this.topicSetPath + '/'));
      if (isParam) {
        // Parameter subtopic arriving (e.g. now/wired, temperature/max).
        if (topic.split('/').pop() === 'wired') this.setWired(message);
      } else {
        // Value arriving on this topic's own path, its set-path, or its wired source.
        const value = this.valueFromText(message);
        this.data.push({value, time: nowMs()});
        this.state.value = value; // Keep state.value current so usableName, wiredTopic, etc. work with no element
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
        display: true, // Chart.js hides a scale title unless asked - without this the axis has no label at all
        // noinspection JSUnresolvedReference
        color: this.color,  // The family colour; the per-line variation happens in MqttGraph.addDataset
        font: { size: 20 },
        // The unit is what tells two axes apart when both read as a number - "Temperature (°C)"
        // noinspection JSUnresolvedReference
        text: getString(this.name.replace(/[0-9]+$/,'')) + (unitSymbol(this.units) ? ` (${unitSymbol(this.units)})` : ''),
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
        // fullName, not name - the legend has to say which device a reading came from
        label: this.fullName,
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
    mqtt_client.publish(this.topicWiredPath, val, {retain: this.retain, qos: this.qos});
  }
  // Adds historical data to the chart - typically chart updates data for each line, then updates the chart.
  addDataFrom(filename, first, cb) {
    //TODO this location may change
    // noinspection JSUnresolvedReference
    let filepath = `${loggerUrl()}/${this.topicPath}/${filename}`;
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

// Stands in for MqttTopicNode on a page with no discovery tree - index-embedded.html has no
// mqtt-wrapper, so a widget given a full topic path has no real node to hang off. Everything
// derived on MqttTopic reaches the node through nodeMt, so this is what makes topicPath work.
class MqttNodeStandalone {
  constructor(topicPath) {
    this.topicPath = topicPath;
    this.groups = {}; // groupMt indexes into this; an embedded page has no groups
  }
  get usableName() { return this.topicPath.split("/").pop(); }
}

// Build a lone MqttTopic from a full path, for an embedded widget with no tree behind it.
function standaloneTopic(topicPath, o = {}) {
  const parts = topicPath.split("/");
  const nodePath = parts.splice(0, 3).join("/"); // org/project/node
  const mt = new MqttTopic();
  mt.initialize(o);
  mt.nodeMt = new MqttNodeStandalone(nodePath);
  mt.twig = parts.join("/");
  mt.group = parts[0];
  mt.standalone = true;
  return mt;
}

// Group-level data node in the topic tree. Holds the leaf MqttTopics for one module group.
// Subclass of MqttTopic so it can be stored in and navigated via the same tree.
// topics: { leaf → MqttTopic } — inherited lazy map via get topics().
class MqttTopicGroup extends MqttTopic {
  // Values roll up here as they arrive - see the groupMt.state[leafAttr] assignments in
  // MqttTopic.message_received and MqttReceiver.topicValueSet - so a summary can be built with no
  // DOM at all. That is why this lives on the data tree and not on the group element.
  // The module's own readings, formatted by the schema. This is what §4.1 always said the fallback
  // should be, and it means every module has a summary rather than only the ten that had one written
  // by hand - a device with no devices.yaml entry used to show a blank line if its modules happened
  // to be among the other twenty. Overridden below only where a list of values is the wrong shape.
  summaryReadings() {
    return Object.values(this.topics)
      .filter((mt) => mt.graphable && (mt.rw === 'r'))
      .map((mt) => mt.formatted)
      .filter(Boolean);
  }
  // How many items this group's chip can hold. A subclass writing its own sentence shows one thing
  // however much room the line has, so it says so and the spare goes to a module that can use it.
  get summaryCapacity() { return this.summaryReadings().length; }
  summaryText(limit = SUMMARY_READINGS_PER_MODULE) {
    const shown = this.summaryReadings();
    return shown.length ? shown.slice(0, limit).join(' ') : null;
  }
  // The chip form, for the one-line summary. Same as summaryText for a sensor, but a control's
  // rule is a sentence and a summary wants "Relay ✓", not "Relay = SHT:Temperature > 32 +/- 3 ✓".
  summaryShort(limit) {
    return this.summaryText(limit);
  }
  trueFalseSymbol(val) {
    return (val === undefined) ? '?' : (val ? '✓' : '✗');
  }
}
class MqttTopicGroupRelay extends MqttTopicGroup {
  get summaryCapacity() { return 1; }   // one sentence, however much room there is
  // Named, because a lone ✓ on a summary line does not say what is on
  summaryText() {
    return `${this.state.name} ${this.trueFalseSymbol(this.state.on)}`
  }
}
class MqttTopicGroupOta extends MqttTopicGroup {
  get summaryCapacity() { return 1; }   // one sentence, however much room there is
  summaryText() {
    return `${this.state.key}`
  }
}
class MqttTopicGroupControlHysteresis extends MqttTopicGroup {
  get summaryCapacity() { return 1; }   // one sentence, however much room there is
  // A wired input shows the name of what it is wired to, rather than the value copied from it
  nameOrValue(val, wired) {
    const projMt = this.projectMt;
    return wired && projMt && projMt.findTopic(wired) && projMt.findTopic(wired).usableName || val;
  }
  summaryText() {
    let hysteresis = this.state.hysteresis || 0
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
// Only the modules whose summary is not simply a list of their readings. Everything else - and that
// is most of the schema - gets the generic MqttTopicGroup.summaryText above. This is what L-3 set out
// to achieve; it needed a sensible default rather than a list in every module.
const topicGroupClasses = {
  relay: MqttTopicGroupRelay,                        // wants its name beside the tick
  ota: MqttTopicGroupOta,                            // a key, not a reading
  controlhysteresis: MqttTopicGroupControlHysteresis, // a rule, not a list of values
};

// Project-level data node in the topic tree. Receives discovery messages and creates nodes.
// Created by MqttWrapper.addProject.
class MqttTopicProject extends MqttTopic {
  // Route directly on the data-tree object rather than through the element.
  // base MqttTopic.message_received routes through this.element.topicValueSet, which is wrong at project level.
  message_received(topicPath, message) {
    this.topicValueSet(topicPath, message);
    if (this.graphdataset) this.graphdataset.dataChanged(); //TODO-73 cant think why project has a dataset?
  }
  // Handle a discovery message. Creates a new node if not yet seen.
  topicValueSet(topicPath, message) {
    const val = this.valueFromText(message);
    if (!this.nodes[val]) this.addNode(val);
  }
  // Creates the MqttTopicNode for a node id.
  addNode(id) {
    const topicPath = `${this.topicPath}/${id}`;
    const mt = new MqttTopicNode();
    mt.initialize({ type: "yaml", twig: topicPath });
    mt._groups = {};
    mt._projectMt = this;
    mt.nodeId = id;
    this.nodes[id] = mt;
    mt.subscribe();
    document.dispatchEvent(new CustomEvent('frugaliot:topicschanged', { detail: { project: this } }));
    return mt;
  }
}

// Node-level data node in the topic tree. Routes incoming MQTT messages to the correct leaf MqttTopic.
// Always created by MqttTopicProject.addNode.
class MqttTopicNode extends MqttTopic {
  /*
   * Route directly on the data-tree object rather than through the element.
   *
   * A RETAINED delivery updates the values but does not count as having heard from the node. Nodes
   * publish almost everything retained, so subscribing produces a flood of last-known values
   * whatever state the node is in - and treating those as "just seen" made a device that died
   * weeks ago read as live, on any server whose logger had restarted since. The honest answer for
   * such a node is that we do not know when it last spoke, which is what an unset lastMessageAt
   * already says ("never"); config.json's lastseen fills it in where the logger does know.
   */
  message_received(topicPath, message, retained) {
    if (!retained) this.noteMessage();
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
    if (["wifistrength", "climate/temp_now", "climate/temp_out", "climate/temp_setpoint", "climate/temperature", "climate/humidity","frugal-iot/reboot", "buttons", "messages", "now/now"].some(s => s === twig || twig.includes(s + "/"))) {
      XXY(["legacy twig will go away after reboot", twig]);
      return false;
    }
    const parts = twig.split("/");
    const groupId = parts[0];
    // Auto-create group from template if it hasn't been seen yet
    if (!this.groups[groupId]) {
      if (this.addGroupFromTemplate(groupId)) {
        document.dispatchEvent(new CustomEvent('frugaliot:topicschanged', { detail: { project: this._projectMt } }));
      }
    }
    let matched = this.sendMessageToMatchingTopics(topicPath, twig, message);
    // No match — try to add the topic from a template and route again
    if (!matched) {
      const leaf = parts[1];
      let t = server_config.schema.topics[leaf];
      const guessName = leaf.replace("_", " ");
      if (
        (!t && ["_now", "_setpoint", "_limit", "_hysteresis","_hyst"].some(suffix => leaf.endsWith(suffix)))
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
        if (this.addTopicFromTemplate(t, groupId)) {
          document.dispatchEvent(new CustomEvent('frugaliot:topicschanged', { detail: { project: this._projectMt } }));
        }
        if (!this.sendMessageToMatchingTopics(topicPath, twig, message)) {
          XXX(["Even after adding topic from template, no destination for", twig]);
          this.noteUnrecognised(twig, message);
        }
      } else {
        XXX(["Unrecognized twig at ", topicPath]);
        this.noteUnrecognised(twig, message);
      }
    }
  }
  // ===== What the cards read. All of this works with no DOM, which is the point. =====

  // Learn the reporting interval as messages arrive, with no timer, so status can be reasoned about and tested.
  noteMessage() {
    const now = nowMs();
    if (this.lastMessageAt) {
      const delta = now - this.lastMessageAt;
      // A node publishes its whole set of topics at once, so most gaps between messages are
      // milliseconds - that is one report arriving, not how often it reports. Learning from those
      // collapsed the interval to nearly nothing, and every device then read as offline seconds
      // after reporting. Only a gap longer than a burst says anything about the interval.
      if (delta > REPORT_BURST_MS) {
        this.expectedInterval = this.expectedInterval ? (this.expectedInterval * 2 / 3) + (delta / 3) : delta;
      }
    }
    this.lastMessageAt = now;
  }
  // null, or a number - never NaN. Anything that cannot be subtracted from means we do not know
  // when this node was last heard from, which is what "never" already says.
  get age() {
    return Number.isFinite(this.lastMessageAt) ? nowMs() - this.lastMessageAt : null;
  }
  // live | stale | offline | never. A device that has never said anything is not the same as one
  // that has gone quiet, and a card shows them differently.
  get status() {
    if (this.age === null) return 'never';
    // Floored: a device that reports every few seconds should not be called stale for a gap that
    // short, and one report is never enough to know the interval anyway
    const expected = Math.max(this.expectedInterval || DEFAULT_REPORT_INTERVAL_MS, MIN_REPORT_INTERVAL_MS);
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

  // Twigs this device publishes that the schema knows nothing about. Kept rather than dropped:
  // someone adding a module needs to see what their device is actually sending before modules.yaml
  // has caught up, and a silently discarded reading is the hardest kind to debug.
  noteUnrecognised(twig, message) {
    this.unrecognised = this.unrecognised || {};
    this.unrecognised[twig] = message;
  }
  get unrecognisedTopics() {
    return Object.entries(this.unrecognised || {}).map(([twig, value]) => ({ twig, value }));
  }

  // The built-in LED, for the status strip: it says the same thing a lit board does, at a glance.
  // Its controls live on the back, like anything else you can change.
  get led() {
    const g = this.groups.ledbuiltin;
    const mt = g && g.topics.on;
    if (!mt) return null;
    const colorMt = g.topics.color;
    return { mt, on: !!mt.state.value, color: (colorMt && colorMt.state.value) || '#ffdd00' };
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

  // battery, health and ota feed the header and footer rather than getting a section of their own,
  // because their values are already shown there. A module you can *change* always needs a section,
  // or the card shows its state with nowhere to alter it - the built-in LED went missing that way.
  isStatusStripGroup(groupId) {
    const m = moduleTemplate(groupId);
    if (!m || !m.insidefrugaliot) return false;
    const groupMt = this.groups[groupId];
    const writable = groupMt && Object.values(groupMt.topics).some((mt) => mt.rw === 'w');
    return !writable;
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
    if (!clash) return mt.name;
    // The module name on its own is enough when the module contributes a single reading - "Soil
    // Temperature" says what is being measured. With more than one it is not: an AHT20 reporting
    // temperature and humidity would end up labelling both of them "AHT20".
    const siblings = allMts.filter((other) => other.group === mt.group).length;
    return (siblings > 1) ? `${mt.groupName} ${mt.name}` : (mt.groupName || mt.name);
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
    const declared = cfg && cfg.front;
    let rows = this.resolveEntries(declared || this.defaultFrontEntries);
    // A declared list that resolves to nothing means the device no longer matches the entry its OTA
    // key picked - a scratch application rebuilt with different sensors. Show what it does have,
    // because a blank front says nothing at all about a device that is reporting fine (D-50).
    if (declared && !rows.length) rows = this.resolveEntries(this.defaultFrontEntries);
    const mts = rows.filter((r) => r.mt).map((r) => r.mt);
    rows.forEach((r) => {
      r.label = r.mt ? this.labelFor(r.mt, mts) : (r.groupMt.state.name || r.groupMt.group);
    });
    return rows;
  }
  resolveEntries(entries) { return entries.map((e) => this.resolveEntry(e)).filter(Boolean); }
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
    // Each declared list falls through when it resolves to nothing, for the same reason frontRows
    // does: a device that has drifted from its entry still has readings worth a chip (D-50).
    const declared = (cfg && cfg.summary) ? fromList(cfg.summary)   // however many were asked for
      : (cfg && cfg.front) ? fromList(cfg.front.slice(0, SUMMARY_CHIP_LIMIT)) : [];
    if (declared.length) return declared;
    const groupMts = this.orderedGroupIds.filter((groupId) => contributesToSummary(groupId))
      .slice(0, SUMMARY_CHIP_LIMIT).map((groupId) => this.groups[groupId]);
    const budget = this.summaryBudget(groupMts);
    return groupMts.map((groupMt, i) => ({ text: groupMt.summaryShort(budget[i]),
                                           row: { kind: 'control', groupMt } }))
      .filter((c) => (c.text !== null) && (c.text !== ''));
  }
  // How many readings each module may put on the summary line. Every module keeps its
  // SUMMARY_READINGS_PER_MODULE; if that leaves the line short of SUMMARY_CHIP_LIMIT items, the
  // difference is offered to the modules in order. Without it a device reporting four readings from
  // one module showed two of them with three chip slots empty, while the same four split across two
  // modules showed all four - and the reader cannot see module boundaries, so they should not decide
  // what fits. The spare is only ever handed out, never taken, so no existing summary shrinks.
  // See CARDS_UX.md 4.7 and D-51.
  summaryBudget(groupMts) {
    const want = groupMts.map((g) => g.summaryCapacity);
    const allow = want.map((w) => Math.min(w, SUMMARY_READINGS_PER_MODULE));
    let spare = SUMMARY_CHIP_LIMIT - allow.reduce((a, b) => a + b, 0);
    for (let i = 0; (i < allow.length) && (spare > 0); i++) {
      const extra = Math.min(want[i] - allow[i], spare);
      allow[i] += extra;
      spare -= extra;
    }
    return allow;
  }

  // Builds the MqttTopicGroup and its template topics.
  addGroupFromTemplate(groupId) {
    if (this.groups[groupId]) return false;
    const mTemplate = moduleTemplate(groupId); // Resolves soil1 -> soil etc, see moduleBaseId
    // An instance resolved by prefix gets its suffix appended, so three probes read as
    // "Soil Moisture 1/2/3" rather than three identically named groups
    const suffix = moduleInstanceSuffix(groupId);
    const groupName = mTemplate ? (suffix ? `${mTemplate.name} ${suffix}` : mTemplate.name) : groupId;
    const GroupClass = topicGroupClasses[groupId] || MqttTopicGroup;
    const groupMt = new GroupClass();
    groupMt.name = groupName;
    groupMt.state.name = groupName;
    groupMt.group = groupId;
    groupMt.twig = groupId;   // So topicPath resolves to org/project/node/group
    groupMt.nodeMt = this;    // So projectMt works, which a control summary needs to name its wiring
    this._groups[groupId] = groupMt;
    if (!mTemplate) {
      XXX(["Unknown group - no template found", groupId]);
    } else {
      mTemplate.topics.forEach(topicUnexpandedTemplate => {
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
  // Sets mt.nodeMt so topicPath, groupMt, and projectMt getters work via the data tree.
  addTopicFromTemplate(topicTemplate, groupId) {
    const groupMt = this.groups[groupId];
    if (groupMt && !groupMt.topics[topicTemplate.leaf]) {
      const mt = new MqttTopic();
      mt.fromTemplate(topicTemplate, groupId + "/" + topicTemplate.leaf, groupId);
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
   The credentials are per USER - user.mqtt_username and user.mqtt_password from /config.json, or
   given as attributes by an embedded page. Nothing is connected until they are known.

   These used to be the organization's own shared account, which meant web-level read-only was not
   broker-level read-only: anyone with READ held credentials that could publish anything. It now is,
   and is enforced by the broker rather than by this file: the server puts each user's broker account
   in a group per capability, so a reader cannot publish, a writer can send "set/" commands only, and
   nobody can forge a reading. See SECURITY-REVIEW.md S3/S4.
*/
class MqttClient extends HTMLElementExtended {
  // This appears to be reconnecting properly, but if not see mqtt (library I think)'s README
  static get observedAttributes() { return ['server', 'username', 'password', 'display']; }

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
              mqtt_client.subscribe(s.topic, (err, granted) => subscribeResult(s.topic, err, granted));
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
      mqtt_client.on('message', (topic, message, packet) => {
        // message is Buffer
        // TODO - check whether topic is string or buffer.
        let msg = message.toString();
        console.log("Received", topic, " ", msg);
        // packet.retain distinguishes the broker replaying its retained store, on subscribe, from
        // the node actually publishing. MQTT 3.1.1 requires the flag be cleared on a delivery to an
        // already-established subscription, so it is exactly "this arrived because we just
        // subscribed" - see MqttTopicNode.message_received for why that matters.
        mqtt_deliver(topic, msg, !!(packet && packet.retain));
      });
    } else {
      // console.log("XXX already started connection") // We expect this, probably one time
    }
  }
  // TODO-86 display some more about the client and its status, but probably under an "i"nfo button on Org
  // display="status" shows only whether it is connected, with no disclosure to open. Which broker
  // and which organization are reference information, wanted once - they belong somewhere findable
  // rather than in the corner of every screen.
  renderDetail() {
    return [
      el('span',{textContent: "server", i8n: false}),
      el('span',{textContent: ": "}),
      el('span',{textContent: this.state.server, i8n: false}),
      el('br'),
      el('span',{textContent: "organization", i8n: false}),
      el('span',{textContent: ": "}),
      el('span',{textContent: this.state.username, i8n: false}), // Username on the broker is the organization id
    ];
  }
  render() {
    const status = el('span', {class: 'status', textContent: this.state.status});
    return [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      (this.state.display === 'status')
        ? el('span', {class: 'mqtt-client mqtt-client--status'}, [status])
        : el('details', {class: 'mqtt-client'},[
            el('summary', {}, [status]),
            ...this.renderDetail(),
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
  static get observedAttributes() { return RECEIVER_ATTRIBUTES.concat(['organization','project','node','clientdisplay']); }
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
    // Capabilities are per organization, so a page offering administration needs to know before a
    // project has been picked - and needs to know the old project has gone.
    document.dispatchEvent(new CustomEvent('frugaliot:organizationchanged', {
      detail: { organization: this.state.organization },
    }));
    this.state.project = null;
    if (this.state.projectEl) {
      this.removeChild(this.state.projectEl);
    }
    if (this.state.organization) { // Will be false if the placeholder option is re-chosen
      this.appender();
    }
  }
  onProject(e) {
    this.state.project = e.target.value;
    if (this.state.project) { // Will be false if the placeholder option is re-chosen
      this.appender();
    }
  }
  appendClient() {
    // The client does not connect until setClientCredentials tells it which organization to connect as,
    // so append it whether or not an organization has been chosen yet - it also shows connection status.
    // noinspection JSUnresolvedReference
    // display comes from the page: the card UI shows only whether it is connected, and puts which
    // broker and which organization on an Info card instead
    this.state.elements.client = el('mqtt-client', {slot: 'client', server: server_config.mqtt.broker,
      display: this.getAttribute('clientdisplay') || undefined}); // typically "wss://frugaliot.naturalinnovation.org/wss"
    this.append(this.state.elements.client);
    this.setClientCredentials(); // In case the organization was already known, e.g. from the URL or a markup attribute
  }
  // Give mqtt-client this USER's broker credentials, from /config.json's "user" block. One account
  // per person, not one per organization: what it may reach is decided by the groups the server put
  // it in, so a reader cannot publish and nobody can forge a reading.
  //
  // It used to be the organization's own mqtt_password, shared by every node and every user of that
  // organization - which meant anybody with READ held working publish credentials for everything in
  // it. See SEC-1.
  //
  // One thing falls out of this: the username no longer changes when the organization does, so
  // switching organization no longer forces a reconnect, and a user who can see several keeps one
  // connection.
  setClientCredentials() {
    const clientEl = this.state.elements.client;
    if (!clientEl) { return; }
    // noinspection JSUnresolvedReference
    const me = server_config && server_config.user;
    if (!me || !me.mqtt_username || !me.mqtt_password) {
      // The server could not reach the broker to set up this account, or there is no plugin - it
      // says so in its log. The dashboard still works for stored data; only live values are missing.
      this.message('No broker credential for this login - live data is unavailable');
      return;
    }
    // Password first: each setAttribute reconsiders connecting, and it is the change of username
    // that triggers a reconnect, so the new password must already be in place when that happens.
    clientEl.setAttribute('password', me.mqtt_password);
    clientEl.setAttribute('username', me.mqtt_username);
  }
  /*
   * Creates the MqttTopicProject - the data tree for one project, and nothing else. Pages build
   * their own display from it.
   */
  addProject(discover) {
    const twig = `${this.state.organization}/${this.state.project}`;
    const mt = new MqttTopicProject();
    mt.initialize({ type: "text", twig });
    mt.subscribe();
    this.state.elements["project"] = mt; // Store MqttTopicProject directly
    // So a page built around the wrapper knows a project now exists. topicschanged only fires once
    // a node arrives, which is too late for a project that has no devices yet.
    document.dispatchEvent(new CustomEvent('frugaliot:projectchanged', {
      detail: { projectMt: mt, organization: this.state.organization, project: this.state.project },
    }));
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
      mt.addNode(this.state.node);
    } else { // !n
      if (!this.state.project)  { // !n !p ?o
        if (!this.state.organization) { // !n !p !o
          // noinspection JSUnresolvedReference
          this.append( // TODO-14 merge with organization dropdown in mqtt-admin and add to mqtt-login and mqtt-register
            el('div', {class: 'dropdown'}, [
              // The name is the placeholder rather than a label: the header is short of space, and
              // once something is chosen the word is redundant. aria-label/title keep it available.
              el('select', {id: 'organizations', 'aria-label': getString("Organization"),
                title: getString("Organization"), onchange: this.onOrganization.bind(this)}, [
                el('option', {value: "", textContent: "Organization", selected: !this.state.value}),
                Object.entries(server_config.organizations).map( ([oid, o]) =>
                  el('option', {value: oid, textContent: `${oid}: ${o.name}`, selected: false}),
                ),
              ]),
            ]));
        } else { // !n !p o
          // noinspection JSUnresolvedReference
          this.append( this.state.projectEl =
            el('div', {class: 'dropdown'}, [
              el('select', {id: 'projects', 'aria-label': getString("Project"),
                title: getString("Project"), onchange: this.onProject.bind(this)}, [
                el('option', {value: "", textContent: "Project", selected: !this.state.value}),
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
        nodes.filter(([id, nc]) => id !== '+' && nc.lastseen)
          .forEach(([id, nc]) => {
            const nodeMt = mt.nodes[id] || mt.addNode(id);
            // Seed when the server last heard from it, so a device that has not reported since the
            // page loaded reads as offline with a real age rather than as never seen at all.
            // lastseen is a Date in the logger, so it arrives here as an ISO string through JSON -
            // subtracting that from a number gives NaN, which reaches Intl as a RangeError.
            const seen = Date.parse(nc.lastseen);
            if (!nodeMt.lastMessageAt && Number.isFinite(seen)) nodeMt.lastMessageAt = seen;
          });
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
  DELETE,
  POST,
  RECEIVER_ATTRIBUTES,
  XXX,
  addVocabulary,
  configSet,
  el,
  getString,
  getStringWith,
  isEditableTarget,
  browserLanguages,
  language,
  languageIndex,
  languageMatch,
  leafAttribute,
  locationParameterChange,
  moduleBaseId,
  mqtt_client,
  mqttTempConnect,
  mqtt_deliver,
  mqtt_subscribe,
  mqtt_unsubscribe,
  mqtt_unsubscribe_organization,
  nextUniqueId,
  nowMs,
  hasCapability,
  redirectToLogin,
  relativeTime,
  brokerHost,
  retainedPattern,
  SUMMARY_CHIP_LIMIT,
  SUMMARY_READINGS_PER_MODULE,
  server_config,
  setClock,
  standaloneTopic,
  topicMatches,
  unitSuffix,
  unitSymbol,
};
