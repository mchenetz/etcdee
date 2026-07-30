'use strict';

/* Value inspection for the key editor.
 *
 * Everything here is pure and side-effect free: given the raw bytes of an
 * etcd value it reports what the value looks like and renders read-only
 * views of it. Nothing in this file ever mutates the edit buffer — that is
 * what keeps "pretty print" a display concern rather than an edit.
 */

const Codecs = (() => {
  // ------------------------------------------------------------ byte helpers

  const enc = new TextEncoder();
  const utf8Strict = new TextDecoder('utf-8', { fatal: true });

  function toBytes(text, encoding) {
    if (encoding === 'base64') {
      const bin = atob(text);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return enc.encode(text);
  }

  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000; // avoid blowing the argument limit on big values
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function tryUtf8(bytes) {
    try { return utf8Strict.decode(bytes); } catch (_) { return null; }
  }

  const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
  function isPrintable(text) {
    return text !== null && !CONTROL.test(text);
  }

  function startsWith(bytes, sig) {
    if (bytes.length < sig.length) return false;
    for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return false;
    return true;
  }

  const ascii = (s) => Array.from(s).map((c) => c.charCodeAt(0));

  // ------------------------------------------------------------- file typing

  const SIGNATURES = [
    { sig: ascii('k8s').concat(0), name: 'Kubernetes protobuf', kind: 'k8s' },
    { sig: [0x1f, 0x8b], name: 'gzip', kind: 'gzip' },
    { sig: [0x89, 0x50, 0x4e, 0x47], name: 'PNG image', kind: 'image', mime: 'image/png' },
    { sig: [0xff, 0xd8, 0xff], name: 'JPEG image', kind: 'image', mime: 'image/jpeg' },
    { sig: ascii('GIF8'), name: 'GIF image', kind: 'image', mime: 'image/gif' },
    { sig: ascii('%PDF'), name: 'PDF document', kind: 'binary' },
    { sig: [0x50, 0x4b, 0x03, 0x04], name: 'ZIP archive', kind: 'binary' },
    { sig: ascii('SQLite format 3'), name: 'SQLite database', kind: 'binary' },
    { sig: [0x42, 0x5a, 0x68], name: 'bzip2', kind: 'binary' },
    { sig: [0xfd, 0x37, 0x7a, 0x58, 0x5a], name: 'xz', kind: 'binary' },
  ];

  function sniff(bytes) {
    for (const s of SIGNATURES) {
      if (startsWith(bytes, s.sig)) return s;
    }
    return null;
  }

  const BASE64_RE = /^[A-Za-z0-9+/\r\n]+={0,2}$/;
  function looksLikeBase64(text) {
    const trimmed = text.trim();
    if (trimmed.length < 8 || trimmed.length % 4 !== 0) return false;
    if (!BASE64_RE.test(trimmed)) return false;
    try { return atob(trimmed).length > 0; } catch (_) { return false; }
  }

  function jsonParse(text) {
    const t = text.trim();
    if (!t || !/^[[{]/.test(t)) return { ok: false };
    try { return { ok: true, value: JSON.parse(t) }; } catch (err) { return { ok: false, error: err.message }; }
  }

  /**
   * Describe a value and list the views that make sense for it.
   * @returns {{typeName, views: string[], json?: object, mime?: string}}
   */
  function inspect(bytes) {
    const views = ['raw'];
    const text = tryUtf8(bytes);
    const sig = sniff(bytes);
    let typeName;

    const json = text ? jsonParse(text) : { ok: false };
    if (json.ok) {
      views.push('pretty');
      typeName = Array.isArray(json.value) ? 'JSON array' : 'JSON object';
    }

    if (sig) {
      typeName = sig.name;
      if (sig.kind === 'k8s') views.push('k8s');
      if (sig.kind === 'gzip') views.push('gunzip');
      if (sig.kind === 'image') views.push('image');
    }

    if (!typeName) {
      if (text === null) typeName = 'binary';
      else if (looksLikeBase64(text)) typeName = 'base64 text';
      else if (/^\s*(---|\w[\w.-]*\s*:)/.test(text)) typeName = 'YAML / text';
      else typeName = 'text';
    }

    if (text !== null && looksLikeBase64(text)) views.push('base64');
    views.push('hex');

    return { typeName, views, json: json.ok ? json.value : null, mime: sig?.mime };
  }

  // ----------------------------------------------------------------- renders

  function prettyJson(text) {
    const parsed = jsonParse(text);
    if (!parsed.ok) return null;
    return JSON.stringify(parsed.value, null, 2);
  }

  function hexDump(bytes, limit = 64 * 1024) {
    const lines = [];
    const end = Math.min(bytes.length, limit);
    for (let off = 0; off < end; off += 16) {
      const slice = bytes.subarray(off, Math.min(off + 16, end));
      const hex = Array.from(slice).map((b) => b.toString(16).padStart(2, '0'));
      const padded = hex.concat(Array(16 - hex.length).fill('  '));
      const gutter = Array.from(slice)
        .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
      lines.push(
        `${off.toString(16).padStart(8, '0')}  ` +
        `${padded.slice(0, 8).join(' ')}  ${padded.slice(8).join(' ')}  |${gutter}|`
      );
    }
    if (bytes.length > end) lines.push(`… ${bytes.length - end} more bytes`);
    return lines.join('\n');
  }

  async function gunzip(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('gzip decoding unavailable');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  // ------------------------------------------------------- protobuf decoding

  function readVarint(bytes, pos) {
    let result = 0n;
    let shift = 0n;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return [result, pos];
      shift += 7n;
      if (shift > 70n) return [null, null];
    }
    return [null, null];
  }

  /**
   * Best-effort protobuf wire-format decode. etcd stores opaque bytes, so
   * there is no schema to work from — field numbers plus inferred types is
   * still far more readable than a base64 blob.
   * @returns {Array|null} null when the bytes are not valid protobuf
   */
  function decodeProtobuf(bytes, depth = 0) {
    if (depth > 12) return null;
    const fields = [];
    let pos = 0;
    while (pos < bytes.length) {
      const [key, p1] = readVarint(bytes, pos);
      if (key === null) return null;
      pos = p1;
      const fieldNo = Number(key >> 3n);
      const wire = Number(key & 7n);
      if (fieldNo === 0) return null;

      if (wire === 0) {
        const [val, p2] = readVarint(bytes, pos);
        if (val === null) return null;
        pos = p2;
        fields.push({ field: fieldNo, type: 'varint', value: val.toString() });
      } else if (wire === 1) {
        if (pos + 8 > bytes.length) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 8);
        fields.push({ field: fieldNo, type: 'fixed64', value: String(view.getFloat64(0, true)) });
        pos += 8;
      } else if (wire === 5) {
        if (pos + 4 > bytes.length) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 4);
        fields.push({ field: fieldNo, type: 'fixed32', value: String(view.getFloat32(0, true)) });
        pos += 4;
      } else if (wire === 2) {
        const [len, p2] = readVarint(bytes, pos);
        if (len === null) return null;
        pos = p2;
        const size = Number(len);
        if (pos + size > bytes.length) return null;
        const payload = bytes.subarray(pos, pos + size);
        pos += size;

        const nested = size > 1 ? decodeProtobuf(payload, depth + 1) : null;
        const text = tryUtf8(payload);
        // Length-delimited bytes are ambiguous: a nested message and a string
        // look alike. A real string almost never opens with a byte below
        // 0x20 — but a nested message always opens with a field tag, which
        // commonly is one (field 1, wire 2 is 0x0a, i.e. "\n").
        const opensWithTag = text !== null && text.length > 0 && text.charCodeAt(0) < 0x20;
        if (nested && nested.length && (text === null || opensWithTag)) {
          fields.push({ field: fieldNo, type: 'message', value: nested });
        } else if (isPrintable(text)) {
          fields.push({ field: fieldNo, type: 'string', value: text });
        } else if (nested && nested.length) {
          fields.push({ field: fieldNo, type: 'message', value: nested });
        } else {
          fields.push({ field: fieldNo, type: 'bytes', value: payload });
        }
      } else {
        return null; // groups (3/4) are deprecated and not emitted by k8s
      }
    }
    return fields;
  }

  // Field names shared by every Kubernetes object, so the common parts of a
  // schema-less decode read properly instead of as bare field numbers.
  const OBJECT_META = {
    1: 'name', 2: 'generateName', 3: 'namespace', 4: 'selfLink', 5: 'uid',
    6: 'resourceVersion', 7: 'generation', 8: 'creationTimestamp',
    9: 'deletionTimestamp', 10: 'deletionGracePeriodSeconds', 11: 'labels',
    12: 'annotations', 13: 'ownerReferences', 14: 'finalizers', 16: 'managedFields',
  };
  const TOP_LEVEL = { 1: 'metadata', 2: 'spec', 3: 'status' };

  function decodeK8s(bytes) {
    if (!startsWith(bytes, ascii('k8s').concat(0))) return null;
    const envelope = decodeProtobuf(bytes.subarray(4));
    if (!envelope) return null;

    const meta = envelope.find((f) => f.field === 1 && f.type === 'message');
    const raw = envelope.find((f) => f.field === 2);
    const apiVersion = meta?.value.find((f) => f.field === 1)?.value || '';
    const kind = meta?.value.find((f) => f.field === 2)?.value || '';

    let object = null;
    if (raw) {
      const payload = raw.type === 'bytes' ? raw.value
        : raw.type === 'string' ? enc.encode(raw.value) : null;
      if (payload) object = decodeProtobuf(payload);
      else if (raw.type === 'message') object = raw.value;
    }
    return { apiVersion, kind, object };
  }

  /**
   * Kubernetes timestamps are {seconds, nanos} messages. Recognising them
   * turns "#1: 1785436422" into a date a human can read.
   */
  function asTimestamp(fields) {
    if (!fields.length || fields.length > 2) return null;
    if (!fields.every((f) => f.type === 'varint' && (f.field === 1 || f.field === 2))) return null;
    const seconds = Number(fields.find((f) => f.field === 1)?.value);
    if (!Number.isFinite(seconds) || seconds < 1e8 || seconds > 4e9) return null;
    return new Date(seconds * 1000).toISOString();
  }

  function renderFields(fields, indent = 0, names = null, skipEmpty = false) {
    const pad = '  '.repeat(indent);
    const out = [];
    for (const f of fields) {
      // Kubernetes serialises unset strings, which buries the real content.
      if (skipEmpty && f.type === 'string' && f.value === '') continue;
      const label = names && names[f.field] ? names[f.field] : `#${f.field}`;
      if (f.type === 'message') {
        const stamp = asTimestamp(f.value);
        if (stamp) { out.push(`${pad}${label}: ${stamp}`); continue; }
        const childNames = names === TOP_LEVEL && f.field === 1 ? OBJECT_META : null;
        out.push(`${pad}${label}:`);
        out.push(renderFields(f.value, indent + 1, childNames, skipEmpty));
      } else if (f.type === 'bytes') {
        out.push(`${pad}${label}: <${f.value.length} bytes> ${shortHex(f.value)}`);
      } else if (f.type === 'string') {
        const v = f.value.includes('\n')
          ? `\n${f.value.split('\n').map((l) => `${pad}  ${l}`).join('\n')}`
          : ` ${JSON.stringify(f.value)}`;
        out.push(`${pad}${label}:${v}`);
      } else {
        out.push(`${pad}${label}: ${f.value}`);
      }
    }
    return out.join('\n');
  }

  function shortHex(bytes, max = 12) {
    const head = Array.from(bytes.subarray(0, max)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return bytes.length > max ? `${head} …` : head;
  }

  function renderK8s(decoded) {
    const header = [
      decoded.apiVersion ? `apiVersion: ${decoded.apiVersion}` : null,
      decoded.kind ? `kind: ${decoded.kind}` : null,
    ].filter(Boolean).join('\n');
    if (!decoded.object) return `${header}\n\n(object payload could not be decoded)`;
    return `${header}\n\n${renderFields(decoded.object, 0, TOP_LEVEL, true)}`;
  }

  // ------------------------------------------------------------- tokenizing
  //
  // Tokenizers return [{t, v}] rather than markup so they stay DOM-free and
  // unit-testable; the renderer turns each token into a styled span, which
  // also means value text is never interpolated into HTML.

  const ISO_DATE = /^\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*$/;

  function tokenizeJson(text) {
    const tokens = [];
    const re = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) tokens.push({ t: 'plain', v: text.slice(last, m.index) });
      if (m[1] !== undefined) {
        if (m[2] !== undefined) {
          tokens.push({ t: 'key', v: m[1] }, { t: 'punct', v: m[2] });
        } else {
          tokens.push({ t: 'string', v: m[1] });
        }
      } else if (m[3] !== undefined) tokens.push({ t: 'number', v: m[3] });
      else if (m[4] !== undefined) tokens.push({ t: 'literal', v: m[4] });
      else tokens.push({ t: 'punct', v: m[5] });
      last = re.lastIndex;
    }
    if (last < text.length) tokens.push({ t: 'plain', v: text.slice(last) });
    return tokens;
  }

  function classifyValue(raw) {
    if (/^\s*".*"\s*$/s.test(raw)) return 'string';
    if (/^\s*-?\d+(\.\d+)?\s*$/.test(raw)) return 'number';
    if (ISO_DATE.test(raw)) return 'date';
    if (/^\s*<\d+ bytes>/.test(raw)) return 'meta';
    return 'plain';
  }

  function tokenizeFieldTree(text) {
    const tokens = [];
    for (const line of text.split('\n')) {
      const m = /^(\s*)([^:]+):(.*)$/.exec(line);
      if (!m) {
        tokens.push({ t: 'plain', v: `${line}\n` });
        continue;
      }
      const [, indent, label, rest] = m;
      tokens.push({ t: 'plain', v: indent });
      tokens.push({ t: label.startsWith('#') ? 'meta' : 'key', v: label });
      tokens.push({ t: 'punct', v: ':' });
      if (rest) tokens.push({ t: classifyValue(rest), v: rest });
      tokens.push({ t: 'plain', v: '\n' });
    }
    return tokens;
  }

  function tokenizeHex(text) {
    const tokens = [];
    for (const line of text.split('\n')) {
      const bar = line.indexOf('|');
      if (line.length < 8 || bar === -1) {
        tokens.push({ t: 'meta', v: `${line}\n` });
        continue;
      }
      tokens.push({ t: 'meta', v: line.slice(0, 8) });
      tokens.push({ t: 'plain', v: line.slice(8, bar) });
      tokens.push({ t: 'string', v: line.slice(bar) });
      tokens.push({ t: 'plain', v: '\n' });
    }
    return tokens;
  }

  // Highlighting a very large value would create tens of thousands of spans
  // for no readability gain; fall back to plain text past this size.
  const MAX_HIGHLIGHT = 300 * 1024;

  function tokenize(text, mode) {
    if (!text || text.length > MAX_HIGHLIGHT) return [{ t: 'plain', v: text || '' }];
    if (mode === 'json') return tokenizeJson(text);
    if (mode === 'tree') return tokenizeFieldTree(text);
    if (mode === 'hex') return tokenizeHex(text);
    return [{ t: 'plain', v: text }];
  }

  return {
    toBytes, bytesToBase64, tryUtf8, isPrintable, looksLikeBase64,
    inspect, prettyJson, hexDump, gunzip,
    decodeProtobuf, decodeK8s, renderK8s, renderFields, jsonParse,
    tokenize,
  };
})();
