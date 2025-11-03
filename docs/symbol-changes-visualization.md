# Symbol Changes Visualization

## Overview

The Symbol Changes visualization mode provides an intuitive, graph-based view of code changes by representing code structures as visual symbols rather than displaying raw diffs. This makes complex changes easier to understand at a glance.

## Features

### Visual Symbol Types

Each code structure is represented by a distinct visual element with minimalist styling:

- **Functions** - Teal rounded rectangles (180×70px) in right column
- **Classes** - Blue rounded rectangles in right column
- **Methods** - Purple rounded rectangles in right column
- **Interfaces** - Light blue dashed rectangles in right column
- **Types** - Light blue dashed rectangles in right column
- **Variables** - Yellow circles (80px diameter) in left column
- **Constants** - Gold circles (80px diameter) in left column

### Layout

The visualization uses a **dynamic row-based layout** for each file:

- **Adaptive Rows**: Only categories with changes are displayed
- **Row Order** (top to bottom):
  1. Variables & Constants (circles)
  2. Types & Interfaces (rounded rectangles)
  3. Classes (rounded rectangles)
  4. Functions & Methods (rounded rectangles)
- **Horizontal Flow**: Symbols of the same type flow left-to-right within their row
- **Smart Spacing**: 15px between symbols, 25px between rows

#### Examples

**Only functions changed:**
```
Row 1: [function1] [function2] [function3]
```

**Functions and variables changed:**
```
Row 1: [var1] [var2]
Row 2: [function1] [function2]
```

**All types changed:**
```
Row 1: [var1] [var2] [var3]
Row 2: [IType1] [IType2]
Row 3: [MyClass]
Row 4: [func1] [func2] [func3]
```

### Change Indicators

Each symbol displays a **change symbol** next to its name:

- `*` (asterisk) - **Added**: Newly created symbol
- `~` (tilde) - **Modified**: Changed or value updated
- `-` (minus) - **Deleted**: Removed symbol (shown with reduced opacity)

Additionally, symbols use subtle border animations:
- **Green border pulse** - Added symbols
- **Yellow border pulse** - Modified symbols
- **Red border pulse** - Deleted symbols

All animations are gentle and non-distracting, with a 3-second cycle time.

### Symbol Content

Each symbol box contains **only two elements**:
1. **Symbol name** - The function/variable/type/class name
2. **Change symbol** - `*`, `~`, or `-` indicator

This minimalist design ensures maximum clarity and scannability.

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

