/*
 * Frugal IoT client - graph.html: readings from the server's GET /api/data drawn as one chart.
 *
 * Everything is in the page's URL, so a link shows the same chart to anyone allowed to read it - which
 * is what the server's MCP tool graph_link hands out (frugal-iot-server issue #44), and what the address
 * bar gives anyone who wants to send one on:
 *
 *   graph.html?device=dev/lotus/+/sht/temperature&from=2026-11-01&to=2026-11-08&bucket=1h&tz=Asia/Kolkata
 *
 * device is repeated or comma-separated and may use "+", exactly as /api/data takes it. With a bucket,
 * each series is drawn as its mean with a band from min to max; without, every reading. One y axis per
 * unit, so temperature and humidity can share a chart.
 *
 * No MQTT: this is history only. The server sends the page itself only to a logged-in browser, and a
 * 401 from /api/data (a session that ended while the page was open) goes to the login page and back.
 */

import { Chart, variantColor, addAlpha } from './graph.js';
import { configSet, el, getString, moduleBaseId, redirectToLogin, server_config, unitSymbol } from './core.js';

const UNIT_MS = { m: 60000, h: 3600000, d: 86400000 };
const RAW_GAP_MS = 3600000; // unbucketed, a silence longer than this is drawn as a break in the line
const AGG_SUFFIX = /\/(mean|min|max|count)$/;
// For a field the schema gives no colour, so lines are still told apart
const PALETTE = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2'];

// What the page's URL asks for
export function graphParams(search) {
  const p = new URLSearchParams(search);
  const devices = p.getAll('device').flatMap((d) => d.split(',')).map((d) => d.trim()).filter(Boolean);
  const bucket = p.get('bucket') || '';
  const m = /^(\d+)([mhd])$/.exec(bucket);
  return {
    devices,
    from: p.get('from') || '',
    to: p.get('to') || '',
    bucket: m ? bucket : '',
    bucketMs: m ? Number(m[1]) * UNIT_MS[m[2]] : 0,
    tz: p.get('tz') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    title: p.get('title') || '',
  };
}

// The /api/data request for those
export function dataUrl({ devices, from, to, bucket, tz }) {
  const q = new URLSearchParams();
  devices.forEach((d) => q.append('device', d));
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (bucket) { q.set('bucket', bucket); q.set('agg', 'mean,min,max'); }
  q.set('tz', tz);
  return `/api/data?${q}`;
}

/*
 * SenML (API.md 4.2: a base record per node, times relative to it, in seconds) into one entry per
 * node and field: { node, module, field, points: [{ t, v }] } unbucketed, or { node, module, field,
 * mean, min, max: [{ t, v }] } bucketed. Sorted by node, then field.
 */
export function seriesFromSenML(pack) {
  const out = new Map();
  let bn = '';
  let bt = 0;
  for (const r of pack || []) {
    if (r.bn !== undefined) { bn = r.bn; bt = r.bt || 0; }
    if (r.n === undefined || typeof r.v !== 'number') continue;
    const agg = (AGG_SUFFIX.exec(r.n) || [])[1];
    const name = agg ? r.n.replace(AGG_SUFFIX, '') : r.n;
    const [module, field] = name.split('/');
    const node = bn.replace(/\/$/, '');
    const key = `${node}/${name}`;
    if (!out.has(key)) out.set(key, { node, module, field });
    const s = out.get(key);
    const list = agg || 'points';
    (s[list] ||= []).push({ t: Math.round((bt + (r.t || 0)) * 1000), v: r.v });
  }
  return [...out.values()].sort((a, b) => (`${a.node}/${a.module}/${a.field}` < `${b.node}/${b.module}/${b.field}` ? -1 : 1));
}

// Chart.js points, with a null wherever the readings stop for longer than gapMs, so a line breaks
// at a gap instead of drawing a straight line across days nobody measured
export function withGaps(points, gapMs) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    if (i && points[i].t - points[i - 1].t > gapMs) out.push({ x: points[i - 1].t + 1, y: null });
    out.push({ x: points[i].t, y: points[i].v });
  }
  return out;
}

// What the schema (from /config.json) says about a field: { name, units, color }, all optional
export function fieldInfo(module, field) {
  const schema = (server_config && server_config.schema) || {};
  const base = moduleBaseId(module);
  const mod = base && schema.modules && schema.modules[base];
  const def = (mod && mod.topics && mod.topics.find((t) => t.leaf === field)) || {};
  const topic = (schema.topics && schema.topics[def.leaf_from || field]) || {};
  const pick = (k) => (def[k] !== undefined ? def[k] : topic[k]);
  const suffix = base && base !== module ? ` ${module.slice(base.length).replace(/^[-_]/, '')}` : '';
  return {
    name: (pick('name') || field) + suffix,
    units: pick('units'),
    color: pick('color'),
  };
}

// The Chart.js datasets and y scales for a set of series
export function chartData(series, { bucketMs }) {
  const nodes = new Set(series.map((s) => s.node));
  const scales = {};
  const datasets = [];
  const used = new Map(); // colour -> how many lines already have it
  series.forEach((s, i) => {
    const info = fieldInfo(s.module, s.field);
    const unit = info.units || '';
    const axis = `y_${unit || 'none'}`;
    if (!scales[axis]) {
      const n = Object.keys(scales).length;
      scales[axis] = {
        type: 'linear', position: n % 2 ? 'right' : 'left',
        grid: { drawOnChartArea: n === 0 },
        title: { display: !!unit, text: unitSymbol(unit) },
      };
    }
    const base = info.color || PALETTE[i % PALETTE.length];
    const n = used.get(base) || 0;
    used.set(base, n + 1);
    const color = variantColor(base, n);
    // The node only when there is more than one; the field always
    const label = `${nodes.size > 1 ? `${s.node.split('/').pop()} ` : ''}${getString(info.name)}${unit ? ` (${unitSymbol(unit)})` : ''}`;
    if (s.mean) {
      const gap = bucketMs * 1.5;
      // The band first, so the line is drawn over it. "-1" fills to the dataset before.
      datasets.push({ label: `${label} min`, band: true, data: withGaps(s.min || [], gap), yAxisID: axis,
        borderWidth: 0, pointRadius: 0, fill: false });
      datasets.push({ label: `${label} max`, band: true, data: withGaps(s.max || [], gap), yAxisID: axis,
        borderWidth: 0, pointRadius: 0, fill: '-1', backgroundColor: addAlpha(color, 0.2) });
      datasets.push({ label, data: withGaps(s.mean, gap), yAxisID: axis, borderColor: color,
        backgroundColor: color, borderWidth: 2, pointRadius: 0, fill: false });
    } else {
      datasets.push({ label, data: withGaps(s.points || [], RAW_GAP_MS), yAxisID: axis, borderColor: color,
        backgroundColor: color, borderWidth: 1, pointRadius: 1, fill: false });
    }
  });
  return { datasets, scales };
}

class GraphPage extends HTMLElement {
  connectedCallback() {
    if (this.started) return;
    this.started = true;
    this.load().catch((err) => this.message(`${getString('Could not load the readings')}: ${err.message}`));
  }

  message(text) {
    this.status.textContent = text;
    this.status.hidden = false;
  }

  async load() {
    const params = graphParams(window.location.search);
    this.replaceChildren(
      el('div', { class: 'fi-graphpage' }, [
        // i8n: false - a title from the link is the asker's own words, not a key
        el('h1', { class: 'fi-graphpage__title', i8n: false, textContent: params.title || getString('Readings') }),
        this.subtitle = el('p', { class: 'fi-graphpage__subtitle' }),
        this.status = el('p', { class: 'fi-graphpage__status', textContent: getString('Loading...') }),
        el('div', { class: 'fi-graphpage__chart' }, [this.canvas = el('canvas')]),
      ]),
    );
    if (!params.devices.length) return this.message(getString('Nothing to graph - the link names no device'));
    this.subtitle.textContent = [params.devices.join(', '), params.bucket, params.tz].filter(Boolean).join(' · ');

    // The schema, for names, units and colours. A failure costs only those.
    const config = await fetch('/config.json');
    if (config.status === 401) return redirectToLogin();
    if (config.ok) configSet(await config.json());

    const response = await fetch(dataUrl(params));
    if (response.status === 401) return redirectToLogin();
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return this.message(`${getString('Could not load the readings')}: ${(body && body.message) || response.status}`);
    }
    const series = seriesFromSenML(body);
    if (!series.length) return this.message(getString('No readings for that time'));
    this.status.hidden = true;
    this.draw(series, params);
  }

  draw(series, params) {
    const { datasets, scales } = chartData(series, params);
    this.chart = new Chart(this.canvas, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: { type: 'time', adapters: { date: { zone: params.tz } } },
          ...scales,
        },
        plugins: {
          // The min and max bands explain themselves; listing them would double the legend
          legend: { labels: { filter: (item, data) => !data.datasets[item.datasetIndex].band } },
          tooltip: { filter: (item) => !item.dataset.band },
        },
      },
    });
  }
}
customElements.define('fi-graph-page', GraphPage);
