/*
 * UX client for Frugal IoT
 *
 */
// noinspection ES6PreferShortImport
import {EL, HTMLElementExtended, toBool, GET} from '/node_modules/html-element-extended/htmlelementextended.js';
import mqtt from '/node_modules/mqtt/dist/mqtt.esm.js'; // https://www.npmjs.com/package/mqtt
import yaml from '/node_modules/js-yaml/dist/js-yaml.mjs'; // https://www.npmjs.com/package/js-yaml
import async from '/node_modules/async/dist/async.mjs'; // https://caolan.github.io/async/v3/docs.html
import { parse } from "csv-parse"; // https://csv.js.org/parse/distributions/browser_esm/
import { Chart, registerables, _adapters } from '/node_modules/chart.js/dist/chart.js'; // "https://www.chartjs.org"
// noinspection ES6UnusedImports
import { DialGauge } from "dial-gauge"; // Complains about unused import, but it actually uses "dial-gauge" the web component
//import 'chartjs-adapter-luxon';
Chart.register(...registerables); //TODO figure out how to only import that chart types needed
/* TODO possible partial list of imports needed for chartjs
import LineElement from '../../elements/element.line.js';
import {_drawfill} from './filler.drawing.js';
import {_shouldApplyFill} from './filler.helper.js';
import {_decodeFill, _resolveTarget} from './filler.options.js';
*/
const CssUrl = './frugaliot.css';
function XXX(args) {
  if (args) { console.log(...args); }
  return false;
} // Put a breakpoint here for debugging and intersperse XXX() in code.

/* This is copied from the chartjs-adapter-luxon, I could not get it to import - gave me an error every time */
/*
 * chartjs-adapter-luxon v1.3.1
 * https://www.chartjs.org
 * (c) 2023 chartjs-adapter-luxon Contributors
 * Released under the MIT license
 */
import { DateTime } from 'luxon';

const FORMATS = {
  datetime: DateTime.DATETIME_MED_WITH_SECONDS,
  millisecond: 'h:mm:ss.SSS a',
  second: DateTime.TIME_WITH_SECONDS,
  minute: DateTime.TIME_SIMPLE,
  hour: {hour: 'numeric'},
  day: {day: 'numeric', month: 'short'},
  week: 'DD',
  month: {month: 'short', year: 'numeric'},
  quarter: "'Q'q - yyyy",
  year: {year: 'numeric'}
};

// noinspection JSCheckFunctionSignatures
_adapters._date.override({
  _id: 'luxon', // DEBUG

  /**
   * @private
   */
  _create: function(time) {
    return DateTime.fromMillis(time, this.options);
  },

  init(chartOptions) {
    if (!this.options.locale) {
      this.options.locale = chartOptions.locale;
    }
  },

  formats: function() {
    return FORMATS;
  },

  parse: function(value, format) {
    const options = this.options;

    const type = typeof value;
    if (value === null || type === 'undefined') {
      return null;
    }

    if (type === 'number') {
      value = this._create(value);
    } else if (type === 'string') {
      if (typeof format === 'string') {
        value = DateTime.fromFormat(value, format, options);
      } else {
        value = DateTime.fromISO(value, options);
      }
    } else if (value instanceof Date) {
      value = DateTime.fromJSDate(value, options);
    } else if (type === 'object' && !(value instanceof DateTime)) {
      value = DateTime.fromObject(value, options);
    }

    return value.isValid ? value.valueOf() : null;
  },

  format: function(time, format) {
    const datetime = this._create(time);
    return typeof format === 'string'
      ? datetime.toFormat(format)
      : datetime.toLocaleString(format);
  },

  add: function(time, amount, unit) {
    const args = {};
    args[unit] = amount;
    return this._create(time).plus(args).valueOf();
  },

  diff: function(max, min, unit) {
    return this._create(max).diff(this._create(min)).as(unit).valueOf();
  },

  startOf: function(time, unit, weekday) {
    if (unit === 'isoWeek') {
      weekday = Math.trunc(Math.min(Math.max(0, weekday), 6));
      const dateTime = this._create(time);
      return dateTime.minus({days: (dateTime.weekday - weekday + 7) % 7}).startOf('day').valueOf();
    }
    return unit ? this._create(time).startOf(unit).valueOf() : time;
  },

  endOf: function(time, unit) {
    // noinspection JSCheckFunctionSignatures
    return this._create(time).endOf(unit).valueOf();
  }
});
/* =============== End of code copied from chartjs-adapter-luxon.esm.js ==================== */

// TODO mqtt_client should be inside the MqttClient class
// https://github.com/mitra42/frugal-iot-client/issues/41
let mqtt_client; // MQTT client - talking to server
// TODO mqtt_subscriptions should be inside the MqttClient class but its non trivial as currently have no way to find that class
let mqtt_subscriptions = [];   // [{topic, cb(message)}]
let unique_id = 1; // Just used as a label for auto-generated elements
let graph;  // Will hold a default MqttGraph once user chooses to graph anything
let server_config;

// ==========TODO-44 === CODE REVIEW FROM HERE DOWN: getters#26; const vs let; globals;TODO's; Problems; Comments

let discover_io = yaml.load(`
analog:
  leaf:     analog
  type:     int
  display:  bar
  rw:       r
  graphable:  true
brightness:
  leaf:     brightness
  name:     Brightness
  type:     int
  display:  slider
  rw:       w
button:
  leaf:     button
  name:     Button
  type:     bool
  display:  toggle
  rw:       r
color:
  leaf: color
  name: Color
  type: color
  display:  color
  rw: w
humidity:
  leaf:  humidity
  name:   Humidity
  type:   float
  display: bar
  min:    0
  max:    100
  color:  blue
  rw:       r
  graphable:  true
pressure:
  leaf:  pressure
  name:     Pressure
  type:     float
  display:  bar
  min:      0
  max:      99
  color:   blue
  rw:       r
  graphable:  true
on:
  leaf:     on
  name:     On
  type:     bool
  display:  toggle
  color:    black
  rw:       w
  graphable:  true
soil:
  leaf:     soil
  type:     int
  display:  bar
  min:      0
  max:      100
  color:    brown
  rw:       r
  graphable:  true
temperature:
  leaf:  temperature
  name:     Temperature
  type:     float
  display:  bar
  rw:       r
  min:      0
  max:      50
  color:    red
  wireable: false
  graphable:  true 
controlfloat:
  #[leaf, name] should be overridden
  min:      0
  max:      100
  type:     float
  display:  text
  color:    black
  wireable: true
  rw:       w
  retain:   true
controltext:
  #[leaf, name] should be overridden
  min:      0
  max:      100
  type:     text
  display:  text
  color:    black
  wireable: true
  rw:       w
  retain:   true
controlintoggle:
  #[leaf, name] should be overridden
  type:     bool
  display:  toggle
  color:    black
  rw:       w
  wireable: false
controlouttoggle:
  #[leaf, name] should be overridden
  type:     bool
  display:  toggle
  color:    black
  rw:       r
  wireable: true
`);
let discover_mod = yaml.load(`
# Each module contains inputs &/o outputs, each of which should have 
# name  Capitalized English (and add translation below in 'languages'
# max   For gauges, slider
# min   For gauges, slider
# color can be a name or a #RRGGBB
# display One of bar,gauge,text,slider,inputbox
# type One of bool,float,int,topic,text,yaml
# rw  r for outputs w for inputs
# wireable true,false, generally only  controls are wireable
# wired not valid in this context, it will come from MQTT broker
# Note battery gets special cased
battery:
 name: "Battery"
 topics:
  - leaf:   battery
    name:   Voltage
    type:   int
    display: text
    min:    3000
    max:    5000
    color:  green
    rw:       r
ensaht:
 name: "ENS AHT"
 topics:
  - leaf:  temperature
    name:   Temperature
    type:   float
    display: bar
    min:    0
    max:    50
    color:  red
    wireable: false
    rw:       r
  - leaf:  humidity
    name:     Humidity
    type:     float
    display:  bar
    min:      0
    max:      100
    color:    blue
    rw:       r
  - leaf:  aqi
    name:     AQI
    type:     int
    display:  bar
    min:      0
    max:      255
    color:    purple
    rw:       r
  - leaf:  tvoc
    name:     TVOC
    type:     int
    display:  bar
    min:      0
    max:      99
    color:    green
    rw:       r
  - leaf:  eco2
    name:     eCO2
    type:     int
    display:  bar
    min:      300
    max:      900
    color:    brown
    rw:       r
  - leaf:  agi500
    name:     AQI500
    type:     int
    display:  bar
    min:      0
    max:      99
    color:    brown
    rw:       r
frugal_iot:
  name: XXX
  topics:
  - leaf:     id
    slot:     id
    name:     Node ID
    type:     text
    display:  text
    rw:       r
  - leaf:     name
    slot:     name
    name:     Node Name
    type:     text
    display:  text
    rw:       w
    retain:   true
  - leaf:     description
    slot:     description
    name:     Description
    type:     text
    display:  text
    rw:       w
    retain:   true
  - leaf:     lastseen
    slot:     lastseen
    name:     Last Seen
    type:     text
    display:  text
    rw:       r
loadcell:
 name: Load Cell
 topics:
  - leaf:     loadcell
    name:     Load Cell
    type:     float
    display:  text
    min:      0
    max:      65000
    color:    yellow
    rw:       r
lux:
 name: Light meter
 topics:
  - leaf:     lux
    name:     Lux
    type:     exponential
    display:  bar
    min:      0
    max:      65000
    color:    yellow
    rw:       r
ota:
  name: OTA
  topics:
  - leaf:     key
    name:     Key
    type:     text
    display:  text
    rw:       r
`);
function d_io_v(io_id, variants) {
  let io = {}
  Object.entries(discover_io[io_id]).forEach(([key, value]) => {io[key] = value});
  if (variants) {
    Object.entries(variants).forEach(([key, value]) => {io[key] = value});
  }
  return io;
}
// TO-ADD-SENSOR TO-ADD-ACTUATOR TO-ADD-CONTROL
discover_mod["button"] = { name: "Button", topics: [d_io_v("button")]};
discover_mod["ht"] = { name: "HT",   topics: [ d_io_v("temperature"), d_io_v("humidity")]};
discover_mod["sht"] = { name: "SHT", topics: [ d_io_v("temperature"), d_io_v("humidity")]};
discover_mod["dht"] = { name: "DHT", topics: [ d_io_v("temperature"), d_io_v("humidity")]};
discover_mod["ms5803"] = { name: "MS5803", topics: [ d_io_v("pressure"), d_io_v("temperature")]};
discover_mod["relay"] = { name: "Relay", topics: [ d_io_v("on")]};
discover_mod["ledbuiltin"] = { name: "LED", slot: "ledbuiltin", topics: [ d_io_v("on"), d_io_v("color"), d_io_v("brightness")]};
discover_mod["soil"] = { name: "Soil", topics: [d_io_v("soil")]};
discover_mod["controlhysterisis"] = { name: "Control", topics: [
  d_io_v('controlfloat', {leaf: "now", name: "Now"}),
  d_io_v('controlintoggle', {leaf: "greater", name: "Greater Than"}),
  d_io_v('controlfloat', {leaf: "limit", name: "Limit"}),
  d_io_v('controlfloat', {leaf: "hysterisis", name: "Hysterisis", max: 100, wireable: false}),
  d_io_v('controlouttoggle', {leaf: "out", name: "Out"}),
]};
let discover_groupsInsideFrugalIot = ["ledbuiltin", "ota", "battery"];
/* Helpers of various kinds */

// Move to a new location by just changing one parameter in the URL
function locationParameterChange(name, value) {
  const url = new URL(window.location.href);
  url.searchParams.set(name, value); // Replace with desired param and value
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

// Subscribe to a topic (no wild cards as topic not passed to cb) << TODO is this still true
function mqtt_subscribe(topic, cb) { // cb(message)
  console.log("Subscribing to ", topic);
  mqtt_subscriptions.push({topic, cb});
  if (mqtt_client.connected) {
    mqtt_client.subscribe(topic, (err) => {
      if (err) console.error(err);
    })
  } else {
    console.log("Delaying till connected"); // It will resubscribe from "subscriptions"
  }
}
// See https://www.chartjs.org/docs/latest/samples/line/segments.html
const skipped = (ctx, value) => ctx.p0.skip || ctx.p1.skip ? value : undefined;

function topicMatches(subscriptionTopic, messageTopic) {
  if (subscriptionTopic.endsWith('/#')) {
    return (messageTopic.startsWith(subscriptionTopic.substring(0, subscriptionTopic.length - 2)));
  } else {
    return (subscriptionTopic === messageTopic);
  }
}

let languages = yaml.load(`
#Language configuration - will be read from files at some point
EN:
  _thisLanguage: English
  _nameAndFlag: English 🇬🇧
  Built in LED: Built in LED
  close: close
  connect: connect
  connecting: connecting
  Email: Email
  Humidity: Humidity
  Humidity control: Humidity control
  Hysterisis: Hysterisis
  Limit: Limit
  Name: Name
  Never seen: Never seen
  Not selected: Not selected
  Now: Now
  offline: offline
  On: On
  Organization: Organization
  Out: Out
  Password: Password
  Phone or Whatsapp: Phone or Whatsapp
  Please login: Please login
  Project: Project
  reconnect: reconnect
  Register: Register
  Relay: Relay
  server: server
  SHT: SHT
  SHT30: SHT30
  Sign In: Sign In
  Sonoff switch: Sonoff switch
  Sonoff R2 switch: Sonoff R2 switch
  Submit: Submit
  Temperature: Temperature
  Username: Username
  Load Cell: Load Cell
  LED: LED
  Control: Control
  Unused: Unused
  Greater Than: Greater Than
  OTA: OTA
  Key: Key
  Description: Description
  Last Seen: Last Seen
  Node ID:  Node ID
  Node Name:  Node Name
  Color:  Color
  Brightness: Brightness
FR:
  _thisLanguage: Francaise
  _nameAndFlag: Français 🇫🇷
  Built in LED: LED intégrée
  close: fermer
  connect: connecter
  connecting: connexion
  Email: Email
  Humidity: Humidité
  Humidity control: Contrôle de l'humidité
  Hysterisis: Hystérésis
  Limit: Limite
  Name: Nom 
  Never seen: Jamais vu
  Not selected: Non sélectionné
  Now: Maintenant
  offline: hors ligne
  On: Allumé
  Organization: Organisation
  Out: Sortie
  Password: Mot de passe
  Phone or Whatsapp: Téléphone ou Whatsapp
  Please login: Veuillez vous connecter
  Project: Projet
  reconnect: reconnecter
  Register: Registre
  Relay: Relais
  server: serveur
  SHT: SHT
  SHT30: SHT30
  Sign In: Se connecter
  Sonoff switch: Interrupteur Sonoff
  Sonoff R2 switch: Interrupteur Sonoff R2
  Submit: Soumettre
  Temperature: Température
  Username: Nom de User
  Load Cell: Cellule de charge
  LED: LED
  Control: Contrôle
  Unused: Inutilisé
  Greater Than: Supérieur à
  OTA: OTA
  Key: Clé
  Node ID: Node ID
  Node Name: Node Name
HI:
  _thisLanguage: हिंदी
  _nameAndFlag: हिंदी 🇮🇳
  Built in LED: बिल्ट-इन एलईडी
  close: बंद करें
  connect: कनेक्ट करें
  connecting: कनेक्ट हो रहा है
  Email: ईमेल
  Humidity: आर्द्रता
  Humidity control: आर्द्रता नियंत्रण
  Hysterisis: हिस्टेरिसिस
  Limit: सीमा
  Name: नाम
  Never seen: कभी नहीं देखा
  Not selected: चयनित नहीं
  Now: अभी
  offline: ऑफ़लाइन
  On: चालू
  Organization: संगठन
  Out: आउट
  Password: पासवर्ड
  Phone or Whatsapp: फ़ोन या व्हाट्सएप
  Please login: कृपया लॉगिन करें
  reconnect: पुनः कनेक्ट करें
  Register: पंजीकरण करें
  Relay: रिले
  server: सर्वर
  SHT: एसएचटी
  SHT30: एसएचटी30
  Sonoff switch: सोनऑफ स्विच
  Sonoff R2 switch: सोनऑफ R2 स्विच
  Sign In: साइन इन करें
  Submit: जमा करें
  Temperature: तापमान
  Username: उपयोगकर्ता नाम
  Project: परियोजना
  Load Cell: लोड सेल
  LED: एलईडी
  Control: नियंत्रण
  Unused: अप्रयुक्त
  Greater Than: इससे बड़ा
  OTA: ओटीए
  Key: कुंजी
  Node ID: Node ID
  Node Name: Node Name
ID:
  _thisLanguage: Bahasa Indonesia
  _nameAndFlag: Bahasa Indonesia 🇮🇩
  Built in LED: LED bawaan
  close: tutup
  connect: sambungkan
  connecting: menghubungkan
  Email: Email
  Humidity: Kelembapan
  Humidity control: Kontrol kelembapan
  Hysterisis: Histeresis
  Limit: Batas
  Name: Nama
  Never seen: Belum pernah terlihat
  Not selected: Tidak dipilih
  Now: Sekarang
  offline: offline
  On: Hidup
  Organization: Organisasi
  Out: Keluar
  Password: Kata Sandi
  Phone or Whatsapp: Telepon atau Whatsapp
  Please login: Silakan masuk
  Project: Proyek
  reconnect: sambungkan kembali
  Register: Daftar
  Relay: Relay
  server: server
  SHT: SHT
  SHT30: SHT30
  Sign In: Masuk
  Sonoff switch: Saklar Sonoff
  Sonoff R2 switch: Saklar Sonoff R2
  Submit: Kirim
  Temperature: Suhu
  Username: Nama Pengguna
  Load Cell: Sel Beban
  LED: LED
  Control: Kontrol
  Unused: Tidak digunakan
  Greater Than: Lebih dari
  OTA: OTA
  Key: Kunci
  Node ID: Node ID
  Node Name: Node Name
`);

let preferedLanguages = [ ];
function languageNamesAndFlags() {
  //noinspection JSUnresolvedVariable
  return Object.entries(languages).map(([k,v]) => [k,v._nameAndFlag]);
}
function getString(tag) {
  for (let lang of preferedLanguages) {
    let foo
    // noinspection JSAssignmentUsedAsCondition
    if (foo = languages[lang] && languages[lang][tag]) {
      return foo;
    }
    XXX(["Cannot translate ", tag, ' into ', lang]);
  }
  //noinspection JSUnresolvedVariable
  return (languages.EN[tag] || tag);
}

let i8ntags = {
  label: ["textContent"],
  button: ["textContent"],
  span: ["textContent"],
  option: ["textContent"],
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
    // TODO-34 build from available languages
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

  // Creation & initialization
  constructor() {
    this.data = [];
    this.qos = 0; // Default to send and not care if received
    this.retain = false; // Default to not retain
  }

  initialize(o) {
    // topic, name, type, display, rw, min, max, color, options, node
    Object.keys(o).forEach((k) => {
      this[k] = o[k];
    });
  }
  fromDiscovery(discoveredTopic, node) {
    // topic, name, type, display, rw, min, max, color, options,
    this.initialize(discoveredTopic);
    // "topic" is ambiguous - currently in discovery it is "twig" e.g. sht/temperature
    this.twig = discoveredTopic.topic;
    // getters defined for leaf
    this.node = node;
  }
  // Gets and related fields
  get project() {
    return this.node.project;
  }
  get leaf() {
    return this.twig.split("/").pop();
  }
  get topicPath() {
    return (this.node ? this.node.mt.topicPath + "/" : "") + this.twig;
  }
  get topicSetPath() {
    // "set" path is meaningless (I think) for a node or project
    return this.node.mt.topicPath + "/set/" + this.twig;
  }
  get topicWiredPath() {
    return this.topicSetPath + "/wired"; // Path to set wired value
  }
  get topicSubscribePath() {
    if (this.element && this.element.isNode) {
      return this.topicPath + "/#"; // Subscribe to all subtopics
    } else {
      //noinspection JSUnresolvedVariable
      switch (this.rw) { // Note for project this will be undefined
        case 'w': // Note should not be happening as subscribing at node level
          return this.topicSetPath;
        default:
          return this.topicPath;
      }
    }
  }
  // Create the UX element that displays this
  createElement() {
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

  setWired(v) {
    // Note will still get messages from old "wired" but these will be ignored
    this.wired = v;
    if (v) {
      mqtt_subscribe(v, this.message_received.bind(this));
    }
  }
  subscribe() {
    if (!mqtt_client) {
      XXX("Trying to subscribe before connected")
    }
    if (!this.subscribed) {
      this.subscribed = true;
      mqtt_subscribe(this.topicSubscribePath, this.message_received.bind(this));
    }
  }

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
      console.error("Error parsing message", message, e);
      return null;  // TODO its unclear how this error will be handled - catch specific cases (like unparseable yaml)
    }
  }

  // Note sometimes called from MqttClient and sometimes from node.topicValueSet
  message_received(topic, message) {
    if (this.element) {
      if (this.element.topicValueSet(topic, message)) {
        this.element.renderAndReplace(); // TODO note gradually replacing need to rerender by smarter valueSet() on different subclasses
      }
    } else { // This is typically a MqttGraphdataset in an embedded mqtt-chartdataset
      let value = this.valueFromText(message);
      let now = Date.now();
      this.data.push({value, time: now}); // Same format as graph dataset expects
    }
    if (this.graphdataset) { // instance of MqttGraphdataset
      this.graphdataset.dataChanged();
    }
  }

  get yaxisid() {
    let scaleNames = Object.keys(this.graph.state.scales);
    let yaxisid;
    // noinspection JSUnresolvedReference
    let n = this.name.toLowerCase().replace(/[0-9]+$/,'');
    let t = this.leaf.toLowerCase().replace(/[0-9]+$/,'');
    if (scaleNames.includes(n)) { return n; }
    if (scaleNames.includes(t)) { return t; }
    // noinspection JSAssignmentUsedAsCondition
    if (yaxisid = scaleNames.find(tt => tt.includes(n) || n.includes(tt))) {
      return yaxisid;
    }
    // noinspection JSAssignmentUsedAsCondition
    if (yaxisid = scaleNames.find(tt => tt.includes(n) || n.includes(tt))) {
      return yaxisid;
    }
    // TODO-46 - need to turn axis on, and position when used.
    // Not found - lets make one - this might get more parameters (e.g. linear vs exponential could be a attribute of Bar ?
    // noinspection JSUnresolvedReference
    this.graph.addScale(t, {
      // TODO-46 add color
      type: 'linear',
      display: this.type !== 'bool',
      title: {
        // noinspection JSUnresolvedReference
        color: this.color,  // May need to vary so not all e.g. humidity same color
        // noinspection JSUnresolvedReference
        text: getString(this.name.replace(/[0-9]+$/,'')),
      },
      // noinspection JSUnresolvedReference
      min: ((this.type === 'bool') ? false : (this.min || 0)),
      // noinspection JSUnresolvedReference
      max: ((this.type === 'bool') ? true : undefined),
    });
    return t;
  }

  get graph() {
    if (this.graphdataset) {
      return this.graphdataset.graph;
    } else {
      return MqttGraph.graph; // Will get default (global) graph, or create one
    }
  }
  // Event gets called when graph icon is clicked - adds a line to the graph (which it creates if needed)
  // It links the datasets of the topic to the dataset.
  createGraph() {
    // Figure out which scale to use, or build it
    let yaxisid = this.yaxisid;

    // Make sure there is a graph to work with,
    // Must do before partially create the graphdataset which breaks this.graph temporarily
    let graph = this.graph;
    
    // Create a graphdataset to put in the chart
    if (!this.graphdataset) {
      let nodename = this.node ? this.node.state.name : "";
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
    if (!graph.contains(this.graphdataset)) {
      graph.append(this.graphdataset); // calls GDS.loadContent which adds dataset to Graph and sets GDS.graph (enabling this.graph to work)
    }
    this.graphdataset.addDataLeft(); // Populate with any back data
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
        // noinspection JSCheckFunctionSignatures
        parse(csvData, (err, newdata) => {
          if (err) {
            console.error(err); // Intentionally not passing error back
          } else if (newdata.length === 0) {
            XXX(["No data in", filepath]);
          } else {
            console.log(`retrieved ${newdata.length} records for ${this.topicPath}`);
            let newprocdata = newdata.map(r => {
              return {
                time: parseInt(r[0]),
                value: parseFloat(r[1])  // TODO-72 need function for this as presuming its float
              };
            });
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
        let t = new Date(this.graph.state.dateFrom) // Have to explicitly copy it else pointer
          .setUTCHours(0,0,0,0)
          .valueOf();
        this.data.splice(0, 0, {
          time: t,
          value: null,
        });
        //console.error(err); - dont need error - the fetch will also report it, so it is just a repeat.
        cb(null); // Dont break caller
      }); // May want to report filename here
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
/* Manages a connection to a MQTT broker */
class MqttClient extends HTMLElementExtended {
  // This appears to be reconnecting properly, but if not see mqtt (library I think)'s README
  static get observedAttributes() { return ['server']; }

  setStatus(text) {
    this.state.status = text;
    this.renderAndReplace();
    // TODO Could maybe just sent textContent of a <span> sitting in a slot ?
  }
  shouldLoadWhenConnected() { return !!this.state.server; } /* Only load when has a server specified */

  // Called from connectedCallBack when MqttWrapper.appendClient called to add MqttClient
  loadContent() {
    if (!mqtt_client) {
      // See https://stackoverflow.com/questions/69709461/mqtt-websocket-connection-failed
      this.setStatus("connecting");
      mqtt_client = mqtt.connect(this.state.server, {
        connectTimeout: 5000,
        username: "public", //TODO-30 parameterize this - read config.json then use password from there
        password: "public",
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
        this.setStatus('connect');
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
        // The subscriptions are all going to be MqttNode which will then look at rest of topic
        for (let o of mqtt_subscriptions) {
          if (topicMatches(o.topic, topic)) { // Matches trailing wildcards, but not middle ones
            o.cb(topic, msg);
          }
        }
        //mqtt_client.end();
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
        el('span',{textContent: "server"}),
        el('span',{textContent: ": "}),
        el('span',{textContent: this.state.server}),
      ]),
    ];
  }
}
customElements.define('mqtt-client', MqttClient);

class MqttLogin extends HTMLElementExtended { // TODO-89 may depend on organization
  constructor(props) {
    super(props);
    this.state = {register: false};
  }
  static get observedAttributes() { return ['register','message','url','lang']; }
  static get boolAttributes() { return ['register']; }

  connectedCallback() {
    this.loadAttributesFromURL();
    super.connectedCallback();
  }
  changeAttribute(name, value) {
    if (name === "lang") {
      if (value.includes(',')) {
        preferedLanguages = (value.split(',')).map(v => v.toUpperCase());
      } else {
        preferedLanguageSet(value.toUpperCase());
      }
    }
    super.changeAttribute(name, value);
  }

  tabRegister(register) {
    this.changeAttribute('register', register);
    this.renderAndReplace();
  }
  render() { //TODO-89 needs styles
    // TODO-89 organization should be dropdown
    // TODO-89 merge login & register
    return [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: 'mqtt-login'},[
        el('div',{class: 'message'},[
          el('span', {textContent: this.state.message}),
          el('language-picker'),
        ]),
        el('section', {class: 'tabs'}, [
          el('button', {class: 'tab' + (!this.state.register ? ' active' : ' inactive'), onclick: this.tabRegister.bind(this, false), textContent: "Sign In"}),
          el('button', {class: 'tab' + (this.state.register ? ' active' : ' inactive'), onclick: this.tabRegister.bind(this, true), textContent: "Register"}),
        ]),
        el('form', {action:  (this.state.register ? '/register' : '/login'), method: "post"}, [
          el('section', {}, [
            el('label', {for: "username", textContent: 'Username'}),
            el('input', {id: "username", name: "username", type: "text", autocomplete: "username", required: true, autofocus: true}),
          ]),
          el('section', {}, [
            el('label', {for: "password", textContent: "Password"}),
            el('input', {id: "password", name: "password", type: "password", autocomplete: "current-password", required: true}),
          ]),
          // TODO-22 organization should be a drop-down
          !this.state.register ? null : [
            el('section', {}, [
              el('label', {for: "organization", textContent: "Organization"}),
              el('input', {id: "organization", name: "organization", type: "text", autocomplete: "organization", required: true}),
            ]),
            el('section', {}, [
              el('label', {for: "name", textContent: "Name"}),
              el('input', {id: "name", name: "name", type: "text", autocomplete: "name", required: true}),
            ]),
            el('section', {}, [
              el('label', {for: "email", textContent: "Email"}),
              el('input', {id: "email", name: "email", type: "text", autocomplete: "email", required: true}),
            ]),
            el('section', {}, [
              el('label', {for: "phone", textContent: "Phone or Whatsapp"}),
              el('input', {id: "phone", name: "phone", type: "text", autocomplete: "phone", required: true}),
            ]),
          ],
          el('input', {id: "url", name: "url", type: "hidden", value: (this.state.url + "?lang=" + preferedLanguages.join(','))}),
          el('button', {class: "submit", type: "submit",
            textContent: (this.state.register ? 'Submit' : 'Submit')}),
          ]),
      ]),
    ];
  }
}
customElements.define('mqtt-login', MqttLogin);

class MqttElement extends HTMLElementExtended {
  // TODO - maybe move this to HTMElementExtended
  // Called whenever an attribute is added or changed,
  // https://developer.mozilla.org/en-US/docs/Web/Web_Components/Using_custom_elements#using_the_lifecycle_callbacks
  // unlikely to be subclassed except to change behavior of when calls renderAndReplace
  attributeChangedCallback(name, oldValue, newValue) {
    // console.log(this.localName, 'Attribute Changed', name); // uncomment for debugging
    if (oldValue !== newValue) {
      let needReRender = this.changeAttribute(name, newValue); // Sets state{} may also munge value (e.g. string to boolean)
      // reconsider if now have sufficient data to load content
      if (this.isConnected && this.constructor.observedAttributes.includes(name) && this.shouldLoadWhenConnected()) {
        this.loadContent();
      }
      // note this render happens before the loadContent completes
      if (needReRender !== false) {  // Testing this way as old changeAttributes returned undefined and assumed a reRender
        this.renderAndReplace();
      }
    }
  }
}

class MqttReceiver extends MqttElement {
  constructor() {
    super();
    this.state.elements = {}; // Pointer to specific elements (for special case updates)
  }
  static get observedAttributes() { return ['value','color','type','label','topic', 'graphable']; }
  static get boolAttributes() { return ['graphable']; }

  get isNode() { return false; } // Overridden in MqttNode
  get node() {
    return this.mt.node;
  }
  connectedCallback() {
    if (this.state.topic && !this.mt) {
      // Created with a topic string, which should be a path, so create the MqttTopic
      XXX("TODO-155 Not expecting connectCallback to work - see createTopic");
      this.createTopic();
    }
    super.connectedCallback();
  }
  // This should be called when a receiver is created with a topic (which should be a path)
  // But not sure how this still works because the mt will not have a node, which is presumed.
  // TODO-155 test embedded examples - doubt this will work now, without a node.
  createTopic() {
    XXX("TODO-155 Not expecting MqttReceiver.createTopic to work");
    let mt = new MqttTopic();
    let tt = this.state.topic.split("/");
    let org = tt.shift();
    let projectId = tt.shift();
    let nodeId = tt.shift();
    mt.initialize({
      type: this.state.type,
      //topic: this.state.topic,
      twig: tt.join("/"),
      element: this,
      name: this.state.label,
      color: this.state.color,
      node: { mt: { topicPath: `${org}/${projectId}/${nodeId}`} }
    })
    this.mt = mt;
    mt.subscribe(); //TODO-155 check embedded case,
  }
  changeAttribute(name, valueString) {
    super.changeAttribute(name, valueString); // Change from string to number etc and store on this.state
    // TODO - could set width, color, name, on sub-elements and return false then copy this to other elements
    if (name === 'wired') {
      this.mt.setWired(valueString);
      if (this.state.elements.chooseTopic) {
        this.state.elements.chooseTopic.setAttribute('value', valueString); // Update the dropdown if it exists
      } else {
        XXX("received 'wired' but no dropdown to pass it to");
      }
      return false; // ChooseTopic will re-render if needed
    } else {
      return true;
    }
  }
  // Return true if need to rerender
  // Note overridden in MqttNode and MqttProject
  topicValueSet(topic, message) {
    if ([this.mt.topicPath, this.mt.topicSetPath, this.mt.wired].includes(topic)) {
      let value = this.mt.valueFromText(message);
      let now = Date.now();
      this.mt.data.push({value, time: now}); // Same format as graph dataset expects
      if (this.node && this.node.topicChanged) { // There is (currently) no node if it is a Project and no "topicChanged" if embedded
        this.node.topicChanged(this.mt.leaf, value);
      }
      return this.valueSet(value);
    } else if ((topic.startsWith(this.mt.topicPath)) || (topic.startsWith(this.mt.topicSetPath))) {
      // topic like org/project/node/set/sht/temperature or ...set/sht/temperature/max
      let parameter = topic.split("/").pop();
      this.parameterSet(parameter, message); // True if need to rerender
      return false; // parameterSet will have rerendered if needed
    } else {
      // Most likely cause of an "unhandled" topic is because received topic after changing "wired" - that is ok, can safely ignore
      // XXX("Unhandled topicValueSet", topic, message);
      return false;
    }
  }
  //TODO maybe able to just setAttribute("value", val) - which would also do type conversion string to number
  valueSet(val) {
    // Note val can be of many types - it will be subclass dependent
    this.state.value = val;
    return true; // Rerender by default - subclass will often return false
  }
  // Subclass "changeAttribute" to edit rendered elements and return true if do not want to rerender
  parameterSet(parameter, message) {
    // Note this will be silently ignored if parameter is not "observed"
    //this.mt[parameter] = Number(message); // Not setting on topic as not needed and do not know HERE if number or string
    // causes a re-render (setAttribute->attributeChangedCallback->changeAttribute->renderAndReplace)
    if (!this.constructor.observedAttributes.includes(parameter)) {
      XXX(["Good chance parameter is not observed:", parameter]);
    }
    this.setAttribute(parameter, message); // Type will be set in changeAttribute
  }
  get project() { // Note this will only work once the element is connected
    // noinspection CssInvalidHtmlTagReference
    return this.closest("mqtt-project");
  }

// Event gets called when graph icon is clicked - asks topic to add a line to the graph
  // noinspection JSUnusedLocalSymbols
  opengraph(e) {
    this.mt.createGraph();
  }
  onwiredchange(e) {
    let newPath = e.target.value;
    this.mt.setWired(newPath);
    // noinspection JSUnresolvedVariable
    if ((this.mt.rw === 'r') && e.target.value) {
      let parts = e.target.value.split("/");
      parts.splice(3,0,"set");
      newPath = parts.join("/");
    }
    this.mt.publishWired(newPath);
    this.renderAndReplace();
  }
  renderLabel() {
    // noinspection JSUnresolvedVariable
    return [
      el('label', {for: this.mt.topicPath, textContent: this.mt.name}),
      !this.state.graphable ? null
      : el('img', {class: "icon", src: 'images/icon_graph.svg', onclick: this.opengraph.bind(this)})
    ];
  }
  renderWiredName(wiredTopic) {
    let wiredTopicName = wiredTopic ? `${wiredTopic.node.usableName}:${wiredTopic.name}` : undefined;
    return el('span', {class: 'wired', textContent: wiredTopicName})
  }
  renderDropdown() {
    // noinspection JSUnresolvedVariable
    return el('mqtt-choosetopic', {name: this.mt.name, type: this.mt.type, value: this.getAttribute('wired'), rw: (this.mt.rw === 'r' ? 'w' : 'r'), project: this.mt.project, onchange: this.onwiredchange.bind(this)});
  }
  // Handle cases ....
  // r/!wireable - text value
  // r/wireable/!wired - text value + hidden dropdown NOT DONE YET
  // r/wireable/wired - text value and wired topic name and hidden dropdown NOT DONE YET
  // w/!wireable - input box with value
  // w/wireable/!wired - input box with value + hidden dropdown
  // w/wireable/wired - text value(from wired) and wired topic name and hidden dropdown

  // For Bool all same except:
  // renderInput - checkbox with value
  // renderValue - check mark if value true, empty if false

    renderMaybeWired(className) {
    if (!this.mt) {
      return []; // Dont render till have mt set
    }
    // noinspection JSUnresolvedVariable
    let wiredTopic = this.mt.wired ? this.mt.project.findTopic(this.mt.wired) : undefined;
    let wiredTopicValue = wiredTopic ? wiredTopic.element.state.value.toString() : undefined; // Works - but maybe error-prone if value can be undefined
    // noinspection JSUnresolvedReference
      return [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: className + " outer"},
        // noinspection JSUnresolvedVariable
        this.mt.rw === 'r'
          ? [
            // noinspection JSUnresolvedVariable
            this.mt.wireable
              ? // rw==r && wireable
              el('details', {} , [
                el('summary', {}, [
                  this.renderLabel(),
                  // noinspection JSUnresolvedVariable
                  this.mt.wired
                    ? [
                      this.renderValue(this.state.value),
                      this.renderWiredName(wiredTopic),
                    ]
                    : this.renderValue(this.state.value),
                ]),
                this.state.elements.chooseTopic = this.renderDropdown(),
              ])
              : [
                this.renderLabel(),
                this.renderValue(this.state.value),
              ]
          ] : [ // rw==='w'
            this.mt.wireable
              ? // rw==w && wireable
              el('details', {} , [
                el('summary', {}, [
                  this.renderLabel(),
                  this.mt.wired
                    ? [
                      this.renderValue(wiredTopicValue),
                      this.renderWiredName(wiredTopic),
                    ]
                    : this.renderInput(),
                ]),
                this.state.elements.chooseTopic = this.renderDropdown(),
              ])
              : [ // rw==w !wireable
                this.renderLabel(),
                this.renderInput(),
              ]
          ])
    ]
  }
}

class MqttTransmitter extends MqttReceiver {
  // TODO - make sure this doesn't get triggered by a message from server.
  valueGet() { // Needs to return an integer or a string
    return this.state.value
    // TODO could probably use a switch in MqttNode rather than overriding in each subclass
  } // Overridden for booleans

  publish() {
    this.mt.publish(this.valueGet());
  }
}

class MqttText extends MqttTransmitter {
  // constructor() { super(); }
  static get observedAttributes() { return MqttReceiver.observedAttributes.concat(['min','max','wired']); }
  static get floatAttributes() { return MqttReceiver.floatAttributes.concat(['min','max']); }

  // TODO - make sure this doesn't get triggered by a message from server.
  onChange(e) {
    //console.log("Changed"+e.target.checked);
    this.state.value = this.mt.valueFromText(e.target.value); // Convert, for example, to float
    this.publish();
  }
  /*
  onClick(e) {
  }
   */
  renderInput() {
    return el('input', {class: "val", id: this.mt.topicPath, name: this.mt.topicPath, value: this.state.value, type: this.mt.inputType, min: this.state.min, max: this.state.max, onchange: this.onChange.bind(this)});
  }
  renderValue(val) {
    return el('span',{class: "val", textContent: val || "", i8n: false, /*onclick: this.onClick.bind(this)*/});
  }
  render() {
    return this.renderMaybeWired("mqtt-text "+(this.mt && this.mt.twig && this.mt.twig.replaceAll('/','_') || ""));
  }

}
customElements.define('mqtt-text', MqttText);

class MqttColor extends MqttTransmitter {
  // constructor() { super(); }
  static get observedAttributes() { return MqttReceiver.observedAttributes.concat(['wired']); }
  ; static get floatAttributes() { return MqttReceiver.floatAttributes.concat(['min','max']); }

  // TODO - make sure this doesn't get triggered by a message from server.
  onChange(e) {
    //console.log("Changed"+e.target.checked);
    this.state.value = this.mt.valueFromText(e.target.value); // Convert, for example, to float
    this.publish();
  }
  /*
  onClick(e) {
  }
   */
  renderInput() {
    return el('input', {class: "val", id: this.mt.topicPath, name: this.mt.topicPath, value: this.state.value, type: "color", onchange: this.onChange.bind(this)});
  }
  renderValue(val) {
    return el('span',{class: "val", textContent: val || "", i8n: false, /*onclick: this.onClick.bind(this)*/});
  }
  render() {
    return this.renderMaybeWired("mqtt-text "+(this.mt && this.mt.twig && this.mt.twig.replaceAll('/','_') || ""));
  }

}
customElements.define('mqtt-color', MqttColor);

class MqttToggle extends MqttTransmitter {
  valueSet(val) {
    super.valueSet(val);
    this.state.indeterminate = false; // Checkbox should default to indeterminate till get a message
    return true; // Rerender // TODO could set values on input instead of rerendering
  }
  valueGet() {
    // TODO use Mqtt to convert instead of subclassing
    return (+this.state.value).toString(); // Implicit conversion from bool to int then to String.
  }
  static get observedAttributes() {
    return MqttTransmitter.observedAttributes.concat(['checked','indeterminate','wired']);
  }
  changeAttribute(name, valueString) {
    super.changeAttribute(name, valueString); // Change from string to number etc and store on this.state
    // TODO - could set width, color, name, on sub-elements and return false then copy this to other elements
    return true;
  }

    // TODO - make sure this doesn't get triggered by a message from server.
  onChange(e) {
    //console.log("Changed"+e.target.checked);
    this.state.value = e.target.checked; // Boolean
    this.publish();
  }
  // Handle cases ....
  // r/!wireable - text value
  // r/wireable/!wired - text value + hidden dropdown NOT DONE YET
  // r/wireable/wired - text value and wired topic name and hidden dropdown NOT DONE YET
  // w/!wireable - input box with value
  // w/wireable/!wired - input box with value + hidden dropdown
  // w/wireable/wired - text value(from wired) and wired topic name and hidden dropdown

  // For Bool all same except:
  // renderInput - checkbox with value
  // renderValue - check mark if value true, empty if false

  renderInput() {
    return el('input', {class: 'val', type: 'checkbox', id: this.mt.topicPath,
      checked: !!this.state.value, indeterminate: typeof(this.state.value) == "undefined",
      onchange: this.onChange.bind(this)});
  }
  renderValue(val) {
    return el('span',{class: 'val', textContent: (val === undefined) ? '?' : (val ? '✓' : '✗')});
  }
  render() {
    return this.renderMaybeWired("mqtt-toggle");
  }
}
customElements.define(  'mqtt-toggle', MqttToggle);

class MqttBar extends MqttReceiver {
  static get observedAttributes() { return MqttReceiver.observedAttributes.concat(['min','max']); }
  static get floatAttributes() { return MqttReceiver.floatAttributes.concat(['value','min','max']); }

  constructor() {
    super();
  }
  // noinspection JSCheckFunctionSignatures
  valueSet(val) {
    super.valueSet(val); // TODO could get smarter about setting with in span rather than rerender
    return true; // Note will not re-render children like a MqttSlider because these are inserted into DOM via a "slot"
  }
  changeAttribute(name, valueString) {
    super.changeAttribute(name, valueString); // Change from string to number etc and store on this.state
    // TODO - could set width, color, name, on sub-elements and return false then copy this to other elements
    return true;
  }
  render() {
    //this.state.changeable.addEventListener('change', this.onChange.bind(this));
    let width = this.state.type === "exponential"
      ? 100*(Math.log(this.state.value/(this.state.min||1))/Math.log(this.state.max/(this.state.min||1)))
      : 100*(this.state.value-this.state.min)/(this.state.max-this.state.min)
      ;
    // noinspection JSUnresolvedReference
    return !(this.isConnected && this.mt) ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: "outer mqtt-bar"}, [

        el('div', {class: "name"}, [
          el('label', {for: this.mt.topicPath, textContent: this.mt.name}),
          !this.state.graphable ? null
          : el('img', {class: "icon", src: 'images/icon_graph.svg', onclick: this.opengraph.bind(this)}),
        ]),
        el('div', {class: "bar", id: this.mt.topicPath},[
          el('span', {class: "left", style: `width:${width}%; background-color:${this.state.color};`},[
            el('span', {class: "val", textContent: this.state.value}),
          ]),
          //Do not appear to need this - and it sometimes wraps, so if re-enabled, need to make sure always horiz next to left
          //el('span', {class: "right", style: "width:"+(100-width)+"%"}),
        ]),
        el('slot',{}), // Children would be a setpoint, but not using currently
      ]),
    ];
  }
}
customElements.define('mqtt-bar', MqttBar);

class MqttGauge extends MqttReceiver {
  static get observedAttributes() { return MqttReceiver.observedAttributes.concat(['min','max']); }
  static get floatAttributes() { return MqttReceiver.floatAttributes.concat(['value','min','max']); }

  constructor() {
    super();
  }
  // noinspection JSCheckFunctionSignatures
  valueSet(val) {
    super.valueSet(val); // TODO could get smarter about setting with in span rather than rerender
    this.dg.setAttribute('value',val);
    return false; // Note will not re-render children like a MqttSlider because these are inserted into DOM via a "slot"
  }
  render() {
    //this.state.changeable.addEventListener('change', this.onChange.bind(this));
    //let width = 100*(this.state.value-this.state.min)/(this.state.max-this.state.min);
    // noinspection JSUnresolvedReference
    return !(this.isConnected && this.mt) ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: "outer mqtt-gauge"}, [
        this.dg = el('dial-gauge', {
          "main-title": this.mt.name,
          "sub-title": "",
          "scale-start": this.state.min,
          "scale-end": this.state.max,
          "value": this.state.value,
          "scale-offset": 45,
          "style": `--dg-arc-color:${this.state.color}`,
        }),
        !this.state.graphable ? null
          : el('img', {class: "icon", src: 'images/icon_graph.svg', onclick: this.opengraph.bind(this)}),
      ]),
    ];
  }
}
customElements.define('mqtt-gauge', MqttGauge);

// TODO Add some way to do numeric display, numbers should change on mousemoves.
class MqttSlider extends MqttTransmitter {
  static get observedAttributes() { return MqttTransmitter.observedAttributes.concat(['min','max','color','setpoint','continuous']); }
  static get floatAttributes() { return MqttTransmitter.floatAttributes.concat(['value','min','max', 'setpoint']); }
  static get boolAttributes() { return MqttTransmitter.boolAttributes.concat(['continuous'])}

  // noinspection JSCheckFunctionSignatures
  valueSet(val) {
    super.valueSet(val);
    this.thumb.style.left = this.leftOffset() + "px";
    return true; // Rerenders on moving based on any received value but not when dragged
    // TODO could get smarter about setting with rather than rerendering
  }
  valueGet() {
    // TODO use mqttTopic for conversion instead of subclassing
    return (this.state.value).toPrecision(3); // Conversion from int to String (for MQTT)
  }
  leftToValue(l) {
    return (l+this.thumb.offsetWidth/2)/this.slider.offsetWidth * (this.state.max-this.state.min) + this.state.min;
  }
  leftOffset() {
    return ((this.state.type === "exponential")
      ? (Math.log(this.state.value/(this.state.min||1))/Math.log(this.state.max/(this.state.min||1)))
      : ((this.state.value-this.state.min)/(this.state.max-this.state.min))
    ) * (this.slider.offsetWidth) - this.thumb.offsetWidth/2;
  }
  onmousedown(event) {
    event.preventDefault();
    let shiftX = event.clientX - this.thumb.getBoundingClientRect().left; // Pixels of mouse click from left
    let thumb = this.thumb;
    let slider = this.slider;
    let tt = this;
    let lastvalue = this.state.value;
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    function onMouseMove(event) {
      let newLeft = event.clientX - shiftX - slider.getBoundingClientRect().left;
      // if the pointer is out of slider => lock the thumb within the boundaries
      newLeft = Math.min(Math.max( -thumb.offsetWidth/2, newLeft,), slider.offsetWidth - thumb.offsetWidth/2);
      tt.valueSet(tt.leftToValue(newLeft));
      // noinspection JSUnresolvedReference
      if (tt.state.continuous && (tt.state.value !== lastvalue)) { tt.publish(); lastvalue = tt.state.value; }
    }
    // noinspection JSUnusedLocalSymbols
    function onMouseUp(event) {
      tt.publish();
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousemove', onMouseMove);
    }
    // shiftY not needed, the thumb moves only horizontally
  }
  renderAndReplace() {
    super.renderAndReplace();
    if (this.thumb) {
      this.thumb.style.left = this.leftOffset() + "px";
    }
  }
  render() {
    if ((!this.slider) && (this.children.length > 0)) {
      // Build once as don't want re-rendered - but do not render till after children added (end of EL)
      this.thumb = el('div', {class: "setpoint"}, this.children);
      this.slider = el('div', {class: "pointbar",},[this.thumb]);
      this.slider.onmousedown = this.onmousedown.bind(this);
    }
    // noinspection JSUnresolvedReference
    return !this.isConnected ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: "mqtt-slider outer"}, [
        el('div', {class: "name"}, [ //TODO maybe use a label
          // noinspection JSUnresolvedReference
          el('span', {textContent: this.mt.name}),
          el('span', {class: "val", textContent: this.state.value}), // TODO restrict number of DP
        ]),
        this.slider,  // <div.setpoint><child></div
      ])
    ];
  }
}
customElements.define('mqtt-slider', MqttSlider);

class MqttChooseTopic extends MqttElement {
  // options = "bool" for boolean topics (matches t.type on others)
  static get observedAttributes() { return MqttTransmitter.observedAttributes.concat(['name', 'type','value', 'project','rw','onchange']); }

  // TODO-43 may need to change findTopics to account for other selection criteria
  findTopics() {
    let project = this.state.project;
    let nodes = Array.from(project.children);
    // Note each node's value is its config
    let allowableTypes = {
      // Mapping of requested types to valid fields - e.g. if want a float then returning an int will be fine
      "float": ["float", "int", "exponential"],
      "text": ["text", "float", "exponential", "int", "bool"],
    }
    return nodes.map(n => n.topicsByType(allowableTypes[this.state.type] || this.state.type, this.state.rw))
      .flat();
  }
  // noinspection JSCheckFunctionSignatures
  valueSet(val) {
    this.state.value = (val);
    this.renderAndReplace();
  }
  changeAttribute(name, valueString) {
    super.changeAttribute(name, valueString); // convert and store on state
    return true; // Rerender - will use new value, name etc.
    // Note that value is expected to change when topic is rewired
  }
  render() {
    // noinspection JSUnresolvedReference
    return !this.isConnected ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: 'outer mqtt-choosetopic'}, [
        el('label', {for: 'choosetopic' + (++unique_id), textContent: name}),
        el('select', {id: 'choosetopic' + unique_id, onchange: this.onchange}, [
          el('option', {value: "", textContent: "Unused", selected: !this.state.value}),
          this.findTopics().map( t => // { name, type etc. }
            el('option', {value: t.topic, textContent: t.name, selected: t.topic === this.state.value}),
          ),
        ]),
      ]),
    ];
  }
}
customElements.define('mqtt-choosetopic', MqttChooseTopic);

// Outer element of the client - Top Level logic
// If specifies org / project / node then believe it and build to that
// otherwise get config from server
// Add appropriate internals

// Functions on the configuration object returned during discovery - see more in frugal-iot-logger
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
  static get observedAttributes() { return MqttReceiver.observedAttributes.concat(['organization','project','node','lang']); }
  // Maybe add 'discover' but think thru interactions
  //static get boolAttributes() { return MqttReceiver.boolAttributes.concat(['discover'])}

  // Note this is not using the standard connectedCallBack which loads content and re-renders,
  // it is going to instead add things to the slot

  message(msg) {
    console.error(msg);
    this.append(el('div', {class: 'message', textContent: msg}));
  }
  onOrganization(e) {
    this.state.organization = e.target.value;
    this.setAttribute('organization', this.state.organization);
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
      this.appender();
    }
  }
  appendClient() {
    // TODO-security at some point we'll need one client per org and to use username and password from config.yaml which by then should be in config.d
    // TODO-security but that should be trivial if only ever display one org
    // noinspection JSUnresolvedReference
    this.append(
      el('mqtt-client', {slot: 'client', server: server_config.mqtt.broker}) // typically "wss://frugaliot.naturalinnovation.org/wss"
    )
  }
  addProject(discover) {
    let twig = `${this.state.organization}/${this.state.project}`;
    // noinspection JSUnresolvedReference
    let elProject = el('mqtt-project', {discover, id: this.state.project, name: server_config.organizations[this.state.organization].projects[this.state.project].name }, []);
    // The project's topic watches for discover packets for nodes
    let mt = new MqttTopic();
    mt.initialize({
      type: "text",
      twig: twig,
      element: elProject,
    });
    elProject.mt = mt;
    mt.subscribe(); // Subscribing Project
    this.append(elProject);
    return elProject;
  }
  appender() {
    // At this point could have any combination of org project or node
    if (this.state.node) { // n
      if (!this.state.organization || !this.state.project) {   // n, !(o,p)
        let [o,p] = nodeId2OrgProject(this.state.node);
        if (!o) {
          this.message(`Unable to find node=${this.state.node}`);
          return;
        } else {
          this.state.organization = o;
          this.state.project = p;
        }
      } // Drop through with n & o & p
      let elProject = this.addProject(false);
      elProject.valueSet(this.state.node, true); // Create node on project along with its MqttNode
    } else { // !n
      if (!this.state.project)  { // !n !p ?o
        if (!this.state.organization) { // !n !p !o
          // noinspection JSUnresolvedReference
          this.append(
            el('div', {class: 'dropdown'}, [
              el('label', {for: 'organizations', textContent: "Organization"}),
              el('select', {id: 'organizations', onchange: this.onOrganization.bind(this)}, [
                el('option', {value: "", textContent: "Not selected", selected: !this.state.value}),
                Object.entries(server_config.organizations).map( ([oid, o]) =>
                  el('option', {value: oid, textContent: `${oid}: ${o.name}`, selected: false}),
                ),
              ]),
            ]));
        } else { // !n !p o  // TODO-69 maybe this should be a blank project ?
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
            this.message(`Unable to find project=${this.state.project}`);
            return;
          } else {
            this.state.organization = o[0];
          }
        } // drop through with !n p o
        // TODO-69 need to have a human-friendly name, and short project id - will be needed in configuration and elsewhere.
        let projElem = this.addProject(true);
        // noinspection JSUnresolvedReference
        let nodes = Object.entries(server_config.organizations[this.state.organization].projects[this.state.project].nodes);
        projElem.nodesFromConfig(nodes);
      }
    }
  }
  connectedCallback() {
    // TODO-69 security this will be replaced by a subset of config.yaml,
    //  that is public, but in the same format, so safe to build on this for now
    GET("/config.json", {}, (err, json) => {
      if (err) {
        this.message(err);
        return;
      } else { // got config
        server_config = json;
        this.loadAttributesFromURL();
        this.appendClient();
        this.appender();
      }
      this.renderAndReplace(); // TODO check, but should not need to renderAndReplace as render is (currently) fully static
    });
    //super.connectedCallback(); // Not doing as finishes with a re-render.
  }
  changeAttribute(name, value) {
    if (name === "lang") {
      if (value.includes(',')) {
        preferedLanguages = (value.split(',')).map(v => v.toUpperCase());
      } else if(!value) {
        preferedLanguageSet('EN');
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

class MqttProject extends MqttReceiver {
  constructor() {
    super();
    this.state.nodes = {};  // [ MqttNode ]
  }
  static get observedAttributes() { return MqttReceiver.observedAttributes.concat(['discover', 'name']); }
  static get boolAttributes() { return MqttReceiver.boolAttributes.concat(['discover'])}

  addNode(id) {
    let topicPath = `${this.mt.topicPath}/${id}`;
    let elNode = el('mqtt-node', {id, topic: topicPath, discover: this.state.discover, name: "", description: ""},[]);
    elNode.addStandardChildren(); // Cant be done in constructor
    this.state.nodes[id] = elNode;
    let mt = new MqttTopic();
    mt.initialize({
      type: "yaml",
      twig: topicPath,
      element: elNode,
    });
    elNode.state.project = this; // For some reason, this cannot be set on elNode while mt can be!
    elNode.mt = mt;
    this.append(elNode);
    mt.subscribe(); // Subscribe (for node) to get Discovery - note subscribes to wild card
    return elNode;
  }
  // Overrides topicValueSet in MqttReceiver
  topicValueSet(topic, message) {
    // value is going to be a discovery message, so should be a node id
    // At the moment since not wild-carding, topic will be "org/project"
    this.valueSet(this.mt.valueFromText(message));
  }
  // noinspection JSCheckFunctionSignatures
  // Two cases either from a discovery message for a new node, OR from Wrapper calling valueSet on new Project
  valueSet(val, force) {  //TODO-REFACTOR maybe dont use "force", (only used by wrapper)
    // val is a node id such as esp8266-12ab3c
    if (this.state.discover || force) {
      if (this.state.nodes[val]) {
        // Already have the node, but reset its watchdog
        this.state.nodes[val].tickle();
      } else {
        this.addNode(val);
      }
    }
    return false; // Should not need to rerender
  }
  nodesFromConfig(nodes) { // { id: { lastseen, ...} }
    nodes.filter(([id,nc]) => ((id !== '+') && (nc.lastseen)))
      .forEach(([id,nc]) => {
        if (!this.state.nodes[id]) {
          let n = this.addNode(id); // Will try and do a discover to fill it in but offline for now
          n.offline();
          n.updateLastSeen(nc.lastseen); // Creates lastseen element
      }
    });
  }
  findTopic(topicPath) {
    // Currently only used in renderMaybeWired
    let parts = topicPath.split("/");
    return this.state.nodes[parts[2]].state.topics[`${parts[3]}/${parts[4]}/#`];
  }
  render() {
    return  !this.isConnected ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('div', {class: "outer mqtt-project"}, [
        el('div', {class: "title"},[
          el('span',{class: 'projectname', textContent: this.mt.twig }), // twig should be e.g. dev/lotus
          el('span',{class: 'name', i8n: false, textContent: this.state.name}),
        ]),
        el('div', {class: "nodes"},[
          el('slot', {}),
        ]),
      ])
    ];
  }
}
customElements.define('mqtt-project', MqttProject);
class MqttNode extends MqttReceiver {
  static get observedAttributes() { return MqttReceiver.observedAttributes.concat(['id', 'name', 'description','discover']); }
  static get boolAttributes() { return MqttReceiver.boolAttributes.concat(['discover'])}
  static get integerAttributes() { return MqttReceiver.integerAttributes.concat(['days'])}

  constructor() {
    super(); // (Comment used to say "subscribes to topic" but doesn't look like it
    this.state.topics = {}; // Index of MqttTopic - TODO-13 is this topicLeafs or topicPaths ?
    this.state.days = 0;
    this.watchdog = new Watchdog(this);
    this.state.lastseen = 0;
    this.groups = {}; // Index of groups
    // Special case elements whose text is changed at top level , not inside a group or the ShadowRoot
  }
  addStandardChildren() {
    // These go in slots in the Node's render.
    /*
    this.groups.frugal_iot.append(this.state.elements.name = el('span', {slot: "name", class: 'name', textContent: this.state.name}));
    this.groups.frugal_iot.append(this.state.elements.description =
      el('mqtt-text', {slot: "description", class: 'description', value: this.state.description, rw: 'w', type: 'text', min: 0, max: 30}));
    this.groups.frugal_iot.append(this.state.elements.description);
    this.groups.frugal_iot.append(this.state.elements.id = el('span',{class: 'nodeid', textContent: this.state.id, i8n: false}));
     */
    // Need the group firs,t else the addDiscoveredTopicsToNode will create a new group.
    this.addGroupFromTemplate("frugal_iot"); // Add group and topics
    this.state.topics["frugal_iot/id/#"].element.valueSet(this.state.id); // Set manually as it is not a message it is a field
  }
  changeAttribute(leaf, valueString) {
    super.changeAttribute(leaf, valueString);
    if (this.state.elements[leaf]) { // This will be false during constructor
      this.state.elements[leaf].textContent = this.state[leaf];
    }
    return false;
  }
  get isNode() { return true; } // Overrides superclass in MqttReceiver

  get usableName() {
    return (this.state.name === "device") ? this.state.id : this.state.name;
  }
  // Filter the topics on this node by type e.g. "bool" "float" or ["float","int"]
  topicsByType(types, rw) { // [ { name, topic: topicpath } ]
    let usableName = this.usableName;
    return Object.values(this.state.topics)
      .filter( t => types.includes(t.type))
      .filter(t => t.rw.includes(rw))
      // TODO-154 when have groups as a Webcomponent - use the groups name, and be clever e.g. ledbuiltin/on is LED, but temperature/max is Temperature Max
      .map(t=> { return({name: `${usableName}:${t.name}`, topic: t.topicPath})});
  }

  // Overrides topicValueSet in MqttReceiver
  // noinspection JSCheckFunctionSignatures
  topicValueSet(topicPath, message) {

    let twig = topicPath.substring(this.mt.topicPath.length+1);
    if (twig.startsWith("set/")) { twig = twig.substring(4); } // Remove "set/" prefix if present
    // TODO-37 ignore some legacy and/or buggy nodes - probably will go away when server restarted
    if (
      (topicPath === this.mt.topicPath) // Its discover for this Node, not a sub-element (old nodes or in DB)
      ||  [
      "relay",
      ].includes(twig) // Its JUST "relay"
      || twig.startsWith("set") // Sonoff esp8266-243053 (note that is a 2nd "set")
      || twig.startsWith("soil1") // Lilygo old
      || twig.startsWith("control/") // Old name for controlhysterisis
      || twig.startsWith("humidity/") // esp8266-243053 Old name for controlhysterisis
      || twig.startsWith("led/") // esp8266-243053 Old name for ledbuiltin
      || twig.endsWith('/wire') // replaced with "/wired"
      || twig.endsWith('/device_name') // replaced with "/name"
      || !twig.includes('/')
    ) { return false }

    // Special case twigs
    if (twig.startsWith("frugal_iot/")) {
      let leaf = twig.substring(11);
      if (!this.constructor.observedAttributes.includes(leaf)) {
        XXX(["Probably not a valid leaf of frugal_iot", leaf]);
      }
      this.setAttribute(leaf, message); // Will update state and rerender if needed
      // Need to drop through and also look for topics that match in the frugal_iot group
    }
    // I don't expect this next match to ever succeed - as topics is usually like set/temperature/# but the test happens below in the loop through this.state.topic
    if (this.state.topics[twig]) {
      XXX(["Unexpected exact match for twig", twig])
      this.state.topics[twig].message_received(topicPath, message);
    } else {
      // Check if it is a group we haven't seen for this node, if so add it - checking first for a template
      this.addGroupFromTemplate(twig.split("/")[0]);
      let matched=false;
      // noinspection JSUnusedLocalSymbols
      Object.entries(this.state.topics)
        .filter(([subscriptionTopic,unusedNode]) => topicMatches(subscriptionTopic, twig))
          .forEach(([unusedSubscriptionTopic, module]) => {
              matched = true;
              module.message_received(topicPath, message);
            });
      if (!matched) {
        XXX(["Unrecognized twig at ", topicPath]);
      }
    }
  }
// Add a group (if not already there) and its topics
  addGroupFromTemplate(groupId) {
    // Check if we already have added the group
    if (!this.groups[groupId]) {
      let dm = discover_mod[groupId];
        let groupName = dm ? dm.name : groupId;
      if (groupId === "frugal_iot") {
        this.groups.frugal_iot = el('mqtt-groupfrugaliot', {class: 'group frugal_iot', group: groupId, name: groupName});
      } else {
        this.groups[groupId] = el('mqtt-group', {class: `group ${groupId}`, group: groupId, name: groupName, slot: ((dm && dm.slot) || null)}, []);
      }
      if (discover_groupsInsideFrugalIot.includes(groupId)) { // ledbuiltin or ota
        this.groups["frugal_iot"].append(this.groups[groupId]); // Add the new group to the frugal_iot node.
      } else {
        this.append(this.groups[groupId]); // Adds the group to the node - typically it will be a dropdown
      }
      if (!dm) {
        XXX(["Unknown group - for now can't guess"]);
      } else {
        dm.topics.forEach(t => {  // Note t.topic in discovery is twig
          t.group = groupId;
          if (t.leaf && !t.topic && groupId) {
            t.topic = groupId + "/" + t.leaf;
            delete t.leaf;
          }
          if (!this.state.topics[t.topic]) { // Have we done this already?
            let mt = new MqttTopic();
            mt.fromDiscovery(t, this);
            this.state.topics[t.topic + "/#"] = mt; // Watch for topic (e.g. sht/temperature or leaflet of it e.g. sht/temperature/color
            // mt.subscribe(); Node will forward to sub topics
            let elx = mt.createElement();
            // If topic specifies a slot - typically these are inside frugal_iot i.e. name, description, id, lastseen
            if (t.slot) {
              // noinspection JSUnresolvedReference
              elx.setAttribute('slot', mt.slot);
              // noinspection JSUnresolvedReference
              elx.setAttribute('class', mt.slot);
              if (groupId === "frugal_iot") {
                this.state.elements[t.slot] = elx
              }
            }
            this.groups[groupId].append(elx);
          }
        });
      }
    }
  }

  /*
  shouldLoadWhenConnected() {
  // For now relying on retention of advertisement by broker
    return this.state.id && super.shouldLoadWhenConnected() ;
  }
 */
  // TODO-13 do we just set state here, or change the render ?
  topicChanged(leaf, value) {
    switch (leaf) {
      case "battery":
        let bars = Math.floor(parseInt(value) * 6/4200);
        this.groups.frugal_iot.state.elements.batteryIndicator.src = `images/Battery${bars}.png`;
        break;
    }
  }
  render() {
    return !this.isConnected ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      this.state.outerDiv = el('div', {class: 'outer mqtt-node'+((this.state.online) ? '' : ' offline')}, [
        this.groups.frugal_iot,
        el('div', {class: "topics"},[
          el('slot', {}), // Groups are children of Node
        ]),
  ])
    ]
  }
  //document.getElementsByTagName('body')[0].classList.add('category');
  tickle() {
    let now = Date.now();
    this.updateLastSeen(now);
    this.watchdog.tickle(now);
    this.state.online = true;
    this.state.outerDiv.classList.remove('offline');
  }
  offline() {
    this.state.outerDiv.classList.add('offline');
    this.state.online = false;
  }
  updateLastSeen(lastseentime) {
    this.state.lastseen = lastseentime;
    let value = lastseentime ? new Date(lastseentime).toLocaleString() : "Never seen";
    this.state.elements.lastseen.setAttribute('value', value);
    /*
    if (this.state.elements.lastSeen) {
      this.groups.frugal_iot.removeChild(this.state.elements.lastSeen);
    }
    //TODO-113 could probably also do by replacing inner text if it flickers
    this.state.elements.lastSeen = el('span', {slot: "lastseen", class: 'lastseen', textContent: value});
    this.groups.frugal_iot.append(this.state.elements.lastSeen);
    */
  }
}
customElements.define('mqtt-node', MqttNode);

class MqttGroup extends MqttElement { // TODO-40 may extend MqttReceiver if needed ....
  constructor() {
    super();
    this.topics = {}
    this.state.elements = {}
  }
  static get observedAttributes() { return ['group','name']; }
  render () {
    return !this.isConnected ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('details', {class: `mqtt-group ${this.state.group}`}, [
        el('summary',{},[
          el('span', {textContent: this.state.name || this.state.group})
        ]),
        el('slot'), // Children go here
      ]),
    ];
  }
}
customElements.define('mqtt-group', MqttGroup);

class MqttGroupFrugalIot extends MqttGroup {
  render() {
    return !this.isConnected ? null : [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      el('details', {}, [
        el('summary', {}, [
          el('slot', {name: 'name', class: 'name'}),
          //Starts off as 1px empty image, changed when battery message received
          this.state.elements.batteryIndicator = el('img', {
            class: "batteryimg",
            src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
          }),
        ]),
        el('slot', {name: 'description', class: 'description'}),
        el('slot', {name: 'lastseen', class: 'lastseen'}),
        el('slot', {name: 'id', class: 'id'}),
        el('div', {class: "health"}, [
          el('slot', {name: 'ledbuiltin'}),
          el('slot', {name: 'battery'}),
        ]),
        el('slot', {name: 'ota', class: 'ota'}),
        el('slot'), // Should probably be unused slot for any other children
      ]),
    ];
  }
}
customElements.define('mqtt-groupfrugaliot', MqttGroupFrugalIot);

/* This could be part of MqttBar, but maybe better standalone */
class MqttGraph extends MqttElement {
  constructor() {
    super();
    this.datasets = []; // Child elements will add/remove chartjs datasets here
    this.state.dataFrom = null;
    this.state.yAxisCount = 0; // 0=left, 1=right
    this.state.leftInProgress = 0;
    this.state.scales = { // Start with an xAxis and add axis as needed
      xAxis: {
        // display: false,
        type: 'time',
        distribution: 'series',
        axis: 'x',
        adapters: {
          date: {
            // locale: 'en-US', // Comment out to Use systems Locale
          },
        },
      }
    };
  }
  static get graph() { // TODO-46 probably belongs in MqttReceiver
    if (!graph) { // global
      graph = el('mqtt-graph');
      document.body.append(graph);
    }
    return graph;
  }

  // Note - makeChart is really fussy, the canvas must be inside something with a size.
  // For some reason, this does not work by adding inside the render - i.e. to the virtual Dom.
  loadContent() {
    this.canvas = el('canvas');
    this.append(el('div', {slot: "chart", style: "width: 80vw; height: 60vw; position: relative;"},[this.canvas]));
    this.makeChart();
  }
  shouldLoadWhenConnected() {return true;}
  addScale(id, o) {
    o.grid = { drawOnChartArea: !this.state.yAxisCount } // only want the grid lines for one axis to show u
    o.position = ((this.state.yAxisCount++) % 2) ? 'right' : 'left';
    this.state.scales[id] = o;
  }
  makeChart() {
    if (this.chart) {
      this.chart.destroy();
    }
    this.chart = new Chart(
      this.canvas,
      {
        type: 'line', // Really want it to be a line
        data: {
          datasets: this.datasets,
        },
        options: {
          //zone: "America/Denver", // Comment out to use system time
          responsive: true,
          scales: this.state.scales,
          elements: { // https://www.chartjs.org/docs/latest/configuration/elements.html
            point: {
              radius: 1,
            },
            line: {
              borderWidth: 1,
              spanGaps: false,
            }
          }
        }
      }
    );
  }
  graphFileNameForDate(d) {
    return d.toISOString().substring(0,10) + ".csv";
  }
  // noinspection JSUnusedLocalSymbols
  graphnavleft(e) {
    // TODO If not first go back x days
    let first = !this.state.dateFrom; // null or date
    if (first) {
      this.state.dateFrom = new Date();
    } else {
      this.state.dateFrom.setDate(this.state.dateFrom.getDate()-1); // Note this rolls over between months ok
    }
    let filename = this.graphFileNameForDate(this.state.dateFrom);
    this.addDataFrom(filename, first);
  }
  // Return a list of filenames to allow a newly added GraphDataset to catch up on old data
  graphNavleftFilenames() {
    let filenames = [];
    if (this.state.dateFrom) {
      let d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      filenames.push(this.graphFileNameForDate(d));
      while (d > this.state.dateFrom) {
        d.setDate(d.getDate() - 1);
        filenames.push(this.graphFileNameForDate(d));
      }
    }
    return filenames;
  }

  addDataFrom(filename, first) {
    if (!this.state.leftInProgress++) {
      this.state.imageLeft.textContent = "⌛";
    }
    async.each(this.children, ((ds,cb) => {
      if (ds.addDataFrom) {
        ds.addDataFrom(filename, first, cb);
      } else {
        cb();
      }
    }),() => { // Note ds.addDataFrom does not return an error via cb, if cannot read file will just skip that line
      this.chart.update();
      if (!--this.state.leftInProgress) {
        this.state.imageLeft.textContent = "⬅︎";
      }
    } );
  }
  graphnavright() {
    // TODO if not last go forward x days
    if (this.state.dateFrom) {
      this.state.dateFrom.setDate(this.state.dateFrom.getDate() + 1); // Note this rolls over between months ok
      if (this.state.dateFrom > new Date()) {
        this.state.dateFrom = null; // Reset to "first"
      }
    }
    let d = this.state.dateFrom; // maybe null
    if (d) {
      d = new Date(this.state.dateFrom);
      d.setUTCHours(0,0,0,0);
    }
    Array.from(this.children).forEach(ds => {
      if (ds.removeDataBefore) {
        ds.removeDataBefore(d); // maybe null
      }
    });
    this.chart.update();
  }
  // Called when data on one of the datasets has changed, can do an update, (makeChart is for more complex changes)
  dataChanged() {
    this.chart.update();
  }
  addDataset(chartdataset) {
    this.datasets.push(chartdataset);
    this.makeChart();
  }
  render() {
    return ( [
      el('link', {rel: 'stylesheet', href: CssUrl}),
      // TODO see https://www.chartjs.org/docs/latest/configuration/responsive.html#important-note div should ONLY contain canvas
      el("div", {class: 'outer mqtt-graph'}, [
        el('div',{class: 'leftright'}, [
          el('div',{},[
            this.state.imageLeft = el('span', {class: "graphnavleft", textContent: "⬅︎", onclick: this.graphnavleft.bind(this)}),
            el('span', {class: "graphnavright", textContent: "↺", onclick: this.graphnavright.bind(this)}),
          ]),
          el('slot', {name: "chart"}), // This is <div><canvas></div>
        ]),
        el('slot', {}), // This is the slot where the GraphDatasets get stored
      ])
    ] );
  }
}
customElements.define('mqtt-graph', MqttGraph);

let lightenablecolors =  ['coral','salmon','pink','salmon','yellow','goldenrodyellow',
  'green','seagreen','cyan','steelblue','blue','skyblue','gray','slategray'];

class MqttGraphDataset extends MqttElement {
  /*
  chartdataset: { data[{value, time}], parsing: { xAixKey: 'time', yAxisKey: 'value' }
  graph: MqttGraph
  state: { data[{value, time}], name, color, min, max, yaxisid }
   */

  constructor() {
    super();
    // Do not make chartDataset here, as do not have attributes yet
  }
  get graph() {
    return this.parentElement;
  }
  // TODO clean up observedAttributes etc as this is not the superclass
  static get observedAttributes() {
      return MqttReceiver.observedAttributes.concat(['color', 'min', 'max', 'yaxisid', 'label','topic', 'type']); }
  static get integerAttributes() {
    return MqttReceiver.integerAttributes.concat(['min', 'max']) };

  // Called from MqttTopic to create a chartdataset
  makeChartDataset() {
    // Some other priorities that might be useful are at https://www.chartjs.org/docs/latest/samples/line/segments.html
    if (this.chartdataset) {
      console.error("Trying to create chartdataset twice");
    } else {
      // Fields only defined once - especially data
      // Unclear why reports unused for borderDash, which clear is used
      // noinspection JSUnusedGlobalSymbols,JSUnresolvedReference
      this.chartdataset = {
        data: this.mt.data, // Should be pointer to receiver's data set in MqttReceiver.valueSet
        stepped: this.mt.type === "bool" ? 'before' : false,
        fill:
          this.mt.type !== "bool" ? false :
          {
          target: 'origin',
          above: lightenablecolors.includes(this.state.color) ? "light"+this.state.color : this.state.color,
        },
        segment: {
          borderColor: ctx => skipped(ctx, 'rgb(0,0,0,0.2)'),
          borderDash: ctx => skipped(ctx, [6, 6]),
        },
        spanGaps: true,
        parsing: {
          xAxisKey: 'time',
          yAxisKey: 'value'
        },
      };
    }
    // Things that are changed by attributes
    this.chartdataset.label = this.state.label; // TODO-80 Needs device name
    this.chartdataset.borderColor = this.state.color; // also sets color of point
    this.chartdataset.backgroundColor =this.state.color;
    this.chartdataset.yAxisID = this.state.yaxisid;
    // Should override display and position and grid of each axis used
  }

  // Normally the MqttTopic creates the MqttGraphDataset,
  // However, in an embedded case, just the GraphDataset is created and has to create the topic.
  makeTopic() {
    this.mt = new MqttTopic();
    let tt = this.state.topic.split("/");
    let org = tt.shift();
    let projectId = tt.shift();
    let nodeId = tt.shift();
    this.mt.initialize({
      twig: tt.join("/"),
      //topic: this.state.topic,
      type: this.state.type,
      min: this.state.min,
      max: this.state.max,
      graphdataset: this,
      node: { mt: { topicPath: `${org}/${projectId}/${nodeId}`} }
    });
    // noinspection JSUnresolvedReference
    if (!this.mt.name) {
      this.mt.name = this.mt.leaf;
    }
    this.mt.subscribe(); // TODO-155 check embedded, may have to create a node.
  }
  shouldLoadWhenConnected() {
    return this.state.type && (this.state.topic || this.mt);
  }

  // Note this gets called multiple times as the attributes are set
  loadContent() { // Happens when connected
    if (this.state.topic && !this.mt) { // When embedded
      this.makeTopic();
      this.state.yaxisid = this.mt.yaxisid; // topic will create an appropriate axis if reqd
      this.mt.createGraph();
    }
    // When creating embedded, this.chartdataset is created by MT.createGraph->MGD.makeChartDataset
    // but only once topic is defined
    if (this.chartdataset) {
      this.graph.addDataset(this.chartdataset);
    }
  }
  // noinspection JSUnusedGlobalSymbols
  dataChanged() { // Called when creating UX adds data.
    this.graph.dataChanged();
  }
  // Note this will not update the chart, but the caller will be fetching multiple data files and update all.
  addDataFrom(filename, first, cb) {
    //TODO this location may change
    this.mt.addDataFrom(filename, first, cb);
  }
  removeDataBefore(date) {
    this.mt.removeDataBefore(date);
  }
  // Add any data left to get a new GraphDataSet up to speed with the chart
  addDataLeft() {
    let filenames = this.graph.graphNavleftFilenames(); // Note in reverse order, latest first.
    async.eachOfSeries(filenames, (filename, key, cb) => {
      this.addDataFrom(filename, !key, cb);
    }, () => {
      this.dataChanged();
    });
  }
  render() {
    return null; // Leave blank till can do something to control it
    /*
    return !this.isConnected ? null :
      el('span', { textContent: this.mt.name}); // TODO-46-line should be controls
     */
  }
}
customElements.define('mqtt-graphdataset', MqttGraphDataset);