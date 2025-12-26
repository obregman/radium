# Radium Demos

This directory contains standalone demos of Radium visualizations.

## Available Demos

### 1. Symbol Changes Demo (`symbol-changes-demo.html`)
A real-time view that tracks code changes at the symbol level (functions, classes, methods, variables, etc.) as they happen in your codebase.

### 2. File Structure Demo (`file-structure-demo.html`)
A graphical visualization showing your codebase organized by directory hierarchy with zoom and pan controls.

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

## File Structure Demo

### What is this?

The File Structure view provides a graphical visualization of your codebase, organizing files by their directory hierarchy with interactive zoom and pan controls. This demo lets you see what it looks like without installing the VSCode extension.

### How to use

1. **Open the demo**: Simply open `file-structure-demo.html` in any modern web browser
2. **Demo loads automatically**: The Stormline.Game project structure appears immediately
3. **Zoom**: Use mouse wheel to zoom in/out
4. **Pan**: Click and drag to move around
5. **Explore**: Click on file names to see simulated file opening actions

### Features demonstrated

#### Visual Elements
- **Root box**: Large gray box showing the project/workspace name
- **Category boxes**: Purple boxes for each top-level directory
- **Subdirectory boxes**: Dark boxes with blue borders containing files
- **Files**: Clickable text items listed within subdirectories
- **Graphical layout**: Visual hierarchy with boxes and spacing

#### Interactive Features
- **Zoom**: Mouse wheel to zoom in/out (0.1x to 4x)
- **Pan**: Click and drag to move around the canvas
- **Click files**: Simulates opening files (shows notification)
- **Auto-load**: Demo data loads automatically on page open
- **Smooth interactions**: D3.js-powered zoom and pan

### Mock Data

The demo displays a realistic project structure:

**Stormline.Game** - A C# game project with:
   - Views/ (Screens, Panels, Components)
   - Services/ (Network, Storage)
   - Utilities/ (Helpers, Extensions)
   - Data/ (Models, DTOs)
   - Controllers/ (API, Web)

### Technical Details

This is a completely standalone HTML file that:
- Uses D3.js v7 for graphical rendering and zoom/pan
- Uses the exact same rendering logic as the VSCode extension
- Removes VSCode-specific API calls
- Includes mock data instead of real file system access
- Works in any modern browser (Chrome, Firefox, Safari, Edge)

### Differences from the Extension

The demo does not include:
- Real file system access
- Integration with VSCode
- Actually opening files in an editor
- Radiumignore filtering
- Dynamic reloading on file changes

Everything else is identical to the actual extension!

