# Radium Usage Guide

## Installation

1. Install from VS Code marketplace
2. Reload VS Code
3. Open your project workspace

## First Steps

### Open the Map

```
Cmd/Ctrl + Shift + P → "Radium: Open Map"
```

This opens an interactive visualization showing:
- All symbols in your codebase (functions, classes, types)
- Relationships between them (imports, calls, inheritance)
- Real-time updates as you edit

### Explore Your Code

**In the Map:**
- **Click** a node to jump to that symbol
- **Drag** nodes to rearrange
- **Scroll** to zoom in/out
- **Pan** by dragging the background
- **Hover** for symbol details

**In the Sidebar:**
- **Code Slices** - Browse files and symbols
- **Recent Sessions** - View change history
- **Issues** - See warnings and errors

## Working with LLM Changes

### Step 1: Get an LLM Plan

When working with an LLM (like GPT-4 or Claude), ask it to generate changes in this format:

```json
{
  "intent": "add feature",
  "rationale": "Adding user authentication",
  "edits": [
    {
      "path": "src/auth.ts",
      "operations": [
        {
          "type": "replace",
          "range": { "start": [10, 0], "end": [20, 0] },
          "text": "export function authenticate(token: string) {\n  // Implementation\n}"
        }
      ]
    }
  ],
  "risk": "medium"
}
```

### Step 2: Copy to Clipboard

Copy the entire JSON plan.

### Step 3: Preview Changes

```
Cmd/Ctrl + Shift + P → "Radium: Preview LLM Plan from Clipboard"
```

Radium will:
- Parse the plan
- Apply changes in memory
- Show you what will change
- Highlight any issues

### Step 4: Apply or Reject

- Click **Apply** to make the changes
- Click **Cancel** to discard them

### Step 5: Review in Map

The map updates to show:
- Changed files highlighted
- New relationships
- Impact on connected code

## Impact Analysis

### Check Before You Change

1. Select a function/class name
2. Run: `Radium: Find Impact`

Radium shows:
- **Fan-in**: What depends on this
- **Fan-out**: What this depends on
- **Affected tests**: Tests that cover this
- **Risk level**: Low/Medium/High

### Find Hotspots

Hotspots are symbols with many dependencies.

Open the map and look for:
- Larger nodes (more connections)
- Darker colors (higher complexity)
- Central positions (architectural hubs)

## Session Management

### View Recent Sessions

```
Radium: Show Changes
```

Select a session to see:
- Files changed
- Lines added/removed
- Rationale
- Timestamp

### Undo a Session

```
Radium: Undo Last LLM Session
```

Pick a session to rollback. Radium will:
- Revert all changes from that session
- Update the graph
- Keep the session in history (marked as reverted)

### Export a Session

```
Radium: Export Session Patch
```

Creates a patch file you can:
- Share with teammates
- Apply to other branches
- Archive for review

## Advanced Features

### Path Finding

In the map:
1. Shift-click first node
2. Shift-click second node
3. Radium highlights the shortest path

Use this to understand:
- Call chains
- Dependency paths
- Import sequences

### Layer Toggles

In the map controls:
- **Structure** - File/module hierarchy
- **Relations** - Imports and calls
- **Changes** - Recent edit highlights

Toggle layers to focus on different aspects.

### Custom Queries

In the Code Slices view:
- Filter by file type
- Search by symbol name
- Group by module

## Configuration

### Indexing Performance

```json
{
  "radium.indexer.maxCPU": 2
}
```

Adjust based on your machine:
- **1** - Minimal impact, slower indexing
- **2** - Balanced (default)
- **4+** - Fast indexing, more CPU usage

### Privacy Settings

```json
{
  "radium.privacy.upload": "none"
}
```

Options:
- **none** - All data stays local (default)
- **symbols** - Share symbol names only (for team features)
- **full** - Full cloud sync (requires account)

### Graph Layout

```json
{
  "radium.graph.layout": "force"
}
```

Options:
- **force** - Dynamic, spreads nodes evenly
- **hierarchical** - Tree-like, shows layers

### Auto-Testing

```json
{
  "radium.tests.autoRun": true
}
```

When enabled:
- Runs affected tests after LLM changes
- Shows test results in Issues view
- Blocks apply if tests fail

## Tips & Tricks

### 1. Keep the Map Open

Pin the map panel to track changes as you work. It updates in real-time.

### 2. Use Session Branches

Before applying risky LLM changes:
```
git checkout -b llm-experiment
```
Then run `Radium: Apply LLM Plan`. Easy to rollback if needed.

### 3. Review Before Commit

After applying LLM changes:
1. Check the map for unexpected connections
2. Run impact analysis on changed symbols
3. Review affected tests

### 4. Explain Unfamiliar Code

Select any code block and run:
```
Radium: Explain Selection
```

Radium shows:
- Symbols used in selection
- Their relationships
- Context in the project

### 5. Find Dead Code

In the map, look for:
- Isolated nodes (no incoming edges)
- Unused imports (grey edges)
- Orphaned functions

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Open Map | `Cmd/Ctrl + Shift + V M` |
| Find Impact | `Cmd/Ctrl + Shift + V I` |
| Apply Plan | `Cmd/Ctrl + Shift + V A` |
| Show Changes | `Cmd/Ctrl + Shift + V C` |

*Note: Set custom shortcuts in VS Code Keyboard Shortcuts*

## Troubleshooting

### Map Not Updating

1. Check if indexing is complete (status bar)
2. Manually refresh: `Radium: Refresh Sessions`
3. Restart the extension

### Large Project Performance

For projects with 10,000+ files:
1. Exclude build directories in `.gitignore`
2. Reduce `maxCPU` to avoid thrashing
3. Use hierarchical layout instead of force

### LLM Plan Errors

If plan preview fails:
1. Validate JSON syntax
2. Check file paths are relative
3. Ensure line numbers are 0-indexed
4. Verify range format: `[line, column]`

### Memory Issues

For very large projects:
1. Close unused workspaces
2. Restart VS Code
3. Clear extension storage:
   ```
   Cmd/Ctrl + Shift + P → "Developer: Clean Extension Storage"
   ```

## Best Practices

### 1. Small, Focused Changes

Break large LLM refactorings into smaller plans:
- One feature per session
- Single file when possible
- Incremental improvements

### 2. Test Coverage

Before applying LLM changes:
- Ensure tests exist for affected code
- Add tests if missing
- Enable `autoRun` to catch issues early

### 3. Review Every Change

Even with LLM assistance:
- Read the diffs
- Check the map for unexpected impacts
- Run tests manually
- Trust but verify

### 4. Document Sessions

In LLM plan rationale, include:
- Why this change is needed
- What alternatives were considered
- Expected impact

### 5. Keep History

Don't immediately rollback failed experiments:
- Learn from the issues
- Export the session for analysis
- Adjust future prompts

## Integration with Other Tools

### Git

Radium tags commits with session IDs:
```
git log --grep="Radium Session"
```

### CI/CD

Export session patches for:
- Code review automation
- Change impact reports
- Test coverage analysis

### Documentation

Use the map to:
- Generate architecture diagrams
- Document code structure
- Track technical debt

## Getting Help

- **Documentation**: `/docs/` in extension folder
- **Examples**: See sample LLM plans in `/examples/`
- **Issues**: Report bugs on GitHub
- **Discussions**: Join the community forum

## Next Steps

- Explore the [Architecture Guide](./architecture.md)
- Read the [API Documentation](./api.md) (coming soon)
- Check out [Example Workflows](./examples.md) (coming soon)

---

**Happy vibe coding! 🎨**

