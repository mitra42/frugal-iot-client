/*
 * Frugal IoT client - entry point.
 *
 * The client used to be this one file. It is now split (see CARDS_PLAN.md phase 3), and this brings
 * the pieces back together so that every page keeps loading a single script, and dashboards keep
 * importing helpers from here.
 *
 * A page that wants less can import less: core.js alone gives the MQTT connection and the topic data
 * tree with no UI at all, and core.js + widgets.js is enough to put an mqtt-bar on a page, which is
 * what index-embedded.html does.
 *
 * See https://github.com/mitra42/frugal-iot-client/wiki for (emerging) documentation
 */
export * from './core.js';   // Evaluates core first, which everything below depends on
import './widgets.js';       // mqtt-bar, mqtt-text, mqtt-toggle and the rest of the leaf elements
import './graph.js';         // mqtt-graph, mqtt-graphdataset - pulls in Chart.js
import './nodeview.js';      // mqtt-project, mqtt-node, mqtt-group* - retires with index.html
import './flash.js';         // mqtt-flash - pulls in esptool-js
import './admin.js';         // mqtt-admin, tabbed-display
import './login.js';         // mqtt-login - its own module so login.html need not load all of this
