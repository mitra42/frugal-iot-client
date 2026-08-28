#!/usr/bin/env node
// Regenerate test/fixtures/config.json from the real schema in ../frugal-iot-server.
// Run after any schema change so the tests exercise the shape the server actually serves.
// Usage: node test/fixtures/regenerate.js [path-to-frugal-iot-server]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = process.argv[2] || resolve(here, '../../../frugal-iot-server');
const schemaDir = `${serverDir}/config.d/schema`;

// The server's readConfigFromDir maps config.d/<dir>/<file>.yaml onto config.<dir>.<file>,
// so schema/modules.yaml is config.schema.modules - mirror that here rather than inventing a shape.
const schema = {};
for (const name of ['modules', 'topics']) {
  schema[name] = yaml.load(readFileSync(`${schemaDir}/${name}.yaml`, 'utf8'));
}

const config = {
  schema,
  organizations: {
    dev: {
      name: 'Development',
      mqtt_password: 'public',
      projects: { lotus: { name: 'Lotus Ponds', nodes: {} } },
    },
  },
  // Shape only - individual tests override permissions to exercise WRITE and the admin cards.
  user: { id: 2, name: 'test', permissions: [{ org: 'dev', capability: 'READ' }] },
};

const out = resolve(here, 'config.json');
writeFileSync(out, JSON.stringify(config, null, 1));
console.log(`wrote ${out}: ${Object.keys(schema.modules).length} modules, ${Object.keys(schema.topics).length} topics`);
