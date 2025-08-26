import {
  App,
  Plugin,
  TFile,
  MarkdownView,
  AbstractInputSuggest,
  MarkdownPostProcessorContext,
  Notice,
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
  const mInput = segment.match(/^#\s*INPUT:\s*(.+)$/m);
  const mCaret = segment.match(/^#\s*CARET:\s*(\d+)$/m);
  if (!mInput && !mCaret) return null;
  const input = mInput ? decodeState(mInput[1].trim()) : "";
  const caret = mCaret ? parseInt(mCaret[1], 10) : input.length;
  return { input, caret: isNaN(caret) ? input.length : caret };
}

/* =======================================================
 * Base embedded block management
 * ======================================================= */
const FENCE_START = "```base";
const BEGIN_MARK = "# BEGIN FILTERS (managed by obsidian-base-live-filter-plugin)";
const END_MARK = "# END FILTERS";

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

async function findOrInsertBaseBlock(app: App, file: TFile): Promise<BaseBlockInfo | null> {
  // Avoid editor dependency; always work from the file contents
  let text = await app.vault.read(file);
  let info = findBaseBlock(text);
  if (info) return info;

  const template = [
    "",
    "```base",
    BEGIN_MARK,
    "filters:\n  - contains(file.tags, \"\")",
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
function escapeQuote(s: string) {
  return s.replace(/"/g, '\\"');
}

function supportsContainsAny(): boolean {
  // TODO: Verify behavior and switch to true if supported
  return false;
}

type MatchSettings = { enablePrefix: boolean; enableSuffix: boolean; enableSubstring: boolean; refreshDelayMs: number };

function buildFiltersFromInput(input: string, allTags: string[], caret: number | undefined, modes: MatchSettings): string {
  const s = input.trim();
  if (s.length === 0) {
    return [
      "filters:",
      `# INPUT: ${encodeState(input)}`,
      `# CARET: ${typeof caret === 'number' ? caret : 0}`
    ].join("\n");
  }

  const parts = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (const part of parts) {
    const isHash = part.startsWith('#');
    const base = isHash ? part.slice(1).trim() : part;
    // Match modes same as suggestions: prefix → suffix → substring (deduplicated)
    const pref = modes.enablePrefix ? prefixMatch(allTags, base, 200) : [];
    const suff = modes.enableSuffix ? suffixMatch(allTags, base, 200) : [];
    const subs = modes.enableSubstring ? substringMatch(allTags, base, 200) : [];
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const t of pref) { if (!seen.has(t)) { seen.add(t); merged.push(t); } }
    for (const t of suff) { if (!seen.has(t)) { seen.add(t); merged.push(t); } }
    for (const t of subs) { if (!seen.has(t)) { seen.add(t); merged.push(t); } }

    const list: string[] = [];
    if (base) list.push(`"${escapeQuote(base)}"`);
    for (const t of merged.slice(0, 60)) list.push(`"${escapeQuote(t)}"`);
    lines.push(`    - file.tags.containsAny([${list.join(", ")}])`);
  }

  return [
    "filters:",
    "  and:",
    ...lines,
    `# INPUT: ${encodeState(input)}`,
    `# CARET: ${typeof caret === 'number' ? caret : input.length}`
  ].join("\n");
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

  // Autocomplete only the current word (space-delimited) at the caret
  getSuggestions(_q: string): string[] {
    const input = this.inputRef as HTMLInputElement;
    const value = input.value ?? "";
    const caret = input.selectionStart ?? value.length;
    const left = value.slice(0, caret);
    const start = left.lastIndexOf(" ") + 1; // space-delimited
    const token = value.slice(start, caret);
    if (!token) return [];
    const base = token.startsWith("#") ? token.slice(1) : token;
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
    const left = value.slice(0, caret);
    const right = value.slice(caret);
    const start = left.lastIndexOf(" ") + 1;
    // End of the current token (up to next space if any)
    const matchNextWs = right.match(/\s/);
    const end = matchNextWs ? caret + (matchNextWs.index ?? 0) : value.length;
    const before = value.slice(0, start);
    const after = value.slice(end);
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
          const block = await findOrInsertBaseBlock(this.app, file);
          if (!block) return;
          const val = (input as HTMLInputElement).value ?? "";
          const caretNow = (input as HTMLInputElement).selectionStart ?? val.length;
          this.inputStore.set(key, { value: val, caret: caretNow });
          const filters = buildFiltersFromInput(val, allTags, caretNow, this.settings);
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
          debounced();
        });

        new TagSuggest(this.app, input, allTags, () => this.settings, (q, caretPos) => {
          input.value = q;
          const caret = typeof caretPos === 'number' ? caretPos : q.length;
          this.inputStore.set(key, { value: q, caret });
          try { input.setSelectionRange(caret, caret); } catch {}
          debounced();
        });
      });
    });
  }

  async loadSettings() {
    const data = (await this.loadData()) as Partial<MatchSettings> | null;
    const defaults: MatchSettings = { enablePrefix: true, enableSuffix: true, enableSubstring: true, refreshDelayMs: 1000 };
    this.settings = { ...defaults, ...(data ?? {}) };
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
  }
}
