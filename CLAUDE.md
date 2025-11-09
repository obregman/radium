# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Radium is a VS Code extension that visualizes codebases as interactive graphs and tracks changes made by LLMs. It indexes source code, creates a visual map of files and relationships, and provides session-based tracking of all LLM-generated changes with rollback capability.

## Build and Development Commands

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode (compile on changes)
npm run watch

# Run tests
npm run test

# Lint code
npm run lint

# Package extension as .vsix
npm run package
```

**Important:** Do not run `npm run dev` - the user runs this themselves. Do not perform git add, commit, or push.

## Architecture

### Core Data Flow

**File System → Parser → Graph Store → Views → Webview**

1. **File watcher** (chokidar) detects changes
2. **Parser** (tree-sitter) extracts symbols and relationships
3. **Graph Store** (SQLite) persists nodes, edges, sessions, and changes
4. **Views** update to reflect new state
5. **Webview** (D3.js) renders interactive graph

### LLM Change Flow

**JSON Plan → Preview → User Approval → Apply → Record Session → Update Visualization**

The orchestrator manages this entire flow atomically with rollback support.

### Key Components

**GraphStore (`src/store/schema.ts`)**
- SQLite database with tables: `node`, `edge`, `file`, `session`, `change`, `issue`, `metric`
- All code symbols, relationships, and LLM sessions stored here
- Transaction support for atomic operations
- Indexed queries on path and fqname

**Indexer (`src/indexer/`)**
- Real-time parsing using tree-sitter (TypeScript, JavaScript, Python)
- Incremental re-indexing on file changes
- Import resolution (relative and absolute paths)
- Automatic edge creation for imports, calls, inheritance

**LLM Orchestrator (`src/orchestrator/llm-orchestrator.ts`)**
- Parses LLM plans from JSON (intent, rationale, edits, tests, risk)
- Preview changes before applying (dry run with hunks)
- Applies changes atomically via WorkspaceEdit
- Records sessions and changes with hunk-level tracking
- Rollback support (partial implementation - see line 196)

**Codebase Map Panel (`src/views/codebase-map-panel.ts`)**
- D3.js force-directed graph visualization
- Interactive node selection and path finding
- Change overlay support

**Sessions Tree, Code Slices Tree, Issues Tree (`src/views/`)**
- VS Code tree views showing recent sessions, code hierarchy, and static analysis warnings

### Message Protocol (Extension ↔ Webview)

**Extension → Webview:**
- `graph:update` - Full graph data
- `overlay:session` - Session changes
- `focus:file` - Navigate to file
- `path:result` - Path between nodes

**Webview → Extension:**
- `node:selected` - User clicked node
- `edge:path` - Request path computation
- `overlay:toggle` - Toggle layer visibility
- `ready` - Webview initialized

## Configuration Files

**radium-components.yaml** - Define components and external dependencies
```yaml
spec:
  components:
    - frontend:
        name: Frontend
        files:
          - src/components/**
        external:
          - type: PostgreSQL
            name: MainDB
```

**radium-features.yaml** - Define product features and their relationships
```yaml
spec:
  features:
    - authentication:
        name: User Authentication
        status: completed
        components: [backend, frontend]
        dependencies: []
```

## Extension Points

### Adding Language Support
Edit `src/indexer/parser.ts` to add tree-sitter parser and symbol extraction logic.

### Adding Edge Types
Extend `EdgeKind` in `src/store/schema.ts`:
```typescript
type EdgeKind = 'imports' | 'calls' | 'inherits' | ...
```

### Adding Analyzers
Create new analyzers in `src/analysis/` for complexity metrics, coverage, churn detection, or ownership tracking.

## Code Style Guidelines

From `.cursor/rules/`:

- Write production-grade code (no demos or mocks except in tests)
- Do not make changes unrelated to the specific task
- Do not claim a bug is fixed without verification via tests
- Keep responses short and honest
- If a fix fails twice, perform extensive code review and prepare a plan before changing code
- Update README.md after significant changes, but keep it high-level without implementation details
- Write documentation in `./docs` directory
- Use constants over magic numbers
- Write self-documenting code with meaningful names
- Single Responsibility: each function does one thing
- DRY: extract repeated code into reusable functions
- Refactor continuously and fix technical debt early

## Testing

Run tests with `npm run test`. Tests are located in `out/test/` after compilation.

Test coverage should include:
- Parser symbol extraction
- Hunk generation
- Impact analysis algorithms
- Full indexing workflow
- Change application
- Session rollback

## Windows Compatibility

This project normalizes paths to forward slashes for cross-platform compatibility. When working with file paths, ensure they are normalized using the Output Channel for reliable logging on Windows.
