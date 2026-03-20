# Base Live Filter (Obsidian Plugin)

**Base Live Filter** is a custom plugin that enhances Obsidian’s new **Base** feature.  
It shows a search input just above embedded Base blocks and **updates filters instantly as you type tags**.  
The Base list narrows in real time on every keystroke, making note exploration smooth and fast.

## Why this project exists

This project exists to solve one narrow workflow problem:

- Use **standard embedded Bases** inside ordinary notes
- Keep using Obsidian's built-in **Cards / Table / List** layouts
- Add a **tag-focused live filter** with autocomplete
- Narrow results **while typing**, without opening the filter UI over and over

When this plugin was first created, Bases did not provide a practical built-in search flow for this use case.  
As of March 2026, Bases has a toolbar with **Search**, **Filter**, **Sort**, and other controls, but that still does not fully solve the workflow this plugin targets.

Relevant official docs:

- [Introduction to Bases](https://help.obsidian.md/bases)
- [Views](https://help.obsidian.md/bases/views)
- [Bases syntax](https://help.obsidian.md/bases/syntax)
- [Build a Bases view](https://docs.obsidian.md/plugins/guides/bases-view)

## What we want from standard Bases

In an ideal world, standard Bases itself would provide the following:

- A first-class **tag autocomplete** experience in search and filter inputs
- A built-in **live filter** workflow for tags, not just manual filter editing
- A way to type a partial tag such as `blu` and expand it into matching tags
- A public plugin API to **augment the built-in Bases toolbar or filter UI**
- A public plugin API to **read and update built-in view search/filter state**

If Bases exposed those capabilities directly, this plugin would likely not need to exist.

## What is currently missing

Bases does support filtering at the syntax level, and the official syntax supports tag-aware conditions such as `file.hasTag("tag")`.  
However, for this plugin's workflow, the important gaps are:

- No documented public API to extend the **built-in** Bases views in place
- No documented public API to control the built-in **search box** or **filter UI**
- No built-in tag autocomplete for the specific "type partial tag, expand candidates, narrow immediately" workflow
- No stable plugin hook for injecting behavior into the standard Cards/Table/List experience
- In practical testing, the built-in Base search box has **unclear and hard-to-explain behavior**
- It does not behave like full Obsidian Search, and it is not reliable enough to use as the foundation for tag-oriented live filtering

This is why the current implementation uses a managed filter section inside the embedded `base` block. It is not elegant, but it keeps the standard Base layouts.

## Approaches considered, but not recommended

Several alternative directions were evaluated and intentionally not chosen as the main direction for this project.

### 1. Rely on the standard Base search box

This looks attractive, but it is not a strong foundation for tag live filtering.

- The built-in Base search behavior is not documented in enough detail for plugin use
- It does not appear to behave like the full Obsidian [Search](https://help.obsidian.md/plugins/search) syntax
- In practice it may sometimes look closer to file-name search, but its actual matching rules are unclear and inconsistent enough that it is hard to build against confidently
- For this plugin's goal, that makes search-box integration low-value even before considering API limitations

As a result, using the standard Base search box as the core of a tag autocomplete system is likely to be fragile or ineffective.

### 2. Build a custom Bases view

This is the cleanest option from an API perspective, but it is a poor product fit for this plugin's goal.

- The official API supports registering **new** Bases views, not extending the built-in ones
- A custom view would avoid some hacks, but it stops being the standard Cards/Table/List experience
- The point of this plugin is to **augment standard Bases**, not replace it with a different view

So while a custom view is technically valid, it weakens the main reason this plugin exists.

### 3. DOM-hack the built-in Bases toolbar or filter UI

This may work temporarily, but it is not recommended as the primary design.

- It depends on internal DOM structure that Obsidian does not promise to keep stable
- It is likely to break across app updates
- It is harder to reason about than a controlled text-rewrite approach

Compared with a targeted rewrite of a managed filter section, deep DOM coupling is usually the less predictable option.

## ⚠️ Status: **Experimental / Not Listed**

- **Proof‑of‑concept and unstable**; behavior may change or break.
- No plan to list in the Obsidian Community Plugins browser.
- **Manual install only; use at your own risk.**
- Limited-scope personal tool: Intended to meet the author’s needs until Obsidian publishes an official Base API; **not a general-purpose or supported solution**.

---

## 🚧 Limitations

- **One Base per note**: Only a single Base block per note is supported. Behavior with multiple Base blocks in the same note is undefined and not supported.
- **All views filters are auto‑managed**: Filters under Base’s "All views" may be automatically rewritten or cleared by this plugin during operation. Do not rely on manual filters at the All views level to persist.
- This plugin currently uses a **managed Markdown rewrite** strategy. That is a deliberate compromise, not an ideal long-term API-supported integration.

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
