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
/* This is copied from the chartjs-adapter-luxon, I could not get it to import - gave me an error every time */
/*!
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

const CssUrl = './frugaliot.css';

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
/* End of code copied from chartjs-adapter-luxon.esm.js */

// TODO mqtt_client should be inside the MqttClient class
let mqtt_client; // MQTT client - talking to server
// TODO mqtt_subscriptions should be inside the MqttClient class
let mqtt_subscriptions = [];   // [{topic, cb(message)}]
let unique_id = 1; // Just used as a label for auto-generated elements
let graph;  // Will hold a default MqttGraph once user chooses to graph anything
let server_config;

/* Helpers of various kinds */

// Subscribe to a topic (no wild cards as topic not passed to cb),
function mqtt_subscribe(topic, cb) { // cb(message)
  console.log("Subscribing to ", topic);
  mqtt_subscriptions.push({topic, cb});
  if (mqtt_client.connected) {
    mqtt_client.subscribe(topic, (err) => {
      if (err) console.error(err);
    })
  } else {
    console.log("Delaying till connected");
  }
}
// See https://www.chartjs.org/docs/latest/samples/line/segments.html
const skipped = (ctx, value) => ctx.p0.skip || ctx.p1.skip ? value : undefined;

class Watchdog {
  constructor(el) {
    this.el = el;
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
    this.el.offline();
  }
}

class MqttTopic {
  // Manages a single topic - keeps track of data it has seen, and can create UI element or graphdataset for it
  // Note this intentionally does NOT extend HtmlElement or MqttElement etc
  // Encapsulate a single topic, mostly this will be built during discovery process,
  // but could also be built by hard coded UI if doesn't exist
  // Should be indexed in MqttNode

  // Creation & initialization
  constructor() {
    this.data = [];
    this.qos = 0; // Default to send and not care if received
    this.retain = false; // Default to not retain
  }

  initialize(o) {
    // topic, name, type, display, rw, min, max, color, options, topic, node
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
  get topicSubscribePath() {
    if (this.element && this.element.isNode) {
      return this.topicPath + "/#"; // Subscribe to all subtopics
    } else {
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
      let name = this.name; // comes from discovery
      let el;
      // noinspection JSUnresolvedReference
      switch (this.display) {
        case 'toggle':
          el = EL('mqtt-toggle', {}, [name]);
          this.retain = true;
          this.qos = 1;
          break;
        case 'bar':
          // noinspection JSUnresolvedReference
          el = EL('mqtt-bar', {max: this.max, min: this.min, color: this.color}, []);
          break;
        case 'gauge':
          el = EL('mqtt-gauge', {max: this.max, min: this.min, color: this.color}, []);
          break;
        case 'text':
          el = EL('mqtt-text', {}, []);
          break;
        case 'slider':
          // noinspection JSUnresolvedReference
          el = EL('mqtt-slider', {min: this.min, max: this.max, value: (this.max + this.min) / 2}, [
            EL('span', {textContent: "△"}, []),
          ]);
          break;
        case 'dropdown':
          // noinspection JSUnresolvedReference
          el = EL('mqtt-dropdown', {options: this.options, rw: this.rw, project: this.project});
          this.retain = true;
          this.qos = 1; // This message needs to get through to node
          break;
        default:
          // noinspection JSUnresolvedReference
          console.log("do not know how to display a ", this.display);
      }
      if (el) el.mt = this;
      this.element = el;
    }
    return this.element;
  }

  subscribe() {
    if (!mqtt_client) {
      console.error("Trying to subscribe before connected")
    }
    if (!this.subscribed) {
      this.subscribed = true;
      mqtt_subscribe(this.topicSubscribePath, this.message_received.bind(this));
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
          return Number(message)
        case "int":
          return Number(message)
        case "topic":
          return message;
        case "text":
          return message;
        case "yaml":
          // noinspection JSUnusedGlobalSymbols
          return yaml.loadAll(message, {onWarning: (warn) => console.log('Yaml warning:', warn)});
        default:
          // noinspection JSUnresolvedReference
          console.error(`Unrecognized message type: ${this.type}`);
      }
    } catch (e) {
      console.error("Error parsing message", message, e);
      return null;  // TODO its unclear how this error will be handled - catch specific cases (like unparseable yaml)
    }
  }

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
        text: this.name.replace(/[0-9]+$/,''),
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
      this.graphdataset = EL('mqtt-graphdataset', {
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
    mqtt_client.publish(this.topicSetPath, val, {retain: this.retain, qos: this.qos});
  }

  // Adds historical data to the chart - typically chart updates data for each line, then updates the chart.
  addDataFrom(filename, first, cb) {
    //TODO this location may change
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
            console.log("No data in", filepath);
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

  topicMatches(subscriptionTopic, messageTopic) {
    if (subscriptionTopic.endsWith('/#')) {
      return (messageTopic.startsWith(subscriptionTopic.substring(0, subscriptionTopic.length - 2)));
    } else {
      return (subscriptionTopic === messageTopic);
    }
  }
  loadContent() {
    //console.log("loadContent", this.state.server);
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
        //path: "/mqtt",
      });
      for (let k of ['disconnect','reconnect','close','offline','end']) {
        mqtt_client.on(k, () => {
          this.setStatus(k);
        });
      }
      mqtt_client.on('connect', () => {
        this.setStatus('connect');
        if (mqtt_subscriptions.length > 0) {
          mqtt_subscriptions.forEach((s) => {
            console.log("Now connected, subscribing to",s.topic);
            mqtt_client.subscribe(s.topic, (err) => { if (err) console.error(err); });
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
      mqtt_client.on('message', (topic, message) => {
        // message is Buffer
        // TODO - check whether topic is string or buffer.
        let msg = message.toString();
        console.log("Received", topic, " ", msg);
        for (let o of mqtt_subscriptions) {
          if (this.topicMatches(o.topic, topic)) {
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
      EL('link', {rel: 'stylesheet', href: CssUrl}),
      EL('details', {class: 'mqtt-client'},[
        EL('summary', {}, [
          EL('span', {class: 'status', textContent: this.state.status}),
            ]),
        EL('span',{class: 'demo', textContent: "server: "+this.state.server}),
      ]),
    ];
  }
}
customElements.define('mqtt-client', MqttClient);

class MqttLogin extends HTMLElementExtended { // TODO-89 may depend on organization
  constructor(props) {
    super(props);
    this.state = {register: false};
    this.loadAttributesFromURL(); // Overrides register if in URL
  }
  static get observedAttributes() { return ['register','message','url']; }
  static get boolAttributes() { return ['register']; }

  tabRegister(register) {
    this.changeAttribute('register', register);
    this.renderAndReplace();
  }
  render() { //TODO-89 needs styles
    // TODO-89 organization should be dropdown
    // TODO-89 merge login & register
    return [
      EL('link', {rel: 'stylesheet', href: CssUrl}),
      EL('div', {class: 'mqtt-login'},[
        EL('div',{class: 'message'},[
          EL('span', {textContent: this.state.message}),
        ]),
        EL('section', {class: 'tabs'}, [
          EL('button', {class: 'tab' + (!this.state.register ? ' active' : ' inactive'), onclick: this.tabRegister.bind(this, false), textContent: "Sign In"}),
          EL('button', {class: 'tab' + (this.state.register ? ' active' : ' inactive'), onclick: this.tabRegister.bind(this, true), textContent: "Register"}),
        ]),
        EL('form', {action:  (this.state.register ? '/register' : '/login'), method: "post"}, [
          EL('section', {}, [
            EL('label', {for: "username", textContent: "Username"}),
            EL('input', {id: "username", name: "username", type: "text", autocomplete: "username", required: true, autofocus: true}),
          ]),
          EL('section', {}, [
            EL('label', {for: "password", textContent: "Password"}),
            EL('input', {id: "password", name: "password", type: "password", autocomplete: "current-password", required: true}),
          ]),
          // TODO-22 organization should be a drop-down
          !this.state.register ? null : [
            EL('section', {}, [
              EL('label', {for: "organization", textContent: "Organization"}),
              EL('input', {id: "organization", name: "organization", type: "text", autocomplete: "organization", required: true}),
            ]),
            EL('section', {}, [
              EL('label', {for: "name", textContent: "Name"}),
              EL('input', {id: "name", name: "name", type: "text", autocomplete: "name", required: true}),
            ]),
            EL('section', {}, [
              EL('label', {for: "email", textContent: "Email"}),
              EL('input', {id: "email", name: "email", type: "text", autocomplete: "email", required: true}),
            ]),
            EL('section', {}, [
              EL('label', {for: "phone", textContent: "Phone or Whatsapp"}),
              EL('input', {id: "phone", name: "phone", type: "text", autocomplete: "phone", required: true}),
            ]),
          ],
          EL('input', {id: "url", name: "url", type: "hidden", value: this.state.url}),
          EL('button', {class: "submit", type: "submit",
            textContent: (this.state.register ? 'Submit' : 'Submit')}),
          ]),
      ]),
    ];
  }
}
customElements.define('mqtt-login', MqttLogin);

class MqttElement extends HTMLElementExtended {
}

class MqttReceiver extends MqttElement {
  static get observedAttributes() { return ['value','color','type','label','topic']; }
  static get boolAttributes() { return []; }

  get isNode() { return false; } // Overridden in MqttNode
  get node() {
    return this.mt.node;
  }
  connectedCallback() {
    if (this.state.topic && !this.mt) {
      // Created with a topic string- which should be a path, so create the MqttTopic
      this.createTopic();
    }
    super.connectedCallback();
  }
  // This should be called when a receiver is created with a topic (which should be a path)
  // But not sure how this still works because the mt will not have a node, which is presumed.
  // TODO-130 test embedded examples - doubt this will work now, without a node.
  createTopic() {
    console.error("TODO-130 Not expecting MqttReceiver.createTopic to work");
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
    mt.subscribe(); //TODO-130 check embedded case,
  }
  topicValueSet(topic, message) {
    // TODO-130 I think this is where we catch "set" (at topicSetPath
    if (topic === this.mt.topicPath) {
      let value = this.mt.valueFromText(message);
      let now = Date.now();
      this.mt.data.push({value, time: now}); // Same format as graph dataset expects
      if (this.node && this.node.topicChanged) { // There is (currently) no node if it is a Project and no "topicChanged" if embedded
        this.node.topicChanged(this.mt.leaf, value);
      }
      return this.valueSet(value);
    }
    console.error("Unhandled topicValueSet", topic, message);
    return false;
  }
  valueSet(val) {
    // Note val can be of many types - it will be subclass dependent
    this.state.value = val;
    return true; // Rerender by default - subclass will often return false
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
}

class MqttText extends MqttReceiver {
  // constructor() { super(); }
  render() {
    return [
      EL('div', {},[
        EL('span',{class: 'demo', textContent: this.mt.leaf + ": "}),
        EL('span',{class: 'demo', textContent: this.state.value || ""}),
      ])
    ]
  }
}
customElements.define('mqtt-text', MqttText);

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
    return MqttTransmitter.observedAttributes.concat(['checked','indeterminate']);
  }
  // TODO - make sure this doesn't get triggered by a message from server.
  onChange(e) {
    //console.log("Changed"+e.target.checked);
    this.state.value = e.target.checked; // Boolean
    this.publish();
  }

  render() {
    //this.state.changeable.addEventListener('change', this.onChange.bind(this));
    return [
      EL('link', {rel: 'stylesheet', href: CssUrl}),
      EL('div', {},[
        EL('input', {type: 'checkbox', id: 'checkbox'+ (++unique_id) ,
          checked: !!this.state.value, indeterminate: typeof(this.state.value) == "undefined",
          onchange: this.onChange.bind(this)}),
        EL('img', {class: "icon", src: 'images/icon_graph.svg', onclick: this.opengraph.bind(this)}),
        EL('label', {for: 'checkbox'+unique_id }, [
          EL('slot', {}),
        ]),
      ]),
    ];
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
  render() {
    //this.state.changeable.addEventListener('change', this.onChange.bind(this));
    let width = 100*(this.state.value-this.state.min)/(this.state.max-this.state.min);
    // noinspection JSUnresolvedReference
    return !(this.isConnected && this.mt) ? null : [
      EL('link', {rel: 'stylesheet', href: CssUrl}),
      EL('div', {class: "outer mqtt-bar"}, [

        EL('div', {class: "name"}, [
          EL('label', {for: this.mt.topicPath, textContent: this.mt.name}),
          EL('img', {class: "icon", src: 'images/icon_graph.svg', onclick: this.opengraph.bind(this)}),
        ]),
        EL('div', {class: "bar", id: this.mt.topicPath},[
          EL('span', {class: "left", style: `width:${width}%; background-color:${this.state.color};`},[
            EL('span', {class: "val", textContent: this.state.value}),
          ]),
          //Do not appear to need this - and it sometimes wraps, so if re-enable, need to make sure always horiz next to left
          //EL('span', {class: "right", style: "width:"+(100-width)+"%"}),
        ]),
        EL('slot',{}), // Children would be a setpoint, but not using currently
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
    return !(this.isConnected && this.mt) ? null : [
      EL('link', {rel: 'stylesheet', href: CssUrl}),
      EL('div', {class: "outer mqtt-gauge"}, [
        this.dg = EL('dial-gauge', {
          "main-title": this.mt.name,
          "sub-title": "",
          "scale-start": this.state.min,
          "scale-end": this.state.max,
          "value": this.state.value,
          "scale-offset": 45,
          "style": `--dg-arc-color:${this.state.color}`,
        }),
        EL('img', {class: "icon", src: 'images/icon_graph.svg', onclick: this.opengraph.bind(this)}),
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
    return ((this.state.value-this.state.min)/(this.state.max-this.state.min)) * (this.slider.offsetWidth) - this.thumb.offsetWidth/2;
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
      this.thumb = EL('div', {class: "setpoint"}, this.children);
      this.slider = EL('div', {class: "pointbar",},[this.thumb]);
      this.slider.onmousedown = this.onmousedown.bind(this);
    }
    return !this.isConnected ? null : [
      EL('link', {rel: 'stylesheet', href: CssUrl}),
      EL('div', {class: "mqtt-slider outer"}, [
        EL('div', {class: "name"}, [ //TODO maybe use a label
          // noinspection JSUnresolvedReference
          EL('span', {textContent: this.mt.name}),
          EL('span', {class: "val", textContent: this.state.value}), // TODO restrict number of DP
        ]),
        this.slider,  // <div.setpoint><child></div
      ])
    ];
  }
}
customElements.define('mqtt-slider', MqttSlider);

// TODO-43 rename as MqttChooseTopic
class MqttDropdown extends MqttTransmitter {
  // options = "bool" for boolean topics (matches t.type on others)
  static get observedAttributes() { return MqttTransmitter.observedAttributes.concat(['options','project','rw']); }

  // TODO-43 may need to change findTopics to account for other selection criteria
  findTopics() {
    let project = this.state.project;
    let nodes = Array.from(project.children);
    // Note each node's value is its config
    let allowableTypes = {
      // Mapping of requested types to valid fields - e.g. if want a float then returning an int will be fine
      "float": ["float","int"],
      "text": ["text","float","int","bool"],
    }
    return nodes.map(n => n.topicsByType(allowableTypes[this.state.options] || this.state.options, this.state.rw))
      .flat();
  }
  // noinspection JSCheckFunctionSignatures
  valueSet(val) {
    super.valueSet(val);
    // TODO get smarter about setting "selected" instead of rerendering
    return true; // Rerenders on moving based on any received value to change selected topic
  }
  onchange(e) {
    //console.log("Dropdown onchange");
    this.state.value = e.target.value; // Want the value
    this.publish();
  }

  render() {
    // noinspection JSUnresolvedReference
    return !this.isConnected ? null : [
      EL('link', {rel: 'stylesheet', href: CssUrl}),
      EL('div', {class: 'outer mqtt-dropdown'}, [
        EL('label', {for: this.mt.topicPath, textContent: this.mt.name}),
        EL('select', {id: this.mt.topicPath, onchange: this.onchange.bind(this)}, [
          EL('option', {value: "", textContent: "Unused", selected: !this.state.value}),
          this.findTopics().map( t => // { name, type etc. }
            EL('option', {value: t.topicPath, textContent: t.name, selected: t.topicPath === this.state.value}),
          ),
        ]),
      ]),
    ];
  }
  // super.valueGet fine as its text
}
customElements.define('mqtt-dropdown', MqttDropdown);

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
  static get observedAttributes() { return MqttReceiver.observedAttributes.concat(['organization','project','node']); }
  // Maybe add 'discover' but think thru interactions
  //static get boolAttributes() { return MqttReceiver.boolAttributes.concat(['discover'])}

  // Note this is not using the standard connectedCallBack which loads content and re-renders,
  // it is going to instead add things to the slot

  message(msg) {
    console.error(msg);
    this.append(EL('div', {class: 'message', textContent: msg}));
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
      EL('mqtt-client', {slot: 'client', server: server_config.mqtt.broker}) // typically "wss://frugaliot.naturalinnovation.org/wss"
    )
  }
  addProject(discover) {
    let twig = `${this.state.organization}/${this.state.project}`;
    // noinspection JSUnresolvedReference
    let elProject = EL('mqtt-project', {discover, id: this.state.project, name: server_config.organizations[this.state.organization].projects[this.state.project].name }, []);
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
            EL('div', {class: 'dropdown'}, [
              EL('label', {for: 'organizations', textContent: "Organization"}),
              EL('select', {id: 'organizations', onchange: this.onOrganization.bind(this)}, [
                EL('option', {value: "", textContent: "Not selected", selected: !this.state.value}),
                Object.entries(server_config.organizations).map( ([oid, o]) =>
                  EL('option', {value: oid, textContent: `${oid}: ${o.name}`, selected: false}),
                ),
              ]),
            ]));
        } else { // !n !p o  // TODO-69 maybe this should be a blank project ?
          // noinspection JSUnresolvedReference
          this.append( this.state.projectEl =
            EL('div', {class: 'dropdown'}, [
              EL('label', {for: 'projects', textContent: "Project"}),
              EL('select', {id: 'projects', onchange: this.onProject.bind(this)}, [
                EL('option', {value: "", textContent: "Not selected", selected: !this.state.value}),
                Object.entries(server_config.organizations[this.state.organization].projects).map(([pid,p]) =>
                  EL('option', {value: pid, textContent: (p.name ? `${pid}: ${p.name}` : pid), selected: false})
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
  render() {
    return [
      EL('link', {rel: 'stylesheet', href: CssUrl}),
      EL('div', {class: 'outer mqtt-wrapper'}, [
        EL('slot', {name: 'client'}),
        EL('slot'),
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
    let elNode = EL('mqtt-node', {id, topic: topicPath, discover: this.state.discover},[]);
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
  render() {
    return  !this.isConnected ? null : [
      EL('link', {rel: 'stylesheet', href: CssUrl}),
      EL('div', {class: "outer mqtt-project"}, [
        EL('div', {class: "title"},[
          EL('span',{class: 'projectname', textContent: this.mt.twig }), // twig should be e.g. dev/lotus
          EL('span',{class: 'name', textContent: this.state.name}),
        ]),
        EL('div', {class: "nodes"},[
          EL('slot', {}),
        ]),
      ])
    ];
  }
}
customElements.define('mqtt-project', MqttProject);

class MqttNode extends MqttReceiver {
  static get observedAttributes() { return MqttReceiver.observedAttributes.concat(['id', 'discover']); }
  static get boolAttributes() { return MqttReceiver.boolAttributes.concat(['discover'])}
  static get integerAttributes() { return MqttReceiver.integerAttributes.concat(['days'])}

  constructor() {
    super(); // Will subscribe to topic
    this.state.topics = {}; // Index of MqttTopic - TODO-13 is this topicLeafs or topicPaths ?
    this.state.days = 0;
    this.watchdog = new Watchdog(this);
    this.state.lastseen = 0;
    this.groups = {}; // Index of groups
    this.queue = []; // Queue of topics to process when discovery received
  }
  get isNode() { return true; } // Overrides suprclass in MqttReceiver

  get usableName() {
    return (this.state.name === "device") ? this.state.id : this.state.name;
  }
  // Filter the topics on this node by type e.g. "bool" "float" or ["float","int"]
  topicsByType(types, rw) { // [ { name, topic: topicpath } ]
    if (!this.state.value) { return []; } // If have not received discovery, do not report any topics
    let usableName = this.usableName;
    return this.state.value.topics
      .filter( t => types.includes(t.type))
      .filter(t => t.rw.includes(rw))
      // TODO-130 this will currently work since t.topic is a twig but wont in future - test it (dropdown only i presume)
      .map(t=> { return({name: `${usableName}:${t.name}`, topic: this.mt.topicPath + "/" + t.topic})});
  }
  appendGroup(t) { // t = { group, name }
    if (!this.groups[t.group]) {
      this.groups[t.group] = EL('details', {class: `group ${t.group}`}, [
        EL('summary',{},[
          EL('span', {textContent: t.name || t.group}),
        ])
      ]);
      this.append(this.groups[t.group]);
    }
    return this.groups[t.group];
  }
  // Have received a discovery message for this node - create elements for all topics and subscribe
  // noinspection JSCheckFunctionSignatures
  topicValueSet(topic, message) {
    if (topic === this.mt.topicPath) { // Its discover for this Node, not a sub-element
      let rerender = this.valueSet(this.mt.valueFromText(message));
      let i;
      while (i = this.queue.shift()) {
        this.topicValueSet(i.topic, i.message);
      }
      return rerender;
    } else if (this.state.discover) { // queue if waiting for discovery
      // Still waiting on discovery.
      this.queue.push({topic, message});
      return false; // Do not rerender as waiting for discovery
    } else { // Its a sub-topic
      let leaf = topic.substring(this.mt.topicPath.length+1);
      if (this.state.topics[leaf]) {
        this.state.topics[leaf].message_received(topic, message);
      }
    }
  }
  valueSet(obj) { // Val is object converted from Yaml
    if (this.state.discover) { // If do not have "discover" set, then presume have defined what UI we want on this node
      this.state.discover = false; // Only want "discover" once, if change then need to get smart about not redrawing working UI as may be relying on data[]
      console.log(obj); // Useful for debugging to see this
      let nodediscover = obj[0]; // Should only ever be one of them
      this.state.value = nodediscover; // Save the object for this node
      ['id', 'description', 'name'].forEach(k => this.state[k] = nodediscover[k]); // Grab top level properties from Discover
      while (this.childNodes.length > 0) this.childNodes[0].remove(); // Remove and replace any existing nodes
      if (this.state.lastSeenElement) { this.append(this.state.lastSeenElement); } // Re-add the lastseen element
      if (!nodediscover.topics) { nodediscover.topics = []; } // if no topics, make it an empty array
      nodediscover.topics.forEach(t => {  // Note t.topic in discovery is twig // TODO-130 may not always be twigs
        if (!t.topic && t.group) {
          this.appendGroup(t);
        } else if (!this.state.topics[t.topic]) { // Have we done this already?
          let mt = new MqttTopic();
          mt.fromDiscovery(t, this);
          this.state.topics[t.topic] = mt;
          // mt.subscribe(); Node will forward to sub topics
          let el = mt.createElement();
          if (['battery','ledbuiltin'].includes(mt.leaf)) { // TODO-30 parameterize this
            // noinspection JSCheckFunctionSignatures
            el.setAttribute('slot', mt.leaf);
          }
          // noinspection JSUnresolvedReference
          if (mt.group) {
            // noinspection JSUnresolvedReference
            this.appendGroup({group: mt.group}); // Check it exists and if not create it
            // noinspection JSUnresolvedReference
            this.groups[mt.group].append(el);
          } else {
            this.append(el);
          }
        }
      });
      let project = this.state.project;
      // Rerender any dropdown elements based on this discovery.
      // TODO make this use new functions node.project, project.nodes, node.topics
      Array.from(project.children)
        .map(n => Object.values(n.state.topics))
        .flat(1)
        .map(t => t.element)
        .filter(el => (el instanceof MqttDropdown))
        .forEach(el => el.renderAndReplace());
      return true; // because change name description etc.
    } else {
      return false;
    }
  }
  /*
  shouldLoadWhenConnected() {
  // For now relying on retention of advertisement by broker
    return this.state.id && super.shouldLoadWhenConnected() ;
  }
 */
  // TODO-13 do we just set state here, or change hte render ? 
  topicChanged(leaf, value) {
    switch (leaf) {
      case "battery":
        let bars = Math.floor(parseInt(value) * 6/4200);
        this.state.batteryIndicator.src = `images/Battery${bars}.png`;
        break;
    }
  }
  render() {
    return !this.isConnected ? null : [
      EL('link', {rel: 'stylesheet', href: CssUrl}),
      this.state.outerDiv = EL('div', {class: 'outer mqtt-node'+((this.state.online) ? '' : ' offline')}, [
        EL('details', {},[
          EL('summary', {},[
            EL('span',{class: 'name', textContent: this.state.name}),
            EL('span',{class: 'nodeid', textContent: this.state.id}),
            //Starts off as 1px empty image, changed when battery message received
            this.state.batteryIndicator = EL('img', {class: "batteryimg", src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"}),
          ]),
          EL('span',{class: 'description', textContent: this.state.description}),
          EL('slot', {name: 'lastseen', class: 'lastseen'}),
          EL('div', {class: "health"},[
            EL('slot',{name: 'ledbuiltin'}),
            EL('slot',{name: 'battery'}),
          ]),
        ]),
        EL('div', {class: "topics"},[
          EL('slot', {}),
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
    if (this.state.lastSeenElement) {
      this.removeChild(this.state.lastSeenElement);
    }
    //TODO-113 could probably also do by replacing inner text if it flickers
    this.state.lastSeenElement = EL('span', {slot: "lastseen", class: 'lastseen', textContent: lastseentime ? new Date(lastseentime).toLocaleString() : "Never seen"});
    this.append(this.state.lastSeenElement);
  }
}
customElements.define('mqtt-node', MqttNode);

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
      graph = EL('mqtt-graph');
      document.body.append(graph);
    }
    return graph;
  }

  // Note - makeChart is really fussy, the canvas must be inside something with a size.
  // For some reason, this does not work by adding inside the render - i.e. to the virtual Dom.
  loadContent() {
    this.canvas = EL('canvas');
    this.append(EL('div', {slot: "chart", style: "width: 80vw; height: 60vw; position: relative;"},[this.canvas]));
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
      EL('link', {rel: 'stylesheet', href: CssUrl}),
      // TODO see https://www.chartjs.org/docs/latest/configuration/responsive.html#important-note div should ONLY contain canvas
      EL("div", {class: 'outer mqtt-graph'}, [
        EL('div',{class: 'leftright'}, [
          EL('div',{},[
            this.state.imageLeft = EL('span', {class: "graphnavleft", textContent: "⬅︎", onclick: this.graphnavleft.bind(this)}),
            EL('span', {class: "graphnavright", textContent: "↺", onclick: this.graphnavright.bind(this)}),
          ]),
          EL('slot', {name: "chart"}), // This is <div><canvas></div>
        ]),
        EL('slot', {}), // This is the slot where the GraphDatasets get stored
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
    this.mt.subscribe(); // TODO-130 check embedded, may have to create a node.
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
      EL('span', { textContent: this.mt.name}); // TODO-46-line should be controls
     */
  }
}
customElements.define('mqtt-graphdataset', MqttGraphDataset);