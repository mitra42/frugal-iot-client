/*
 * Serialize a rendered element tree to stable text, descending into shadow roots.
 *
 * Snapshots exist to protect the existing UI through the card work, so they record what a user
 * would see - tags, the attributes that carry meaning, and text - not internal structure.
 */

// Attributes worth recording. Deliberately not `style` (layout churn) or `id` on inputs
// (topic paths already appear via `topic`).
const KEEP = ['topic', 'group', 'name', 'value', 'label', 'class', 'slot', 'type', 'min', 'max', 'color', 'checked', 'open'];

// Values that change run to run and would make a snapshot useless.
function stableValue(name, value) {
  if (name === 'value' && /^\d{4}-\d{2}-\d{2}|:\d{2}:/.test(value)) return '<timestamp>';
  if (name === 'value' && value === 'Never seen') return 'Never seen';
  return value;
}

function attrs(el) {
  return KEEP
    .filter((a) => el.hasAttribute && el.hasAttribute(a))
    .map((a) => `${a}="${stableValue(a, el.getAttribute(a))}"`)
    .join(' ');
}

export function serialize(node, depth = 0) {
  const pad = '  '.repeat(depth);
  const out = [];
  if (node.nodeType === 3) { // text
    const t = node.textContent.trim();
    if (t) out.push(`${pad}"${t}"`);
    return out;
  }
  if (node.nodeType !== 1) return out;
  const tag = node.localName;
  if (tag === 'link' || tag === 'style' || tag === 'script') return out; // stylesheet links carry no meaning here
  const a = attrs(node);
  out.push(`${pad}<${tag}${a ? ' ' + a : ''}>`);
  if (node.shadowRoot) {
    out.push(`${pad}  #shadow`);
    for (const c of node.shadowRoot.childNodes) out.push(...serialize(c, depth + 2));
  }
  for (const c of node.childNodes) out.push(...serialize(c, depth + 1));
  return out;
}

export function snapshot(root) {
  return serialize(root).join('\n') + '\n';
}
