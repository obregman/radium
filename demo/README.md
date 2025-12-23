# Radium Symbol Changes Demo

This directory contains a standalone demo of the Radium Symbol Changes visualization.

## What is this?

The Symbol Changes visualization is a real-time view that tracks code changes at the symbol level (functions, classes, methods, variables, etc.) as they happen in your codebase. This demo lets you see what it looks like without installing the VSCode extension.

## Quick Start

**Just open `symbol-changes-demo.html` in your browser and click "Load Demo Data"!**

No installation, no setup, no dependencies required.

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

