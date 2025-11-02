# Symbol Changes Visualization

## Overview

The Symbol Changes visualization mode provides an intuitive, graph-based view of code changes by representing code structures as visual symbols rather than displaying raw diffs. This makes complex changes easier to understand at a glance.

## Features

### Visual Symbol Types

Each code structure is represented by a distinct visual element:

- **Functions** - Teal rounded boxes with change statistics
- **Classes** - Blue rectangular boxes  
- **Methods** - Purple rounded boxes
- **Interfaces** - Light blue dashed boxes
- **Types** - Light blue dashed boxes
- **Variables** - Yellow rounded boxes with values
- **Constants** - Gold rounded boxes with values

### Change Indicators

Symbols pulse with different colors to indicate the type of change:

- **Green pulse** - Newly added symbols (functions, variables, interfaces)
- **Yellow pulse** - Modified symbols (changed function bodies)
- **Orange pulse** - Value changed (variable/constant values updated)
- **Red pulse** - Deleted symbols (shown with reduced opacity)

### Detected Changes

The visualization automatically detects and displays:

1. **Function Changes**
   - New functions added
   - Existing functions modified (shows +/- line counts)
   - Functions deleted

2. **Variable Changes**
   - New variables declared (shows initial value)
   - New constants declared (shows initial value)
   - Variable value changes (shows old → new)

3. **Type Changes**
   - New interfaces created
   - New type aliases created
   - Interface modifications

4. **Call Relationships**
   - New function calls added
   - Calls between changed functions
   - Method invocations

### Call Relationships

Animated curved arrows connect symbols that call each other, making it easy to understand the flow and dependencies in your code changes.

### File Organization

Changes are grouped by file, with each file getting its own horizontal section. File labels show the relative path and indicate if it's a new file.

## How It Works

1. **File Watching** - Monitors your workspace for changes to source files
2. **Diff Analysis** - Retrieves git diffs for changed files
3. **Symbol Extraction** - Parses the current file state to extract functions, classes, methods, and interfaces
4. **Change Mapping** - Maps changed lines to their containing symbols
5. **Call Detection** - Identifies function calls between symbols
6. **Visualization** - Renders symbols as boxes with animated connectors

## Usage

### Opening the View

Run the command: `Radium: Symbol Changes`

### Navigation

- **Pan** - Click and drag the canvas
- **Zoom** - Mouse wheel (hold Shift for faster zoom)
- **Reset** - Click the reset button (⟲) in the bottom-right

### Clearing the View

Click the "Clear All" button in the bottom-left to remove all symbols and reset the view.

## Supported Languages

The visualization currently supports:

- TypeScript (.ts, .tsx)
- JavaScript (.js, .jsx, .mjs, .cjs)
- Python (.py, .pyx, .pyi)
- Java (.java)
- Kotlin (.kt)
- Scala (.scala)
- Go (.go)
- Rust (.rs)
- C/C++ (.c, .cpp, .h, .hpp)
- C# (.cs)
- Swift (.swift)
- Ruby (.rb)
- PHP (.php)
- Vue (.vue)
- Svelte (.svelte)

## Technical Details

### Symbol Detection

The visualization uses tree-sitter parsers to accurately extract symbols from source code. This ensures:

- Precise symbol boundaries
- Correct nesting (methods within classes)
- Accurate call site detection

### Performance

- **Debouncing** - File changes are debounced (300ms) to avoid excessive processing
- **Caching** - Git diffs are cached (2s TTL) to reduce git command overhead
- **Selective Parsing** - Only changed files are re-parsed

### Limitations

- Call detection only works within the same file
- Only shows calls between changed symbols
- Complex call chains (callbacks, promises) may not be fully visualized
- Method calls on objects are simplified (e.g., `obj.method()` becomes `method`)

## Comparison with Real-time File Changes

| Feature | Symbol Visualization | Real-time File Changes |
|---------|---------------|-------------------|
| View Type | Symbol graph | Code diff |
| Best For | Understanding structure | Reviewing code details |
| Shows | Functions, classes, calls | Line-by-line changes |
| Complexity | High-level overview | Detailed inspection |
| Learning Curve | Intuitive | Requires diff knowledge |

## Future Enhancements

Potential improvements for future versions:

- Cross-file call relationships
- Symbol filtering by type
- Grouping by component/module
- Time-based playback of changes
- Integration with git history
- Export as diagram/image

