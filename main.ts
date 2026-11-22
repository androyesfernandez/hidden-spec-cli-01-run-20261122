// mend: one command-line tool that applies AI-written edits in four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls) to a tree
// of text files, to the contract in SPEC.md. Node 22, standard library only.
// Run as `node main.ts [options] [PATCH]`. Every edit of a patch is applied to
// the tree in memory in order; when any edit fails, nothing is written.
//
// Matching: an edit names old lines O replaced by new lines N. O is found at the
// first of three tiers where it occurs at least once: tier 0 every line equal,
// tier 1 equal after trailing spaces/tabs are stripped, tier 2 equal after
// leading and trailing spaces/tabs are stripped. `--strict` tries tier 0 only.
// A context line is always written as the file's own matched line; at tier 2
// the other new lines are re-indented from the patch's indent to the file's.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and the
 * empty piece after a final `\n` dropped. Line numbers count these from 1. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Split a file's text into its lines, its line break and whether it ends with
 * one. A file's break is CRLF when its first line feed follows a carriage
 * return, LF otherwise. An empty file has no lines and no final break. */
function splitFile(text: string): { lines: string[]; br: string; finalBr: boolean } {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { lines: parts, br, finalBr };
}

function joinFile(lines: string[], br: string, finalBr: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBr ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the
 * rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  private readonly origExists = new Map<string, boolean>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  /** True when the path exists on disk at all (a file or a directory). */
  existsOnDisk(p: string): boolean {
    if (!this.origExists.has(p)) {
      try {
        statSync(p);
        this.origExists.set(p, true);
      } catch {
        this.origExists.set(p, false);
      }
    }
    return this.origExists.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** True when the path holds a file in the tree as earlier edits left it, or
   * exists on disk at all (a file or a directory) when untouched. */
  existsNow(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    if (this.original(p) !== null) return true;
    return this.existsOnDisk(p);
  }
}

/** An edit applied to the tree; it returns a move pair when it moved a file. */
type Edit = (tree: Tree) => [string, string] | void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// --- Line matching (SPEC.md section 5) ---

const stripRight = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripRight(a) === stripRight(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position where O occurs in `lines` at this tier. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!tierEq(lines[i + j]!, o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (from `from`), with its
 * positions, or null when it occurs at no tier. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos = occurrences(lines, o, tier, from);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** A new line: `ctx` is the index into O of the context line it repeats, or -1
 * for a line only the patch adds. */
interface NLine {
  text: string;
  ctx: number;
}

/** Build the replacement lines for a match of O at `at`, at the tier it was
 * found at. Context lines are the file's own matched lines; at tier 2 every
 * other line is re-indented from O's first line's indent to the file's. */
function buildReplacement(fileLines: string[], o: string[], n: NLine[], at: number, tier: number): string[] {
  const out: string[] = [];
  const f = fileLines[at] ?? '';
  const p = o[0] ?? '';
  const indentF = leadingWs(f);
  const indentP = leadingWs(p);
  for (const line of n) {
    if (line.ctx >= 0) {
      out.push(fileLines[at + line.ctx]!);
      continue;
    }
    let t = line.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(indentP)) t = indentF + t.slice(indentP.length);
    out.push(t);
  }
  return out;
}

// --- Unified diffs (SPEC.md section 6) ---

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line (for created files). */
  noEolPlus: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Apply one section's hunks in order to a file's lines. `d` tracks the drift
 * between the patch's line numbers and the file as hunks land. `path` names the
 * file a `no-match` failure reports. */
function applyHunks(state: { lines: string[]; finalBr: boolean }, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const oldLen = state.lines.length;
      const at = Math.min(Math.max(h.a + d, 0), oldLen);
      const added = h.n.map((l) => l.text);
      state.lines.splice(at, 0, ...added);
      if (at === oldLen) state.finalBr = !h.noEol;
      d += h.n.length;
      continue;
    }
    const found = findTier(state.lines, h.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    const atEnd = best + h.o.length === state.lines.length;
    const replacement = buildReplacement(state.lines, h.o, h.n, best, found.tier);
    state.lines.splice(best, h.o.length, ...replacement);
    if (atEnd) state.finalBr = !h.noEol;
    d += h.n.length - h.o.length;
  }
}

/** A hunk body line: ' ' context, '-' old, '+' new, '\' marker, '' context. */
function isBodyLine(l: string): boolean {
  return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
}

/** Parse one hunk body starting at `i` (the line after the header). Returns
 * the hunk and the index of the first line after the body. */
function parseHunkBody(lines: string[], i: number): { hunk: Hunk; next: number } {
  const raw: string[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (!isBodyLine(l)) break;
    raw.push(l);
    j += 1;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const o: string[] = [];
  const n: NLine[] = [];
  // The `\` flags count only when the marker follows the hunk's last context
  // or `+` line (or its last `+` line), not a marker mid-body.
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < raw.length; k += 1) {
    const l = raw[k]!;
    if (l === '' || l[0] === ' ') lastCtxPlus = k;
    else if (l[0] === '+') { lastCtxPlus = k; lastPlus = k; }
  }
  const noEol = lastCtxPlus >= 0 && (raw[lastCtxPlus + 1] ?? '').startsWith('\\');
  const noEolPlus = lastPlus >= 0 && (raw[lastPlus + 1] ?? '').startsWith('\\');
  for (const l of raw) {
    if (l.startsWith('\\')) continue;
    if (l === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    } else if (l[0] === ' ') {
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: o.length - 1 });
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push({ text: l.slice(1), ctx: -1 });
    }
  }
  return { hunk: { a: 0, o, n, noEol, noEolPlus }, next: j };
}

/** The path after `--- `/`+++ `: up to the first tab, surrounding spaces off,
 * a leading `a/` or `b/` removed. `/dev/null` stays as it is. */
function diffPath(text: string): string {
  let p = text.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** Parse the unified diff into one edit per section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  let cur: Section | null = null;
  let inHeader = false;
  let havePair = false;
  const startSection = (oldP: string | null, newP: string | null): Section => {
    const s: Section = { oldPath: oldP, newPath: newP, create: false, del: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    havePair = false;
    return s;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = diffPath(l);
      const newP = diffPath(lines[i + 1]!);
      if (cur === null || !inHeader) {
        startSection(oldP === '/dev/null' ? null : oldP, newP === '/dev/null' ? null : newP);
      } else {
        cur.oldPath = oldP === '/dev/null' ? null : oldP;
        cur.newPath = newP === '/dev/null' ? null : newP;
        havePair = true;
      }
      if (cur !== null && inHeader) havePair = true;
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && l.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const { hunk, next } = parseHunkBody(lines, i + 1);
      hunk.a = Number(m[1]);
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ') && !havePair) cur.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ') && !havePair) cur.newPath = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One unified section as an edit on the tree. */
function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.oldPath;
  const newP = s.newPath;
  const isCreate = s.create || oldP === null;
  const isDelete = !isCreate && (s.del || newP === null);
  return (tree: Tree): [string, string] | void => {
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.existsNow(p)) throw new Fail('exists', p);
      const lines: string[] = [];
      for (const h of s.hunks) for (const nl of h.n) if (nl.ctx < 0) lines.push(nl.text);
      let finalBr = false;
      for (let k = s.hunks.length - 1; k >= 0; k -= 1) {
        const h = s.hunks[k]!;
        if (h.n.some((nl) => nl.ctx < 0)) { finalBr = !h.noEolPlus; break; }
      }
      tree.now.set(p, joinFile(lines, '\n', finalBr));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.existsNow(newP)) throw new Fail('exists', newP);
      const f = splitFile(before);
      const state = { lines: [...f.lines], finalBr: f.finalBr };
      applyHunks(state, s.hunks, strict, oldP);
      tree.now.set(newP, joinFile(state.lines, f.br, state.finalBr));
      tree.now.set(oldP, null);
      return [oldP, newP];
    }
    const p = oldP ?? newP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    const state = { lines: [...f.lines], finalBr: f.finalBr };
    applyHunks(state, s.hunks, strict, p);
    tree.now.set(p, joinFile(state.lines, f.br, state.finalBr));
  };
}

// --- SEARCH/REPLACE blocks (SPEC.md section 7) ---

const SEARCH_MARK = '<<<<<<< SEARCH';
const SEP_MARK = '=======';
const REPLACE_MARK = '>>>>>>> REPLACE';

/** Parse SEARCH/REPLACE blocks into edits. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== SEARCH_MARK) { i += 1; continue; }
    const searchLine = i + 1;
    // The path is the nearest line before the SEARCH line, after the previous
    // block's REPLACE line, that is not blank and does not start with ```.
    let path: string | null = null;
    for (let k = i - 1; k >= prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let sep = -1;
    let end = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      const l = lines[k]!.trimEnd();
      if (sep < 0 && l === SEP_MARK) sep = k;
      else if (sep >= 0 && l === REPLACE_MARK) { end = k; break; }
      else if (sep < 0 && (l === SEARCH_MARK || l === REPLACE_MARK)) break;
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.existsNow(path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const replacement = buildReplacement(f.lines, oldLines, n, at, found.tier);
    const out = [...f.lines];
    out.splice(at, oldLines.length, ...replacement);
    tree.now.set(path, joinFile(out, f.br, f.finalBr));
  };
}

// --- V4A patches (SPEC.md section 8) ---

interface V4aChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
}

/** Parse one Update File section's body lines into chunks. `firstLine` is the
 * 1-based number of the patch line `body[0]` sits on. */
function v4aChunks(body: string[], firstLine: number): V4aChunk[] {
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  const startChunk = (anchor: string | null): V4aChunk => {
    const c: V4aChunk = { anchor, o: [], n: [], eof: false };
    chunks.push(c);
    cur = c;
    return c;
  };
  let i = 0;
  while (i < body.length) {
    const l = body[i]!;
    if (l.startsWith('@@')) {
      startChunk(l.slice(2).trim() === '' ? null : l.slice(2).trim());
      i += 1;
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${firstLine + i}`);
      cur.eof = true;
      cur = null;
      i += 1;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) startChunk(null);
      if (l === '') {
        cur!.o.push('');
        cur!.n.push({ text: '', ctx: cur!.o.length - 1 });
      } else if (l[0] === ' ') {
        cur!.o.push(l.slice(1));
        cur!.n.push({ text: l.slice(1), ctx: cur!.o.length - 1 });
      } else if (l[0] === '-') {
        cur!.o.push(l.slice(1));
      } else {
        cur!.n.push({ text: l.slice(1), ctx: -1 });
      }
      i += 1;
      continue;
    }
    throw new Exit2(`error: parse ${firstLine + i}`);
  }
  return chunks;
}

/** Parse a V4A patch into edits. `lines` is the whole patch. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = (() => {
    for (let k = lines.length - 1; k >= 0; k -= 1) if (!blank(lines[k]!)) return k;
    return -1;
  })();
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i += 1; continue; }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File: ')) { kind = 'add'; path = l.slice('*** Add File: '.length).trim(); }
    else if (l.startsWith('*** Delete File: ')) { kind = 'delete'; path = l.slice('*** Delete File: '.length).trim(); }
    else if (l.startsWith('*** Update File: ')) { kind = 'update'; path = l.slice('*** Update File: '.length).trim(); }
    else throw new Exit2(`error: parse ${i + 1}`);
    const sectionLine = i + 1;
    // Collect the section's lines up to the next section or `*** End Patch`.
    const raw: string[] = [];
    let j = i + 1;
    while (j < last) {
      const m = lines[j]!;
      if (m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: ')) break;
      raw.push(m);
      j += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const m = raw[k]!;
        if (m === '') fileLines.push('');
        else if (m[0] === '+') fileLines.push(m.slice(1));
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      if (raw.some((m) => !blank(m))) throw new Exit2(`error: parse ${i + 2 + raw.findIndex((m) => !blank(m))}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let body = raw;
      let bodyFirstLine = sectionLine + 1;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice('*** Move to: '.length).trim();
        body = raw.slice(1);
        bodyFirstLine = sectionLine + 2;
      }
      const chunks = v4aChunks(body, bodyFirstLine);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.existsNow(path)) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** Apply one Update File section's chunks to a file's lines, cursor-based. */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree: Tree): [string, string] | void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.existsNow(moveTo)) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    const lines = [...f.lines];
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null) {
        let foundAt: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (tierEq(lines[k]!, c.anchor, tier)) { foundAt = k; break; }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      if (c.o.length === 0) {
        const at = c.eof ? lines.length : cursor;
        const added = c.n.map((l) => l.text);
        lines.splice(at, 0, ...added);
        cursor = at + added.length;
        continue;
      }
      const found = findTier(lines, c.o, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let at: number | null = null;
      for (const p of found.pos) {
        if (c.eof && p + c.o.length !== lines.length) continue;
        at = p;
        break;
      }
      if (at === null) throw new Fail('no-match', path);
      const replacement = buildReplacement(lines, c.o, c.n, at, found.tier);
      lines.splice(at, c.o.length, ...replacement);
      cursor = at + replacement.length;
    }
    const out = joinFile(lines, f.br, f.finalBr);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      return [path, moveTo];
    }
    tree.now.set(path, out);
  };
}

// --- JSON edits (SPEC.md section 9) ---

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.existsNow(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      const lines = [...f.lines];
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(lines, f.br, f.finalBr));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- Running the CLI (SPEC.md sections 1, 2 and 10) ---

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const moved = edit(tree);
      if (moved !== undefined) moves.push(moved);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: one per path whose state changed, in byte order of the paths.
  // A successful move replaces its D/A pair with one `R old -> new` line that
  // sorts by the new path.
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) === null) continue;
    if (tree.now.get(oldP) !== null) continue;
    if (tree.original(newP) !== null) continue;
    if (tree.now.get(newP) === null || tree.now.get(newP) === undefined) continue;
    rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    covered.add(oldP);
    covered.add(newP);
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
