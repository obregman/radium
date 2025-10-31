# Real-time Changes Feature

## Overview

The Real-time Changes feature provides live monitoring of file modifications in your workspace with visual diff display. It watches for file changes and displays them in an animated, intuitive interface.

## How It Works

### File Watching
- Uses `chokidar` to monitor the workspace directory
- Automatically filters out common directories (node_modules, .git, out, dist, build, .radium)
- Only tracks source files (TypeScript, JavaScript, Python, Java, Go, Rust, C/C++, C#, Swift, Kotlin, Ruby, PHP, Vue, Svelte)
- Waits for file write operations to complete before processing

### Visual Display

When a file changes, the interface displays:

1. **File Box**: Shows the changed file path
   - Appears in a vertical layout
   - Highlighted in orange for 5 seconds
   - Remains visible after highlight fades
   - **Hover tooltip**: Hover for 1.8 seconds to see a scrollable diff tooltip
     - Shows file name in header
     - Displays full diff with syntax highlighting
     - Stays open while hovering over tooltip
     - Scrollable for large diffs

2. **Diff Box**: Shows the actual code changes
   - Positioned to the right of the file box
   - Displays git diff with syntax highlighting:
     - Green background for additions (+)
     - Red background for deletions (-)
     - Gray for context lines
   - **Auto-focuses on latest change**: Automatically scrolls to and highlights the most recent change (last addition/deletion in the diff) with:
     - Pulsing glow animation
     - Animated arrow indicator (→)
     - Centered in the viewport
   - Visible for 5 seconds, then fades out
   - **Hover to keep open**: When you hover over a diff box, it stays visible until you move the cursor away (then hides after 2 seconds)
   - Scrollable for large diffs

3. **Connection Line**: Links file box to diff box
   - Dashed line connecting the two boxes
   - Visible for 5 seconds along with the diff
   - Fades out smoothly

### Git Integration

- Retrieves git diffs for each changed file
- First tries `git diff HEAD` (staged changes)
- Falls back to `git diff` (unstaged changes)
- Handles new files, modifications, and deletions

## Usage

1. Open the command palette (Cmd+Shift+P / Ctrl+Shift+P)
2. Run: `Radium: Real-time Changes`
3. The panel opens and starts monitoring immediately
4. Edit files in your workspace to see changes appear in real-time

### Navigation

- **Pan**: Click and drag on the background to move around
- **Zoom**: 
  - Use mouse wheel to zoom in/out (smooth, optimized for trackpads)
  - Hold **Shift** while scrolling for 3x faster zoom
  - Use the `+` and `−` buttons in the bottom-right
  - Click the `⟲` button to reset view to default
- **Clear All**: Click the 🗑️ "Clear All" button (bottom-left) to remove all file boxes and start fresh
- **Hover**: Move your mouse over a diff box to keep it visible for reading

## UI Elements

### Info Panel
- Fixed position in top-right corner
- Shows "Watching for Changes" status
- Displays the last changed file and timestamp

### File Positioning
- Files are positioned in a vertical layout
- Each unique file maintains its position
- New files appear below the previous one
- Position wraps to top when reaching bottom of screen

### Controls

**Zoom Controls (Bottom-right):**
- `+` button: Zoom in (up to 500%)
- `−` button: Zoom out (down to 10%)
- `⟲` button: Reset to 100% zoom and center position
- **Mouse Wheel**: Zoom towards cursor position
  - Smooth zoom (1.03x per scroll) optimized for trackpads
  - Hold **Shift** for 3x faster zoom (1.09x per scroll)
- **Zoom Level Display**: Shows current zoom percentage

**Clear Button (Bottom-left):**
- 🗑️ **Clear All**: Removes all file boxes, diff boxes, and connection lines
- Smooth fade-out animation
- Resets file positions
- Useful for decluttering the view

## Technical Details

### Implementation
- **Panel**: `src/views/realtime-changes-panel.ts`
- **Command**: `radium.realtimeChanges`
- **Dependencies**: chokidar (file watching), child_process (git commands)

### Performance
- File write stabilization (200ms threshold)
- Efficient filtering of non-source files
- Automatic cleanup of old visual elements
- Smooth CSS transitions for all animations

### Timing
- File box highlight: 5 seconds
- Diff box display: 5 seconds (or until user stops hovering)
- Connection line display: 5 seconds (linked to diff box)
- Fade out transition: 300ms
- Hover exit delay: 2 seconds after cursor leaves diff box

## Use Cases

- **Live Coding Sessions**: Monitor changes as you code
- **Pair Programming**: Show real-time changes to collaborators
- **Code Review**: Track modifications during review sessions
- **LLM Interactions**: Watch AI-generated changes appear live
- **Learning**: Understand what changed and why

## Limitations

- Only tracks files within the workspace
- Requires git for diff generation
- Large diffs may be truncated in the display
- Does not track binary files or non-source files

