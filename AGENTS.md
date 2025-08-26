# AGENTS.md — Working Guide (obsidian-base-live-filter-plugin)

This repository provides an Obsidian plugin that displays a search input above Base blocks and updates tag filters in real time as you type. Follow this guide to make safe and consistent changes.

## Overview
- Purpose: Display an input above Base blocks and apply tag-based filtering in real time.
- Target: Obsidian v1.6+ (see `minAppVersion` in `manifest.json`).
- Entry point: TypeScript `main.ts` compiled by `tsc` into `main.js`.
- Key features:
  - Autocomplete in the input (`Tags`) with prefix/suffix/substring matching (ordered, de-duplicated).
  - Build Base block filter section from input while preserving other settings (columns, display options).
  - Debounced tag scanning and cache refresh tied to file/metadata events.

## Repository Layout
- `main.ts`: Plugin logic (UI, behavior, settings tab).
- `manifest.json`: Plugin metadata. `main` points to `main.js`.
- `tsconfig.json`: TypeScript configuration (outputs to repository root).
- `package.json`: Dev dependencies (Obsidian types, TypeScript).
- `README.md`: User-facing overview and usage.

## Build and Run
- Install dependencies (if needed)
  - `npm ci` or `npm i`
- Build
  - `npx tsc -p tsconfig.json`
  - Produces `main.js` (loaded by Obsidian).
- Dev watch (optional)
  - `npx tsc -p tsconfig.json --watch`
- Manual install for testing
  1) Copy `main.js`, `manifest.json`, and (if present) `styles.css` to your vault at `.obsidian/plugins/base-live-filter/`.
  2) Reload Obsidian and enable the plugin.

## Coding Guidelines
- Minimal changes: Keep modifications tightly scoped to the stated goal.
- Follow existing style: Respect variable/function names and file layout; avoid unnecessary renames/splits.
- Avoid new dependencies: Prefer Obsidian API and platform features.
- Type safety: Keep `strict: true`; avoid excessive `any`.
- Public API only: Do not rely on internal/private Obsidian APIs.
- Comments sparingly: Clarify tricky parts only; avoid noisy inline commentary.
- Language: Write all documentation, commit messages, PR descriptions, and code comments in English.

## Safe-to-Change Areas (examples)
- Autocomplete behavior: Matching modes, item limits, merge order.
- Settings UI: Toggles, sliders, defaults, and labels.
- Tag harvesting/refresh: Improve `collectAllTags`, debounce intervals, event handling.
- Filter generation: Adjust `buildFiltersFromInput` (do not break other Base block settings).
- Performance: Caching, debouncing, and avoidance of redundant work.

## Changes Requiring Prior Agreement
- Plugin identity/structure: Changes to `id`/`main`/`minAppVersion` in `manifest.json`.
- Managed block markers: Text and structure of `BEGIN_FILTERS`/`END_FILTERS` comments.
- I/O strategy: The safe full-text replace flow via `app.vault.modify`.
- Large file layout changes: Moving away from the single-file `main.ts` setup.

## Performance and UX Principles
- Debounce: Tag rescans should follow the configured debounce; default is 1000 ms (0 is allowed but not recommended).
- Caret preservation: Persist and restore input value and caret per block.
- IME-aware: Suppress updates during composition; update on composition end.
- De-duplication: Merge suggestions prefix → suffix → substring with duplicates removed.

## Test/Verification Checklist
- Multiple Base blocks: Input state is preserved/restored correctly per block.
- Suggestion quality: Order and limits for prefix/suffix/substring behave as expected.
- Filter generation: Column/display settings are preserved; only filters change.
- Cache refresh: Tag list updates on file rename/modify/delete and metadata events.
- IME behavior: No unintended writes during active composition.

## Common Tasks
- Bug fix (e.g., suggestions exceed 12 items)
  - Adjust limits and merging in `TagSuggest.getSuggestions` → build (`tsc`) → verify in Obsidian.
- Change default debounce
  - Update defaults in `loadSettings` and sync the settings tab label → build.
- Reorder suggestion strategy
  - Update both `getSuggestions` and `buildFiltersFromInput` to keep strategy consistent → regression check.

## CLI Notes (this environment)
- Network/filesystem restrictions may require approval for `npm i` or running commands.
- Before builds/tests, briefly state the actions and request approval if needed.
- Do not commit by default; only commit when explicitly requested.

## Additional Notes
- `supportsContainsAny()` is a placeholder for potential Base syntax changes (currently returns `false`).
- Keep UI text short and clear (e.g., `Tags`). If localization is desired, agree on a plan first.

By following this guide, you can keep changes safe, readable, and consistent. Update this document first if you need to adjust the rules.
