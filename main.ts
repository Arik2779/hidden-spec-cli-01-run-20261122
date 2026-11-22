// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; new: string }> = [];
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
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /** Record a move edit: the old path is deleted, the new path holds the content. */
  move(oldP: string, newP: string, content: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, content);
    this.moves.push({ old: oldP, new: newP });
  }
}

type Edit = (tree: Tree) => void;

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

/** A file's text as lines: its line break, its lines, and whether it ends with a break. */
interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** SPEC.md section 5: one line normalised at a tier. */
function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Positions i where O's lines match the file's lines i, i+1, ... at the tier (plain window). */
function occurrences(O: string[], F: string[], tier: number): number[] {
  const res: number[] = [];
  const nO = O.map((l) => normLine(l, tier));
  for (let i = 0; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(F[i + j]!, tier) !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier at which O occurs at least once, or -1. */
function firstTier(O: string[], F: string[], strict: boolean): number {
  for (const t of tiers(strict)) {
    if (occurrences(O, F, t).length > 0) return t;
  }
  return -1;
}

/** One line of N: `o` is its index in O when it is a context line, else null. */
interface NLine {
  text: string;
  o: number | null;
}

/** The leading spaces and tabs of a line. */
function leadWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/**
 * Write N over the matched lines: a context line is the file's own matched line, never the patch's.
 * At tier 2 every other line of N is re-indented (SPEC.md section 5).
 */
function mapN(N: NLine[], F: string[], at: number, O: string[], tier: number): string[] {
  const out: string[] = [];
  const f0 = F.length > at ? leadWs(F[at]!) : '';
  const p0 = O.length > 0 ? leadWs(O[0]!) : '';
  for (const n of N) {
    if (n.o !== null) {
      out.push(F[at + n.o]!);
      continue;
    }
    const t = n.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p0)) out.push(f0 + t.slice(p0.length));
    else out.push(t);
  }
  return out;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
      if (tree.get(p) !== null) throw new Fail('exists', p);
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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/* SPEC.md section 6: unified diffs. */

interface UniHunk {
  a: number;
  body: string[];
}

interface UniSection {
  gitOld: string | undefined;
  gitNew: string | undefined;
  oldDash: string | null | undefined;
  newDash: string | null | undefined;
  oldRename: string | undefined;
  newRename: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UniHunk[];
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed. */
function dashPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function isBodyLine(line: string): boolean {
  return line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\';
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/;
const DIFF_GIT = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoBreak(body: string[]): boolean {
  for (let j = body.length - 1; j >= 0; j--) {
    const l = body[j]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') {
      return j + 1 < body.length && body[j + 1]![0] === '\\';
    }
  }
  return false;
}

/** A hunk body as context/old/new items, keeping each new line's index in O when it is context. */
function hunkItems(body: string[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const l of body) {
    if (l === '' || l[0] === ' ') {
      O.push(l.slice(1));
      N.push({ text: l.slice(1), o: O.length - 1 });
    } else if (l[0] === '-') {
      O.push(l.slice(1));
    } else if (l[0] === '+') {
      N.push({ text: l.slice(1), o: null });
    }
  }
  return { O, N };
}

/** Apply one section's hunks, in order, to a file's text. */
function applyHunks(hunks: UniHunk[], text: string, strict: boolean, path: string): string {
  const f = splitFile(text);
  const lines = f.lines;
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = hunkItems(h.body);
    const noBreak = hunkNoBreak(h.body);
    if (O.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...N.map((n) => n.text));
      if (atEnd && N.length > 0) final = !noBreak;
      d += N.length;
      continue;
    }
    const tier = firstTier(O, lines, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occ = occurrences(O, lines, tier);
    const target = h.a - 1 + d;
    let at = occ[0]!;
    let best = Math.abs(at - target);
    for (const o of occ) {
      const dist = Math.abs(o - target);
      if (dist < best) {
        at = o;
        best = dist;
      }
    }
    const runsToEnd = at + O.length === lines.length;
    lines.splice(at, O.length, ...mapN(N, lines, at, O, tier));
    if (runsToEnd) final = !noBreak;
    d += N.length - O.length;
  }
  return joinFile(lines, f.br, final);
}

function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  const oldPath = sec.oldDash !== undefined ? sec.oldDash : sec.oldRename !== undefined ? sec.oldRename : sec.gitOld;
  const newPath = sec.newDash !== undefined ? sec.newDash : sec.newRename !== undefined ? sec.newRename : sec.gitNew;
  const oldP = oldPath === undefined ? '' : oldPath;
  const newP = newPath === undefined ? '' : newPath;
  const isCreate = oldPath === null || sec.isCreate;
  const isDelete = !isCreate && (newPath === null || sec.isDelete);
  const isMove = !isCreate && !isDelete && oldP !== newP;
  return (tree) => {
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noBreak = false;
      let lastH = -1;
      let lastB = -1;
      for (let hi = 0; hi < sec.hunks.length; hi++) {
        const body = sec.hunks[hi]!.body;
        for (let bi = 0; bi < body.length; bi++) {
          if (body[bi]![0] === '+') {
            plus.push(body[bi]!.slice(1));
            lastH = hi;
            lastB = bi;
          }
        }
      }
      if (lastH >= 0) {
        const body = sec.hunks[lastH]!.body;
        noBreak = lastB + 1 < body.length && body[lastB + 1]![0] === '\\';
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (isMove) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.move(oldP, newP, applyHunks(sec.hunks, before, strict, oldP));
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(sec.hunks, before, strict, oldP));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let sec: UniSection | null = null;
  let hunk: UniHunk | null = null;
  let inHeader = false;
  const flushHunk = (): void => {
    if (hunk !== null && sec !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      sec.hunks.push(hunk);
    }
    hunk = null;
  };
  const flushSection = (): void => {
    if (sec !== null) edits.push(unifiedSectionEdit(sec, strict));
    sec = null;
    inHeader = false;
  };
  const newSection = (gitOld?: string, gitNew?: string): UniSection => ({
    gitOld,
    gitNew,
    oldDash: undefined,
    newDash: undefined,
    oldRename: undefined,
    newRename: undefined,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git ')) {
        flushHunk();
        flushSection();
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        flushHunk();
        flushSection();
      } else if (isBodyLine(line)) {
        hunk.body.push(line);
        continue;
      } else {
        flushHunk();
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      flushSection();
      sec = newSection(m[1], m[2]);
      inHeader = true;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null || sec === null) throw new Exit2(`error: parse ${i + 1}`);
      flushHunk();
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      inHeader = false;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec !== null && inHeader && sec.oldDash === undefined && sec.newDash === undefined) {
        sec.oldDash = dashPath(line);
        sec.newDash = dashPath(lines[i + 1]!);
        i++;
        continue;
      }
      flushSection();
      sec = newSection();
      sec.oldDash = dashPath(line);
      sec.newDash = dashPath(lines[i + 1]!);
      i++;
      inHeader = true;
      continue;
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) sec.oldRename = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.newRename = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.isCreate = true;
      else if (line.startsWith('deleted file mode')) sec.isDelete = true;
      continue;
    }
  }
  flushHunk();
  flushSection();
  return edits;
}

/* SPEC.md section 7: SEARCH/REPLACE blocks. */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const lines = f.lines;
    const tier = firstTier(oldLines, lines, strict);
    if (tier < 0) throw new Fail('no-match', path);
    const occ = occurrences(oldLines, lines, tier);
    if (occ.length > 1) throw new Fail('ambiguous', path);
    const at = occ[0]!;
    const N: NLine[] = newLines.map((t) => ({ text: t, o: null }));
    lines.splice(at, oldLines.length, ...mapN(N, lines, at, oldLines, tier));
    tree.now.set(path, joinFile(lines, f.br, f.final));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

/* SPEC.md section 8: V4A patches. */

interface VChunk {
  anchor: string | null;
  items: Array<{ kind: 'ctx' | 'old' | 'new'; text: string }>;
  eof: boolean;
}

type AlignStep =
  | { type: 'match'; o: number; f: number }
  | { type: 'skipO'; o: number }
  | { type: 'skipF'; f: number };

/**
 * Align O against the file's lines from `start` at the tier: a line matches when it is equal at the
 * tier; an empty line of O (at the tier) that faces a non-empty file line is dropped, and an empty
 * file line that faces a non-empty line of O is left in place. Returns the steps and the index just
 * past the last file line the alignment touched, or null when O cannot be placed there.
 */
function align(O: string[], F: string[], start: number, tier: number): { end: number; steps: AlignStep[] } | null {
  const steps: AlignStep[] = [];
  let i = 0;
  let j = start;
  while (i < O.length) {
    if (j >= F.length) {
      if (normLine(O[i]!, tier) === '') {
        steps.push({ type: 'skipO', o: i });
        i++;
        continue;
      }
      return null;
    }
    const o = O[i]!;
    const f = F[j]!;
    if (normLine(o, tier) === normLine(f, tier)) {
      steps.push({ type: 'match', o: i, f: j });
      i++;
      j++;
    } else if (normLine(o, tier) === '') {
      steps.push({ type: 'skipO', o: i });
      i++;
    } else if (normLine(f, tier) === '') {
      steps.push({ type: 'skipF', f: j });
      j++;
    } else {
      return null;
    }
  }
  return { end: j, steps };
}

function v4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const f = splitFile(before);
    let lines = f.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let found = -1;
        for (const t of tiers(strict)) {
          for (let j = cursor; j < lines.length; j++) {
            if (normLine(lines[j]!, t) === normLine(chunk.anchor, t)) {
              found = j;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const O: string[] = [];
      const N: NLine[] = [];
      for (const it of chunk.items) {
        if (it.kind === 'ctx') {
          O.push(it.text);
          N.push({ text: it.text, o: O.length - 1 });
        } else if (it.kind === 'old') {
          O.push(it.text);
        } else {
          N.push({ text: it.text, o: null });
        }
      }
      if (O.length === 0) {
        const pos = chunk.eof ? lines.length : cursor;
        const ins = N.map((n) => n.text);
        lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
        continue;
      }
      let placed: { start: number; end: number; steps: AlignStep[]; tier: number } | null = null;
      for (const t of tiers(strict)) {
        for (let s = cursor; s <= lines.length; s++) {
          const al = align(O, lines, s, t);
          if (al === null) continue;
          if (chunk.eof) {
            let lastConsumed = s - 1;
            for (const st of al.steps) if (st.type === 'match' && st.f > lastConsumed) lastConsumed = st.f;
            if (lastConsumed !== lines.length - 1) continue;
          }
          placed = { start: s, end: al.end, steps: al.steps, tier: t };
          break;
        }
        if (placed !== null) break;
      }
      if (placed === null) throw new Fail('no-match', path);
      // Build the replacement span: body items in order, context lines as the file's own lines,
      // empty file lines the alignment skipped kept in place after the previous matched line.
      const stepOfO = new Map<number, AlignStep>();
      const skipAfter = new Map<number, number[]>();
      const skipBeforeFirst: number[] = [];
      let lastMatchO = -1;
      for (const st of placed.steps) {
        if (st.type === 'match') {
          stepOfO.set(st.o, st);
          lastMatchO = st.o;
        } else if (st.type === 'skipO') {
          stepOfO.set(st.o, st);
        } else if (lastMatchO < 0) {
          skipBeforeFirst.push(st.f);
        } else {
          const arr = skipAfter.get(lastMatchO) ?? [];
          arr.push(st.f);
          skipAfter.set(lastMatchO, arr);
        }
      }
      const span: string[] = [...skipBeforeFirst.map((fi) => lines[fi]!)];
      const firstMatch = placed.steps.find((st) => st.type === 'match');
      const f0 = firstMatch !== undefined ? leadWs(lines[firstMatch.f]!) : '';
      const p0 = O.length > 0 ? leadWs(O[0]!) : '';
      for (const n of N) {
        if (n.o !== null) {
          const st = stepOfO.get(n.o);
          if (st === undefined || st.type === 'skipO') continue;
          span.push(lines[st.f]!);
          for (const fi of skipAfter.get(n.o) ?? []) span.push(lines[fi]!);
        } else {
          const t = n.text;
          if (placed.tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p0)) span.push(f0 + t.slice(p0.length));
          else span.push(t);
        }
      }
      lines = [...lines.slice(0, placed.start), ...span, ...lines.slice(placed.end)];
      cursor = placed.start + span.length;
    }
    const out = joinFile(lines, f.br, f.final);
    if (moveTo !== null) tree.move(path, moveTo, out);
    else tree.now.set(path, out);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const isAdd = line.startsWith('*** Add File: ');
      const isDelete = line.startsWith('*** Delete File: ');
      const prefix = isAdd ? '*** Add File: ' : isDelete ? '*** Delete File: ' : '*** Update File: ';
      const path = line.slice(prefix.length).trim();
      const hi = i;
      let j = i + 1;
      let end = j;
      while (end < last && !v4aSectionStart(lines[end]!)) end++;
      let e = end;
      while (e > j && blank(lines[e - 1]!)) e--;
      if (isAdd) {
        const fileLines: string[] = [];
        for (let k = j; k < e; k++) {
          const l = lines[k]!;
          if (l.startsWith('+')) fileLines.push(l.slice(1));
          else if (l === '') fileLines.push('');
          else throw new Exit2(`error: parse ${k + 1}`);
        }
        edits.push(v4aAddEdit(path, fileLines));
      } else if (isDelete) {
        for (let k = j; k < e; k++) throw new Exit2(`error: parse ${k + 1}`);
        edits.push(v4aDeleteEdit(path));
      } else {
        let k = j;
        let moveTo: string | null = null;
        if (k < e && lines[k]!.startsWith('*** Move to: ')) {
          moveTo = lines[k]!.slice('*** Move to: '.length).trim();
          k++;
        }
        const chunks: VChunk[] = [];
        let cur: VChunk | null = null;
        let started = false;
        for (; k < e; k++) {
          const l = lines[k]!;
          if (l.startsWith('@@')) {
            if (cur !== null) chunks.push(cur);
            const anchor = l.slice(2).trim();
            cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
            started = true;
          } else if (l === '*** End of File') {
            if (cur === null) throw new Exit2(`error: parse ${k + 1}`);
            cur.eof = true;
            chunks.push(cur);
            cur = null;
          } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
            if (cur === null) {
              if (started) throw new Exit2(`error: parse ${k + 1}`);
              cur = { anchor: null, items: [], eof: false };
              started = true;
            }
            const kind = l === '' || l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new';
            cur.items.push({ kind, text: l === '' ? '' : l.slice(1) });
          } else {
            throw new Exit2(`error: parse ${k + 1}`);
          }
        }
        if (cur !== null) chunks.push(cur);
        if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${hi + 1}`);
        edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      }
      i = end;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const used = new Set<string>();
  for (const m of tree.moves) {
    const oldWas = tree.original(m.old);
    const newWas = tree.original(m.new);
    const oldNow = tree.get(m.old);
    const newNow = tree.get(m.new);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      used.add(m.old);
      used.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
