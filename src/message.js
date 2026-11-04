'use strict';

const OPEN = '';
const CLOSE = '';
const MARKER_RE = /(\d+)/g;
const SPLIT_RE = /(<ChatLinkAction\b[^>]*>[\s\S]*?<\/ChatLinkAction>)|(<[^>]*>)/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const ENTITY_RE = /&(#\d+|#x[0-9a-f]+|lt|gt|amp|quot|apos);/gi;

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeEntities(s) {
  return s.replace(ENTITY_RE, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'amp') return '&';
    if (k === 'quot') return '"';
    if (k === 'apos') return '\'';
    const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });
}

function marker(i) { return OPEN + i + CLOSE; }
function stripMarkers(s) { return s.replace(MARKER_RE, ' '); }

function parse(message, glossary) {
  const spans = [];
  const addSpan = html => marker(spans.push(html) - 1);
  const clean = s => decodeEntities(s).replace(/[]/g, '');

  let text = '';
  let last = 0;
  for (const m of message.matchAll(SPLIT_RE)) {
    if (m.index > last) text += clean(message.slice(last, m.index));
    if (m[1]) text += addSpan(m[1]);
    last = m.index + m[0].length;
  }
  if (last < message.length) text += clean(message.slice(last));

  text = text.replace(URL_RE, u => addSpan(escapeHtml(u)));
  if (glossary) text = glossary.protect(text, term => addSpan(escapeHtml(term)));
  text = text.replace(/\s+/g, ' ').trim();

  const plain = stripMarkers(text).replace(/\s+/g, ' ').trim();
  const letters = (plain.match(/\p{L}/gu) || []).length;
  return { text, spans, plain, letters };
}

function toHtml(marked, spans, transform) {
  let out = '';
  let last = 0;
  const piece = s => escapeHtml(transform ? transform(s) : s);
  for (const m of marked.matchAll(MARKER_RE)) {
    out += piece(marked.slice(last, m.index));
    const span = spans[Number(m[1])];
    if (span !== undefined) out += span;
    last = m.index + m[0].length;
  }
  return out + piece(marked.slice(last));
}

function markerIds(s) {
  const ids = [];
  for (const m of s.matchAll(MARKER_RE)) ids.push(m[1]);
  return ids;
}

function markersIntact(source, translated) {
  const have = new Set(markerIds(translated));
  return markerIds(source).every(id => have.has(id));
}

function fontOpen(color) {
  return color ? `<FONT COLOR="${color}">` : '<FONT>';
}

function tagOf(entry, cfg) {
  return cfg.showTag && entry.detected ? `[${entry.detected.toUpperCase()}] ` : '';
}

function renderInbound(message, parsed, entry, cfg, transform) {
  const body = toHtml(entry.text, parsed.spans, transform);
  const tag = escapeHtml(tagOf(entry, cfg));
  const open = fontOpen(cfg.color);
  if (cfg.displayMode === 'replace' && markersIntact(parsed.text, entry.text)) {
    return `${open}${tag}${body}</FONT>`;
  }
  return `${message}${open}${escapeHtml(cfg.separator)}${tag}${body}</FONT>`;
}

function renderSeparate(parsed, entry, cfg, transform) {
  return `${fontOpen(cfg.color)}(Translated) ${escapeHtml(tagOf(entry, cfg))}${toHtml(entry.text, parsed.spans, transform)}</FONT>`;
}

function renderOutbound(parsed, entry) {
  return `<FONT>${toHtml(entry.text, parsed.spans)}</FONT>`;
}

module.exports = {
  OPEN, CLOSE, MARKER_RE, marker, escapeHtml, decodeEntities, stripMarkers,
  parse, toHtml, markersIntact, renderInbound, renderSeparate, renderOutbound,
};
