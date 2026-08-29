/*
 * Canned MQTT scenarios, replayed into the data tree with no broker.
 *
 * Works unchanged in node (see setup.js) and in a browser (see mock.html), because the only seam
 * it uses is mqtt_deliver - the same call the real client makes for every message it receives.
 */
import { configSet, el, mqtt_deliver, mqtt_unsubscribe_organization, server_config, setClock,
         MqttTopicProject } from '../webcomponents.js';

const ORG = 'dev';
const PROJECT = 'lotus';

// One device's worth of messages. `id` is the node id; `groups` maps twig -> payload.
// Values are strings because that is what arrives off the wire.
function device(id, name, twigs, { ota = 'sht30_c3_pico', battery = '3940', wifi = 'shed-ap' } = {}) {
  const msgs = [[`${ORG}/${PROJECT}`, id]]; // Discovery: node id published on the project topic
  const base = `${ORG}/${PROJECT}/${id}`;
  msgs.push([`${base}/frugal_iot/name`, name]);
  msgs.push([`${base}/frugal_iot/description`, `${name} - test scenario`]);
  if (ota) msgs.push([`${base}/ota/key`, ota]);
  if (battery) msgs.push([`${base}/battery/battery`, battery]);
  if (wifi) { msgs.push([`${base}/health/wifibars`, '3']); msgs.push([`${base}/health/wifissid`, wifi]); }
  Object.entries(twigs).forEach(([twig, val]) => msgs.push([`${base}/${twig}`, val]));
  return msgs;
}

// A control wired to a sensor and a relay: `wired` parameters arrive on the set path.
function wiring(id, groupId, wires) {
  const base = `${ORG}/${PROJECT}/${id}/set/${groupId}`;
  return Object.entries(wires).map(([leaf, target]) => [`${base}/${leaf}/wired`, target]);
}

const SHT = { 'sht/temperature': '30.142857', 'sht/humidity': '85.1' };

// A plausible reading for a topic, so the every-module scenario shows something in every widget
function sampleValue(spec) {
  switch (spec.type) {
    case 'bool':  return 'true';
    case 'int':   return String(Math.round(((spec.min ?? 0) + (spec.max ?? 100)) / 2));
    case 'float':
    case 'exponential': {
      const mid = ((spec.min ?? 0) + (spec.max ?? 100)) / 2;
      return (Math.round(mid * 10) / 10).toString();
    }
    case 'color': return '#3388cc';
    default:      return 'sample';
  }
}

export const scenarios = {
  'one-device': {
    title: 'One device, SHT readings only',
    messages: device('esp8266-fb94bb', 'Greenhouse North', SHT),
  },

  'no-readings': {
    title: 'Device discovered but silent - no readings yet',
    messages: [[`${ORG}/${PROJECT}`, 'esp8266-newborn']],
  },

  'default-front': {
    // No devices.yaml entry matches "workbench_c3", so the default ordering applies - and two
    // temperature sources exercise the label-collision rule
    title: 'Unconfigured device (default front) with two temperature sources',
    messages: device('esp8266-two-temps', 'Two Temperatures', {
      ...SHT,
      'ds18b20/ds18b20': '18.3',
      'soil/soil': '38',
      'relay/on': 'true',
    }, { ota: 'workbench_c3' }),
  },

  'out-of-range': {
    // temperature is 0..50 and humidity 0..100 in topics.yaml, so one is far below its range and
    // the other above it - the two ends look different and both need checking
    title: 'Readings below and above their declared min/max',
    messages: device('esp8266-broken', 'Broken Probe', { 'sht/temperature': '-999', 'sht/humidity': '118.4' }),
  },

  'control-wired': {
    title: 'Control wired to a local sensor, driving a local relay',
    messages: [
      ...device('esp8266-fb94bb', 'Greenhouse North', {
        ...SHT,
        'relay/on': 'true',
        'controlhysteresis/now': '30.1',
        'controlhysteresis/limit': '32',
        'controlhysteresis/greater': 'true',
        'controlhysteresis/hysteresis': '3',
        'controlhysteresis/out': 'true',
      }),
      ...wiring('esp8266-fb94bb', 'controlhysteresis', {
        now: `${ORG}/${PROJECT}/esp8266-fb94bb/sht/temperature`,
        out: `${ORG}/${PROJECT}/esp8266-fb94bb/set/relay/on`,
      }),
    ],
  },

  'control-unwired': {
    title: 'Control present but nothing wired to it',
    messages: device('esp8266-fb94bb', 'Greenhouse North', {
      ...SHT,
      'controlhysteresis/limit': '32',
      'controlhysteresis/greater': 'true',
    }),
  },

  'unknown-module': {
    // Nothing in modules.yaml declares 'quantumflux' - it must still reach the back of the card,
    // because that is what someone adding a module needs to see
    title: 'A module absent from modules.yaml',
    messages: device('esp8266-odd', 'Odd Device', { 'quantumflux/spin': '42', 'quantumflux/charm': 'up' }),
  },

  'module-no-data': {
    // The group exists, because one of its topics reported and the rest come from the template -
    // so humidity has a row and no value. Distinct from a device that has said nothing at all.
    title: 'A module present but one of its readings never arrives',
    messages: device('esp8266-halfsht', 'Half an SHT', { 'sht/temperature': '24.5' }),
  },

  'graph-history': {
    // A run of readings spread over a day, so a graph has something to draw. The third element of a
    // message is when it arrived: the clock is set to it before delivery, which is why timestamps go
    // through nowMs rather than Date.now.
    title: 'One device with a day of readings, for the graph',
    messages: () => {
      const id = 'esp8266-history';
      const base = `${ORG}/${PROJECT}/${id}`;
      const start = 1800000000000 - (24 * 3600 * 1000);
      const msgs = [[`${ORG}/${PROJECT}`, id, start],
                    [`${base}/frugal_iot/name`, 'A Day of Readings', start],
                    [`${base}/ota/key`, 'sht30_c3_pico', start]];
      for (let i = 0; i < 144; i++) {                    // every ten minutes for a day
        const at = start + (i * 600000);
        const t = 18 + (8 * Math.sin((i / 144) * 2 * Math.PI)); // a daily swing
        msgs.push([`${base}/sht/temperature`, t.toFixed(2), at]);
        msgs.push([`${base}/sht/humidity`, (70 - (t - 18) * 2).toFixed(1), at]);
        msgs.push([`${base}/battery/battery`, String(4100 - i), at]);
      }
      return msgs;
    },
  },

  'every-device': {
    // One device per devices.yaml entry, each announcing that entry's OTA key, so every configured
    // card layout can be seen at once. Built when it runs, since it reads the schema.
    title: 'One device for every entry in devices.yaml',
    messages: () => {
      const devices = (server_config && server_config.schema && server_config.schema.devices) || {};
      const modules = (server_config && server_config.schema && server_config.schema.modules) || {};
      const topics = (server_config && server_config.schema && server_config.schema.topics) || {};
      const msgs = [];
      Object.keys(devices).sort().forEach((key) => {
        const id = `esp8266-${key}`;
        const base = `${ORG}/${PROJECT}/${id}`;
        msgs.push([`${ORG}/${PROJECT}`, id]);
        msgs.push([`${base}/frugal_iot/name`, key]);
        msgs.push([`${base}/ota/key`, `${key}_c3_pico`]);   // matches the entry by prefix
        msgs.push([`${base}/battery/battery`, '3940']);
        const entry = devices[key];
        const wanted = [...(entry.front || []), ...(entry.summary || [])];
        [...new Set(wanted)].forEach((e) => {
          const [groupId, leaf] = e.split('/');
          const module = modules[groupId];
          if (!module) return;
          // A bare module id is a control: give it every leaf, and wire its output so it is not idle
          const leaves = leaf ? [leaf] : (module.topics || []).map((t) => t.leaf);
          leaves.forEach((l) => {
            const t = (module.topics || []).find((x) => x.leaf === l) || {};
            msgs.push([`${base}/${groupId}/${l}`, sampleValue({ ...(topics[t.leaf_from || l] || {}), ...t })]);
          });
          if (!leaf && leaves.includes('out')) {
            msgs.push([`${base}/set/${groupId}/out/wired`, `${base}/set/relay/on`]);
          }
        });
      });
      return msgs;
    },
  },

  'every-module': {
    // Every module in the schema at once, alphabetically: ugly on purpose, so every sensor and
    // control can be eyeballed in one pass. Built when the scenario runs, since it needs the schema.
    title: 'Every module in the schema (for scanning, not for looking at)',
    messages: () => {
      const modules = (server_config && server_config.schema && server_config.schema.modules) || {};
      const topics = (server_config && server_config.schema && server_config.schema.topics) || {};
      const id = 'esp8266-everything';
      const msgs = [[`${ORG}/${PROJECT}`, id], [`${ORG}/${PROJECT}/${id}/frugal_iot/name`, 'Everything']];
      Object.keys(modules).sort().forEach((groupId) => {
        (modules[groupId].topics || []).forEach((t) => {
          const spec = { ...(topics[t.leaf_from || t.leaf] || {}), ...t };
          msgs.push([`${ORG}/${PROJECT}/${id}/${groupId}/${t.leaf}`, sampleValue(spec)]);
        });
      });
      return msgs;
    },
  },

  'mixed-sensors': {
    // The agri entry in devices.yaml declares soil and ds18b20 ahead of the SHT
    title: 'Soil, DS18B20 and SHT, ordered by the agri devices.yaml entry',
    messages: device('esp8266-agri', 'Bed 3', {
      ...SHT,
      'ds18b20/ds18b20': '18.3',
      'soil/soil': '38',
    }, { ota: 'agri_d1_mini' }),
  },
};

// `manual` is still absent: the node implements it in examples/sonoff, but no module declares it,
// so nothing arrives on that topic. See CARDS_UX.md L-2.

export function loadConfig(config) {
  configSet(config);
}

// A scenario's messages, built on demand if it needs the schema to construct them
export function messagesOf(name) {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`No such scenario: ${name}`);
  return (typeof scenario.messages === 'function') ? scenario.messages() : scenario.messages;
}

// Freeze "now" so status (live / stale / offline) can be tested without waiting for it.
// setNow(null) hands the clock back to Date.now.
export function setNow(t) {
  setClock(t === null ? null : () => t);
}

// Build a project data tree and replay a scenario into it.
// headless: true builds the data tree only. headless: false builds the existing node/group UI too,
// which is how the same scenarios give that UI a regression check - see CARDS_PLAN.md phase 0.
// Returns { projectMt, projectEl } (projectEl is null when headless).
export function runScenario(name, { headless = true, container = null, at = null } = {}) {
  const scenario = scenarios[name];
  if (!scenario) throw new Error(`No such scenario: ${name}`);
  if (at !== null) setNow(at); // Deliver the whole scenario at one instant
  // Subscriptions are module-level and would otherwise leak between scenarios, delivering one
  // scenario's messages into the previous scenario's tree.
  mqtt_unsubscribe_organization(ORG);

  const projectMt = new MqttTopicProject();
  let projectEl = null;
  if (headless) {
    projectMt.initialize({ type: 'text', twig: `${ORG}/${PROJECT}`, headless: true });
  } else {
    projectEl = el('mqtt-project', { discover: true, id: PROJECT, name: 'Lotus Ponds' }, []);
    projectMt.initialize({ type: 'text', twig: `${ORG}/${PROJECT}`, element: projectEl });
    projectEl.mt = projectMt;
    (container || document.body).append(projectEl); // connectedCallback renders on append
  }
  projectMt.subscribe();
  // A message may carry the instant it arrived, so a replayed history is spread over real time
  // rather than piling onto one moment
  messagesOf(name).forEach(([topic, payload, when]) => {
    if (when !== undefined) setNow(when);
    mqtt_deliver(topic, payload);
  });
  return { projectMt, projectEl };
}

// Deliver one extra message into a scenario already running - a device arriving late, say
export function deliver(topic, payload) {
  mqtt_deliver(topic, payload);
}

export { ORG, PROJECT };
