import {
  App,
  Plugin,
  TFile,
  MarkdownView,
  AbstractInputSuggest,
  MarkdownPostProcessorContext,
  PluginSettingTab,
  Setting
} from "obsidian";

/* =======================================================
 * Utilities: tag collection, matchers, debounce
 * ======================================================= */
function collectAllTags(app: App): string[] {
  const set = new Set<string>();
  for (const f of app.vault.getMarkdownFiles()) {
    const c = app.metadataCache.getFileCache(f);
    // frontmatter tags
    const fmTags = (c?.frontmatter?.tags ? ([] as any[]).concat(c.frontmatter.tags) : []) as any[];
    fmTags.forEach(t => set.add(String(t).replace(/^#/, "")));
    // inline #tags
    c?.tags?.forEach(t => t.tag && set.add(String(t.tag).replace(/^#/, "")));
  }
  return Array.from(set).sort();
}

function prefixMatch(all: string[], prefix: string, limit = 60): string[] {
  const p = prefix.replace(/^#/, "").toLowerCase();
  if (!p) return [];
  return all.filter(t => t.toLowerCase().startsWith(p)).slice(0, limit);
}

function suffixMatch(all: string[], suffix: string, limit = 60): string[] {
  const s = suffix.replace(/^#/, "").toLowerCase();
  if (!s) return [];
  return all.filter(t => t.toLowerCase().endsWith(s)).slice(0, limit);
}

function substringMatch(all: string[], part: string, limit = 60): string[] {
  const s = part.replace(/^#/, "").toLowerCase();
  if (!s) return [];
  return all.filter(t => t.toLowerCase().includes(s)).slice(0, limit);
}

function debounce<T extends (...args: any[]) => void>(fn: T, ms = 200) {
  let id: number | null = null;
  return (...args: Parameters<T>) => {
    if (id) window.clearTimeout(id);
    id = window.setTimeout(() => fn(...args), ms);
  };
}

// Debounce that follows the current setting value
function debounceDynamic<T extends (...args: any[]) => void>(fn: T, getMs: () => number) {
  let id: number | null = null;
  return (...args: Parameters<T>) => {
    if (id) window.clearTimeout(id);
    const ms = Math.max(0, Number(getMs()) || 0);
    id = window.setTimeout(() => fn(...args), ms);
  };
}

// Encode/decode state (safe via URL-encoding)
function encodeState(s: string): string {
  try { return encodeURIComponent(s); } catch { return s; }
}
function decodeState(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function extractSavedState(text: string): { input: string; caret: number } | null {
  const info = findBaseBlock(text);
  if (!info) return null;
  const segment = text.slice(info.filtersStart, info.filtersEnd);
  const mInput = segment.match(/^#\s*INPUT:[ \t]*(.*)$/m);
  const mCaret = segment.match(/^#\s*CARET:\s*(\d+)$/m);
  if (!mInput && !mCaret) return null;
  const input = mInput ? decodeState(mInput[1]) : "";
  const caret = mCaret ? parseInt(mCaret[1], 10) : input.length;
  return { input, caret: isNaN(caret) ? input.length : caret };
}

/* =======================================================
 * Base embedded block management
 * ======================================================= */
const FENCE_START = "```base";
const BEGIN_MARK = "# BEGIN FILTERS (managed by obsidian-base-live-filter-plugin)";
const END_MARK = "# END FILTERS";
const MIN_FILTER_TEXT_LENGTH = 200;
const DEFAULT_FILTER_TEXT_LENGTH = 2000;
const MAX_FILTER_TEXT_LENGTH = 10000;
const DEFAULT_MIN_TAG_EXPANSION_TERM_LENGTH = 2;

type BaseBlockInfo = { start: number; end: number; filtersStart: number; filtersEnd: number };

function findBaseBlock(text: string): BaseBlockInfo | null {
  const fenceIdx = text.indexOf(FENCE_START);
  if (fenceIdx < 0) return null;
  const fenceEnd = text.indexOf("\n```", fenceIdx + FENCE_START.length);
  if (fenceEnd < 0) return null;
  const beginIdx = text.indexOf(BEGIN_MARK, fenceIdx);
  const endIdx = text.indexOf(END_MARK, fenceIdx);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) return null;
  return { start: fenceIdx, end: fenceEnd + 4, filtersStart: beginIdx, filtersEnd: endIdx + END_MARK.length };
}

// Remove the first top-level `filters:` block from a Base block's inner content
function stripTopLevelFilters(blockContent: string): string {
  const lines = blockContent.split("\n");
  // Find a line that starts at column 0 with `filters:`
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^filters\s*:/.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return blockContent;
  // Consume subsequent indented lines (YAML block)
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    // Stop at next top-level line (no leading space) or end
    if (!/^\s+/.test(l) && l.trim().length > 0) break;
    end++;
  }
  const cleaned = [...lines.slice(0, start), ...lines.slice(end)].join("\n");
  return cleaned;
}

async function findOrInsertBaseBlock(app: App, file: TFile): Promise<BaseBlockInfo | null> {
  // Avoid editor dependency; always work from the file contents
  let text = await app.vault.read(file);
  // 1) If there's already a managed filters section inside a Base block, use it
  let info = findBaseBlock(text);
  if (info) return info;

  // 2) If there is an existing Base block (without our markers), insert our managed
  //    filter section at the top of that block and preserve the rest as-is.
  const fenceIdx = text.indexOf(FENCE_START);
  if (fenceIdx >= 0) {
    const closeFenceIdx = text.indexOf("\n```", fenceIdx + FENCE_START.length);
    if (closeFenceIdx >= 0) {
      // Find the start of the block content (the first newline after ```base)
      const firstNlAfterOpen = text.indexOf("\n", fenceIdx);
      const contentStart = firstNlAfterOpen >= 0 ? firstNlAfterOpen + 1 : (fenceIdx + FENCE_START.length);
      const blockInner = text.slice(contentStart, closeFenceIdx);
      const cleanedInner = stripTopLevelFilters(blockInner);
      // Build our managed section to inject at the top of the Base block
      const managed = [
        BEGIN_MARK,
        "filters:",
        END_MARK,
        "# ---- Manual edits below are OK (column definitions, view settings, etc.) ----",
        ""
      ].join("\n");
      const newText = text.slice(0, contentStart) + managed + cleanedInner + text.slice(closeFenceIdx);
      await app.vault.modify(file, newText);
      text = newText;
      info = findBaseBlock(text);
      return info ?? null;
    }
  }

  // 3) No Base block exists in the note: append a new one at the end
  const template = [
    "",
    "```base",
    BEGIN_MARK,
    "filters:",
    END_MARK,
    "# ---- Manual edits below are OK (column definitions, view settings, etc.) ----",
    "```",
    ""
  ].join("\n");

  const newText = text + (text.endsWith("\n") ? "" : "\n") + template;
  await app.vault.modify(file, newText);
  text = newText;
  info = findBaseBlock(text);
  return info ?? null;
}

async function replaceFiltersInBaseBlock(app: App, file: TFile, info: BaseBlockInfo, newFilters: string) {
  // Always read latest file contents, replace as text, then save
  const text = await app.vault.read(file);
  const latest = findBaseBlock(text);
  const target = latest ?? info;
  const before = text.slice(0, target.filtersStart);
  const after = text.slice(target.filtersEnd);
  const replacement = `${BEGIN_MARK}\n${newFilters}\n${END_MARK}`;
  const newText = before + replacement + after;
  await app.vault.modify(file, newText);
}

/* =======================================================
 * Generate Base filters
 * ======================================================= */
function escapeFormulaString(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function yamlSingleQuote(s: string) {
  return `'${s.replace(/'/g, "''")}'`;
}

type FilterBuildResult =
  | { ok: true; filters: string }
  | { ok: false; reason: string };

type MatchSettings = {
  enablePrefix: boolean;
  enableSuffix: boolean;
  enableSubstring: boolean;
  refreshDelayMs: number;
  maxFilterTextLength: number;
  minTagExpansionTermLength: number;
};

type QueryToken =
  | { type: "term"; value: string; explicitHash: boolean }
  | { type: "or" | "minus" | "lparen" | "rparen" };

type QueryNode =
  | { type: "term"; value: string; explicitHash: boolean }
  | { type: "and"; children: QueryNode[] }
  | { type: "or"; children: QueryNode[] }
  | { type: "not"; child: QueryNode };

function tokenizeTagQuery(input: string): QueryToken[] | null {
  const tokens: QueryToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }
    if (ch === "|") {
      const prev = i === 0 ? "" : input[i - 1];
      const next = i + 1 >= input.length ? "" : input[i + 1];
      const prevBoundary = i === 0 || /\s/.test(prev) || prev === "(" || prev === ")";
      const nextBoundary = i + 1 >= input.length || /\s/.test(next) || next === "(" || next === ")";
      if (!prevBoundary || !nextBoundary) return null;
      tokens.push({ type: "or" });
      i++;
      continue;
    }
    if (ch === "-") {
      tokens.push({ type: "minus" });
      i++;
      continue;
    }

    let end = i;
    while (end < input.length && !/\s/.test(input[end]) && input[end] !== "(" && input[end] !== ")") {
      end++;
    }
    const raw = input.slice(i, end);
    const explicitHash = raw.startsWith("#");
    const value = explicitHash ? raw.slice(1) : raw;
    if (!value.trim()) return null;
    tokens.push({ type: "term", value, explicitHash });
    i = end;
  }
  return tokens;
}

class TagQueryParser {
  private tokens: QueryToken[];
  private pos = 0;

  constructor(tokens: QueryToken[]) {
    this.tokens = tokens;
  }

  parse(): QueryNode | null {
    const node = this.parseOr();
    if (!node || this.peek()) return null;
    return node;
  }

  private parseOr(): QueryNode | null {
    const children: QueryNode[] = [];
    const first = this.parseAnd();
    if (!first) return null;
    children.push(first);

    while (this.match("or")) {
      const next = this.parseAnd();
      if (!next) return null;
      children.push(next);
    }

    return children.length === 1 ? children[0] : { type: "or", children };
  }

  private parseAnd(): QueryNode | null {
    const children: QueryNode[] = [];
    const first = this.parseUnary();
    if (!first) return null;
    children.push(first);

    while (true) {
      const next = this.peek();
      if (!next || next.type === "or" || next.type === "rparen") break;
      if (this.startsUnary(next)) {
        const implicit = this.parseUnary();
        if (!implicit) return null;
        children.push(implicit);
        continue;
      }
      return null;
    }

    return children.length === 1 ? children[0] : { type: "and", children };
  }

  private parseUnary(): QueryNode | null {
    if (this.match("minus")) {
      const child = this.parseUnary();
      return child ? { type: "not", child } : null;
    }

    if (this.match("lparen")) {
      const node = this.parseOr();
      if (!node || !this.match("rparen")) return null;
      return node;
    }

    const token = this.peek();
    if (token?.type === "term") {
      this.pos++;
      return { type: "term", value: token.value, explicitHash: token.explicitHash };
    }

    return null;
  }

  private startsUnary(token: QueryToken) {
    return token.type === "term" || token.type === "minus" || token.type === "lparen";
  }

  private peek(): QueryToken | undefined {
    return this.tokens[this.pos];
  }

  private match(type: QueryToken["type"]) {
    if (this.tokens[this.pos]?.type !== type) return false;
    this.pos++;
    return true;
  }
}

function mergeTagMatches(allTags: string[], term: string, modes: MatchSettings): string[] {
  const pref = modes.enablePrefix ? prefixMatch(allTags, term, 200) : [];
  const suff = modes.enableSuffix ? suffixMatch(allTags, term, 200) : [];
  const subs = modes.enableSubstring ? substringMatch(allTags, term, 200) : [];
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const t of pref) { if (!seen.has(t)) { seen.add(t); merged.push(t); } }
  for (const t of suff) { if (!seen.has(t)) { seen.add(t); merged.push(t); } }
  for (const t of subs) { if (!seen.has(t)) { seen.add(t); merged.push(t); } }
  return merged;
}

function renderTermFilter(node: Extract<QueryNode, { type: "term" }>, allTags: string[], modes: MatchSettings): string | null {
  const base = node.value.trim();
  if (!base) return null;

  const seen = new Set<string>();
  const tags: string[] = [];
  const addTag = (tag: string) => {
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  };

  addTag(base);
  if (!node.explicitHash && base.length >= modes.minTagExpansionTermLength) {
    for (const tag of mergeTagMatches(allTags, base, modes).slice(0, 60)) addTag(tag);
  }

  const args = tags.map(t => `"${escapeFormulaString(t)}"`).join(", ");
  return `file.hasTag(${args})`;
}

function renderQueryFilter(node: QueryNode, allTags: string[], modes: MatchSettings): string | null {
  if (node.type === "term") return renderTermFilter(node, allTags, modes);
  if (node.type === "not") {
    const child = renderQueryFilter(node.child, allTags, modes);
    return child ? `!(${child})` : null;
  }

  const rendered = node.children
    .map(child => renderQueryFilter(child, allTags, modes))
    .filter((child): child is string => child != null);
  if (rendered.length !== node.children.length || rendered.length === 0) return null;
  if (rendered.length === 1) return rendered[0];

  const op = node.type === "and" ? " && " : " || ";
  return `(${rendered.join(op)})`;
}

function getCurrentTagTokenRange(value: string, caret: number): { start: number; end: number; token: string } | null {
  let start = caret;
  while (start > 0) {
    const ch = value[start - 1];
    if (/\s/.test(ch) || ch === "(" || ch === ")") break;
    if (ch === "-" && (start - 1 === 0 || /\s|\(/.test(value[start - 2]))) break;
    start--;
  }

  let end = caret;
  while (end < value.length) {
    const ch = value[end];
    if (/\s/.test(ch) || ch === "(" || ch === ")") break;
    end++;
  }

  const token = value.slice(start, caret);
  if (!token) return null;
  return { start, end, token };
}

function buildFiltersFromInput(input: string, allTags: string[], caret: number | undefined, modes: MatchSettings): FilterBuildResult {
  const s = input.trim();
  if (s.length === 0) {
    return { ok: true, filters: [
      "filters:",
      `# INPUT: ${encodeState(input)}`,
      `# CARET: ${typeof caret === 'number' ? caret : 0}`
    ].join("\n") };
  }

  const tokens = tokenizeTagQuery(s);
  if (!tokens) return { ok: false, reason: "Invalid query syntax" };
  const ast = new TagQueryParser(tokens).parse();
  if (!ast) return { ok: false, reason: "Incomplete query syntax" };
  const statement = renderQueryFilter(ast, allTags, modes);
  if (!statement) return { ok: false, reason: "Invalid tag query" };

  return { ok: true, filters: [
    "filters:",
    "  and:",
    `    - ${yamlSingleQuote(statement)}`,
    `# INPUT: ${encodeState(input)}`,
    `# CARET: ${typeof caret === 'number' ? caret : input.length}`
  ].join("\n") };
}

/* =======================================================
 * Suggest class
 * ======================================================= */
class TagSuggest extends AbstractInputSuggest<string> {
  private allTags: string[];
  private onPick: (q: string, caret?: number) => void;
  private inputRef: HTMLInputElement;
  private getModes: () => MatchSettings;

  constructor(app: App, textInputEl: HTMLInputElement, allTags: string[], getModes: () => MatchSettings, onPick: (q: string, caret?: number) => void) {
    super(app, textInputEl);
    this.allTags = allTags;
    this.onPick = onPick;
    this.inputRef = textInputEl;
    this.getModes = getModes;
  }

  // Autocomplete only the current tag token at the caret.
  getSuggestions(_q: string): string[] {
    const input = this.inputRef as HTMLInputElement;
    const value = input.value ?? "";
    const caret = input.selectionStart ?? value.length;
    const range = getCurrentTagTokenRange(value, caret);
    const token = range?.token ?? "";
    if (!token) return [];
    if (token === "|") return [];
    const base = token.startsWith("#") ? token.slice(1) : token;
    if (!base) return [];
    // Suggestions in order per settings: prefix → suffix → substring (deduplicated)
    const modes = this.getModes();
    const pref = modes.enablePrefix ? prefixMatch(this.allTags, base, 100) : [];
    const suff = modes.enableSuffix ? suffixMatch(this.allTags, base, 100) : [];
    const subs = modes.enableSubstring ? substringMatch(this.allTags, base, 100) : [];
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const t of pref) {
      if (!seen.has(t)) { seen.add(t); merged.push(t); }
      if (merged.length >= 12) break;
    }
    if (merged.length < 12) {
      for (const t of suff) {
        if (!seen.has(t)) { seen.add(t); merged.push(t); }
        if (merged.length >= 12) break;
      }
    }
    if (merged.length < 12) {
      for (const t of subs) {
        if (!seen.has(t)) { seen.add(t); merged.push(t); }
        if (merged.length >= 12) break;
      }
    }
    return merged.map(t => `#${t}`);
  }

  renderSuggestion(v: string, el: HTMLElement) {
    el.setText(v);
  }

  // Replace only the current token with the chosen suggestion; append a space if needed
  selectSuggestion(v: string) {
    const input = this.inputRef as HTMLInputElement;
    const value = input.value ?? "";
    const caret = input.selectionStart ?? value.length;
    const range = getCurrentTagTokenRange(value, caret);
    if (!range) return;
    const before = value.slice(0, range.start);
    const after = value.slice(range.end);
    const needSpace = after.startsWith(" ") ? "" : " ";
    const newValue = before + v + needSpace + after;
    const newCaret = (before + v + needSpace).length;
    this.onPick(newValue, newCaret);
  }
}

/* =======================================================
 * Editor-like type
 * ======================================================= */
type CodeEditorLike = {
  getValue(): string;
  replaceRange: (text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }) => void;
  lastLine(): number;
};

/* =======================================================
 * Plugin main
 * ======================================================= */
export default class BaseInstantFilterPlugin extends Plugin {
  settings!: MatchSettings;
  private inputStore = new Map<string, { value: string; caret: number }>();
  private focusedKey: string | null = null;
  // Tag cache (reduce heavy scans)
  private cachedTags: string[] = [];
  private refreshTags!: () => void;
  // Cache for restoring state from file comments (avoid duplicate reads per file)
  private stateCache = new Map<string, Promise<{ input: string; caret: number } | null>>();
  async onload() {
    // Load settings
    await this.loadSettings();
    this.addSettingTab(new MatchSettingTab(this.app, this));
    this.configureRefreshTags();
    // Inject styles: make the input stretch horizontally
    const style = document.createElement('style');
    style.id = 'base-instant-filter-style';
    style.textContent = `
      .base-instant-filter { display: block; width: 100%; margin: 0.25rem 0; }
      .base-instant-filter .bif-row { display: flex; align-items: center; gap: 8px; width: 100%; }
      .base-instant-filter .bif-label { white-space: nowrap; color: var(--text-muted); font-size: var(--font-ui-small); }
      .base-instant-filter .bif-status {
        display: none;
        margin: 3px 0 0 calc(4ch + 8px);
        color: var(--text-error);
        font-size: var(--font-ui-smaller);
        line-height: 1.3;
      }
      .base-instant-filter.bif-error .bif-status { display: block; }
      .base-instant-filter.bif-error input[type="text"] {
        border-color: var(--text-error);
      }
      .base-instant-filter input[type="text"] {
        width: 100%;
        max-width: 100%;
        flex: 1 1 auto;
        box-sizing: border-box;
        padding: 6px 8px;
        font-size: var(--font-ui-small);
      }
    `;
    document.head.appendChild(style);
    this.register(() => style.remove());

    // To avoid conflicts with existing `base` code block handling,
    // use a general Markdown post-processor to detect `language-base` and insert the UI.
    // Initialize tag cache
    this.cachedTags = collectAllTags(this.app);
    // Update the tag cache on metadata updates and file operations
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.refreshTags()));
    this.registerEvent(this.app.vault.on('modify', (f) => { this.refreshTags(); if ((f as any).path) this.stateCache.delete((f as any).path); }));
    this.registerEvent(this.app.vault.on('rename', (f) => { this.refreshTags(); if ((f as any).path) this.stateCache.delete((f as any).path); }));
    this.registerEvent(this.app.vault.on('delete', (f) => { this.refreshTags(); if ((f as any).path) this.stateCache.delete((f as any).path); }));

    this.registerMarkdownPostProcessor((el, ctx) => {
      const allTags = this.cachedTags;

      // Collect possible anchors (works both before and after Base replaces the block)
      const anchors: HTMLElement[] = [];
      el.querySelectorAll('.block-language-base').forEach(n => anchors.push(n as HTMLElement));
      el.querySelectorAll('pre').forEach(pre => {
        const code = pre.querySelector('code.language-base');
        if (code) anchors.push(pre as HTMLElement);
      });

      if (anchors.length === 0) return;

      anchors.forEach((anchor, idx) => {
        // Avoid duplicate insertion
        if ((anchor as any)._baseInstantFilterBound) return;
        (anchor as any)._baseInstantFilterBound = true;

        const container = createDiv({ cls: 'base-instant-filter' });
        const row = container.createDiv({ cls: 'bif-row' });
        const inputId = `bif-input-${idx}`;
        const label = row.createEl('label', { cls: 'bif-label' });
        label.textContent = 'Tags';
        label.setAttr('for', inputId);
        const input = row.createEl('input', { type: 'text', placeholder: '#tag …' });
        input.id = inputId;
        const status = container.createDiv({ cls: 'bif-status' });
        const setQueryError = (message: string | null) => {
          if (message) {
            container.addClass('bif-error');
            status.setText(message);
          } else {
            container.removeClass('bif-error');
            status.setText('');
          }
        };
        const validateInput = () => {
          const val = (input as HTMLInputElement).value ?? "";
          const caretNow = (input as HTMLInputElement).selectionStart ?? val.length;
          const result = buildFiltersFromInput(val, allTags, caretNow, this.settings);
          if (!result.ok) {
            setQueryError(result.reason);
            return result;
          }
          if (result.filters.length > this.settings.maxFilterTextLength) {
            const reason = `Filter text is too long: ${result.filters.length}/${this.settings.maxFilterTextLength} chars`;
            setQueryError(reason);
            return { ok: false, reason } as FilterBuildResult;
          }
          setQueryError(null);
          return result;
        };

        // Persist/restore input per block key
        const key = `${ctx.sourcePath ?? ''}::${idx}`;
        const prev = this.inputStore.get(key);
        if (prev != null) {
          const prevVal = (prev as any).value ?? (prev as any);
          const prevCaret = (prev as any).caret ?? String(prevVal ?? '').length;
          input.value = String(prevVal ?? '');
          try {
            const pos = Math.min(Number(prevCaret) || 0, input.value.length);
            input.setSelectionRange(pos, pos);
          } catch {}
          validateInput();
        } else {
          // Restore state from comments in the file (avoid duplicate reads within the same file)
          (async () => {
            try {
              const sp = ctx.sourcePath ?? '';
              let p = this.stateCache.get(sp);
              if (!p) {
                const file = sp ? (this.app.vault.getAbstractFileByPath(sp) as TFile) : null;
                p = file ? this.app.vault.read(file).then(extractSavedState).catch(() => null) : Promise.resolve(null);
                this.stateCache.set(sp, p);
              }
              const st = await p;
              if (st) {
                input.value = st.input;
                this.inputStore.set(key, { value: st.input, caret: st.caret });
                try {
                  const pos = Math.min(st.caret, input.value.length);
                  input.setSelectionRange(pos, pos);
                } catch {}
                validateInput();
              }
            } catch {}
          })();
        }

        anchor.parentElement?.insertBefore(container, anchor);

        // If this block had focus previously, restore focus
        if (this.focusedKey === key) {
          setTimeout(() => {
            input.focus({ preventScroll: true } as any);
            try {
              const st = this.inputStore.get(key);
              const pos = Math.min((st?.caret ?? input.value.length), input.value.length);
              input.setSelectionRange(pos, pos);
            } catch {}
          }, 0);
        }

        const debounced = debounceDynamic(async () => {
          const file = ctx.sourcePath ? (this.app.vault.getAbstractFileByPath(ctx.sourcePath) as TFile) : null;
          if (!file) return;
          const val = (input as HTMLInputElement).value ?? "";
          const caretNow = (input as HTMLInputElement).selectionStart ?? val.length;
          this.inputStore.set(key, { value: val, caret: caretNow });
          const result = validateInput();
          if (!result.ok) return;
          const filters = result.filters;
          const block = await findOrInsertBaseBlock(this.app, file);
          if (!block) return;
          await replaceFiltersInBaseBlock(this.app, file, block, filters);
        }, () => this.settings.refreshDelayMs);

        // IME composition flag (suppress updates while composing)
        let composing = false;
        input.addEventListener('compositionstart', () => { composing = true; });
        input.addEventListener('compositionend', () => {
          composing = false;
          requestAnimationFrame(() => {
            debounced();
          });
        });

        input.addEventListener('focus', () => {
          this.focusedKey = key;
        });
        input.addEventListener('blur', () => {
          if (this.focusedKey === key) this.focusedKey = null;
        });
        input.addEventListener('input', (e) => {
          const ev = e as InputEvent;
          const caret = (input as HTMLInputElement).selectionStart ?? input.value.length;
          // While composing, only save; update once at compositionend
          if ((ev as any)?.isComposing || composing) {
            this.inputStore.set(key, { value: input.value, caret });
            return;
          }
          this.inputStore.set(key, { value: input.value, caret });
          validateInput();
          debounced();
        });

        new TagSuggest(this.app, input, allTags, () => this.settings, (q, caretPos) => {
          input.value = q;
          const caret = typeof caretPos === 'number' ? caretPos : q.length;
          this.inputStore.set(key, { value: q, caret });
          try { input.setSelectionRange(caret, caret); } catch {}
          validateInput();
          debounced();
        });
      });
    });
  }

  async loadSettings() {
    const data = (await this.loadData()) as Partial<MatchSettings> | null;
    const defaults: MatchSettings = {
      enablePrefix: true,
      enableSuffix: true,
      enableSubstring: true,
      refreshDelayMs: 1000,
      maxFilterTextLength: DEFAULT_FILTER_TEXT_LENGTH,
      minTagExpansionTermLength: DEFAULT_MIN_TAG_EXPANSION_TERM_LENGTH
    };
    this.settings = { ...defaults, ...(data ?? {}) };
    this.settings.maxFilterTextLength = Math.min(
      MAX_FILTER_TEXT_LENGTH,
      Math.max(MIN_FILTER_TEXT_LENGTH, Number(this.settings.maxFilterTextLength) || DEFAULT_FILTER_TEXT_LENGTH)
    );
    this.settings.minTagExpansionTermLength = Math.max(1, Number(this.settings.minTagExpansionTermLength) || DEFAULT_MIN_TAG_EXPANSION_TERM_LENGTH);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  configureRefreshTags() {
    this.refreshTags = debounce(() => {
      this.cachedTags = collectAllTags(this.app);
    }, Math.max(0, this.settings.refreshDelayMs || 0));
  }
}

class MatchSettingTab extends PluginSettingTab {
  plugin: BaseInstantFilterPlugin;
  constructor(app: App, plugin: BaseInstantFilterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h3', { text: 'Tag match modes' });

    new Setting(containerEl)
      .setName('Prefix match')
      .setDesc('Include prefix matches in suggestions')
      .addToggle(t => t
        .setValue(this.plugin.settings.enablePrefix)
        .onChange(async (v) => { this.plugin.settings.enablePrefix = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Substring match')
      .setDesc('Include substring matches in suggestions')
      .addToggle(t => t
        .setValue(this.plugin.settings.enableSubstring)
        .onChange(async (v) => { this.plugin.settings.enableSubstring = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Suffix match')
      .setDesc('Include suffix matches in suggestions')
      .addToggle(t => t
        .setValue(this.plugin.settings.enableSuffix)
        .onChange(async (v) => { this.plugin.settings.enableSuffix = v; await this.plugin.saveSettings(); }));

    const delaySetting = new Setting(containerEl)
      .setName(`Refresh interval: ${this.plugin.settings.refreshDelayMs} ms`)
      .setDesc('Debounce interval for re-scanning tags');
    const choices = [500, 750, 1000, 1500, 2000, 3000, 4000, 5000];
    const nearestIndex = (val: number) => {
      let idx = 0; let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < choices.length; i++) {
        const d = Math.abs(choices[i] - val);
        if (d < best) { best = d; idx = i; }
      }
      return idx;
    };
    const initialIdx = nearestIndex(this.plugin.settings.refreshDelayMs);
    delaySetting.addSlider(sl => sl
      .setLimits(0, choices.length - 1, 1)
      .setValue(initialIdx)
      .onChange(async (idx) => {
        const v = choices[Math.max(0, Math.min(choices.length - 1, idx)) | 0];
        this.plugin.settings.refreshDelayMs = v;
        delaySetting.setName(`Refresh interval: ${v} ms`);
        await this.plugin.saveSettings();
        this.plugin.configureRefreshTags();
      }));

    const lengthSetting = new Setting(containerEl)
      .setName(`Filter text limit: ${this.plugin.settings.maxFilterTextLength} chars`)
      .setDesc(`Skip updates when generated filter text exceeds this length (${MIN_FILTER_TEXT_LENGTH}-${MAX_FILTER_TEXT_LENGTH})`);
    const lengthChoices = [200, 300, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10000];
    const nearestLengthIndex = (val: number) => {
      let idx = 0; let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < lengthChoices.length; i++) {
        const d = Math.abs(lengthChoices[i] - val);
        if (d < best) { best = d; idx = i; }
      }
      return idx;
    };
    const initialLengthIdx = nearestLengthIndex(this.plugin.settings.maxFilterTextLength);
    lengthSetting.addSlider(sl => sl
      .setLimits(0, lengthChoices.length - 1, 1)
      .setValue(initialLengthIdx)
      .onChange(async (idx) => {
        const v = lengthChoices[Math.max(0, Math.min(lengthChoices.length - 1, idx)) | 0];
        this.plugin.settings.maxFilterTextLength = v;
        lengthSetting.setName(`Filter text limit: ${v} chars`);
        await this.plugin.saveSettings();
      }));

    const minCharsSetting = new Setting(containerEl)
      .setName(`Min chars before tag expansion: ${this.plugin.settings.minTagExpansionTermLength}`)
      .setDesc('Only expand matching tags after a non-hash token reaches this length');
    const minCharsChoices = [1, 2, 3, 4, 5];
    const initialMinCharsIdx = Math.max(0, minCharsChoices.indexOf(this.plugin.settings.minTagExpansionTermLength));
    minCharsSetting.addSlider(sl => sl
      .setLimits(0, minCharsChoices.length - 1, 1)
      .setValue(initialMinCharsIdx >= 0 ? initialMinCharsIdx : 1)
      .onChange(async (idx) => {
        const v = minCharsChoices[Math.max(0, Math.min(minCharsChoices.length - 1, idx)) | 0];
        this.plugin.settings.minTagExpansionTermLength = v;
        minCharsSetting.setName(`Min chars before tag expansion: ${v}`);
        await this.plugin.saveSettings();
      }));
  }
}
