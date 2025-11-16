# Performance Optimization - Symbol Realtime View

## Issue
Symbol realtime view was taking up to 10 seconds to display code changes after saving a file.

## Changes Made

### 1. Reduced File Watcher Delays

#### Symbol Changes Panel (`src/views/symbol-changes-panel.ts`)
- **Debounce delay**: 300ms → 100ms
- **Stability threshold**: 200ms → 50ms  
- **Poll interval**: 100ms → 25ms

#### Realtime Changes Panel (`src/views/realtime-changes-panel.ts`)
- **Debounce delay**: 300ms → 100ms
- **Stability threshold**: 200ms → 50ms
- **Poll interval**: 100ms → 25ms

#### Indexer (`src/indexer/indexer.ts`)
- **Stability threshold**: 300ms → 50ms
- **Poll interval**: 100ms → 25ms

### 2. Added Diagnostic Logging

Added timestamp logging in `symbol-changes-panel.ts` to track:
- When file change is detected
- When processing starts (after debounce)
- When processing completes
- Total processing time

## Expected Impact

**Before**: ~600ms+ file watcher delays + processing time
**After**: ~150ms+ file watcher delays + processing time

## Potential Causes of 10-Second Delay

If you're still experiencing 10-second delays, it could be:

1. **VSCode AutoSave Settings**: Check your VSCode settings for `files.autoSave` and `files.autoSaveDelay`
   - If set to `afterDelay` with a long delay (e.g., 10000ms), this would explain the issue
   - Recommendation: Set to `onFocusChange` or reduce `autoSaveDelay`

2. **Large File Processing**: The symbol analysis might take time for very large files
   - Check the diagnostic logs in "Output" → "Radium Symbol Changes" channel
   - Look for processing times in the logs

3. **Tree-sitter Parsing**: Complex files with many symbols might take longer to parse
   - The logs will show parsing duration

## How to Diagnose

1. Open the Output panel in VSCode (View → Output)
2. Select "Radium Symbol Changes" from the dropdown
3. Make a code change and save
4. Look for the ⏱️ emoji timestamps:
   - "File change detected" - when chokidar sees the change
   - "Processing started" - after debounce delay
   - "Processing completed" - when analysis finishes

The logs will show you exactly where the delay is occurring.

## Testing

To test the improvements:
1. Reload the VSCode window (Developer: Reload Window)
2. Open the Symbol Realtime View
3. Make a code change and save
4. Check the Output panel for timing information
5. Verify the change appears within 1-2 seconds

## Further Optimizations

If processing time is still high, consider:
- Caching parsed symbol trees
- Incremental parsing (only re-parse changed sections)
- Async/parallel processing of multiple files
- Reducing the complexity of symbol analysis

