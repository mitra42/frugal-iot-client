// graph.html (graphpage.js): from the page's URL to the request, and from the SenML that comes back to
// what Chart.js is given. Chart.js cannot draw in jsdom, so the chart itself is not drawn here.
import './setup.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('./fixtures/config.json', import.meta.url), 'utf8'));
let gp;

before(async () => {
  const mock = await import('./mock.js');
  mock.loadConfig(config);
  gp = await import('../graphpage.js');
});

describe('the page URL', () => {
  test('devices repeated or comma-separated, and a bucket asks for the band', () => {
    const p = gp.graphParams('?device=dev/lotus/a/sht,dev/lotus/b/sht&device=dev/magi/c&from=2026-11-01&bucket=1h&tz=Asia/Kolkata');
    assert.deepEqual(p.devices, ['dev/lotus/a/sht', 'dev/lotus/b/sht', 'dev/magi/c']);
    assert.equal(p.bucketMs, 3600000);
    const url = new URL(gp.dataUrl(p), 'https://x');
    assert.equal(url.pathname, '/api/data');
    assert.deepEqual(url.searchParams.getAll('device'), p.devices);
    assert.equal(url.searchParams.get('agg'), 'mean,min,max');
    assert.equal(url.searchParams.get('tz'), 'Asia/Kolkata');
  });
  test('a bucket that is not one is ignored, and no zone means the browser\'s', () => {
    const p = gp.graphParams('?device=dev/lotus/a&bucket=lots');
    assert.equal(p.bucket, '');
    assert.equal(new URL(gp.dataUrl(p), 'https://x').searchParams.get('agg'), null);
    assert.ok(p.tz);
  });
});

describe('SenML to series', () => {
  test('one entry per node and field, times made absolute, aggregates gathered', () => {
    const series = gp.seriesFromSenML([
      { bn: 'dev/lotus/b/', bt: 1000 },
      { n: 'sht/temperature/mean', v: 20 }, { n: 'sht/temperature/min', v: 18 }, { n: 'sht/temperature/max', v: 22 },
      { n: 'sht/temperature/mean', v: 21, t: 3600 },
      { bn: 'dev/lotus/a/', bt: 2000 },
      { n: 'sht/humidity', v: 60 },
      { n: 'sht/text', vs: 'not a number' },
    ]);
    assert.deepEqual(series.map((s) => `${s.node}/${s.module}/${s.field}`), ['dev/lotus/a/sht/humidity', 'dev/lotus/b/sht/temperature']);
    assert.deepEqual(series[0].points, [{ t: 2000000, v: 60 }]);
    assert.deepEqual(series[1].mean, [{ t: 1000000, v: 20 }, { t: 4600000, v: 21 }]);
    assert.deepEqual(series[1].max, [{ t: 1000000, v: 22 }]);
  });
  test('a gap longer than allowed breaks the line', () => {
    const pts = gp.withGaps([{ t: 0, v: 1 }, { t: 10, v: 2 }, { t: 100, v: 3 }], 50);
    assert.deepEqual(pts.map((p) => p.y), [1, 2, null, 3]);
  });
});

describe('what the chart is given', () => {
  test('names, units and colour from the schema, an axis per unit, a band per bucketed series', () => {
    const series = [
      { node: 'dev/lotus/a', module: 'sht', field: 'temperature', mean: [{ t: 0, v: 20 }], min: [{ t: 0, v: 18 }], max: [{ t: 0, v: 22 }] },
      { node: 'dev/lotus/a', module: 'sht', field: 'humidity', mean: [{ t: 0, v: 60 }], min: [], max: [] },
    ];
    const { datasets, scales } = gp.chartData(series, { bucketMs: 3600000 });
    assert.deepEqual(Object.keys(scales), ['y_Cel', 'y_%RH']);
    const lines = datasets.filter((d) => !d.band);
    assert.equal(lines.length, 2);
    assert.match(lines[0].label, /^Temperature/); // one node, so the node is not named
    assert.equal(lines[0].borderColor, '#ff0000');
    assert.equal(datasets.filter((d) => d.band).length, 4);
    assert.equal(datasets[1].fill, '-1'); // max fills down to min
  });
  test('several nodes are named, and the same field on each gets its own shade', () => {
    const one = (node) => ({ node, module: 'sht', field: 'temperature', points: [{ t: 0, v: 20 }] });
    const { datasets } = gp.chartData([one('dev/lotus/a'), one('dev/lotus/b')], { bucketMs: 0 });
    assert.match(datasets[0].label, /^a /);
    assert.notEqual(datasets[0].borderColor, datasets[1].borderColor);
  });
  test('a field the schema does not know still gets a name and a colour', () => {
    const info = gp.fieldInfo('nosuch', 'thing');
    assert.equal(info.name, 'thing');
    const { datasets } = gp.chartData([{ node: 'dev/lotus/a', module: 'nosuch', field: 'thing', points: [] }], { bucketMs: 0 });
    assert.ok(datasets[0].borderColor);
  });
});
