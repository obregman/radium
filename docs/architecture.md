# Radium Architecture

## Overview

Radium is a VS Code extension that provides a living, zoomable map of your codebase with special focus on tracking LLM-originated changes.

## Core Components

### 1. Graph Store (`src/store/schema.ts`)

SQLite-based persistent storage for the code graph.

**Tables:**
- `node` - Code symbols (functions, classes, interfaces)
- `edge` - Relationships (imports, calls, inheritance)
- `file` - File metadata and hashes
- `session` - LLM/user interaction sessions
- `change` - Detailed change records with hunks
- `issue` - Static analysis results
- `metric` - Code metrics (complexity, coverage)

**Key Operations:**
- Node CRUD with path-based queries
- Edge creation with kind categorization
- Session tracking with timestamps
- Transaction support for atomic operations

### 2. Indexer (`src/indexer/`)

Real-time code parsing and graph building.

**Parser (`parser.ts`):**
- Uses tree-sitter for AST parsing
- Supports TypeScript, JavaScript, Python
- Extracts symbols, imports, and call sites
- Generates file hashes for change detection

**Indexer (`indexer.ts`):**
- File system watching with chokidar
- Incremental re-indexing on changes
- Debounced queue processing
- Import resolution (relative and absolute)
- Automatic edge creation for relationships

**Workflow:**
1. Initial workspace scan
2. Parse each source file
3. Extract symbols and relationships
4. Store in graph database
5. Watch for file changes
6. Update graph incrementally

### 3. LLM Orchestrator (`src/orchestrator/llm-orchestrator.ts`)

Manages all LLM-originated code changes.

**Plan Schema:**
```typescript
interface LLMPlan {
  intent: 'add feature' | 'refactor' | 'fix bug';
  rationale: string;
  edits: FileEdit[];
  tests?: string[];
  risk?: 'low' | 'medium' | 'high';
}
```

**Workflow:**
1. Parse LLM plan from JSON
2. Preview changes (dry run)
3. Generate hunks and diffs
4. Show preview to user
5. Apply as atomic WorkspaceEdit
6. Record session and changes
7. Update visualization

**Key Features:**
- Atomic operations (all or nothing)
- Change preview before apply
- Session rollback support
- Hunk-level tracking

### 4. Views (`src/views/`)

VS Code UI components.

**Sessions Tree:**
- Recent LLM/user sessions
- Expandable to show file changes
- Click to view change details

**Code Slices Tree:**
- File and symbol hierarchy
- Navigate to definitions
- Symbol icons by type

**Issues Tree:**
- Static analysis warnings
- Severity indicators
- Direct file navigation

**Map Panel (`map-panel.ts`):**
- Webview-based visualization
- D3.js force-directed graph
- Interactive node selection
- Path finding between symbols
- Overlay support for changes

### 5. Extension Host (`src/extension.ts`)

Main activation and command registration.

**Commands:**
- `vibe.openMap` - Open visualization
- `vibe.applyLLMPlan` - Apply changes from clipboard
- `vibe.undoSession` - Rollback session
- `vibe.findImpact` - Show impact analysis
- `vibe.explainSelection` - LLM explanation
- `vibe.exportSessionPatch` - Export as patch

**Lifecycle:**
1. Activation on workspace open
2. Initialize store and indexer
3. Register commands and views
4. Start background indexing
5. Show welcome notification

### 6. Git Integration (`src/git/git-tracker.ts`)

Track sessions with git commits.

**Features:**
- Tag commits with session IDs
- Get file history
- Create session branches
- Watch repository changes

### 7. Impact Analyzer (`src/analysis/impact-analyzer.ts`)

Analyze code dependencies and blast radius.

**Metrics:**
- Fan-in (who depends on this)
- Fan-out (what this depends on)
- Transitive impact
- Affected tests
- Risk calculation

**Algorithms:**
- BFS for path finding
- DFS for transitive closure
- Hotspot detection

## Data Flow

```
File System Change
    ↓
File Watcher (chokidar)
    ↓
Parser (tree-sitter)
    ↓
Graph Store (SQLite)
    ↓
Views Update
    ↓
Webview Refresh
```

## LLM Change Flow

```
LLM Plan (JSON)
    ↓
Orchestrator.previewPlan()
    ↓
Apply operations
    ↓
Generate hunks
    ↓
User approval
    ↓
Orchestrator.applyPlan()
    ↓
WorkspaceEdit
    ↓
Record session
    ↓
Update visualization
```

## Message Protocol

### Extension → Webview

- `graph:update` - Full graph data
- `overlay:session` - Session changes
- `focus:file` - Navigate to file
- `path:result` - Path between nodes

### Webview → Extension

- `node:selected` - User clicked node
- `edge:path` - Request path computation
- `overlay:toggle` - Toggle layer visibility
- `ready` - Webview initialized

## Performance Considerations

### Indexing
- Incremental updates only
- Debounced queue (300ms)
- Respect maxCPU setting
- Skip ignored directories

### Graph Store
- Indexed queries on path/fqname
- Transactions for atomicity
- Single connection per workspace

### Visualization
- Force simulation with constraints
- Progressive disclosure for large graphs
- Canvas/WebGL for >1000 nodes
- Viewport culling

## Security

### Local First
- All data stored locally
- No external API calls by default
- Optional cloud sync (opt-in)

### Change Safety
- Preview before apply
- Atomic transactions
- Session rollback
- Git integration for audit trail

### Secrets
- Redact env files
- Warn on exposed credentials
- Path allowlist/denylist

## Extension Points

### Language Support
Add new parsers in `src/indexer/parser.ts`:
```typescript
const GoParser = require('tree-sitter-go');
// Register parser
// Implement symbol extraction
```

### Edge Types
Extend `EdgeKind` in schema:
```typescript
type EdgeKind = 'imports' | 'calls' | 'implements' | ...
```

### Analysis
Add analyzers in `src/analysis/`:
- Complexity metrics
- Coverage ingestion
- Churn detection
- Ownership tracking

## Configuration

Settings in `package.json`:
- `vibe.indexer.maxCPU` - CPU cores
- `vibe.privacy.upload` - Cloud sync level
- `vibe.graph.layout` - Layout algorithm
- `vibe.layers.default` - Visible layers
- `vibe.tests.autoRun` - Auto-test

## Testing Strategy

### Unit Tests
- Parser symbol extraction
- Hunk generation
- Impact analysis algorithms

### Integration Tests
- Full indexing workflow
- Change application
- Session rollback

### UI Tests
- Webview rendering
- Tree view updates
- Command execution

## Future Enhancements

### v0.2
- Enhanced call graph
- Test runner integration
- Coverage visualization

### v0.3
- Go/Java support
- Ownership tracking
- Timeline replay

### v0.4
- LLM adapters
- Policy guardrails
- Cloud indexing option

