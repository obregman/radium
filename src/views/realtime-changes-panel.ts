import * as vscode from 'vscode';
import * as chokidar from 'chokidar';
import * as cp from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { RadiumIgnore } from '../config/radium-ignore';

const exec = promisify(cp.exec);

interface FileChange {
  filePath: string;
  timestamp: number;
  diff: string;
  isNew: boolean;
}

export class RealtimeChangesPanel {
  public static currentPanel: RealtimeChangesPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private watcher?: chokidar.FSWatcher;
  private workspaceRoot: string;
  private pendingChanges = new Map<string, NodeJS.Timeout>();
  private diffCache = new Map<string, { diff: string; timestamp: number }>();
  private fileHashes = new Map<string, string>(); // Track file content hashes
  private filesCreatedThisSession = new Set<string>(); // Track files created during this session
  private radiumIgnore: RadiumIgnore;
  private readonly DEBOUNCE_DELAY = 300; // ms
  private readonly CACHE_TTL = 2000; // ms

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    workspaceRoot: string
  ) {
    this.panel = panel;
    this.workspaceRoot = workspaceRoot;
    this.radiumIgnore = new RadiumIgnore(workspaceRoot);

    // Set HTML content
    this.panel.webview.html = this.getHtmlContent(extensionUri);

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      message => {
        switch (message.type) {
          case 'clearAll':
            // Clear session tracking when user clicks "Clear All"
            this.filesCreatedThisSession.clear();
            console.log('[Radium] Cleared session file tracking');
            break;
        }
      },
      null,
      this.disposables
    );

    // Clean up when panel is closed
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Start watching for file changes
    this.startWatching();
  }

  public static createOrShow(extensionUri: vscode.Uri, workspaceRoot: string) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (RealtimeChangesPanel.currentPanel) {
      RealtimeChangesPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'realtimeChanges',
      'Radium: Real-time File Changes',
      column || vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    RealtimeChangesPanel.currentPanel = new RealtimeChangesPanel(panel, extensionUri, workspaceRoot);
  }

  private startWatching() {
    // Watch for file changes, excluding common directories
    this.watcher = chokidar.watch(this.workspaceRoot, {
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/out/**',
        '**/dist/**',
        '**/build/**',
        '**/.radium/**',
        '**/.*' // Ignore hidden files
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100
      }
    });

    this.watcher.on('change', async (filePath: string) => {
      await this.handleFileChange(filePath, false);
    });

    this.watcher.on('add', async (filePath: string) => {
      await this.handleFileChange(filePath, true);
    });

    this.watcher.on('unlink', async (filePath: string) => {
      // Only track source files
      if (!this.isSourceFile(filePath)) {
        return;
      }

      // Remove from session tracking if file is deleted
      const relativePath = path.relative(this.workspaceRoot, filePath);
      const wasInSession = this.filesCreatedThisSession.has(relativePath);
      this.filesCreatedThisSession.delete(relativePath);
      
      console.log(`[Radium] File deleted: ${relativePath}, was in session: ${wasInSession}`);
      
      // If the file was being tracked in the view, remove it
      if (wasInSession) {
        this.panel.webview.postMessage({
          type: 'file:deleted',
          data: {
            filePath: relativePath,
            timestamp: Date.now()
          }
        });
      }
    });
  }

  private async handleFileChange(absolutePath: string, isNewFile: boolean) {
    // Only track source files
    if (!this.isSourceFile(absolutePath)) {
      return;
    }

    // Track files created during this session
    const relativePath = path.relative(this.workspaceRoot, absolutePath);
    
    // Check if file should be ignored
    if (this.radiumIgnore.shouldIgnore(relativePath)) {
      console.log(`[Radium] Ignoring file: ${relativePath}`);
      return;
    }
    
    if (isNewFile) {
      this.filesCreatedThisSession.add(relativePath);
      console.log(`[Radium] File created this session: ${relativePath}`);
    }

    // Clear existing timeout for this file (debouncing)
    if (this.pendingChanges.has(absolutePath)) {
      clearTimeout(this.pendingChanges.get(absolutePath)!);
    }

    // Debounce: wait before processing to avoid rapid fire during typing
    const timeout = setTimeout(async () => {
      this.pendingChanges.delete(absolutePath);
      await this.processFileChange(absolutePath);
    }, this.DEBOUNCE_DELAY);

    this.pendingChanges.set(absolutePath, timeout);
  }

  private async processFileChange(absolutePath: string) {
    // Convert to relative path
    const relativePath = path.relative(this.workspaceRoot, absolutePath);

    // Clear cache for this file to ensure we get fresh diff
    this.diffCache.delete(relativePath);

    // Get git diff for the file (without using stale cache)
    const diff = await this.getFileDiff(relativePath);

    // Check if changes were reverted (no diff means file matches HEAD)
    const hasChanges = diff && diff !== 'No diff available' && diff.trim().length > 0;
    
    if (!hasChanges) {
      // Changes were reverted - remove the file box
      console.log(`[Radium] Changes reverted for ${relativePath}, removing file box`);
      this.panel.webview.postMessage({
        type: 'file:reverted',
        data: {
          filePath: relativePath,
          timestamp: Date.now()
        }
      });
      
      return;
    }

    // Check if file was created during this session
    const isNew = this.filesCreatedThisSession.has(relativePath);

    // Send change to webview
    this.panel.webview.postMessage({
      type: 'file:changed',
      data: {
        filePath: relativePath,
        timestamp: Date.now(),
        diff: diff,
        isNew: isNew
      }
    });
  }

  private async getFileDiff(filePath: string): Promise<string> {
    // Check cache first
    const cached = this.diffCache.get(filePath);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      console.log(`[Radium] Using cached diff for ${filePath}`);
      return cached.diff;
    }

    try {
      console.log(`[Radium] Getting diff for: ${filePath}`);
      
      // Check if this is a git repository first
      let isGitRepo = false;
      try {
        await exec('git rev-parse --git-dir', { cwd: this.workspaceRoot });
        isGitRepo = true;
      } catch {
        console.log(`[Radium] Not a git repository, will treat all files as new`);
      }
      
      // If not a git repo, generate full-file diff for all files
      if (!isGitRepo) {
        const fullPath = path.join(this.workspaceRoot, filePath);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          const diff = `+++ ${filePath}\n` + lines.map(line => `+${line}`).join('\n') + '\n';
          
          this.diffCache.set(filePath, { diff, timestamp: Date.now() });
          this.cleanupCache();
          return diff;
        } else {
          return 'No diff available';
        }
      }
      
      // Try git diff HEAD first
      let diff: string = '';
      try {
        const { stdout } = await exec(`git diff HEAD -- "${filePath}"`, {
          cwd: this.workspaceRoot
        });
        if (stdout) {
          console.log(`[Radium] Got diff from HEAD for ${filePath}`);
          diff = stdout;
        }
      } catch (headError: any) {
        console.warn(`[Radium] git diff HEAD failed for ${filePath}:`, headError.message);
      }

      // If no diff from HEAD, try unstaged diff
      if (!diff) {
        try {
          const { stdout: unstagedDiff } = await exec(`git diff -- "${filePath}"`, {
            cwd: this.workspaceRoot
          });
          
          if (unstagedDiff) {
            console.log(`[Radium] Got unstaged diff for ${filePath}`);
            diff = unstagedDiff;
          }
        } catch (unstagedError: any) {
          console.warn(`[Radium] git diff unstaged failed for ${filePath}:`, unstagedError.message);
        }
      }
      
      // If still no diff, check if file is tracked
      if (!diff) {
        let isTracked = false;
        try {
          await exec(`git ls-files --error-unmatch "${filePath}"`, {
            cwd: this.workspaceRoot
          });
          isTracked = true;
          console.log(`[Radium] File ${filePath} is tracked but has no diff`);
        } catch {
          isTracked = false;
          console.log(`[Radium] File ${filePath} is not tracked`);
        }
        
        // If not tracked, generate a full-file diff
        if (!isTracked) {
          try {
            const fullPath = path.join(this.workspaceRoot, filePath);
            if (fs.existsSync(fullPath)) {
              const content = fs.readFileSync(fullPath, 'utf8');
              const lines = content.split('\n');
              diff = `+++ ${filePath}\n`;
              lines.forEach((line: string) => {
                diff += `+${line}\n`;
              });
              console.log(`[Radium] Generated full-file diff for untracked ${filePath}`);
            } else {
              console.warn(`[Radium] File does not exist: ${fullPath}`);
              diff = 'No diff available';
            }
          } catch (error) {
            console.error(`[Radium] Failed to read new file ${filePath}:`, error);
            diff = 'No diff available';
          }
        } else {
          // File is tracked but has no changes
          diff = '';
        }
      }

      // Cache the result
      this.diffCache.set(filePath, {
        diff: diff,
        timestamp: Date.now()
      });

      // Clean up old cache entries (keep cache size manageable)
      this.cleanupCache();

      return diff;
    } catch (error: any) {
      console.error(`[Radium] Failed to get diff for ${filePath}:`, error.message || error);
      return 'Error getting diff';
    }
  }

  private cleanupCache() {
    const now = Date.now();
    const entriesToDelete: string[] = [];

    // Find expired entries
    for (const [filePath, entry] of this.diffCache.entries()) {
      if (now - entry.timestamp > this.CACHE_TTL) {
        entriesToDelete.push(filePath);
      }
    }

    // Delete expired entries
    for (const filePath of entriesToDelete) {
      this.diffCache.delete(filePath);
    }

    // If cache is still too large (>100 entries), remove oldest entries
    if (this.diffCache.size > 100) {
      const entries = Array.from(this.diffCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      
      const toRemove = entries.slice(0, this.diffCache.size - 100);
      for (const [filePath] of toRemove) {
        this.diffCache.delete(filePath);
      }
    }
  }

  private isSourceFile(filePath: string): boolean {
    const sourceExtensions = [
      // JavaScript/TypeScript
      '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
      // Python
      '.py', '.pyx', '.pyi',
      // JVM languages
      '.java', '.kt', '.scala', '.groovy',
      // Systems programming
      '.go', '.rs', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
      // .NET
      '.cs', '.vb', '.fs', '.xaml',
      // Mobile
      '.swift', '.m', '.mm',
      // Ruby
      '.rb', '.rake',
      // PHP
      '.php',
      // Web frameworks
      '.vue', '.svelte',
      // Markup & Config
      '.html', '.htm', '.xml', '.json', '.yaml', '.yml', '.toml',
      // Stylesheets
      '.css', '.scss', '.sass', '.less',
      // Shell
      '.sh', '.bash', '.zsh', '.fish',
      // Other
      '.sql', '.graphql', '.proto', '.thrift'
    ];
    return sourceExtensions.some(ext => filePath.endsWith(ext));
  }

  private getHtmlContent(extensionUri: vscode.Uri): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Real-time File Changes</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: var(--vscode-font-family);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      padding: 20px;
      overflow: hidden;
    }

    #container {
      width: 100%;
      height: 100vh;
      position: relative;
      overflow: hidden;
      cursor: grab;
    }

    #container.panning {
      cursor: grabbing;
    }

    #canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      transform-origin: 0 0;
      transition: transform 0.1s ease-out;
    }

    #canvas.no-transition {
      transition: none;
    }

    .file-box {
      position: absolute;
      padding: 12px 20px;
      background-color: var(--vscode-editor-background);
      border: 2px solid var(--vscode-panel-border);
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      transition: all 0.3s ease;
      z-index: 10;
    }

    .file-box.highlight {
      background-color: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      box-shadow: 0 6px 20px rgba(255, 165, 0, 0.5);
      transform: scale(1.05);
    }

    .file-hover-tooltip {
      position: absolute;
      background-color: var(--vscode-editor-background);
      border: 2px solid var(--vscode-button-background);
      border-radius: 8px;
      padding: 12px 12px 12px 30px;
      max-width: 500px;
      max-height: 300px;
      overflow: auto;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
      z-index: 100;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      white-space: pre-wrap;
      word-wrap: break-word;
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: none;
      scroll-behavior: smooth;
    }

    .file-hover-tooltip.visible {
      opacity: 1;
      pointer-events: auto;
    }

    .file-hover-tooltip .tooltip-header {
      font-weight: bold;
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-button-background);
    }

    .diff-box {
      position: absolute;
      padding: 16px 16px 16px 30px;
      background-color: var(--vscode-editor-background);
      border: 2px solid var(--vscode-panel-border);
      border-radius: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      max-width: 600px;
      max-height: 400px;
      overflow: auto;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      white-space: pre-wrap;
      word-wrap: break-word;
      z-index: 5;
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .diff-box.visible {
      opacity: 1;
    }

    .diff-line {
      font-family: 'Courier New', monospace;
      line-height: 1.4;
    }

    .diff-line.addition {
      background-color: rgba(0, 255, 0, 0.1);
      color: #90ee90;
    }

    .diff-line.deletion {
      background-color: rgba(255, 0, 0, 0.1);
      color: #ff6b6b;
    }

    .diff-line.context {
      color: var(--vscode-editor-foreground);
      opacity: 0.7;
    }

    .diff-line.latest-change {
      position: relative;
      animation: highlightPulse 2s ease-in-out;
    }

    .diff-line.latest-change::before {
      content: '→';
      position: absolute;
      left: -24px;
      font-size: 18px;
      font-weight: bold;
      color: var(--vscode-button-background);
      text-shadow: 0 0 8px var(--vscode-button-background);
      animation: arrowBounce 1s ease-in-out infinite;
    }

    @keyframes highlightPulse {
      0%, 100% { 
        box-shadow: none;
      }
      50% { 
        box-shadow: 0 0 15px rgba(255, 165, 0, 0.6);
      }
    }

    @keyframes arrowBounce {
      0%, 100% {
        transform: translateX(0);
      }
      50% {
        transform: translateX(-5px);
      }
    }

    .connection-line {
      position: absolute;
      stroke: var(--vscode-panel-border);
      stroke-width: 2;
      stroke-dasharray: 5, 5;
      fill: none;
      z-index: 1;
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .connection-line.visible {
      opacity: 1;
    }

    #info {
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 12px 16px;
      background-color: var(--vscode-panel-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      font-size: 13px;
      z-index: 100;
    }

    #info h3 {
      margin-bottom: 0;
      font-size: 14px;
      color: var(--vscode-button-background);
    }

    #info p {
      margin: 4px 0;
      opacity: 0.8;
    }

    .timestamp {
      font-size: 11px;
      opacity: 0.6;
      margin-top: 4px;
    }

    #zoom-controls {
      position: fixed;
      bottom: 20px;
      right: 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 100;
    }

    .zoom-button {
      width: 40px;
      height: 40px;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid var(--vscode-button-border);
      border-radius: 6px;
      font-size: 18px;
      font-weight: bold;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    }

    .zoom-button:hover {
      background-color: var(--vscode-button-hoverBackground);
      transform: scale(1.05);
    }

    .zoom-button:active {
      transform: scale(0.95);
    }

    #zoom-level {
      text-align: center;
      font-size: 11px;
      opacity: 0.7;
      padding: 4px;
    }

    #clear-button {
      position: fixed;
      bottom: 20px;
      left: 20px;
      padding: 10px 16px;
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-button-border);
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      z-index: 100;
      transition: all 0.2s ease;
    }

    #clear-button:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
      transform: scale(1.05);
    }

    #clear-button:active {
      transform: scale(0.95);
    }
  </style>
</head>
<body>
  <div id="info">
    <h3>🔴 Watching for Changes</h3>
  </div>
  <div id="zoom-controls">
    <button class="zoom-button" id="zoom-in" title="Zoom In">+</button>
    <div id="zoom-level">100%</div>
    <button class="zoom-button" id="zoom-out" title="Zoom Out">−</button>
    <button class="zoom-button" id="zoom-reset" title="Reset View">⟲</button>
  </div>
  <button id="clear-button" title="Clear all file boxes">
    <span>🗑️</span>
    <span>Clear All</span>
  </button>
  <div id="container">
    <div id="canvas">
      <svg id="connections" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none;">
      </svg>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const container = document.getElementById('container');
    const canvas = document.getElementById('canvas');
    const connectionsContainer = document.getElementById('connections');
    const zoomLevelEl = document.getElementById('zoom-level');

    // Track active elements for cleanup
    let activeElements = [];

    // Pan and zoom state
    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let isPanning = false;
    let startX = 0;
    let startY = 0;

    // Position tracking for file boxes
    const filePositions = new Map();
    let nextPosition = { x: 100, y: 100 };
    const FILE_BOX_HEIGHT = 60; // Height including spacing
    
    // Track previous diffs to detect new changes
    const previousDiffs = new Map();

    function getFilePosition(filePath) {
      if (!filePositions.has(filePath)) {
        filePositions.set(filePath, { ...nextPosition });
        // Move to next position (vertically) - no limit, just keep stacking
        nextPosition.y += FILE_BOX_HEIGHT;
      }
      return filePositions.get(filePath);
    }

    function formatDiff(diffText, uniqueId, filePath) {
      const lines = diffText.split('\\n');
      let formattedLines = [];
      let lastChangeIndex = -1;
      let lowestNewChangeLineNumber = Infinity;
      let currentHunkStart = 0;
      
      console.log('[Radium] Parsing diff for', uniqueId, 'file:', filePath);
      
      // Get previous diff for comparison
      const previousDiff = previousDiffs.get(filePath) || '';
      const previousLines = new Set(previousDiff.split('\\n'));
      
      // First pass: format all lines and find NEW changes (not in previous diff)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (line.startsWith('@@')) {
          // Parse hunk header to get starting line number
          // Format: @@ -old_start,old_count +new_start,new_count @@
          const match = line.match(/@@ -\\d+(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/);
          if (match) {
            currentHunkStart = parseInt(match[1], 10);
            console.log('[Radium] Found hunk starting at line', currentHunkStart, ':', line);
          }
          formattedLines.push({ type: 'hunk', content: line, index: i, lineNumber: currentHunkStart });
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          // This is an addition
          const isNewChange = !previousLines.has(line);
          console.log('[Radium] Addition at line', currentHunkStart, ':', line.substring(0, 50), isNewChange ? '(NEW)' : '(old)');
          
          if (isNewChange && currentHunkStart < lowestNewChangeLineNumber) {
            console.log('[Radium] New lowest NEW change line:', currentHunkStart, '(was', lowestNewChangeLineNumber, ')');
            lowestNewChangeLineNumber = currentHunkStart;
            lastChangeIndex = i;
          }
          formattedLines.push({ type: 'addition', content: line, index: i, lineNumber: currentHunkStart });
          currentHunkStart++; // Additions increment the line counter
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          // This is a deletion
          const isNewChange = !previousLines.has(line);
          console.log('[Radium] Deletion at line', currentHunkStart, ':', line.substring(0, 50), isNewChange ? '(NEW)' : '(old)');
          
          if (isNewChange && currentHunkStart < lowestNewChangeLineNumber) {
            console.log('[Radium] New lowest NEW change line:', currentHunkStart, '(was', lowestNewChangeLineNumber, ')');
            lowestNewChangeLineNumber = currentHunkStart;
            lastChangeIndex = i;
          }
          formattedLines.push({ type: 'deletion', content: line, index: i, lineNumber: currentHunkStart });
          // Deletions don't increment the new file line counter
        } else {
          // Context line - exists in both old and new
          formattedLines.push({ type: 'context', content: line, index: i, lineNumber: currentHunkStart });
          if (!line.startsWith('---') && !line.startsWith('+++') && line.trim().length > 0) {
            currentHunkStart++; // Context lines increment the counter
          }
        }
      }
      
      console.log('[Radium] Final lowest NEW change line:', lowestNewChangeLineNumber, 'at index', lastChangeIndex);
      
      // Store current diff for next comparison
      previousDiffs.set(filePath, diffText);
      
      // Second pass: generate HTML with the last change marked
      let formattedHtml = '';
      for (const lineData of formattedLines) {
        const isLatestChange = lineData.index === lastChangeIndex;
        const latestClass = isLatestChange ? ' latest-change' : '';
        const latestId = isLatestChange ? \` id="latest-change-\${uniqueId}"\` : '';
        
        if (lineData.type === 'addition') {
          formattedHtml += \`<div class="diff-line addition\${latestClass}"\${latestId}>\${escapeHtml(lineData.content)}</div>\`;
        } else if (lineData.type === 'deletion') {
          formattedHtml += \`<div class="diff-line deletion\${latestClass}"\${latestId}>\${escapeHtml(lineData.content)}</div>\`;
        } else if (lineData.type === 'hunk') {
          formattedHtml += \`<div class="diff-line context" style="font-weight: bold;">\${escapeHtml(lineData.content)}</div>\`;
        } else {
          formattedHtml += \`<div class="diff-line context">\${escapeHtml(lineData.content)}</div>\`;
        }
      }
      
      return formattedHtml;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function createFileTooltip(filePath, diff, fileBox, hideTooltipTimeoutRef) {
      const tooltip = document.createElement('div');
      tooltip.className = 'file-hover-tooltip';
      
      // Create header
      const header = document.createElement('div');
      header.className = 'tooltip-header';
      header.textContent = filePath;
      tooltip.appendChild(header);
      
      // Create diff content
      const diffContent = document.createElement('div');
      const tooltipId = 'tooltip-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      diffContent.innerHTML = formatDiff(diff, tooltipId, filePath);
      tooltip.appendChild(diffContent);
      
      // Cancel hide timeout when hovering over tooltip
      tooltip.addEventListener('mouseenter', (e) => {
        e.stopPropagation();
        if (hideTooltipTimeoutRef.value) {
          clearTimeout(hideTooltipTimeoutRef.value);
          hideTooltipTimeoutRef.value = null;
        }
      });
      
      // Close tooltip when leaving it
      tooltip.addEventListener('mouseleave', () => {
        tooltip.classList.remove('visible');
        setTimeout(() => {
          if (tooltip.parentNode) {
            tooltip.remove();
          }
        }, 200);
      });
      
      // Allow mouse wheel scrolling inside tooltip without zooming the canvas
      tooltip.addEventListener('wheel', (e) => {
        e.stopPropagation(); // Prevent canvas zoom
        
        // Let the browser handle the scroll naturally
        // The tooltip has overflow: auto, so it will scroll
      }, { passive: true });
      
      return tooltip;
    }

    function formatTimestamp(timestamp) {
      const date = new Date(timestamp);
      return date.toLocaleTimeString();
    }

    function handleFileChange(data) {
      const { filePath, timestamp, diff, isNew } = data;

      // Get or create file box position
      const filePos = getFilePosition(filePath);

      // Create file box
      const fileBox = document.createElement('div');
      fileBox.className = 'file-box highlight';
      fileBox.textContent = filePath + (isNew ? ' *' : '');
      fileBox.style.left = filePos.x + 'px';
      fileBox.style.top = filePos.y + 'px';
      
      // Store diff data for tooltip
      fileBox.setAttribute('data-diff', diff);
      fileBox.setAttribute('data-filepath', filePath);
      
      // Add hover handlers for tooltip
      let hoverTimeout = null;
      let hideTooltipTimeout = null;
      let tooltip = null;
      
      // Create a reference object to share the timeout with the tooltip
      const hideTooltipTimeoutRef = { value: null };
      
      fileBox.addEventListener('mouseenter', (e) => {
        // Cancel any pending hide
        if (hideTooltipTimeoutRef.value) {
          clearTimeout(hideTooltipTimeoutRef.value);
          hideTooltipTimeoutRef.value = null;
        }
        
        // Wait 1.8 seconds before showing tooltip
        hoverTimeout = setTimeout(() => {
          tooltip = createFileTooltip(filePath, diff, fileBox, hideTooltipTimeoutRef);
          canvas.appendChild(tooltip);
          
          // Position tooltip above or below the file box
          const boxRect = fileBox.getBoundingClientRect();
          const canvasRect = canvas.getBoundingClientRect();
          
          const tooltipX = filePos.x;
          const tooltipY = filePos.y + 50; // Below the file box
          
          tooltip.style.left = tooltipX + 'px';
          tooltip.style.top = tooltipY + 'px';
          
          // Show tooltip
          setTimeout(() => tooltip.classList.add('visible'), 10);
        }, 1800);
      });
      
      fileBox.addEventListener('mouseleave', () => {
        // Cancel tooltip if not shown yet
        if (hoverTimeout) {
          clearTimeout(hoverTimeout);
          hoverTimeout = null;
        }
        
        // Delay hiding tooltip to allow moving cursor to it
        if (tooltip) {
          hideTooltipTimeoutRef.value = setTimeout(() => {
            if (tooltip) {
              tooltip.classList.remove('visible');
              setTimeout(() => {
                if (tooltip && tooltip.parentNode) {
                  tooltip.remove();
                }
                tooltip = null;
              }, 200);
            }
          }, 300); // 300ms delay to move cursor to tooltip
        }
      });
      
      canvas.appendChild(fileBox);

      // Wait for the fileBox to render so we can get its actual width
      setTimeout(() => {
        // Calculate the maximum right edge of all file boxes
        const allFileBoxes = Array.from(canvas.querySelectorAll('.file-box'));
        let maxRightEdge = 0;
        
        allFileBoxes.forEach(box => {
          const boxLeft = parseInt(box.style.left) || 0;
          const boxWidth = box.offsetWidth || 0;
          const rightEdge = boxLeft + boxWidth;
          if (rightEdge > maxRightEdge) {
            maxRightEdge = rightEdge;
          }
        });
        
        // Add spacing (100px gap) after the longest file box
        const diffStartX = maxRightEdge + 100;
        
        // Create diff box with unique ID
        const diffBox = document.createElement('div');
        diffBox.className = 'diff-box';
        const diffBoxId = 'diff-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        diffBox.innerHTML = formatDiff(diff, diffBoxId, filePath);
        
        // Position diff box to the right of all file boxes
        const diffPos = {
          x: diffStartX,
          y: filePos.y
        };
        diffBox.style.left = diffPos.x + 'px';
        diffBox.style.top = diffPos.y + 'px';
        canvas.appendChild(diffBox);

        // Create connection line (SVG)
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('class', 'connection-line');
        
        // Calculate actual right edge of this specific file box
        const fileBoxWidth = fileBox.offsetWidth || 0;
        const fileBoxRightEdge = filePos.x + fileBoxWidth;
        
        line.setAttribute('x1', fileBoxRightEdge); // Right edge of file box
        line.setAttribute('y1', filePos.y + 20);  // Middle of file box
        line.setAttribute('x2', diffPos.x);       // Left edge of diff box
        line.setAttribute('y2', diffPos.y + 20);  // Middle of diff box
        connectionsContainer.appendChild(line);

        // Animate in
        setTimeout(() => {
          diffBox.classList.add('visible');
          line.classList.add('visible');
        }, 100);
        
        // Wait for the visibility transition to complete before scrolling
        setTimeout(() => {
          const latestChange = diffBox.querySelector('#latest-change-' + diffBoxId);
          console.log('[Radium] Looking for latest change with ID:', 'latest-change-' + diffBoxId);
          console.log('[Radium] Found element:', latestChange);
          
          if (latestChange) {
            // Calculate the position to scroll to within the diff box
            const latestChangeTop = latestChange.offsetTop;
            const diffBoxHeight = diffBox.clientHeight;
            const scrollTarget = Math.max(0, latestChangeTop - (diffBoxHeight / 2));
            
            console.log('[Radium] Scroll info:', {
              latestChangeTop,
              diffBoxHeight,
              scrollTarget,
              currentScrollTop: diffBox.scrollTop,
              scrollHeight: diffBox.scrollHeight
            });
            
            // Use scrollTo with instant behavior
            diffBox.scrollTo({
              top: scrollTarget,
              behavior: 'instant'
            });
            
            console.log('[Radium] After scroll, scrollTop:', diffBox.scrollTop);
          } else {
            console.warn('[Radium] Could not find latest change element');
          }
        }, 400);

        // Track for cleanup
        activeElements.push({ fileBox, diffBox, line, timestamp });

        // Track hover state
        let isHovering = false;
        let hideTimeout = null;

        const scheduleDiffHide = () => {
          hideTimeout = setTimeout(() => {
            if (!isHovering) {
              diffBox.classList.remove('visible');
              line.classList.remove('visible');
              
              setTimeout(() => {
                diffBox.remove();
                line.remove();
              }, 300); // Wait for fade out
            }
          }, 5000);
        };

        const cancelDiffHide = () => {
          if (hideTimeout) {
            clearTimeout(hideTimeout);
            hideTimeout = null;
          }
        };

        // Hover handlers for diff box
        diffBox.addEventListener('mouseenter', () => {
          isHovering = true;
          cancelDiffHide();
        });

        diffBox.addEventListener('mouseleave', () => {
          isHovering = false;
          // Start a new timeout to hide after 2 seconds of leaving
          hideTimeout = setTimeout(() => {
            diffBox.classList.remove('visible');
            line.classList.remove('visible');
            
            setTimeout(() => {
              diffBox.remove();
              line.remove();
            }, 300);
          }, 2000);
        });

        // Start initial hide timer
        scheduleDiffHide();
      }, 10); // Small delay to ensure fileBox is rendered

      // Remove highlight from file box after 5 seconds
      setTimeout(() => {
        fileBox.classList.remove('highlight');
      }, 5000);

      // Clean up old file boxes (keep only the most recent one for each file)
      cleanupOldFileBoxes(filePath, fileBox);
    }

    function cleanupOldFileBoxes(filePath, currentBox) {
      // Find all file boxes with the same file path
      const allFileBoxes = Array.from(canvas.querySelectorAll('.file-box'));
      allFileBoxes.forEach(box => {
        if (box !== currentBox && box.textContent === filePath) {
          // Fade out and remove old box
          box.style.opacity = '0';
          setTimeout(() => box.remove(), 300);
        }
      });
    }

    // Update canvas transform
    function updateTransform() {
      canvas.style.transform = \`translate(\${translateX}px, \${translateY}px) scale(\${scale})\`;
      zoomLevelEl.textContent = Math.round(scale * 100) + '%';
    }

    // Pan handlers
    container.addEventListener('mousedown', (e) => {
      // Don't pan if clicking on a button or interactive element
      if (e.target.closest('.zoom-button') || e.target.closest('.diff-box') || e.target.closest('.file-box')) {
        return;
      }
      isPanning = true;
      startX = e.clientX - translateX;
      startY = e.clientY - translateY;
      container.classList.add('panning');
      canvas.classList.add('no-transition');
    });

    container.addEventListener('mousemove', (e) => {
      if (!isPanning) return;
      translateX = e.clientX - startX;
      translateY = e.clientY - startY;
      updateTransform();
    });

    container.addEventListener('mouseup', () => {
      if (isPanning) {
        isPanning = false;
        container.classList.remove('panning');
        canvas.classList.remove('no-transition');
      }
    });

    container.addEventListener('mouseleave', () => {
      if (isPanning) {
        isPanning = false;
        container.classList.remove('panning');
        canvas.classList.remove('no-transition');
      }
    });

    // Zoom with mouse wheel
    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      
      // Reduced zoom speed for smoother experience, especially on Mac trackpads
      // When Shift is held, zoom three times as fast
      const delta = -e.deltaY;
      const baseScaleBy = delta > 0 ? 1.03 : 0.97;
      const scaleBy = e.shiftKey ? (delta > 0 ? 1.09 : 0.91) : baseScaleBy;
      const newScale = Math.max(0.1, Math.min(5, scale * scaleBy));
      
      // Zoom towards mouse position
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      // Calculate the point in canvas coordinates before zoom
      const canvasX = (mouseX - translateX) / scale;
      const canvasY = (mouseY - translateY) / scale;
      
      // Update scale
      scale = newScale;
      
      // Adjust translation to keep the same point under the mouse
      translateX = mouseX - canvasX * scale;
      translateY = mouseY - canvasY * scale;
      
      updateTransform();
    });

    // Zoom buttons
    document.getElementById('zoom-in').addEventListener('click', () => {
      scale = Math.min(5, scale * 1.2);
      updateTransform();
    });

    document.getElementById('zoom-out').addEventListener('click', () => {
      scale = Math.max(0.1, scale / 1.2);
      updateTransform();
    });

    document.getElementById('zoom-reset').addEventListener('click', () => {
      scale = 1;
      translateX = 0;
      translateY = 0;
      updateTransform();
    });

    // Clear all button
    document.getElementById('clear-button').addEventListener('click', () => {
      // Remove all file boxes
      const allFileBoxes = Array.from(canvas.querySelectorAll('.file-box'));
      allFileBoxes.forEach(box => {
        box.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        box.style.opacity = '0';
        box.style.transform = 'scale(0.8)';
        setTimeout(() => box.remove(), 300);
      });

      // Remove all diff boxes
      const allDiffBoxes = Array.from(canvas.querySelectorAll('.diff-box'));
      allDiffBoxes.forEach(box => {
        box.style.transition = 'opacity 0.3s ease';
        box.style.opacity = '0';
        setTimeout(() => box.remove(), 300);
      });

      // Remove all connection lines
      const allLines = Array.from(connectionsContainer.querySelectorAll('.connection-line'));
      allLines.forEach(line => {
        line.style.transition = 'opacity 0.3s ease';
        line.style.opacity = '0';
        setTimeout(() => line.remove(), 300);
      });

      // Clear file positions
      filePositions.clear();

      // Reset next position
      nextPosition = { x: 100, y: 100 };

      // Notify extension to clear session tracking
      vscode.postMessage({ type: 'clearAll' });

      console.log('[Radium] Cleared all file boxes');
    });

    // Listen for messages from extension
    window.addEventListener('message', event => {
      const message = event.data;
      
      switch (message.type) {
        case 'file:changed':
          handleFileChange(message.data);
          break;
        case 'file:reverted':
          handleFileReverted(message.data);
          break;
        case 'file:deleted':
          handleFileDeleted(message.data);
          break;
      }
    });

    function handleFileReverted(data) {
      const { filePath, timestamp } = data;
      
      console.log(\`[Radium] Handling revert for \${filePath}\`);
      
      // Find and remove all elements for this file
      const allFileBoxes = Array.from(canvas.querySelectorAll('.file-box'));
      allFileBoxes.forEach(box => {
        // Match the file path (with or without asterisk)
        const boxText = box.textContent || '';
        const boxFilePath = boxText.replace(' *', ''); // Remove asterisk if present
        
        if (boxFilePath === filePath) {
          // Fade out animation
          box.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
          box.style.opacity = '0';
          box.style.transform = 'scale(0.8)';
          
          setTimeout(() => {
            box.remove();
            // Clear the position so it can be reused
            filePositions.delete(filePath);
          }, 500);
        }
      });
      
      // Also remove any visible diff boxes for this file
      const allDiffBoxes = Array.from(canvas.querySelectorAll('.diff-box'));
      allDiffBoxes.forEach(diffBox => {
        // Check if this diff box is near the file position
        const filePos = filePositions.get(filePath);
        if (filePos) {
          const diffLeft = parseInt(diffBox.style.left);
          const expectedDiffLeft = filePos.x + 500;
          
          // If diff box is at the expected position for this file
          if (Math.abs(diffLeft - expectedDiffLeft) < 50) {
            diffBox.style.transition = 'opacity 0.3s ease';
            diffBox.style.opacity = '0';
            setTimeout(() => diffBox.remove(), 300);
          }
        }
      });
      
      // Remove connection lines
      const allLines = Array.from(connectionsContainer.querySelectorAll('.connection-line'));
      allLines.forEach(line => {
        const filePos = filePositions.get(filePath);
        if (filePos) {
          const x1 = parseFloat(line.getAttribute('x1'));
          const expectedX1 = filePos.x + 150;
          
          if (Math.abs(x1 - expectedX1) < 50) {
            line.style.transition = 'opacity 0.3s ease';
            line.style.opacity = '0';
            setTimeout(() => line.remove(), 300);
          }
        }
      });
    }

    function handleFileDeleted(data) {
      const { filePath, timestamp } = data;
      
      console.log(\`[Radium] Handling deletion for \${filePath}\`);
      
      // Find and remove all elements for this file
      const allFileBoxes = Array.from(canvas.querySelectorAll('.file-box'));
      allFileBoxes.forEach(box => {
        // Match the file path (with or without asterisk)
        const boxText = box.textContent || '';
        const boxFilePath = boxText.replace(' *', ''); // Remove asterisk if present
        
        if (boxFilePath === filePath) {
          // Fade out animation
          box.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
          box.style.opacity = '0';
          box.style.transform = 'scale(0.8)';
          
          setTimeout(() => {
            box.remove();
            // Clear the position so it can be reused
            filePositions.delete(filePath);
          }, 500);
        }
      });
      
      // Also remove any visible diff boxes for this file
      const allDiffBoxes = Array.from(canvas.querySelectorAll('.diff-box'));
      allDiffBoxes.forEach(diffBox => {
        // Check if this diff box is near the file position
        const filePos = filePositions.get(filePath);
        if (filePos) {
          const diffLeft = parseInt(diffBox.style.left);
          
          // Get the actual right edge of all file boxes to calculate expected diff position
          const allFileBoxElements = Array.from(canvas.querySelectorAll('.file-box'));
          let maxRightEdge = 0;
          allFileBoxElements.forEach(box => {
            const boxLeft = parseInt(box.style.left) || 0;
            const boxWidth = box.offsetWidth || 0;
            const rightEdge = boxLeft + boxWidth;
            if (rightEdge > maxRightEdge) {
              maxRightEdge = rightEdge;
            }
          });
          const expectedDiffLeft = maxRightEdge + 100;
          
          // If diff box is at the expected position for this file (same Y coordinate)
          const diffTop = parseInt(diffBox.style.top);
          if (Math.abs(diffTop - filePos.y) < 10) {
            diffBox.style.transition = 'opacity 0.3s ease';
            diffBox.style.opacity = '0';
            setTimeout(() => diffBox.remove(), 300);
          }
        }
      });
      
      // Remove connection lines
      const allLines = Array.from(connectionsContainer.querySelectorAll('.connection-line'));
      allLines.forEach(line => {
        const filePos = filePositions.get(filePath);
        if (filePos) {
          const y1 = parseFloat(line.getAttribute('y1'));
          const expectedY1 = filePos.y + 20;
          
          // Match by Y coordinate (more reliable than X)
          if (Math.abs(y1 - expectedY1) < 10) {
            line.style.transition = 'opacity 0.3s ease';
            line.style.opacity = '0';
            setTimeout(() => line.remove(), 300);
          }
        }
      });
    }
  </script>
</body>
</html>`;
  }

  private dispose() {
    RealtimeChangesPanel.currentPanel = undefined;

    // Clear all pending debounced changes
    for (const timeout of this.pendingChanges.values()) {
      clearTimeout(timeout);
    }
    this.pendingChanges.clear();

    // Clear cache
    this.diffCache.clear();

    // Stop watching
    if (this.watcher) {
      this.watcher.close();
    }

    // Clean up resources
    this.panel.dispose();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}

