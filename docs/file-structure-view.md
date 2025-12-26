# File Structure View

## Overview

The File Structure view is a graphical visualization mode that displays your codebase files organized by directory hierarchy. It uses D3.js to render boxes representing directories and subdirectories, with zoom and pan capabilities for easy navigation.

## Implementation

### Files Created
- `src/views/file-structure-panel.ts` - Main panel class implementing the File Structure visualization

### Files Modified
- `src/extension.ts` - Added command registration for `radium.openFileStructure` and import for `FileStructurePanel`
- `package.json` - Added command to VS Code command palette
- `README.md` - Added documentation for the File Structure feature

## Architecture

### Component Structure

**FileStructurePanel Class** (`src/views/file-structure-panel.ts`)
- Follows the same webview panel pattern as other Radium views
- Communicates with webview via message passing
- Handles file opening when user clicks on file names

**Data Source**: `GraphStore`
- `getAllFiles()` - Returns all indexed files with metadata
- Files are filtered using `RadiumIgnore` to respect `.radium/radiumignore` patterns

**Command**: `radium.openFileStructure`
- Registered in extension activation
- Available in command palette as "Radium: File Structure"

## Data Model

### Directory Structure

The view organizes files into a hierarchical structure:

```typescript
interface DirectoryStructure {
  [key: string]: {
    subdirectories: { [key: string]: string[] }; // subdirectory -> files
    files: string[]; // files directly in this directory
  };
}
```

**Example Structure:**
```
{
  "src": {
    subdirectories: {
      "views": ["file-structure-panel.ts", "files-map-panel.ts"],
      "store": ["schema.ts"]
    },
    files: ["extension.ts"]
  },
  "docs": {
    subdirectories: {},
    files: ["README.md", "file-structure-view.md"]
  }
}
```

## Visual Layout

The table layout consists of:

1. **Root Header Row**: Displays workspace name (e.g., "Stormline.Game/")
2. **Category Header Row**: Shows top-level directories as column headers (e.g., "Views/", "Services/", "Utilities/", "Data/")
3. **Content Rows**: Each row can contain:
   - Subdirectory sections with their files
   - Direct files in the top-level directory
   - Empty cells for alignment

### Styling

- **Table**: Dark theme (#2d2d2d background) with visible borders
- **Headers**: Lighter background (#3d3d3d) with sticky positioning
- **Category Headers**: Purple/lavender background (#c8b6ff) for visual distinction
- **Subdirectory Names**: Blue (#4a9eff), underlined, bold
- **Files**: Clickable with hover effects (turns blue with underline)

## Features

### File Navigation
- Click any file name to open it in the editor
- Full path resolution from workspace root
- Error handling for missing files

### Responsive Layout
- Columns automatically adjust based on number of top-level directories
- Rows expand to accommodate content
- Scrollable for large codebases

### Radiumignore Integration
- Respects `.radium/radiumignore` patterns
- Filtered files are completely excluded from the view
- Same ignore logic as Files Map and other views

## Use Cases

1. **Quick Overview**: Get a bird's-eye view of project organization
2. **Directory Comparison**: See which directories contain the most files
3. **File Location**: Find files by their logical location in the hierarchy
4. **Structure Analysis**: Understand how files are distributed across modules
5. **Navigation**: Click to open files directly from the table

## Comparison with Files Map

| Feature | File Structure | Files Map |
|---------|---------------|-----------|
| Layout | Table-based | Force-directed graph |
| Visual | Clean rows/columns | Sized rectangles with physics |
| Organization | Strict hierarchy | Spatial clustering |
| File Size | Not shown | Rectangle size = line count |
| Relationships | Not shown | Arrows for imports/calls |
| Color Modes | None | Directory/Symbol/Smell |
| Best For | Quick scanning | Visual exploration |

## Future Enhancements

Potential improvements for future versions:

1. **Sorting Options**: Sort files by name, size, or modification date
2. **Filtering**: Search/filter files by name or extension
3. **File Metadata**: Show line counts, last modified dates
4. **Collapsible Sections**: Collapse/expand subdirectories
5. **Color Coding**: Optional color modes (by file type, size, etc.)
6. **Export**: Export table as CSV or markdown
7. **Multi-level Subdirectories**: Better handling of deeply nested structures

## Technical Notes

- Uses the same `GraphStore` data source as other views
- Minimal JavaScript in webview (no external libraries like D3.js)
- Lightweight and fast rendering
- Fully responsive to window resizing
- Works with multi-root workspaces

