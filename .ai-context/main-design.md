# Vibe Coding Visualizer for VS Code

A VS Code extension that keeps “vibe coders” grounded in the codebase by rendering a living, zoomable map of the project, breaking it down into digestible slices, and visually highlighting **everything the LLM touches**.

---

## 1) Problem & Goals

**Problem:** When collaborating with an LLM, developers quickly lose situational awareness—what files exist, how parts connect, and what exactly changed.

**Goals:**

* Provide a **codebase map** (modules, packages, classes, functions, tests) that updates in near‑real‑time.
* Track **LLM-originated edits** and surface them as visual overlays, diffs, and timelines.
* Offer guided exploration: dependency graph, call graph, ownership, hotspots, TODO/tech debt clusters.
* Make LLM changes safe: atomic previews, rollback, tests, and impact analysis.

**Non-goals (v1):** Full semantic understanding for every language. We target popular ecosystems first (TS/JS, Python, Go, Java), then expand.

---

## 2) Top-Level Architecture

```
+--------------------+     +---------------------------+
| VS Code Extension  |     | Optional Language Server  |
| (TypeScript)       |<--->| (LSP; indexing/semantics) |
+--------------------+     +---------------------------+
      |  ^                                  ^
      |  | IPC / RPC                        | (JSON-RPC)
      v  |                                  |
+--------------------+         +-------------------------------+
| Indexer Daemon     | <-----> | Local Graph Store (SQLite/DB) |
| (Node/Rust +       |         | Nodes/Edges/Diffs/Sessions    |
| tree-sitter)       |         +-------------------------------+
      ^  ^                                               ^
      |  | FS Watchers (git, files)                      |
      |  +-----------------------------------------------+
      |
      v
+--------------------+
| Webview UI (D3)    |
| Graph, timeline,   |
| diffs, overlays    |
+--------------------+
```

**Key pieces**

* **Extension Host (TS):** Commands, contributions, Webview/Trees, Git integration, WorkspaceEdits, Diagnostics, CodeLens, Timeline provider.
* **Indexer:** Incremental parsing via **tree-sitter** (or language-native tools), builds symbol & dependency graphs. Emits edges: `imports`, `calls`, `defines`, `modifies`, `tests`, `refers`, `ownership`.
* **Graph Store:** SQLite (bundled) or DuckDB; provides versioned nodes/edges and change sessions. Indexed for fast queries.
* **LLM Change Orchestrator:** A single path by which LLM edits are proposed/applied, ensuring every change is tracked and diffed (see §6).
* **Webview UI:** Zoomable map, per-layer overlays for changes, hotspots, ownership, test coverage; searchable, filterable.

---

## 3) Data Model (SQLite)

**Tables**

* `node(id, kind, lang, name, fqname, path, range_start, range_end, hash, ts)`
* `edge(id, kind, src, dst, weight, ts)`  — kinds: `imports|calls|inherits|defines|modifies|tests|owns|mentions`
* `file(id, path, lang, hash, size, ts)`
* `session(id, actor, actor_version, origin, started_at, ended_at)` — `origin: user|LLM|mixed` (LLM vendor/model optional)
* `change(id, session_id, file_id, hunks_json, summary, ts)`
* `issue(id, session_id, severity, kind, message, node_id, file_id, ts)` — static analysis results
* `metric(id, node_id, kind, value, ts)` — complexity, churn, coverage

**Indexes**

* `node(path)`, `edge(src,dst,kind)`, `change(session_id)`, `file(path)`

**Hunks JSON Schema (simplified)**

```json
{
  "filePath": "src/foo.ts",
  "beforeHash": "abc",
  "afterHash": "def",
  "hunks": [
    { "start": 42, "end": 60, "type": "insert|delete|modify", "text": "..." }
  ]
}
```

---

## 4) VS Code Integration (APIs & Contributions)

* **Commands** (`package.json > contributes.commands`)

  * `vibe.openMap`: Open main visualization
  * `vibe.showChanges`: Show current session changes
  * `vibe.applyLLMPlan`: Preview & apply LLM changes (atomic)
  * `vibe.undoSession`: Revert last LLM session
  * `vibe.explainSelection`: Summarize selected code in map context
  * `vibe.findImpact`: Impact analysis for a symbol change
* **Views**

  * **TreeView**: “Code Slices” (modules/packages/classes), “Recent Sessions”, “Issues”
  * **TimelineProvider**: File timeline merges git commits + LLM sessions
  * **CodeLens**: Above functions/classes showing inbound/outbound refs, tests, last change actor
  * **Decorations**: Inline highlights for LLM edits (gutter marks, range background)
* **Webview Panel**: Main map (D3/Canvas/WebGL). Message bus with `postMessage`.
* **Source Control**: Integrate with Git; tag commits with session metadata; optional virtual SCM for LLM sessions.
* **Diagnostics & Problems**: Emit issues from static analysis/test failures post-change.

---

## 5) Visual Model & UX

**Layers**

* **Structure:** packages → modules → symbols (class/func/vars)
* **Relations:** imports, calls, inherits
* **Quality:** complexity, coverage, TODO density
* **Churn:** git churn, LLM edits heatmap

**Change Overlays**

* **Session heatmap:** nodes glow with intensity by lines changed
* **Edge recolor:** darker edges where call/import paths are affected
* **Mini-diff popover:** hover a node to view inline diff summary and rationale
* **Timeline scrubber:** slide through sessions/commits to “replay” changes

**Navigation**

* Global search; filter by lang/owner/folder
* “Explain this region” command triggers LLM summary anchored to current viewport
* “Impact mode”: click a symbol to show fan-in/fan-out and affected tests

**Safeguards**

* **Preview & Apply:** LLM edits staged in a virtual workspace; user accepts/rejects hunks
* **Auto‑tests:** run tests impacted by changed symbols first
* **Rollback:** one-click revert by session or file

---

## 6) LLM Change Orchestrator

All LLM edits must pass through a single orchestrator so they’re consistently tracked and visualized.

**Flow**

```
LLM Plan (JSON) → Dry Run (patch in temp FS) → Index & Analyze → Preview UI → Apply WorkspaceEdits → Save → Commit/tag session → Reindex → Visual overlay update
```

**LLM Plan Schema (input)**

```json
{
  "intent": "add feature|refactor|fix bug",
  "rationale": "...",
  "edits": [
    {
      "path": "src/api/user.ts",
      "operations": [
        { "type": "replace", "range": {"start": [12,0], "end": [60,0]}, "text": "..." }
      ]
    }
  ],
  "tests": ["tests/api/user.spec.ts"],
  "risk": "low|medium|high"
}
```

**Outputs**

* `session` row created
* For each file, create `change` with hunks; attach `issues` from analyzers
* Post-apply: trigger test runner (language-specific) and update diagnostics

**Why a Plan?** It forces LLM to reason explicitly, eases preview, enables rationale at hover, and allows static analysis before touching working files.

---

## 7) Indexing & Language Coverage

**Parsing**

* **tree-sitter** for TS/JS, Python, Go, Java (extensible)
* Fallbacks to **ripgrep + ctags** when no grammar available
* Incremental updates via FS watch + git hooks

**Relationships**

* TS/JS: `import` graph; call graph via AST + heuristic
* Python: imports + `ast` call sites
* Go: `go list`, `guru`/`gopls` for refs/calls
* Java: LSP for symbols/calls

**Performance**

* First index cached; subsequent runs incremental
* Debounce updates; prioritize foreground files and LLM-touched files
* DB compression; edge weights for layout stability

---

## 8) Security, Privacy, Safety

* **Local by default.** No code leaves machine unless user opts into cloud indexing.
* **Model sandboxing:** The orchestrator mediates all edits. Prevent arbitrary file writes outside workspace.
* **Secrets hygiene:** redact `.env`, keys in diffs; warn on exposure.
* **Policy:** allowlists for editable paths; denylist for generated or vendor folders.

---

## 9) UI Details (Webview)

* **Tech:** D3.js + Canvas/WebGL (Pixi.js) for large graphs.
* **Layout:** Force-directed w/ constraints, or hierarchical by folder/module.
* **State:** Viewport bookmarks; session color palettes; legend for layers.
* **Interactions:**

  * Click node → right panel: metadata, mini-diff, rationale
  * Shift-click → path find between nodes
  * Timeline at bottom with commit/session ticks; keyboard to scrub

---

## 10) Developer Workflow & Commands

* `Vibe: Open Map`
* `Vibe: Preview LLM Plan from Clipboard`
* `Vibe: Apply LLM Plan`
* `Vibe: Explain Selection`
* `Vibe: Show Impact of Change`
* `Vibe: Undo Last LLM Session`
* `Vibe: Export Session Patch`

**Settings**

* `vibe.indexer.maxCPU` (default 2)
* `vibe.privacy.upload`: `none|symbols|full` (default `none`)
* `vibe.graph.layout`: `force|hierarchical`
* `vibe.layers.default`: `structure,relations,changes`
* `vibe.tests.autoRun`: `true`

---

## 11) Minimal Extension Scaffold (TypeScript)

```ts
// src/extension.ts
import * as vscode from 'vscode';

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('vibe.openMap', () => openMap(ctx)),
    vscode.commands.registerCommand('vibe.applyLLMPlan', applyLLMPlan),
    vscode.window.registerTreeDataProvider('vibe.sessions', new SessionsTree()),
  );
}

function openMap(ctx: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel(
    'vibeMap', 'Vibe Map', vscode.ViewColumn.Two, { enableScripts: true }
  );
  panel.webview.html = getMapHtml();
  panel.webview.onDidReceiveMessage(handleWebviewMessage);
}

async function applyLLMPlan() {
  const raw = await vscode.env.clipboard.readText();
  const plan = JSON.parse(raw);
  // 1) dry-run in memory
  // 2) show preview diff via quickDiff provider or custom UI
  // 3) if accepted, apply WorkspaceEdits
}

function getMapHtml() {
  return `<!doctype html><html><body><canvas id="map"></canvas><script>
  const vscode = acquireVsCodeApi();
  // Render graph here (D3/Pixi). Listen for messages with change overlays.
  </script></body></html>`;
}

class SessionsTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(e: vscode.TreeItem) { return e; }
  getChildren() { return []; }
}

export function deactivate() {}
```

---

## 12) Webview <-> Extension Message Protocol

**From Extension → Webview**

* `graph:update` `{ nodes, edges }`
* `overlay:session` `{ sessionId, changes }`
* `focus:file` `{ path, range }`
* `timeline:update` `{ ticks: [...], current }`

**From Webview → Extension**

* `node:selected` `{ nodeId }` → reveal in editor
* `edge:path` `{ srcId, dstId }` → compute shortest path
* `overlay:toggle` `{ layer, enabled }`
* `session:replay` `{ sessionId, t }`

---

## 13) Change Preview & Diffing

* Use **WorkspaceEdit** to stage changes
* Provide a custom **DiffPanel** with hunk-level accept/reject
* Git integration: offer to commit as `chore(vibe): <intent>` tagged with session ID
* Show inline range decorations in editors for accepted hunks

---

## 14) Impact Analysis

* For a changed symbol, compute **fan-in/out** and highlight affected tests
* Rank risk: complexity x churn x test coverage x blast radius
* Offer quick-actions: “Generate focused unit test”, “Explain risk”, “Open related docs”

---

## 15) Telemetry (opt-in)

* Session counts, apply/abort rates, avg preview time
* Language coverage, graph size, render FPS (no code content by default)

---

## 16) Roadmap

* **v0.1 (MVP):** TS/JS + Python indexing; map + session overlays; basic diffs; apply/undo
* **v0.2:** Call graph for TS/JS; impact analysis; test runner integration (Jest/Pytest)
* **v0.3:** Go/Java support; coverage ingestion; ownership and hotspots; replay timeline
* **v0.4:** Model-agnostic LLM adapters; policy guardrails; cloud index optional

---

## 17) Risks & Mitigations

* **Indexing performance** → incremental parsing, prioritize visible/changed files
* **Graph overload** → progressive disclosure, clustering, search-driven focus
* **LLM unsafe edits** → plan+preview, policy allowlist, tests, rollback
* **Multi-language complexity** → staged language rollouts, community grammars

---

## 18) Testing Strategy

* Unit tests for parsers and plan application
* Snapshot tests for overlay rendering (DOM/canvas harness)
* Workspace integration tests using VS Code test runner
* Golden repos (small/medium) for perf/regression

---

## 19) Packaging & Distribution

* `vsce package` → `.vsix`
* Marketplace listing with animated GIFs of overlays
* Privacy policy (local-first), opt-in telemetry

---

## 20) Nice-to-haves

* “Story mode”: narrate a session as a comic timeline (LLM rationale + diffs)
* “Mentor mode”: guided tours of a codebase (ownership, hotspots)
* “Design surface”: whiteboard nodes/notes pinned to symbols

---

**Summary**: A single source of truth for LLM edits plus a living map of your project. Stay in flow, but never lose the plot.
