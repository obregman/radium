# Radium Demos

This directory contains standalone demos of Radium visualizations.

## Available Demos

### 1. Symbol Changes Demo (`symbol-changes-demo.html`)
A real-time view that tracks code changes at the symbol level (functions, classes, methods, variables, etc.) as they happen in your codebase.

### 2. Files Map Demo (`file-map-demo.html`)
An interactive dependency graph showing files and directories with their relationships, symbol usage, and code quality metrics.

## Quick Start

**Just open any `.html` file in your browser!**

Demo data loads automatically. No installation, no setup, no dependencies required.

---

## Symbol Changes Demo

## How to use

1. **Open the demo**: Simply open `symbol-changes-demo.html` in any modern web browser
2. **Load demo data**: Click the "Load Demo Data" button in the top-right corner
3. **Explore**: Use the controls to interact with the visualization

## Features demonstrated

### Visual Elements
- **File containers**: Gray boxes representing files with their paths
- **Symbol boxes**: Individual code symbols with color-coded change types:
  - 🟢 Green = Added
  - 🟡 Yellow = Modified
  - 🔴 Red = Deleted
- **Change indicators**: Line additions (+) and deletions (-) shown on each symbol
- **Time labels**: How long ago each change occurred
- **Animations**: Pulsing borders and glowing effects for recent changes

### Interactive Controls
- **Pan**: Click and drag to move around the canvas
- **Zoom**: Use mouse wheel to zoom in/out (hold Shift for faster zoom)
- **Zoom buttons**: +/- buttons in bottom-right corner
- **Reset view**: ⟲ button to reset pan and zoom
- **Clear all**: 🗑️ button to remove all symbols
- **Auto-focus toggle**: Automatically center view on new changes

### Hover Features
- **Code icon (#)**: Hover to see the actual code diff
- **Comment icon (//)**: Hover to see associated comments (if any)
- **Symbol boxes**: Hover for scaling effect

## Mock Data

The demo includes realistic mock data showing:
- Multiple files being modified
- Various symbol types (functions, classes, methods, interfaces, variables, constants)
- Different change types (added, modified, deleted, value changed)
- Line change statistics
- Code diffs

## Technical Details

This is a completely standalone HTML file that:
- Uses the exact same CSS and JavaScript as the VSCode extension
- Removes VSCode-specific API calls
- Includes mock data instead of real file watching
- Works in any modern browser (Chrome, Firefox, Safari, Edge)

## Differences from the Extension

The demo does not include:
- Real-time file watching
- Integration with VSCode
- Opening files at specific lines
- Context menu actions (explain/revert)
- Clipboard integration

Everything else is identical to the actual extension!

---

## Files Map Demo

## How to use

1. **Open the demo**: Simply open `file-map-demo.html` in any modern web browser
2. **Explore the graph**: Demo data loads automatically showing a sample project structure
3. **Interact**: Use the controls to explore files, directories, and their relationships

## Features demonstrated

### Visual Elements
- **File nodes**: Colored rectangles representing files, sized by line count
- **Directory nodes**: Hexagonal containers grouping related files
- **Edges**: Lines showing containment and dependency relationships
- **Symbol indicators**: Small icons (f, v, t) showing functions, variables, and types
- **Code smell panel**: Metrics displayed when zooming into a file

### Color Modes
- **By Directory**: Files colored by their parent directory (default)
- **By Symbol Use**: Files colored by how many symbols they export (green = more exports)
- **By Code Smell**: Files colored by code quality score (green = clean, red = high smell)

### Interactive Controls
- **Pan**: Click and drag to move around the graph
- **Zoom**: Use mouse wheel to zoom in/out
- **Search**: Type in the search box to filter files and directories
- **Drag directories**: Click and drag directory nodes to reposition them (they'll stay pinned)
- **Click files**: Single click to zoom to a file, double click to "open" it (shows alert in demo)
- **Hover symbols**: Hover over f/v/t icons to see lists of functions, variables, or types
- **Copy path**: When zoomed in on a file, a copy button appears to copy the file path

### Graph Layout
- **Force-directed**: Files orbit around their parent directories
- **Hierarchical**: Directories show parent-child relationships
- **Collision detection**: Nodes avoid overlapping
- **Pinnable**: Drag directories to pin them in place

## Mock Data

The demo includes a realistic sample project:
- Multiple directories (src, services, models, utils, controllers)
- 7 TypeScript files with varying sizes and complexity
- Different code smell scores (10-55)
- Symbol lists for each file
- Directory hierarchy with containment edges

## Technical Details

This is a completely standalone HTML file that:
- Uses the exact same D3.js force-directed graph code as the VSCode extension
- Uses the exact same CSS styling
- Removes VSCode-specific API calls
- Includes mock data instead of real workspace indexing
- Works in any modern browser (Chrome, Firefox, Safari, Edge)

## Differences from the Extension

The demo does not include:
- Real-time workspace indexing
- Integration with VSCode
- Opening files in the editor
- Actual clipboard integration
- Persistent layout saving (resets on page reload)
- Real dependency analysis

Everything else is identical to the actual extension!

