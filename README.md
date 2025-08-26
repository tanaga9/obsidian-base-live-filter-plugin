# Base Live Filter (Obsidian Plugin)

**Base Live Filter** is a custom plugin that enhances Obsidian’s new **Base** feature.  
It shows a search input just above embedded Base blocks and **updates filters instantly as you type tags**.  
The Base list narrows in real time on every keystroke, making note exploration smooth and fast.

## ⚠️ Status: **Experimental / Not Listed**

- **Proof‑of‑concept and unstable**; behavior may change or break.
- No plan to list in the Obsidian Community Plugins browser.
- **Manual install only; use at your own risk.**
- Limited-scope personal tool: Intended to meet the author’s needs until Obsidian publishes an official Base API; **not a general-purpose or supported solution**.

---

## 🚧 Limitations

- **One Base per note**: Only a single Base block per note is supported. Behavior with multiple Base blocks in the same note is undefined and not supported.
- **All views filters are auto‑managed**: Filters under Base’s "All views" may be automatically rewritten or cleared by this plugin during operation. Do not rely on manual filters at the All views level to persist.

---

## ✨ Features

- Shows a search box above Base blocks  
- Instant filtering on every keystroke  
- Tag autocompletion (prefix match)  
- Automatically expands suggestions to **containsAny**  
- Keeps your Base **column definitions and display settings** intact (only the filter section is auto-managed)

---

## 🚀 Usage

1. Enable the plugin.  
2. Add a Base block to any note.  
   The following template is appended automatically on first use:

   ````markdown
   ```base
   # BEGIN FILTERS (managed by obsidian-base-live-filter-plugin)
   filters:
   # END FILTERS
   # ---- Manual edits below are OK (column definitions, view settings, etc.) ----
   ```
   ````
3. Switch the note to **Reading view**.  
   The Tags input and live filtering UI render in **Reading view** (they are **not shown in Source mode**).
