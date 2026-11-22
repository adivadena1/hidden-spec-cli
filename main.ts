// mend — one patch tool for every AI edit format.
//
// Implements SPEC.md: unified diff, SEARCH/REPLACE blocks, V4A patches and
// JSON edits. Reads a patch from a file or stdin, applies every edit to the
// working tree, and writes all changes or none of them.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// This file was written for the hidden-spec-cli bounty. The handover block
// at the bottom (MAKEFUN_ENV_URL -> ./runner.ts) is kit plumbing and is
// kept exactly as handed out.

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

type Format = "unified" | "search-replace" | "v4a" | "json";

// ---- Internal representation (SPEC sections 6-9) ----
//
// Every parser normalizes its format to the same list of Edits, and one
// engine (applyEdit) executes them against the tree. A line edit carries a
// LineOp describing what to do with the file's lines:
//
//   set         — replace the whole file with these lines (a creation; the
//                 file must not exist yet). Created files use LF.
//   match       — replace the first occurrence (mode "first", at or after
//                 `from`) or the occurrence nearest `target` (mode
//                 "nearest") of oldLines with newLines, at the first tier
//                 with one. `unique` requires exactly one occurrence at
//                 that tier (else ambiguous). `eof` requires the match to
//                 end at the file's last line. `endBreak` decides the
//                 result's final line break when the match runs to the end
//                 of the file: "keep" leaves it as it was, "on" forces it
//                 on, "off" forces it off.
//   seq         — a sequence of steps applied in order to the same file,
//                 threading a cursor through them (V4A): an anchor step
//                 finds one line at or after the cursor and moves the
//                 cursor past it; a match step replaces the first
//                 occurrence at or after the cursor.
//   str-replace — replace one occurrence of a substring (JSON), with the
//                 file's CRLF handling.
//
// A context line of N is written as the file's own matched line; every
// other N line is written as the patch wrote it, re-indented at tier 2.
// `contextInOld` / `contextInNew` mark the context lines of O / N.

type SeqStep =
  | { type: "anchor"; line: string }
  | {
      type: "match";
      oldLines: string[];
      newLines: string[];
      contextInOld: boolean[];
      contextInNew: boolean[];
      mode: "first" | "nearest";
      from?: number;
      target?: number;
      eof?: boolean;
      endBreak: "keep" | "on" | "off";
    };

type LineOp =
  | { type: "set"; lines: string[]; endsWithBreak: boolean }
  | {
      type: "match";
      oldLines: string[];
      newLines: string[];
      contextInOld: boolean[];
      contextInNew: boolean[];
      mode: "first" | "nearest";
      from?: number;
      target?: number;
      eof?: boolean;
      unique?: boolean;
      endBreak: "keep" | "on" | "off";
    }
  | { type: "seq"; steps: SeqStep[] }
  | { type: "str-replace"; oldStr: string; newStr: string };

type Edit =
  | { kind: "write"; path: string; text: string }
  | { kind: "delete"; path: string }
  | { kind: "line"; path: string; op: LineOp; move?: { from: string; to: string } };

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

class EditError extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

// A failed write (SPEC section 10: no file is written when the run fails).
class WriteError extends Error {
  path: string;
  constructor(path: string) {
    super(`write ${path}`);
    this.path = path;
  }
}

// ---- Text model (SPEC section 3) ----

// Split a patch into lines: split at "\n", drop one trailing "\r" from each
// line, drop the empty piece after a final "\n".
function splitPatch(text: string): string[] {
  const raw = text.split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  return raw.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

interface FileModel {
  lines: string[];
  endsWithBreak: boolean;
  crlf: boolean;
}

// Split a file's text into lines at its own line break. The break is CRLF
// when the first LF follows a CR, else LF. Only those two count as breaks:
// a lone CR is an ordinary byte, and "ends with a break" is judged by the
// file's own break, so a mixed-EOL tail cannot lose bytes.
function splitFile(text: string): FileModel {
  const firstLf = text.indexOf("\n");
  const crlf = firstLf > 0 && text[firstLf - 1] === "\r";
  const sep = crlf ? "\r\n" : "\n";
  const endsWithBreak = text.endsWith(sep);
  const body = endsWithBreak ? text.slice(0, -sep.length) : text;
  const lines = text === "" ? [] : body.split(sep);
  return { lines, endsWithBreak, crlf };
}

function joinFile(model: FileModel): string {
  if (model.lines.length === 0) return "";
  const sep = model.crlf ? "\r\n" : "\n";
  return model.lines.join(sep) + (model.endsWithBreak ? sep : "");
}

// ---- Safe paths (SPEC section 3) ----

function safePath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  for (const part of path.split("/")) {
    if (part === "" || part === "." || part === "..") return false;
  }
  return true;
}

// ---- Matching (SPEC section 5) ----

function stripTrail(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  return line.slice(0, end);
}

function stripBoth(line: string): string {
  let start = 0;
  while (start < line.length && (line[start] === " " || line[start] === "\t")) start++;
  let end = line.length;
  while (end > start && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  return line.slice(start, end);
}

// All start positions (overlapping allowed) where `needle` occurs in
// `lines` at the given tier. A single empty needle line matches every line.
function occurrencesAt(lines: string[], needle: string[], tier: number): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  const norm =
    tier === 0 ? (s: string) => s : tier === 1 ? stripTrail : stripBoth;
  const n = needle.map(norm);
  const last = lines.length - needle.length;
  for (let i = 0; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (norm(lines[i + j]) !== n[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function leadingWs(line: string): string {
  let end = 0;
  while (end < line.length && (line[end] === " " || line[end] === "\t")) end++;
  return line.slice(0, end);
}

// ---- Working tree ----

class Tree {
  now: Map<string, string>;
  before: Map<string, string>;
  dirs: Set<string>;
  constructor(files: Map<string, string>, dirs: Set<string>) {
    this.now = new Map(files);
    this.before = new Map(files);
    this.dirs = dirs;
  }
  exists(path: string): boolean {
    return this.now.has(path);
  }
  // True when the path is a file or a directory. Only the create / set /
  // move-to "exists" checks use this; "missing" checks stay file-only, so
  // deleting or moving from a directory still reports "missing" as before.
  existsAny(path: string): boolean {
    return this.now.has(path) || this.dirs.has(path);
  }
  model(path: string): FileModel {
    return splitFile(this.now.get(path) ?? "");
  }
  set(path: string, text: string): void {
    this.now.set(path, text);
  }
  remove(path: string): void {
    this.now.delete(path);
  }
}

async function readTree(root: string): Promise<{ files: Map<string, string>; dirs: Set<string> }> {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(join(root, dir), { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        dirs.add(rel);
        await walk(join(dir, entry.name), rel);
      } else if (entry.isFile()) {
        files.set(rel, await readFile(join(root, dir, entry.name), "utf8"));
      }
    }
  }
  await walk("", "");
  return { files, dirs };
}

// Write the tree, all-or-nothing: writes happen first, deletions last, and
// if any step throws, every file this call touched is restored (original
// bytes back, new files removed) before the failure is reported, so a
// failed run leaves the directory exactly as it was.
async function writeTree(root: string, before: Map<string, string>, after: Map<string, string>): Promise<void> {
  const written: string[] = [];
  const deleted: string[] = [];
  let current = "";
  try {
    for (const [path, text] of after) {
      if (before.get(path) !== text) {
        current = path;
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), text, "utf8");
        written.push(path);
      }
    }
    for (const path of before.keys()) {
      if (!after.has(path)) {
        current = path;
        await rm(join(root, path), { force: true });
        deleted.push(path);
      }
    }
  } catch {
    for (const path of written) {
      const orig = before.get(path);
      try {
        if (orig === undefined) await rm(join(root, path), { force: true });
        else await writeFile(join(root, path), orig, "utf8");
      } catch { /* rollback is best effort */ }
    }
    for (const path of deleted) {
      try {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), before.get(path) ?? "", "utf8");
      } catch { /* rollback is best effort */ }
    }
    throw new WriteError(current);
  }
}

// ---- The one application engine (SPEC sections 6-10) ----
//
// Applies a single normalized Edit to the tree. A failed edit changes
// nothing; the caller (run) keeps going with the next edit.

function applyEdit(tree: Tree, edit: Edit, strict: boolean): void {
  if (edit.kind === "write") {
    if (!safePath(edit.path)) throw new EditError("unsafe", edit.path);
    if (tree.existsAny(edit.path)) throw new EditError("exists", edit.path);
    tree.set(edit.path, edit.text);
    return;
  }
  if (edit.kind === "delete") {
    if (!safePath(edit.path)) throw new EditError("unsafe", edit.path);
    if (!tree.exists(edit.path)) throw new EditError("missing", edit.path);
    tree.remove(edit.path);
    return;
  }
  // Line edit. A move reads from move.from and writes to move.to; every
  // path the edit names is checked for safety before anything else.
  if (!safePath(edit.path)) throw new EditError("unsafe", edit.path);
  const srcPath = edit.move ? edit.move.from : edit.path;
  const dstPath = edit.move ? edit.move.to : edit.path;
  // Errors about lines not found concern the file that was searched (SPEC
  // section 2), which for a move is the source, not the destination.
  const reportPath = edit.move ? edit.move.from : edit.path;
  if (edit.move) {
    if (!safePath(srcPath)) throw new EditError("unsafe", srcPath);
    if (!safePath(dstPath)) throw new EditError("unsafe", dstPath);
    if (!tree.exists(srcPath)) throw new EditError("missing", srcPath);
    if (tree.existsAny(dstPath)) throw new EditError("exists", dstPath);
  }
  const op = edit.op;
  if (op.type === "set") {
    if (tree.existsAny(edit.path)) throw new EditError("exists", edit.path);
    tree.set(edit.path, joinFile({ lines: op.lines, endsWithBreak: op.endsWithBreak, crlf: false }));
    return;
  }
  if (!tree.exists(srcPath)) throw new EditError("missing", srcPath);
  const file = tree.model(srcPath);
  if (op.type === "str-replace") {
    tree.set(dstPath, applyStrReplace(file, op.oldStr, op.newStr, edit.path));
    return;
  }
  if (op.type === "match") {
    const result = applyLineMatch(file, reportPath, op.oldLines, op.newLines, op.contextInOld, op.contextInNew, {
      mode: op.mode,
      from: op.from,
      target: op.target,
      eof: op.eof,
      unique: op.unique,
      strict,
    });
    const endsWithBreak =
      op.endBreak === "keep"
        ? file.endsWithBreak
        : op.endBreak === "on"
          ? result.atEnd
            ? true
            : file.endsWithBreak
          : result.atEnd
            ? false
            : file.endsWithBreak;
    tree.set(dstPath, joinFile({ lines: result.lines, endsWithBreak, crlf: file.crlf }));
    return;
  }
  // seq: steps applied in order to one in-memory copy, so a failure in a
  // later step leaves the file unchanged. The cursor (V4A) is threaded
  // through the steps; the final line break follows each step's rule.
  let lines = file.lines;
  let endsWithBreak = file.endsWithBreak;
  let cursor = 0;
  for (const step of op.steps) {
    if (step.type === "anchor") {
      // The first tier with an occurrence at or after the cursor.
      const maxTier = strict ? 0 : 2;
      let anchorPos = -1;
      for (let tier = 0; tier <= maxTier; tier++) {
        const at = occurrencesAt(lines, [step.line], tier).filter((i) => i >= cursor);
        if (at.length > 0) {
          anchorPos = at[0];
          break;
        }
      }
      if (anchorPos === -1) throw new EditError("no-match", reportPath);
      cursor = anchorPos + 1;
      continue;
    }
    const result = applyLineMatch(
      { lines, endsWithBreak, crlf: file.crlf },
      reportPath,
      step.oldLines,
      step.newLines,
      step.contextInOld,
      step.contextInNew,
      // A "first" step (V4A) searches at or after the cursor; a "nearest"
      // step (unified) searches the whole file for the occurrence nearest
      // its target, so it takes no lower bound.
      { mode: step.mode, from: step.mode === "first" ? cursor : step.from, target: step.target, eof: step.eof, strict },
    );
    lines = result.lines;
    if (step.endBreak === "on" && result.atEnd) endsWithBreak = true;
    if (step.endBreak === "off" && result.atEnd) endsWithBreak = false;
    // Cursor moves to just after the lines written.
    cursor = result.pick + step.newLines.length;
  }
  tree.set(dstPath, joinFile({ lines, endsWithBreak, crlf: file.crlf }));
  if (edit.move) tree.remove(srcPath);
}

// JSON str_replace (SPEC section 9): exact substring match, no tiers. In
// a CRLF file the text and both strings are read with every CRLF as LF and
// the result is written back with CRLF. The old string must occur exactly
// once (overlapping positions count).
function applyStrReplace(file: FileModel, oldStr: string, newStr: string, path: string): string {
  const text = file.crlf ? joinFile(file).replace(/\r\n/g, "\n") : joinFile(file);
  const oldNorm = file.crlf ? oldStr.replace(/\r\n/g, "\n") : oldStr;
  const newNorm = file.crlf ? newStr.replace(/\r\n/g, "\n") : newStr;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = text.indexOf(oldNorm, idx);
    if (found === -1) break;
    count++;
    idx = found + 1;
    if (count > 1) break;
  }
  if (count === 0) throw new EditError("no-match", path);
  if (count > 1) throw new EditError("ambiguous", path);
  // Splice, not String.replace: `$&`, `$$`, `` $` ``, `$'` in newStr must be
  // written literally (SPEC section 9), not read as replacement patterns.
  const at = text.indexOf(oldNorm);
  const replaced = text.slice(0, at) + newNorm + text.slice(at + oldNorm.length);
  return file.crlf ? replaced.replace(/\n/g, "\r\n") : replaced;
}

// Replace the lines of `file` that match `oldLines` with `newLines`.
// `contextInOld` / `contextInNew` mark which lines of O / N are context
// lines: a context line in N is written as the file's own matched line
// (the context line of O at the same position in the chunk's context
// order); every other N line is written as the patch wrote it, re-indented
// at tier 2. `mode` picks which occurrence is taken: "first" (the first
// occurrence at or after `from`, at the first tier with one) or "nearest"
// (the occurrence at the first tier with one whose position is nearest to
// `target`, ties to the earlier one). `eof` restricts the match to
// occurrences that end at the file's last line. Returns the new lines and
// whether the matched lines ran to the end of the file (or, for an empty
// O, whether the insertion is at the end); the caller decides the final
// line break from that. Throws EditError("no-match") when there is none.
function applyLineMatch(
  file: FileModel,
  path: string,
  oldLines: string[],
  newLines: string[],
  contextInOld: boolean[],
  contextInNew: boolean[],
  opts: { mode: "first" | "nearest"; from?: number; target?: number; eof?: boolean; unique?: boolean; strict: boolean },
): { lines: string[]; atEnd: boolean; pick: number } {
  const lines = file.lines;
  if (oldLines.length === 0) {
    // Empty old block: insert the new lines after a position.
    let pos: number;
    if (opts.eof) {
      pos = lines.length;
    } else if (opts.mode === "nearest") {
      pos = Math.max(0, Math.min(lines.length, (opts.target ?? 0) + 1));
    } else {
      // A direct position (JSON insert) must be inside the file.
      const from = opts.from ?? 0;
      if (from < 0 || from > lines.length) throw new EditError("no-match", path);
      pos = from;
    }
    const out = [...lines.slice(0, pos), ...newLines, ...lines.slice(pos)];
    return { lines: out, atEnd: pos === lines.length, pick: pos };
  }
  const maxTier = opts.strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const at = occurrencesAt(lines, oldLines, tier).filter((i) => i >= (opts.from ?? 0));
    const usable = opts.eof ? at.filter((i) => i + oldLines.length === lines.length) : at;
    if (usable.length === 0) continue;
    if (opts.unique && usable.length > 1) throw new EditError("ambiguous", path);
    let pick: number;
    if (opts.mode === "first") {
      pick = usable[0];
    } else {
      const target = opts.target ?? 0;
      pick = usable[0];
      for (const i of usable) {
        if (Math.abs(i - target) < Math.abs(pick - target)) pick = i;
      }
    }
    const matched = lines.slice(pick, pick + oldLines.length);
    // The context lines of O, in order; the k-th context line of N takes
    // the file's text of the k-th context line of O.
    const oldCtxIdx: number[] = [];
    oldLines.forEach((_, i) => {
      if (contextInOld[i]) oldCtxIdx.push(i);
    });
    let k = 0;
    let written = newLines.map((nl, i) => {
      if (!contextInNew[i]) return nl;
      return matched[oldCtxIdx[k++]];
    });
    if (tier === 2 && oldLines.length > 0) {
      const f = leadingWs(matched[0]);
      const p = leadingWs(oldLines[0]);
      written = written.map((line, i) => {
        if (contextInNew[i]) return line;
        if (line.length === 0 || line.trim() === "") return line;
        if (!line.startsWith(p)) return line;
        return f + line.slice(p.length);
      });
    }
    const out = [...lines.slice(0, pick), ...written, ...lines.slice(pick + oldLines.length)];
    return { lines: out, atEnd: pick + oldLines.length === lines.length, pick };
  }
  throw new EditError("no-match", path);
}

// ---- Parsers (SPEC sections 6-9) ----
// Each parser turns patch lines into the same list of Edits.

// JSON (section 9)
function parseJsonEdits(lines: string[]): Edit[] {
  const firstNonBlank = lines.findIndex((line) => line.trim() !== "");
  if (firstNonBlank === -1) throw new ParseError(1);
  if (lines[firstNonBlank].trimStart().startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines.join("\n"));
    } catch {
      throw new ParseError(firstNonBlank + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseError(firstNonBlank + 1);
    return parsed.map((item) => jsonEditObject(item, firstNonBlank + 1));
  }
  const edits: Edit[] = [];
  lines.forEach((line, idx) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ParseError(idx + 1);
    }
    edits.push(jsonEditObject(parsed, idx + 1));
  });
  return edits;
}

function jsonEditObject(value: unknown, lineNo: number): Edit {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ParseError(lineNo);
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.path !== "string" || typeof obj.command !== "string") {
    throw new ParseError(lineNo);
  }
  const path = obj.path;
  if (obj.command === "create") {
    if (typeof obj.file_text !== "string") throw new ParseError(lineNo);
    return { kind: "write", path, text: obj.file_text };
  }
  if (obj.command === "str_replace") {
    if (typeof obj.old_str !== "string" || obj.old_str.length === 0) {
      throw new ParseError(lineNo);
    }
    const newStr = obj.new_str === undefined ? "" : obj.new_str;
    if (typeof newStr !== "string") throw new ParseError(lineNo);
    return { kind: "line", path, op: { type: "str-replace", oldStr: obj.old_str, newStr } };
  }
  if (obj.command === "insert") {
    if (typeof obj.insert_line !== "number" || !Number.isInteger(obj.insert_line)) {
      throw new ParseError(lineNo);
    }
    if (typeof obj.new_str !== "string") throw new ParseError(lineNo);
    return {
      kind: "line",
      path,
      op: {
        type: "match",
        oldLines: [],
        newLines: splitPatch(obj.new_str),
        contextInOld: [],
        contextInNew: [],
        mode: "first",
        from: obj.insert_line,
        endBreak: "keep",
      },
    };
  }
  throw new ParseError(lineNo);
}

// ---- Unified diff (section 6) ----

interface UniHunkBody {
  kind: "context" | "minus" | "plus" | "backslash";
  text: string;
  raw: string;
}

interface UniHunk {
  a: number;
  body: UniHunkBody[];
}

interface UniSection {
  oldRaw: string | null;
  newRaw: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  diffA: string | null;
  diffB: string | null;
  hasPair: boolean;
  hunks: UniHunk[];
}

function stripGitPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

// A header path: the text after the 4-character prefix, up to the first
// tab, with surrounding spaces removed.
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf("\t");
  return (tab === -1 ? rest : rest.slice(0, tab)).trim();
}

// Whether a `\` line follows the last body line whose kind is in `kinds`.
function backslashAfter(body: UniHunkBody[], kinds: ("context" | "plus")[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    if (kinds.includes(body[i].kind as "context" | "plus")) {
      return body[i + 1]?.kind === "backslash";
    }
  }
  return false;
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let section: UniSection | null = null;
  let hunk: UniHunk | null = null;
  let state: "outside" | "header" | "body" | "between" = "outside";

  const newSection = (): UniSection => ({
    oldRaw: null,
    newRaw: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    diffA: null,
    diffB: null,
    hasPair: false,
    hunks: [],
  });

  const flushHunk = () => {
    if (hunk && section) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1].raw === "") {
        hunk.body.pop();
      }
      section.hunks.push(hunk);
      hunk = null;
    }
  };
  const flushSection = () => {
    flushHunk();
    if (section) {
      edits.push(...unifiedSectionEdits(section));
      section = null;
    }
    state = "outside";
  };

  const diffGitPaths = (line: string): [string, string] | null => {
    const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
    return m ? [m[1], m[2]] : null;
  };
  const hunkStart = (line: string): number | null => {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    return m ? parseInt(m[1], 10) : null;
  };
  const isPairAt = (i: number): boolean =>
    lines[i].startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (state === "body") {
      // A section start ends the body first.
      if (line.startsWith("diff --git ") || isPairAt(i)) {
        flushHunk();
        state = "between";
      } else if (
        line === "" ||
        line.startsWith(" ") ||
        line.startsWith("-") ||
        line.startsWith("+") ||
        line.startsWith("\\")
      ) {
        if (line === "") hunk!.body.push({ kind: "context", text: "", raw: line });
        else if (line.startsWith(" ")) hunk!.body.push({ kind: "context", text: line.slice(1), raw: line });
        else if (line.startsWith("-")) hunk!.body.push({ kind: "minus", text: line.slice(1), raw: line });
        else if (line.startsWith("+")) hunk!.body.push({ kind: "plus", text: line.slice(1), raw: line });
        else hunk!.body.push({ kind: "backslash", text: line.slice(1), raw: line });
        i++;
        continue;
      } else {
        flushHunk();
        state = "between";
      }
    }
    if (line.startsWith("diff --git ")) {
      const paths = diffGitPaths(line);
      if (!paths) throw new ParseError(i + 1);
      flushSection();
      section = newSection();
      section.diffA = paths[0];
      section.diffB = paths[1];
      state = "header";
      i++;
      continue;
    }
    if (isPairAt(i)) {
      if (state === "header" && section && !section.hasPair) {
        // The pair belongs to this section's header.
        section.oldRaw = headerPath(line);
        section.newRaw = headerPath(lines[i + 1]);
        section.hasPair = true;
        i += 2;
        continue;
      }
      flushSection();
      section = newSection();
      section.oldRaw = headerPath(line);
      section.newRaw = headerPath(lines[i + 1]);
      section.hasPair = true;
      state = "header";
      i += 2;
      continue;
    }
    if (line.startsWith("@@")) {
      const a = hunkStart(line);
      if (a === null) throw new ParseError(i + 1);
      if (!section) throw new ParseError(i + 1);
      flushHunk();
      hunk = { a, body: [] };
      state = "body";
      i++;
      continue;
    }
    if (state === "header" && section) {
      if (line.startsWith("--- ")) {
        throw new ParseError(i + 2);
      }
      if (line.startsWith("+++ ")) {
        section.newRaw = headerPath(line);
        i++;
        continue;
      }
      if (line.startsWith("rename from ")) {
        section.renameFrom = line.slice("rename from ".length).trim();
        i++;
        continue;
      }
      if (line.startsWith("rename to ")) {
        section.renameTo = line.slice("rename to ".length).trim();
        i++;
        continue;
      }
      if (line.startsWith("new file mode ")) {
        section.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith("deleted file mode ")) {
        section.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flushSection();
  return edits;
}

function unifiedSectionEdits(section: UniSection): Edit[] {
  const oldIsDevNull = section.oldRaw === "/dev/null";
  const newIsDevNull = section.newRaw === "/dev/null";
  const oldPath = oldIsDevNull
    ? null
    : section.oldRaw !== null
      ? stripGitPrefix(section.oldRaw)
      : section.renameFrom !== null
        ? section.renameFrom
        : section.diffA;
  const newPath = newIsDevNull
    ? null
    : section.newRaw !== null
      ? stripGitPrefix(section.newRaw)
      : section.renameTo !== null
        ? section.renameTo
        : section.diffB;
  if (oldPath === null && newPath === null) return [];
  const isCreate = section.newFile || oldIsDevNull;
  const isDelete = section.deletedFile || newIsDevNull;
  if (isCreate) {
    if (newPath === null) return [];
    const plusLines: string[] = [];
    for (const hunk of section.hunks) {
      for (const entry of hunk.body) {
        if (entry.kind === "plus") plusLines.push(entry.text);
      }
    }
    let endsWithBreak = true;
    for (let h = section.hunks.length - 1; h >= 0; h--) {
      const body = section.hunks[h].body;
      if (body.some((e) => e.kind === "plus")) {
        endsWithBreak = !backslashAfter(body, ["plus"]);
        break;
      }
    }
    return [{ kind: "line", path: newPath, op: { type: "set", lines: plusLines, endsWithBreak } }];
  }
  if (isDelete) {
    if (oldPath === null) return [];
    return [{ kind: "delete", path: oldPath }];
  }
  // Change or move: the hunks become steps of one sequence, applied in
  // order to the old file's lines. d tracks the running line offset.
  const steps: SeqStep[] = [];
  let d = 0;
  for (const hunk of section.hunks) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    const contextInOld: boolean[] = [];
    const contextInNew: boolean[] = [];
    for (const entry of hunk.body) {
      if (entry.kind === "context") {
        oldLines.push(entry.text);
        newLines.push(entry.text);
        contextInOld.push(true);
        contextInNew.push(true);
      } else if (entry.kind === "minus") {
        oldLines.push(entry.text);
        contextInOld.push(false);
      } else if (entry.kind === "plus") {
        newLines.push(entry.text);
        contextInNew.push(false);
      }
    }
    steps.push({
      type: "match",
      oldLines,
      newLines,
      contextInOld,
      contextInNew,
      mode: "nearest",
      target: hunk.a - 1 + d,
      endBreak: backslashAfter(hunk.body, ["context", "plus"]) ? "off" : "on",
    });
    d += newLines.length - oldLines.length;
  }
  if (oldPath !== null && newPath !== null && oldPath !== newPath) {
    return [{ kind: "line", path: newPath, op: { type: "seq", steps }, move: { from: oldPath, to: newPath } }];
  }
  const path = oldPath ?? newPath;
  if (path === null) return [];
  return [{ kind: "line", path, op: { type: "seq", steps } }];
}

// ---- SEARCH/REPLACE (section 7) ----

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let lastEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== "<<<<<<< SEARCH") {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= lastEnd; j--) {
      const cand = lines[j];
      if (cand.trim() === "") continue;
      if (cand.trim().startsWith("```")) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseError(searchLine);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === "=======") {
        eq = j;
        break;
      }
      if (lines[j].trimEnd() === ">>>>>>> REPLACE") break;
    }
    if (eq === -1) throw new ParseError(searchLine);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === ">>>>>>> REPLACE") {
        end = j;
        break;
      }
    }
    if (end === -1) throw new ParseError(searchLine);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    if (oldLines.length === 0) {
      edits.push({ kind: "line", path, op: { type: "set", lines: newLines, endsWithBreak: true } });
    } else {
      edits.push({
        kind: "line",
        path,
        op: {
          type: "match",
          oldLines,
          newLines,
          contextInOld: oldLines.map(() => false),
          contextInNew: newLines.map(() => false),
          mode: "first",
          unique: true,
          endBreak: "keep",
        },
      });
    }
    prevPath = path;
    lastEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---- V4A (section 8) ----

function parseV4a(lines: string[]): Edit[] {
  const firstNonBlank = lines.findIndex((l) => l.trim() !== "");
  if (firstNonBlank === -1) throw new ParseError(1);
  if (lines[firstNonBlank].trim() !== "*** Begin Patch") {
    throw new ParseError(firstNonBlank + 1);
  }
  let lastNonBlank = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k].trim() !== "") {
      lastNonBlank = k;
      break;
    }
  }
  if (lines[lastNonBlank].trim() !== "*** End Patch") {
    throw new ParseError(lines.length + 1);
  }
  const isSectionStart = (l: string): boolean =>
    l.startsWith("*** Add File: ") || l.startsWith("*** Delete File: ") || l.startsWith("*** Update File: ");
  const edits: Edit[] = [];
  let i = firstNonBlank + 1;
  const end = lastNonBlank;
  while (i < end) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      // Collect the section's raw lines; a bare "+" line is a file line
      // (empty), while a blank patch line is not a file line at all — the
      // two must not be confused when trailing blank lines are dropped.
      const rawLines: string[] = [];
      i++;
      while (i < end && !isSectionStart(lines[i])) {
        const l = lines[i];
        if (l.startsWith("+") || l === "") rawLines.push(l);
        else throw new ParseError(i + 1);
        i++;
      }
      while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === "") {
        rawLines.pop();
      }
      const fileLines = rawLines.map((l) => (l.startsWith("+") ? l.slice(1) : ""));
      edits.push({ kind: "line", path, op: { type: "set", lines: fileLines, endsWithBreak: true } });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      const path = line.slice("*** Delete File: ".length).trim();
      edits.push({ kind: "delete", path });
      i++;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      const updateLineNo = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < end && lines[i].startsWith("*** Move to: ")) {
        moveTo = lines[i].slice("*** Move to: ".length).trim();
        i++;
      }
      const sectionLines: { text: string; lineNo: number }[] = [];
      while (i < end && !isSectionStart(lines[i])) {
        sectionLines.push({ text: lines[i], lineNo: i + 1 });
        i++;
      }
      while (sectionLines.length > 0 && sectionLines[sectionLines.length - 1].text.trim() === "") {
        sectionLines.pop();
      }
      const steps = parseV4aChunks(sectionLines);
      if (steps.length === 0 && moveTo === null) {
        throw new ParseError(updateLineNo);
      }
      const edit: Edit =
        moveTo !== null
          ? { kind: "line", path, op: { type: "seq", steps }, move: { from: path, to: moveTo } }
          : { kind: "line", path, op: { type: "seq", steps } };
      edits.push(edit);
      continue;
    }
    throw new ParseError(i + 1);
  }
  return edits;
}

// Split an Update File section's lines into chunks at @@ lines and
// *** End of File lines, and turn each chunk into anchor/match steps.
function parseV4aChunks(sectionLines: { text: string; lineNo: number }[]): SeqStep[] {
  const steps: SeqStep[] = [];
  let anchor: string | null = null;
  let eof = false;
  let body: { text: string; lineNo: number }[] = [];
  let started = false;
  const finishChunk = () => {
    if (!started) return;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    const contextInOld: boolean[] = [];
    const contextInNew: boolean[] = [];
    for (const { text } of body) {
      if (text === "" || text.startsWith(" ")) {
        const t = text === "" ? "" : text.slice(1);
        oldLines.push(t);
        newLines.push(t);
        contextInOld.push(true);
        contextInNew.push(true);
      } else if (text.startsWith("-")) {
        oldLines.push(text.slice(1));
        contextInOld.push(false);
      } else if (text.startsWith("+")) {
        newLines.push(text.slice(1));
        contextInNew.push(false);
      }
    }
    if (anchor !== null && anchor !== "") {
      steps.push({ type: "anchor", line: anchor });
    }
    steps.push({
      type: "match",
      oldLines,
      newLines,
      contextInOld,
      contextInNew,
      mode: "first",
      eof,
      endBreak: "keep",
    });
    anchor = null;
    eof = false;
    body = [];
    started = false;
  };
  for (const { text, lineNo } of sectionLines) {
    if (text.startsWith("@@")) {
      finishChunk();
      anchor = text.slice(2).trim();
      started = true;
      continue;
    }
    if (text.trim() === "*** End of File") {
      if (!started) throw new ParseError(lineNo);
      eof = true;
      finishChunk();
      continue;
    }
    if (text === "" || text.startsWith(" ") || text.startsWith("-") || text.startsWith("+")) {
      started = true;
      body.push({ text, lineNo });
      continue;
    }
    throw new ParseError(lineNo);
  }
  finishChunk();
  return steps;
}

// ---- Format detection (section 4) ----

function detectFormat(lines: string[]): Format | null {
  const firstNonBlank = lines.find((line) => line.trim() !== "");
  if (firstNonBlank === undefined) return null;
  if (firstNonBlank.trim() === "*** Begin Patch") return "v4a";
  const firstChar = firstNonBlank.trimStart()[0];
  if (firstChar === "[" || firstChar === "{") return "json";
  for (const line of lines) {
    if (line.trimEnd() === "<<<<<<< SEARCH") return "search-replace";
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("diff --git ")) return "unified";
    if (lines[i].startsWith("--- ") && i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
      return "unified";
    }
  }
  return null;
}

// ---- Reading the patch and running (sections 1-2, 10) ----

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function readPatch(patchArg: string | null): Promise<string> {
  if (patchArg === null || patchArg === "-") {
    return await new Promise<string>((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        data += chunk;
      });
      process.stdin.on("end", () => resolve(data));
    });
  }
  try {
    return await readFile(patchArg, "utf8");
  } catch {
    return "";
  }
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function fail(code: number, text: string): { code: number; stdout: string } {
  return { code, stdout: text + "\n" };
}

interface CliOptions {
  format: Format | null;
  check: boolean;
  strict: boolean;
  patchArg: string | null;
  error: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const out: CliOptions = { format: null, check: false, strict: false, patchArg: null, error: false };
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let noMoreOptions = false;
  for (const arg of args) {
    if (!noMoreOptions && arg === "--") {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && arg.startsWith("-") && arg !== "-") {
      if (arg === "--check") {
        if (seenCheck) {
          out.error = true;
          return out;
        }
        seenCheck = true;
        out.check = true;
      } else if (arg === "--strict") {
        if (seenStrict) {
          out.error = true;
          return out;
        }
        seenStrict = true;
        out.strict = true;
      } else if (arg.startsWith("--format=")) {
        if (seenFormat) {
          out.error = true;
          return out;
        }
        seenFormat = true;
        const value = arg.slice("--format=".length);
        if (
          value !== "unified" &&
          value !== "search-replace" &&
          value !== "v4a" &&
          value !== "json" &&
          value !== "auto"
        ) {
          out.error = true;
          return out;
        }
        out.format = value === "auto" ? null : (value as Format);
      } else {
        out.error = true;
        return out;
      }
    } else {
      if (out.patchArg !== null) {
        out.error = true;
        return out;
      }
      out.patchArg = arg;
    }
  }
  return out;
}

async function run(): Promise<{ code: number; stdout: string }> {
  const { format, check, strict, patchArg, error } = parseArgs(process.argv.slice(2));
  if (error) return fail(2, "error: usage");
  const patchExists = patchArg === null || patchArg === "-" ? true : await exists(patchArg);
  if (!patchExists) return fail(2, "error: no-patch");
  const patchText = await readPatch(patchArg);
  const lines = splitPatch(patchText);
  const chosen = format ?? detectFormat(lines);
  if (chosen === null) return fail(2, "error: format");
  let edits: Edit[];
  try {
    edits =
      chosen === "unified"
        ? parseUnified(lines)
        : chosen === "search-replace"
          ? parseSearchReplace(lines)
          : chosen === "v4a"
            ? parseV4a(lines)
            : parseJsonEdits(lines);
  } catch (err) {
    if (err instanceof ParseError) return fail(2, `error: parse ${err.line}`);
    throw err;
  }
  if (edits.length === 0) return fail(2, "error: parse 1");
  const { files, dirs } = await readTree(process.cwd());
  const tree = new Tree(files, dirs);
  const fails: string[] = [];
  for (const edit of edits) {
    try {
      applyEdit(tree, edit, strict);
    } catch (err) {
      if (err instanceof EditError) {
        fails.push(`error: ${err.code} ${err.path}`);
        continue;
      }
      throw err;
    }
  }
  if (fails.length > 0) {
    return fail(1, [...fails, `failed: ${fails.length} of ${edits.length} edits`].join("\n"));
  }
  // One line per changed path, in byte order. A genuine move (the old path
  // existed before and is gone after, the new path did not exist before
  // and exists after) is one R line sorted by the new path.
  const moves = new Map<string, string>();
  for (const edit of edits) {
    if (edit.kind === "line" && edit.move) moves.set(edit.move.from, edit.move.to);
  }
  const rows: { key: string; text: string }[] = [];
  const covered = new Set<string>();
  for (const [from, to] of moves) {
    if (
      tree.before.get(from) !== undefined &&
      tree.now.get(from) === undefined &&
      tree.before.get(to) === undefined &&
      tree.now.get(to) !== undefined
    ) {
      rows.push({ key: to, text: `R ${from} -> ${to}` });
      covered.add(from);
      covered.add(to);
    }
  }
  for (const path of new Set([...tree.before.keys(), ...tree.now.keys()])) {
    if (covered.has(path)) continue;
    const b = tree.before.get(path);
    const a = tree.now.get(path);
    if (b === a) continue;
    if (b === undefined) rows.push({ key: path, text: `A ${path}` });
    else if (a === undefined) rows.push({ key: path, text: `D ${path}` });
    else rows.push({ key: path, text: `M ${path}` });
  }
  rows.sort((x, y) => byteCompare(x.key, y.key));
  const count = rows.length;
  const summary = `ok: ${count} ${count === 1 ? "file" : "files"}`;
  const stdout = [...rows.map((r) => r.text), summary].join("\n") + "\n";
  if (!check) {
    try {
      await writeTree(process.cwd(), tree.before, tree.now);
    } catch (err) {
      if (err instanceof WriteError) {
        return fail(1, `error: write ${err.path}\nfailed: 1 of ${edits.length} edits`);
      }
      throw err;
    }
  }
  return { code: 0, stdout };
}

async function main(): Promise<number> {
  const { code, stdout } = await run();
  process.stdout.write(stdout);
  return code;
}

// ---- Handover ----
// Everything below this line must stay exactly as it is.
// When MAKEFUN_ENV_URL is set, the harness drives the trial; otherwise
// the CLI runs normally.
const envUrl = process.env["MAKEFUN_ENV_URL"];
if (envUrl) {
  const { runTrial } = await import("./runner.ts");
  await runTrial(envUrl);
} else {
  const code = await main();
  process.exit(code);
}
