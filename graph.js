/*
 * Frugal IoT client - time-series graphing, wrapping Chart.js with the Luxon date adapter inlined.
 *
 * Kept separate because Chart.js is the largest dependency here, and a page that never draws a
 * graph should not pay for it.
 */

import async from '/node_modules/async/dist/async.mjs'; // https://caolan.github.io/async/v3/docs.html
import { Chart, _adapters, registerables } from '/node_modules/chart.js/dist/chart.js'; // https://www.chartjs.org
import { parse } from "csv-parse"; // https://csv.js.org/parse/distributions/browser_esm/
import { DateTime } from 'luxon'; // for the chartjs-adapter-luxon copy below
import { CssUrl, MqttTopic, el, mqtt_client } from './core.js';
import { MqttElement, MqttReceiver } from './widgets.js';

Chart.register(...registerables); //TODO figure out how to only import that chart types needed

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
let graph;  // Will hold a default MqttGraph once user chooses to graph anything
const skipped = (ctx, value) => ctx.p0.skip || ctx.p1.skip ? value : undefined;

// ============= Topic manipulation - some of these may end up in a new MqttPacket class
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
        ticks: { font: { size: 24 }},
      }
    };
  }
  static get graph() { // TODO-46 probably belongs in MqttReceiver
    if (!graph) { // global
      // See if there is a graphContainer as a specific place to put this otherwise end of document
      const graphContainer = document.getElementById('graph-container') || document.body
      graph = el('mqtt-graph'); // graph is global
      graphContainer.append(graph);
    }
    return graph;
  }

  // Note - makeChart is really fussy, the canvas must be inside something with a size.
  // For some reason, this does not work by adding inside the render - i.e. to the virtual Dom.
  loadContent() {
    this.canvas = el('canvas');
    const width = window.innerWidth * 0.8;
    const height = window.innerHeight * 0.6;
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.maxWidth = '100%';
    this.canvas.style.maxHeight = '100%';
    this.append(el('div', {slot: "chart", style: "width: 80vw; height: 60vw; position: relative;"},[this.canvas]));
    this.makeChart();
  }
  shouldLoadWhenConnected() {return true;}
  addScale(id, o) {
    o.grid = { drawOnChartArea: !this.state.yAxisCount } // only want the grid lines for one axis to show u
    o.position = ((this.state.yAxisCount++) % 2) ? 'right' : 'left';
    o.ticks = { font: { size: 24 } };
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
          responsive: false,
          maintainAspectRatio: false, // Suggested by Claude so doesnt crunch height on mobile
          devicePixelRatio: 1,
          scales: this.state.scales,
          plugins: {
            legend: {
              labels: {
                font: {size: 16}
              }
            }
          },
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
  get graphNavleftFilenames() {
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
  removeDataset(chartdataset) {
    // Removes a single chartjs dataset object from this graph and redraws.
    const idx = this.datasets.indexOf(chartdataset);
    if (idx >= 0) {
      this.datasets.splice(idx, 1);
      this.makeChart();
    }
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
        fill: this.mt.type !== "bool" ? false : true, // Use true for fill, rely on backgroundColor
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
    this.chartdataset.backgroundColor = this.addAlpha(this.state.color, 0.3); // 30% opacity
    this.chartdataset.yAxisID = this.state.yaxisid;
    // Should override display and position and grid of each axis used
  }

  // Helper method to add alpha transparency to a color
  addAlpha(color, alpha) {
    // Named color map for common colors
    const namedColors = {
      'purple': 'rgb(128, 0, 128)',
      'brown': 'rgb(165, 42, 42)',
      'red': 'rgb(255, 0, 0)',
      'pink': 'rgb(255, 192, 203)',
      'green': 'rgb(0, 128, 0)',
      'blue': 'rgb(0, 0, 255)',
      'black': 'rgb(0, 0, 0)'
    };

    // If it's already an rgba color, modify the alpha
    if (color.startsWith('rgba')) {
      return color.replace(/[\d.]+\)$/, alpha + ')');
    }
    // Convert hex or named color to rgba
    if (color.startsWith('#')) {
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    // If it's rgb, convert to rgba
    if (color.startsWith('rgb')) {
      return color.replace('rgb', 'rgba').replace(')', `, ${alpha})`);
    }
    // Check for named colors
    const lowerColor = color.toLowerCase().trim();
    if (namedColors[lowerColor]) {
      return namedColors[lowerColor].replace('rgb', 'rgba').replace(')', `, ${alpha})`);
    }
    // For unknown colors, return as-is
    return color;
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
    let filenames = this.graph.graphNavleftFilenames; // Note in reverse order, latest first.
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

// This event is used by custom dashboards to send
document.addEventListener('frugaliot:publish', ({detail}) => {
  if (mqtt_client && detail.topic && detail.value !== undefined)
    mqtt_client.publish(detail.topic, String(detail.value), detail.options || {retain: true, qos: 1});
});

// Public API for custom dashboards and pages that import this module.
// Add further exports here as dashboard needs grow (e.g. getString for i18n).

