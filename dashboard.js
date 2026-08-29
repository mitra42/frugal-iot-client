/*
 * Entry point for index.html - the card UI.
 *
 * Everything except nodeview.js, which is the node/group UI this page replaces. webcomponents.js
 * would pull that in too; it is the entry for index.html, which still needs it.
 */
import './core.js';      // MQTT, the topic data tree, i18n, the wrapper and the connection
import './widgets.js';   // mqtt-bar, mqtt-text, mqtt-toggle and the rest
import './graph.js';     // mqtt-graph - reached from the graph icon on a reading
import './admin.js';     // mqtt-admin, rendered a section at a time by the project's back
import './flash.js';     // mqtt-flash, its own card on the project's back
import './cards.js';     // the cards, the grid, the project back and the page itself
