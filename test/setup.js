// Test environment: a jsdom DOM plus a resolve hook for the client's /node_modules/... imports.
// Import this before importing anything from the client.
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve as resolvePath, dirname } from 'node:path';
import { JSDOM } from 'jsdom';

const projectRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

// The client imports '/node_modules/x' because a web server serves it from the root.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('/node_modules/')) {
      return { url: pathToFileURL(resolvePath(projectRoot, '.' + specifier)).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://localhost:8080/', pretendToBeVisual: true });
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (!(k in globalThis)) {
    try { globalThis[k] = dom.window[k]; } catch { /* getters that throw on access */ }
  }
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node provides its own Event/CustomEvent/EventTarget globals, which jsdom's document rejects.
// The loop above skips them because they already exist, so override explicitly.
for (const k of ['Event', 'CustomEvent', 'EventTarget', 'MessageEvent']) {
  globalThis[k] = dom.window[k];
}

export { dom };
