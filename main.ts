// mend — one patch tool for every AI edit format.
//
// Applies a patch written as unified diff, SEARCH/REPLACE, V4A, or JSON
// (see SPEC.md) to the files in the current directory. The patch is read
// from a file, from stdin when the patch argument is absent or "-", and the
// format is detected from the patch text unless --format names one.
//
// Design: four readers (one per format) turn a patch into a list of edits
// (create / delete / change / move, each carrying its line sequences), and
// a single engine applies them to an in-memory tree. Every edit is checked
// for safety and validity before anything is written; if any edit fails,
// no file is written at all (all-or-nothing). A file is only ever written
// back in the shape it had before the edit (its own line break, its own
// final break), except where the format's own section says otherwise.

import { readFileSync, writeFileSync, writeSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------- small helpers ----------

function isBlank(s: string): boolean {
  return s.trim() === '';
}

// Order paths by their UTF-8 bytes, not by JavaScript's default sort.
function comparePath(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripEdges(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// A path is unsafe when it could reach outside the tree: an empty path, a
// backslash anywhere, or any segment that is empty, "." or "..".
function isUnsafe(p: string): boolean {
  if (p === '' || p.includes('\\')) return true;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return true;
  }
  return false;
}

// Split patch text into lines: at "\n", one trailing "\r" removed per line,
// and no empty piece left after a final "\n".
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n').map((s) => (s.endsWith('\r') ? s.slice(0, -1) : s));
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

// ---------- the file model ----------

// A file as a list of lines plus the break that separates them and whether
// it ends with one. The break is CRLF when the file's first LF follows a
// CR, otherwise LF. A file holding exactly one line break is one empty
// line; a lone "\r" is not a break at all, it is part of the line.
interface FileDoc {
  lines: string[];
  sep: string;
  ends: boolean;
}

function docFromText(text: string): FileDoc {
  if (text === '') return { lines: [], sep: '\n', ends: false };
  const firstLf = text.indexOf('\n');
  const sep = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(sep);
  const body = ends ? text.slice(0, -sep.length) : text;
  const lines = body === '' ? [''] : body.split(sep);
  return { lines, sep, ends };
}

function docToText(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.sep) + (d.ends ? d.sep : '');
}

// A line as the matcher sees it at a tier: 0 exact, 1 trailing whitespace
// stripped, 2 leading and trailing whitespace stripped.
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return stripTrailing(s);
  return stripEdges(s);
}

// ---------- the working tree ----------

// The tree holds the files as they are on disk (read lazily, once) plus
// the edits applied so far. Nothing touches the disk until the very end,
// so a failed edit can be undone by restoring the pending map alone.
// Directories are tracked too: a path counts as "existing" for a create
// or a move destination when it is a file or a directory, while the
// "missing" check for a change, delete or move source only accepts a file.
class Tree {
  private base = new Map<string, string | null>();
  private dirSet = new Set<string>();
  readonly pending = new Map<string, string | null>();

  original(path: string): string | null {
    if (this.base.has(path)) return this.base.get(path) ?? null;
    let text: string | null = null;
    try {
      if (statSync(path).isFile()) text = readFileSync(path, 'utf8');
    } catch {
      text = null;
    }
    this.base.set(path, text);
    return text;
  }

  content(path: string): string | null {
    if (this.pending.has(path)) return this.pending.get(path) ?? null;
    return this.original(path);
  }

  isFile(path: string): boolean {
    return this.content(path) !== null;
  }

  isDir(path: string): boolean {
    if (this.dirSet.has(path)) return true;
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  existsAny(path: string): boolean {
    return this.isFile(path) || this.isDir(path);
  }

  set(path: string, text: string): void {
    this.pending.set(path, text);
    let d = dirname(path);
    while (d !== '.' && d !== '') {
      this.dirSet.add(d);
      d = dirname(d);
    }
  }

  remove(path: string): void {
    this.pending.set(path, null);
  }

  // Paths whose content differs from the disk, in byte order.
  changedPaths(): string[] {
    const out: string[] = [];
    for (const [p, v] of this.pending) {
      if (v !== this.original(p)) out.push(p);
    }
    return out.sort(comparePath);
  }
}

// ---------- line sequences ----------

// One line of a patch body. `kind` is " " for a context line, "-" for a
// line being removed, "+" for a line being added. `bs` records whether a
// "\" line follows this body line in the patch (only meaningful for
// context and "+" lines). `raw` is the patch line as written.
interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  raw: string;
  bs: boolean;
}

// A hunk or chunk as the engine sees it: the lines to match (old) and the
// lines to write (new). A context line appears in both; in the new list it
// carries `oIdx`, its index in the old list, so it can be written back as
// the file's own line. A "+" line carries `bs` for the end-of-file rule.
interface SeqLine {
  text: string;
  ctx: boolean;
  oIdx: number;
  bs: boolean;
}

interface Seq {
  oldSeq: SeqLine[];
  newSeq: SeqLine[];
}

function seqFromBody(body: BodyLine[]): Seq {
  const oldSeq: SeqLine[] = [];
  const newSeq: SeqLine[] = [];
  for (const bl of body) {
    if (bl.kind === ' ') {
      const oIdx = oldSeq.length;
      oldSeq.push({ text: bl.text, ctx: true, oIdx: -1, bs: false });
      newSeq.push({ text: bl.text, ctx: true, oIdx, bs: bl.bs });
    } else if (bl.kind === '-') {
      oldSeq.push({ text: bl.text, ctx: false, oIdx: -1, bs: false });
    } else {
      newSeq.push({ text: bl.text, ctx: false, oIdx: -1, bs: bl.bs });
    }
  }
  return { oldSeq, newSeq };
}

// ---------- matching ----------

// Every start position where `old` occurs in `file` at a tier, searching
// from `from`. Positions are tried one by one, so occurrences may overlap.
function occurrencePositions(file: string[], old: string[], tier: number, from: number): number[] {
  const pos: number[] = [];
  if (old.length === 0) return pos;
  const normOld = old.map((l) => normLine(l, tier));
  const normFile = file.map((l) => normLine(l, tier));
  for (let i = from; i + old.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (normFile[i + j] !== normOld[j]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

// The first tier (0, then 1, then 2; only 0 when strict) that has an
// occurrence at or after `from`, with all its positions. When `eofOnly`,
// only occurrences ending at the file's last line count.
function findFirstTier(
  file: string[],
  old: string[],
  from: number,
  strict: boolean,
  eofOnly = false,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    let pos = occurrencePositions(file, old, tier, from);
    if (eofOnly) pos = pos.filter((p) => p + old.length === file.length);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

// Render the new lines of a sequence at a match. Context lines are written
// as the file's own matched line. Other lines are written as the patch
// wrote them, except at tier 2, where a non-empty, non-whitespace-only
// line starting with P (the leading whitespace of the old sequence's first
// line) has that P replaced by F (the leading whitespace of the file's
// first matched line). With an empty P that prepends F to every such line.
function renderNew(
  newSeq: SeqLine[],
  fileLines: string[],
  matchPos: number,
  tier: number,
  p: string,
  f: string,
): string[] {
  const out: string[] = [];
  for (const nl of newSeq) {
    if (nl.ctx) {
      out.push(fileLines[matchPos + nl.oIdx]);
    } else if (tier === 2 && nl.text !== '' && nl.text.trim() !== '' && nl.text.startsWith(p)) {
      out.push(f + nl.text.slice(p.length));
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

// ---------- the apply engine ----------

interface Fail {
  code: string;
  path: string;
}

interface Hunk {
  a: number;
  seq: Seq;
}

interface Chunk {
  anchor: string | null;
  seq: Seq;
  eof: boolean;
}

// Apply one unified hunk to a document. `d` is the running shift between
// the patch's old line numbers and the file's current ones (each hunk
// moves it by the difference between its new and old line counts).
// Returns the new document and shift, or null when the old lines are not
// found. The final break follows section 6: a hunk running to the end of
// the file leaves the result ending with a break, unless a "\" line
// follows its last context or "+" line; any other hunk leaves it as is.
function applyHunk(doc: FileDoc, hunk: Hunk, d: number, strict: boolean): { doc: FileDoc; d: number } | null {
  const oldLines = hunk.seq.oldSeq.map((l) => l.text);
  const newSeq = hunk.seq.newSeq;
  const lastNew = newSeq.length > 0 ? newSeq[newSeq.length - 1] : null;
  const backslashAtEnd = lastNew !== null && lastNew.bs;
  if (oldLines.length === 0) {
    let idx = hunk.a + d;
    if (idx < 0) idx = 0;
    if (idx > doc.lines.length) idx = doc.lines.length;
    const atEnd = idx === doc.lines.length;
    const rendered = renderNew(newSeq, doc.lines, idx, 0, '', '');
    const lines = [...doc.lines.slice(0, idx), ...rendered, ...doc.lines.slice(idx)];
    return { doc: { lines, sep: doc.sep, ends: atEnd ? !backslashAtEnd : doc.ends }, d: d + rendered.length };
  }
  const found = findFirstTier(doc.lines, oldLines, 0, strict);
  if (found === null) return null;
  const target = hunk.a - 1 + d;
  let best = found.pos[0];
  let bestDist = Math.abs(best - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const matchPos = best;
  const f = leadingWs(doc.lines[matchPos]);
  const p = leadingWs(oldLines[0]);
  const rendered = renderNew(newSeq, doc.lines, matchPos, found.tier, p, f);
  const lines = [...doc.lines.slice(0, matchPos), ...rendered, ...doc.lines.slice(matchPos + oldLines.length)];
  const atEnd = matchPos + oldLines.length === doc.lines.length;
  return {
    doc: { lines, sep: doc.sep, ends: atEnd ? !backslashAtEnd : doc.ends },
    d: d + (rendered.length - oldLines.length),
  };
}

// Apply one V4A chunk. The cursor starts at 0 and moves to just after the
// written lines; an anchor moves it past the anchor line first. The chunk
// takes the first occurrence at or after the cursor at the first tier with
// one; an EOF chunk only takes one ending at the file's last line. An
// empty old sequence inserts at the cursor (or at the end for an EOF
// chunk). The file's final break never changes here.
function applyChunk(doc: FileDoc, chunk: Chunk, cursor: number, strict: boolean): { doc: FileDoc; cursor: number } | null {
  let cur = cursor;
  if (chunk.anchor !== null) {
    const tiers = strict ? [0] : [0, 1, 2];
    let foundIdx: number | null = null;
    for (const tier of tiers) {
      const aNorm = normLine(chunk.anchor, tier);
      for (let i = cur; i < doc.lines.length; i++) {
        if (normLine(doc.lines[i], tier) === aNorm) {
          foundIdx = i;
          break;
        }
      }
      if (foundIdx !== null) break;
    }
    if (foundIdx === null) return null;
    cur = foundIdx + 1;
  }
  const oldLines = chunk.seq.oldSeq.map((l) => l.text);
  const newSeq = chunk.seq.newSeq;
  if (oldLines.length === 0) {
    const idx = chunk.eof ? doc.lines.length : Math.min(cur, doc.lines.length);
    const rendered = renderNew(newSeq, doc.lines, idx, 0, '', '');
    const lines = [...doc.lines.slice(0, idx), ...rendered, ...doc.lines.slice(idx)];
    return { doc: { lines, sep: doc.sep, ends: doc.ends }, cursor: idx + rendered.length };
  }
  const found = findFirstTier(doc.lines, oldLines, cur, strict, chunk.eof);
  if (found === null) return null;
  const matchPos = found.pos[0];
  const f = leadingWs(doc.lines[matchPos]);
  const p = leadingWs(oldLines[0]);
  const rendered = renderNew(newSeq, doc.lines, matchPos, found.tier, p, f);
  const lines = [...doc.lines.slice(0, matchPos), ...rendered, ...doc.lines.slice(matchPos + oldLines.length)];
  return { doc: { lines, sep: doc.sep, ends: doc.ends }, cursor: matchPos + rendered.length };
}

// ---------- edits ----------

type Edit =
  | { format: 'unified'; section: UnifiedSection }
  | { format: 'sr'; path: string; oldLines: string[]; newLines: string[] }
  | { format: 'v4a'; section: V4ASection }
  | { format: 'json'; json: JSONEdit };

type JSONEdit =
  | { command: 'create'; path: string; fileText: string }
  | { command: 'str_replace'; path: string; oldStr: string; newStr: string }
  | { command: 'insert'; path: string; insertLine: number; newStr: string };

interface UnifiedSection {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  // True when the section was opened by a "diff --git " line that does not
  // match the four-token form. Such a section is dropped: the pair and
  // hunks after it belong to it, but it never becomes an edit.
  badDiffGit: boolean;
  hunks: Hunk[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: Chunk[];
}

function stripAB(p: string, which: 'a' | 'b'): string {
  const prefix = `${which}/`;
  return p.startsWith(prefix) ? p.slice(2) : p;
}

// The old and new path a section names, in order: the ---/+++ pair, the
// rename from/to, the diff --git pair. A "/dev/null" side is no path.
function resolveUnifiedPaths(sec: UnifiedSection): { oldPath: string | null; newPath: string | null } {
  let oldPath: string | null;
  let newPath: string | null;
  if (sec.pairOld !== null || sec.pairNew !== null) {
    oldPath = sec.pairOld === null ? null : stripAB(sec.pairOld, 'a');
    newPath = sec.pairNew === null ? null : stripAB(sec.pairNew, 'b');
  } else if (sec.renameOld !== null || sec.renameNew !== null) {
    // Rename paths are used as written, with no a/ or b/ stripping.
    oldPath = sec.renameOld;
    newPath = sec.renameNew;
  } else {
    oldPath = sec.diffOld;
    newPath = sec.diffNew;
  }
  if (oldPath === '/dev/null') oldPath = null;
  if (newPath === '/dev/null') newPath = null;
  return { oldPath, newPath };
}

function applyUnified(
  tree: Tree,
  sec: UnifiedSection,
  strict: boolean,
  moves: { from: string; to: string }[],
): Fail | null {
  const { oldPath, newPath } = resolveUnifiedPaths(sec);
  if (oldPath === null && newPath === null) return null;

  const isCreation = oldPath === null || sec.newFile;
  const isDeletion = !isCreation && (newPath === null || sec.deletedFile);
  const isMove = !isCreation && !isDeletion && oldPath !== null && newPath !== null && oldPath !== newPath;

  if (isCreation) {
    const p = newPath as string;
    if (isUnsafe(p)) return { code: 'unsafe', path: p };
    if (tree.existsAny(p)) return { code: 'exists', path: p };
    const lines: string[] = [];
    let hasPlus = false;
    let lastPlusBs = false;
    for (const hunk of sec.hunks) {
      for (const nl of hunk.seq.newSeq) {
        if (!nl.ctx) {
          lines.push(nl.text);
          hasPlus = true;
          lastPlusBs = nl.bs;
        }
      }
    }
    const ends = hasPlus ? !lastPlusBs : false;
    tree.set(p, lines.length === 0 ? '' : lines.join('\n') + (ends ? '\n' : ''));
    return null;
  }

  if (isDeletion) {
    const p = oldPath as string;
    if (isUnsafe(p)) return { code: 'unsafe', path: p };
    if (!tree.isFile(p)) return { code: 'missing', path: p };
    tree.remove(p);
    return null;
  }

  const src = oldPath as string;
  const dst = newPath as string;
  if (isMove) {
    if (isUnsafe(dst)) return { code: 'unsafe', path: dst };
    if (isUnsafe(src)) return { code: 'unsafe', path: src };
  } else if (isUnsafe(src)) {
    return { code: 'unsafe', path: src };
  }
  const content = tree.content(src);
  if (content === null) return { code: 'missing', path: src };
  if (isMove && tree.existsAny(dst)) return { code: 'exists', path: dst };
  let doc = docFromText(content);
  let d = 0;
  for (const hunk of sec.hunks) {
    const res = applyHunk(doc, hunk, d, strict);
    if (res === null) return { code: 'no-match', path: src };
    doc = res.doc;
    d = res.d;
  }
  tree.set(dst, docToText(doc));
  if (isMove) {
    tree.remove(src);
    moves.push({ from: src, to: dst });
  }
  return null;
}

function applySR(tree: Tree, edit: Extract<Edit, { format: 'sr' }>, strict: boolean): Fail | null {
  if (isUnsafe(edit.path)) return { code: 'unsafe', path: edit.path };
  if (edit.oldLines.length === 0) {
    if (tree.existsAny(edit.path)) return { code: 'exists', path: edit.path };
    tree.set(edit.path, edit.newLines.length === 0 ? '' : edit.newLines.join('\n') + '\n');
    return null;
  }
  const content = tree.content(edit.path);
  if (content === null) return { code: 'missing', path: edit.path };
  const doc = docFromText(content);
  const found = findFirstTier(doc.lines, edit.oldLines, 0, strict);
  if (found === null) return { code: 'no-match', path: edit.path };
  if (found.pos.length > 1) return { code: 'ambiguous', path: edit.path };
  const matchPos = found.pos[0];
  const f = leadingWs(doc.lines[matchPos]);
  const p = leadingWs(edit.oldLines[0]);
  const newSeq: SeqLine[] = edit.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1, bs: false }));
  const rendered = renderNew(newSeq, doc.lines, matchPos, found.tier, p, f);
  const lines = [...doc.lines.slice(0, matchPos), ...rendered, ...doc.lines.slice(matchPos + edit.oldLines.length)];
  tree.set(edit.path, docToText({ lines, sep: doc.sep, ends: doc.ends }));
  return null;
}

function applyV4A(
  tree: Tree,
  sec: V4ASection,
  strict: boolean,
  moves: { from: string; to: string }[],
): Fail | null {
  if (isUnsafe(sec.path)) return { code: 'unsafe', path: sec.path };
  if (sec.moveTo !== null && isUnsafe(sec.moveTo)) return { code: 'unsafe', path: sec.moveTo };
  if (sec.kind === 'add') {
    if (tree.existsAny(sec.path)) return { code: 'exists', path: sec.path };
    tree.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
    return null;
  }
  if (sec.kind === 'delete') {
    if (!tree.isFile(sec.path)) return { code: 'missing', path: sec.path };
    tree.remove(sec.path);
    return null;
  }
  const content = tree.content(sec.path);
  if (content === null) return { code: 'missing', path: sec.path };
  if (sec.moveTo !== null && tree.existsAny(sec.moveTo)) return { code: 'exists', path: sec.moveTo };
  let doc = docFromText(content);
  let cursor = 0;
  for (const chunk of sec.chunks) {
    const res = applyChunk(doc, chunk, cursor, strict);
    if (res === null) return { code: 'no-match', path: sec.path };
    doc = res.doc;
    cursor = res.cursor;
  }
  if (sec.moveTo !== null) {
    tree.set(sec.moveTo, docToText(doc));
    tree.remove(sec.path);
    moves.push({ from: sec.path, to: sec.moveTo });
  } else {
    tree.set(sec.path, docToText(doc));
  }
  return null;
}

function applyJSON(tree: Tree, edit: JSONEdit): Fail | null {
  if (isUnsafe(edit.path)) return { code: 'unsafe', path: edit.path };
  if (edit.command === 'create') {
    if (tree.existsAny(edit.path)) return { code: 'exists', path: edit.path };
    tree.set(edit.path, edit.fileText);
    return null;
  }
  const content = tree.content(edit.path);
  if (content === null) return { code: 'missing', path: edit.path };
  if (edit.command === 'str_replace') {
    const doc = docFromText(content);
    const crlf = doc.sep === '\r\n';
    const norm = (s: string): string => (crlf ? s.replace(/\r\n/g, '\n') : s);
    const text = norm(content);
    const old = norm(edit.oldStr);
    const nw = norm(edit.newStr);
    let count = 0;
    let firstIdx = -1;
    let idx = 0;
    for (;;) {
      const k = text.indexOf(old, idx);
      if (k === -1) break;
      if (count === 0) firstIdx = k;
      count++;
      idx = k + 1;
    }
    if (count === 0) return { code: 'no-match', path: edit.path };
    if (count > 1) return { code: 'ambiguous', path: edit.path };
    let result = text.slice(0, firstIdx) + nw + text.slice(firstIdx + old.length);
    if (crlf) result = result.replace(/\n/g, '\r\n');
    tree.set(edit.path, result);
    return null;
  }
  const doc = docFromText(content);
  if (edit.insertLine < 0 || edit.insertLine > doc.lines.length) return { code: 'no-match', path: edit.path };
  const insLines = patchLines(edit.newStr);
  const lines = [...doc.lines.slice(0, edit.insertLine), ...insLines, ...doc.lines.slice(edit.insertLine)];
  tree.set(edit.path, docToText({ lines, sep: doc.sep, ends: doc.ends }));
  return null;
}

function applyEdit(
  tree: Tree,
  edit: Edit,
  strict: boolean,
  moves: { from: string; to: string }[],
): Fail | null {
  switch (edit.format) {
    case 'unified':
      return applyUnified(tree, edit.section, strict, moves);
    case 'sr':
      return applySR(tree, edit, strict);
    case 'v4a':
      return applyV4A(tree, edit.section, strict, moves);
    case 'json':
      return applyJSON(tree, edit.json);
  }
}

// ---------- output and writing ----------

// Build the report rows from the changed paths. A genuine move (its old
// path existed before and not after, its new path not before and after)
// is one "R <old> -> <new>" line sorted by <new>, replacing that pair's
// D and A lines; every other change is A, D or M, sorted by path.
function computeRows(tree: Tree, moves: { from: string; to: string }[]): string[] {
  const covered = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const m of moves) {
    const wasFrom = tree.original(m.from);
    const nowFrom = tree.content(m.from);
    const wasTo = tree.original(m.to);
    const nowTo = tree.content(m.to);
    if (wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null) {
      rows.push({ key: m.to, text: `R ${m.from} -> ${m.to}` });
      covered.add(m.from);
      covered.add(m.to);
    }
  }
  for (const p of tree.changedPaths()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.content(p);
    if (was === null && now !== null) rows.push({ key: p, text: `A ${p}` });
    else if (was !== null && now === null) rows.push({ key: p, text: `D ${p}` });
    else if (was !== null && now !== null && was !== now) rows.push({ key: p, text: `M ${p}` });
  }
  rows.sort((a, b) => comparePath(a.key, b.key));
  return rows.map((r) => r.text);
}

// Write the changed files, in byte order of path (so a deletion of "a"
// lands before a creation of "a/b.txt"). If any write fails, every file
// touched so far is restored to its original bytes (or removed, when it
// did not exist), and the failing path is returned instead of crashing.
function writeTree(tree: Tree): string | null {
  const changed = tree.changedPaths();
  const touched: { path: string; original: string | null }[] = [];
  try {
    for (const p of changed) {
      const now = tree.content(p);
      touched.push({ path: p, original: tree.original(p) });
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        const dir = dirname(p);
        if (dir !== '.' && dir !== '') mkdirSync(dir, { recursive: true });
        writeFileSync(p, now, 'utf8');
      }
    }
    return null;
  } catch {
    for (const t of touched) {
      try {
        if (t.original === null) {
          rmSync(t.path, { force: true });
        } else {
          const dir = dirname(t.path);
          if (dir !== '.' && dir !== '') mkdirSync(dir, { recursive: true });
          writeFileSync(t.path, t.original, 'utf8');
        }
      } catch {
        // Best effort: the original write error is the one reported.
      }
    }
    return touched.length > 0 ? touched[touched.length - 1].path : '';
  }
}

// ---------- readers ----------

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`error: parse ${line}`);
    this.line = line;
  }
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Unified diff. A section starts at a `diff --git a/<X> b/<Y>` line (four
// tokens, trailing whitespace allowed) or at a `--- ` line followed by a
// `+++ ` line. A lone `--- ` inside a header is a parse error at the line
// after it; outside a header it is ignored prose. A lone `+++ ` in a
// header sets the new path. Hunks apply in order; a hunk before any
// section, or any other line starting with `@@`, is a parse error at its
// line. Body lines are " ", "-", "+", "\" or empty (an empty line is a
// context line with empty text); empty lines at the end of a body are not
// part of it.
function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let sec: UnifiedSection | null = null;
  let inHeader = false;
  let inBody = false;
  let body: BodyLine[] = [];
  let hunkA = 0;

  const newSection = (): UnifiedSection => ({
    pairOld: null,
    pairNew: null,
    renameOld: null,
    renameNew: null,
    diffOld: null,
    diffNew: null,
    newFile: false,
    deletedFile: false,
    badDiffGit: false,
    hunks: [],
  });

  const finishBody = () => {
    if (sec === null) return;
    while (body.length > 0 && body[body.length - 1].raw === '') body.pop();
    sec.hunks.push({ a: hunkA, seq: seqFromBody(body) });
    body = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBody) {
      if (line.startsWith('--- ')) {
        // A "--- " line is never a body line: it ends the body, and is
        // then read as a section start (with a following "+++ ") or as
        // prose (a lone one outside a header).
        finishBody();
        inBody = false;
        // Fall through and process this line outside the body.
      } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
        const kind = line === '' ? ' ' : (line[0] as ' ' | '-' | '+');
        body.push({ kind, text: line === '' ? '' : line.slice(1), raw: line, bs: false });
        continue;
      } else if (line[0] === '\\') {
        for (let k = body.length - 1; k >= 0; k--) {
          if (body[k].kind === ' ' || body[k].kind === '+') {
            body[k].bs = true;
            break;
          }
          if (body[k].kind === '-') break;
        }
        continue;
      } else {
        finishBody();
        inBody = false;
        // Fall through and process this line outside the body.
      }
    }

    // A "diff --git " line opens a section whether or not it matches the
    // four-token form. A malformed one poisons the section: the pair and
    // hunks that follow belong to it, but it never becomes an edit.
    if (line.startsWith('diff --git ')) {
      const dg = DIFF_GIT_RE.exec(line);
      if (sec !== null && !sec.badDiffGit) edits.push({ format: 'unified', section: sec });
      sec = newSection();
      if (dg !== null) {
        sec.diffOld = dg[1];
        sec.diffNew = dg[2];
      } else {
        sec.badDiffGit = true;
      }
      inHeader = true;
      continue;
    }

    if (line.startsWith('--- ')) {
      const next = i + 1 < lines.length ? lines[i + 1] : '';
      if (next.startsWith('+++ ')) {
        if (sec !== null && (inHeader ? sec.pairOld !== null || sec.pairNew !== null : true)) {
          if (!sec.badDiffGit) edits.push({ format: 'unified', section: sec });
          sec = newSection();
        }
        if (sec === null) sec = newSection();
        // A "--- "/"+++ " line may carry a git timestamp after a tab;
        // the path is the part before it.
        const cutTab = (s: string): string => {
          const t = s.indexOf('\t');
          return t === -1 ? s : s.slice(0, t);
        };
        sec.pairOld = cutTab(line.slice(4));
        sec.pairNew = cutTab(next.slice(4));
        inHeader = true;
        i++;
        continue;
      }
      if (inHeader && sec !== null) throw new ParseError(i + 2);
      continue;
    }

    if (line.startsWith('+++ ')) {
      if (sec !== null && inHeader) {
        const t = line.slice(4).indexOf('\t');
        sec.pairNew = t === -1 ? line.slice(4) : line.slice(4, 4 + t);
      }
      continue;
    }

    if (line.startsWith('rename from ')) {
      if (sec !== null && inHeader) sec.renameOld = line.slice(12);
      continue;
    }

    if (line.startsWith('rename to ')) {
      if (sec !== null && inHeader) sec.renameNew = line.slice(10);
      continue;
    }

    if (line === 'new file mode' || line.startsWith('new file mode ')) {
      if (sec !== null && inHeader) sec.newFile = true;
      continue;
    }

    if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
      if (sec !== null && inHeader) sec.deletedFile = true;
      continue;
    }

    if (line.startsWith('@@')) {
      const hm = HUNK_RE.exec(line);
      if (hm === null) throw new ParseError(i + 1);
      if (sec === null) throw new ParseError(i + 1);
      hunkA = parseInt(hm[1], 10);
      body = [];
      inBody = true;
      inHeader = false;
      continue;
    }

    // Anything else is ignored (prose, or a header line like "index").
  }

  if (inBody) finishBody();
  if (sec !== null && !sec.badDiffGit) edits.push({ format: 'unified', section: sec });
  return edits;
}

// SEARCH/REPLACE. One edit per block. The path is the nearest non-blank,
// non-fence line before the SEARCH line (after the previous block's
// REPLACE line, or the start of the patch); when there is none, the
// previous block's path is reused, and a first block with none is a parse
// error at the SEARCH line. A SEARCH line with no `=======` and then
// `>>>>>>> REPLACE` after it is a parse error at the SEARCH line.
function parseSR(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let k = searchLine - 1; k > prevEnd; k--) {
      const t = lines[k].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseError(searchLine + 1);
    let sep = -1;
    for (let k = searchLine + 1; k < lines.length; k++) {
      if (lines[k].trimEnd() === '=======') {
        sep = k;
        break;
      }
    }
    if (sep === -1) throw new ParseError(searchLine + 1);
    let rep = -1;
    for (let k = sep + 1; k < lines.length; k++) {
      if (lines[k].trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep === -1) throw new ParseError(searchLine + 1);
    edits.push({
      format: 'sr',
      path,
      oldLines: lines.slice(searchLine + 1, sep),
      newLines: lines.slice(sep + 1, rep),
    });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// V4A. The first non-blank line must be `*** Begin Patch` and the last
// non-blank line `*** End Patch`, or the patch is a parse error (at the
// first line, or at the number of patch lines plus 1). Blank lines
// between sections are ignored. An Add File section's lines must start
// with "+" or be exactly empty (a whitespace-only line is a parse error
// at its line). A Delete File section has no lines. An Update File
// section may start with `*** Move to: <path>`, then chunks starting at
// "@@" (anchor = the text after it, trimmed) or at a body line for the
// first chunk; `*** End of File` ends a chunk and anchors it to the end
// of the file, and with no chunk it is a parse error at its line. A
// section with no chunk and no Move to is a parse error at its Update
// File line. Blank lines at the end of a section are not part of it.
function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);

  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const isAdd = line.startsWith('*** Add File: ');
      const isDelete = line.startsWith('*** Delete File: ');
      const prefix = isAdd ? '*** Add File: ' : isDelete ? '*** Delete File: ' : '*** Update File: ';
      const path = line.slice(prefix.length).trim();
      const content: { text: string; idx: number }[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j])) {
        content.push({ text: lines[j], idx: j });
        j++;
      }
      if (isAdd) {
        while (content.length > 0 && isBlank(content[content.length - 1].text)) content.pop();
        const fileLines: string[] = [];
        for (const c of content) {
          if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
          else if (c.text === '') fileLines.push('');
          else throw new ParseError(c.idx + 1);
        }
        edits.push({ format: 'v4a', section: { kind: 'add', path, moveTo: null, lines: fileLines, chunks: [] } });
      } else if (isDelete) {
        for (const c of content) {
          if (!isBlank(c.text)) throw new ParseError(c.idx + 1);
        }
        edits.push({ format: 'v4a', section: { kind: 'delete', path, moveTo: null, lines: [], chunks: [] } });
      } else {
        const updateLine = i;
        let moveTo: string | null = null;
        let k = 0;
        if (k < content.length && content[k].text.startsWith('*** Move to: ')) {
          moveTo = content[k].text.slice('*** Move to: '.length).trim();
          k++;
        }
        const rawChunks: { anchor: string | null; body: BodyLine[]; eof: boolean }[] = [];
        let cur: { anchor: string | null; body: BodyLine[]; eof: boolean } | null = null;
        const pushChunk = () => {
          if (cur !== null) {
            rawChunks.push(cur);
            cur = null;
          }
        };
        while (k < content.length) {
          const c = content[k];
          const t = c.text;
          if (t.startsWith('@@')) {
            pushChunk();
            // The anchor is the text after "@@", trimmed; an empty one
            // means the chunk has no anchor.
            const a = t.slice(2).trim();
            cur = { anchor: a === '' ? null : a, body: [], eof: false };
            k++;
            continue;
          }
          if (t.trim() === '*** End of File') {
            if (cur === null) throw new ParseError(c.idx + 1);
            cur.eof = true;
            pushChunk();
            k++;
            continue;
          }
          if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
            if (cur === null) cur = { anchor: null, body: [], eof: false };
            const kind = t === '' ? ' ' : (t[0] as ' ' | '-' | '+');
            cur.body.push({ kind, text: t === '' ? '' : t.slice(1), raw: t, bs: false });
            k++;
            continue;
          }
          if (isBlank(t)) {
            let allBlank = true;
            for (let m = k + 1; m < content.length; m++) {
              if (!isBlank(content[m].text)) {
                allBlank = false;
                break;
              }
            }
            if (allBlank) {
              k = content.length;
              continue;
            }
            throw new ParseError(c.idx + 1);
          }
          throw new ParseError(c.idx + 1);
        }
        pushChunk();
        if (rawChunks.length > 0) {
          const lastBody = rawChunks[rawChunks.length - 1].body;
          while (lastBody.length > 0) {
            const bl = lastBody[lastBody.length - 1];
            if (bl.kind === ' ' && isBlank(bl.raw)) lastBody.pop();
            else break;
          }
        }
        const chunks: Chunk[] = [];
        for (const rc of rawChunks) {
          if (rc.anchor === null && !rc.eof && rc.body.length === 0) continue;
          chunks.push({ anchor: rc.anchor, seq: seqFromBody(rc.body), eof: rc.eof });
        }
        if (chunks.length === 0 && moveTo === null) throw new ParseError(updateLine + 1);
        edits.push({ format: 'v4a', section: { kind: 'update', path, moveTo, lines: [], chunks } });
      }
      i = j;
      continue;
    }
    throw new ParseError(i + 1);
  }
  return edits;
}

// JSON. Either an array of edit objects, or one edit object per non-blank
// line (JSON Lines). In array form any fault is a parse error at the line
// where the array starts; in JSON Lines form a bad line is a parse error
// at that line.
function jsonEdit(v: unknown): JSONEdit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const cmd = o.command;
  if (cmd === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { command: 'create', path: o.path, fileText: o.file_text };
  }
  if (cmd === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return {
      command: 'str_replace',
      path: o.path,
      oldStr: o.old_str,
      newStr: typeof o.new_str === 'string' ? o.new_str : '',
    };
  }
  if (cmd === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { command: 'insert', path: o.path, insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function parseJSON(lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  const edits: Edit[] = [];
  if (lines[first].trimStart()[0] === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(lines.join('\n'));
    } catch {
      throw new ParseError(first + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(first + 1);
    for (const el of arr) {
      const e = jsonEdit(el);
      if (e === null) throw new ParseError(first + 1);
      edits.push({ format: 'json', json: e });
    }
    return edits;
  }
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      throw new ParseError(i + 1);
    }
    const e = jsonEdit(obj);
    if (e === null) throw new ParseError(i + 1);
    edits.push({ format: 'json', json: e });
  }
  return edits;
}

// Format detection, in order: V4A, JSON, SEARCH/REPLACE, unified.
function detectFormat(lines: string[]): 'unified' | 'search-replace' | 'v4a' | 'json' | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const ch = lines[first].trimStart()[0];
  if (ch === '[' || ch === '{') return 'json';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------- command line ----------

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let patchFile: string | null = null;
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a === '--check') {
      if (check) return { code: 2, out: ['error: usage'] };
      check = true;
      continue;
    }
    if (!endOpts && a === '--strict') {
      if (strict) return { code: 2, out: ['error: usage'] };
      strict = true;
      continue;
    }
    if (!endOpts && a.startsWith('--format=')) {
      if (format !== null) return { code: 2, out: ['error: usage'] };
      const v = a.slice('--format='.length);
      if (!FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
      format = v;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      return { code: 2, out: ['error: usage'] };
    }
    if (patchFile !== null) return { code: 2, out: ['error: usage'] };
    patchFile = a;
  }

  // A patch argument of "-" means stdin, the same as no argument.
  const file = patchFile === null || patchFile === '-' ? null : patchFile;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);

  let fmt = format;
  if (fmt === null || fmt === 'auto') {
    const det = detectFormat(lines);
    if (det === null) return { code: 2, out: ['error: format'] };
    fmt = det;
  }

  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSR(lines);
    else if (fmt === 'v4a') edits = parseV4A(lines);
    else edits = parseJSON(lines);
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };

  const tree = new Tree();
  const moves: { from: string; to: string }[] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snap = new Map(tree.pending);
    const fail = applyEdit(tree, edit, strict, moves);
    if (fail !== null) {
      tree.pending.clear();
      for (const [k, v] of snap) tree.pending.set(k, v);
      fails.push(fail);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const rows = computeRows(tree, moves);
  const out = [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    const writeErr = writeTree(tree);
    if (writeErr !== null) {
      return { code: 1, out: [`error: write ${writeErr}`, `failed: 1 of ${edits.length} edits`] };
    }
  }
  return { code: 0, out };
}

// --- handover to the kit runner (do not edit) ---
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
