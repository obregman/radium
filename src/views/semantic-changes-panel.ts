import * as vscode from 'vscode';
import * as chokidar from 'chokidar';
import * as cp from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as Diff from 'diff';
import { RadiumIgnore } from '../config/radium-ignore';
import { SemanticAnalyzer, SemanticChange, SemanticChangeCategory } from '../analysis/semantic-analyzer';

const exec = promisify(cp.exec);

interface FileSemanticChanges {
  filePath: string;
  changes: SemanticChange[];
  timestamp: number;
  isNew: boolean;
  diff?: string;
}

interface ChangeHistory {
  filePath: string;
  changes: SemanticChange[];
  timestamp: number;
  diff?: string;
}

export class SemanticChangesPanel {
  public static currentPanel: SemanticChangesPanel | undefined;
  private static outputChannel: vscode.OutputChannel;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private watcher?: chokidar.FSWatcher;
  private workspaceRoot: string;
  private pendingChanges = new Map<string, NodeJS.Timeout>();
  private filesCreatedThisSession = new Set<string>();
  private lastKnownFileStates = new Map<string, string>();
  private baselineFileStates = new Map<string, string>();
  private radiumIgnore: RadiumIgnore;
  private analyzer: SemanticAnalyzer;
  private readonly DEBOUNCE_DELAY = 100;
  private readonly CACHE_TTL = 2000;
  private changeHistory = new Map<string, ChangeHistory[]>(); // filePath -> array of historical changes
  private diffCache = new Map<string, { diff: string; timestamp: number }>();

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    workspaceRoot: string
  ) {
    this.panel = panel;
    this.workspaceRoot = workspaceRoot;
    this.radiumIgnore = new RadiumIgnore(workspaceRoot);
    this.analyzer = new SemanticAnalyzer();

    this.panel.webview.html = this.getHtmlContent();

    this.panel.webview.onDidReceiveMessage(
      async message => {
        switch (message.type) {
          case 'clearAll':
            this.filesCreatedThisSession.clear();
            this.lastKnownFileStates.clear();
            this.baselineFileStates.clear();
            this.changeHistory.clear();
            this.log('Cleared session tracking and file states');
            await this.snapshotAllSourceFiles();
            break;
          case 'openFile':
            const filePath = path.join(this.workspaceRoot, message.filePath);
            try {
              const document = await vscode.workspace.openTextDocument(filePath);
              const editor = await vscode.window.showTextDocument(document);
              const line = Math.max(0, (message.line || 1) - 1);
              const position = new vscode.Position(line, 0);
              editor.selection = new vscode.Selection(position, position);
              editor.revealRange(
                new vscode.Range(position, position),
                vscode.TextEditorRevealType.InCenter
              );
              this.log(`Opened ${message.filePath} at line ${message.line}`);
            } catch (error) {
              this.log(`Failed to open file ${message.filePath}: ${error}`);
              vscode.window.showErrorMessage(`Failed to open file: ${message.filePath}`);
            }
            break;
          case 'webviewError':
            this.log(`❌ WEBVIEW ERROR: ${message.error.message}`);
            this.log(`Stack trace: ${message.error.stack}`);
            vscode.window.showErrorMessage(`Semantic Changes webview error: ${message.error.message}`);
            break;
        }
      },
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    vscode.workspace.onDidOpenTextDocument((document) => {
      const filePath = document.uri.fsPath;
      if (this.isSourceFile(filePath) && filePath.startsWith(this.workspaceRoot)) {
        const relativePath = path.relative(this.workspaceRoot, filePath);
        if (!this.radiumIgnore.shouldIgnore(relativePath)) {
          try {
            const content = document.getText();
            if (!this.baselineFileStates.has(relativePath)) {
              this.baselineFileStates.set(relativePath, content);
              this.log(`Stored baseline state for: ${relativePath}`);
            }
            if (!this.lastKnownFileStates.has(relativePath)) {
              this.lastKnownFileStates.set(relativePath, content);
              this.log(`Stored initial state for newly opened file: ${relativePath}`);
            }
          } catch (error) {
            this.log(`Failed to store initial state for ${relativePath}: ${error}`);
          }
        }
      }
    }, null, this.disposables);

    this.log(`Initializing semantic changes panel, workspace root: ${this.workspaceRoot}`);
    this.startWatching();
    this.log(`Panel initialization complete`);
  }

  public static createOrShow(extensionUri: vscode.Uri, workspaceRoot: string) {
    if (!SemanticChangesPanel.outputChannel) {
      SemanticChangesPanel.outputChannel = vscode.window.createOutputChannel('Radium Semantic Changes');
    }

    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SemanticChangesPanel.currentPanel) {
      SemanticChangesPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'semanticChanges',
      'Radium: Semantic Changes',
      column || vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    SemanticChangesPanel.currentPanel = new SemanticChangesPanel(panel, extensionUri, workspaceRoot);
  }

  private log(message: string) {
    SemanticChangesPanel.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  }

  private startWatching() {
    this.log(`Starting file watcher for: ${this.workspaceRoot}`);

    const defaultIgnorePatterns = [
      '**/node_modules/**',
      '**/.git/**',
      '**/out/**',
      '**/dist/**',
      '**/build/**',
      '**/release/**',
      '**/.radium/**',
      '**/.*'
    ];

    const radiumIgnorePatterns = this.radiumIgnore.getPatterns().map(pattern => {
      if (pattern.endsWith('/')) {
        const dirName = pattern.slice(0, -1);
        return `**/${dirName}/**`;
      } else if (pattern.includes('*')) {
        return pattern.startsWith('**/') ? pattern : `**/${pattern}`;
      } else {
        return `**/${pattern}`;
      }
    });

    const allIgnorePatterns = [...defaultIgnorePatterns, ...radiumIgnorePatterns];

    if (radiumIgnorePatterns.length > 0) {
      this.log(`Added ${radiumIgnorePatterns.length} patterns from radiumignore to file watcher`);
    }

    this.watcher = chokidar.watch(this.workspaceRoot, {
      ignored: allIgnorePatterns,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 25
      }
    });

    this.watcher.on('ready', async () => {
      this.log(`✅ File watcher is ready and monitoring: ${this.workspaceRoot}`);
      await this.snapshotAllSourceFiles();
      this.log(`✅ Ready to detect changes! Make a change to a file and save it.`);
    });

    this.watcher.on('error', (error) => {
      this.log(`File watcher error: ${error}`);
    });

    this.watcher.on('change', async (filePath: string) => {
      this.log(`🔔 File changed detected: ${filePath}`);
      await this.handleFileChange(filePath, false);
    });

    this.watcher.on('add', async (filePath: string) => {
      this.log(`File added: ${filePath}`);
      await this.handleFileChange(filePath, true);
    });

    this.watcher.on('unlink', async (filePath: string) => {
      if (!this.isSourceFile(filePath)) {
        return;
      }

      const relativePath = path.relative(this.workspaceRoot, filePath);
      this.filesCreatedThisSession.delete(relativePath);
      this.lastKnownFileStates.delete(relativePath);
      this.baselineFileStates.delete(relativePath);
      this.changeHistory.delete(relativePath);

      this.log(`File deleted: ${relativePath}`);
    });
  }

  private async snapshotAllSourceFiles() {
    this.log('Starting to snapshot all source files...');

    try {
      const files = await vscode.workspace.findFiles(
        '**/*',
        '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**,**/.radium/**,**/.*}'
      );

      let snapshotCount = 0;
      for (const fileUri of files) {
        const filePath = fileUri.fsPath;

        if (!this.isSourceFile(filePath) || !filePath.startsWith(this.workspaceRoot)) {
          continue;
        }

        const relativePath = path.relative(this.workspaceRoot, filePath);

        if (this.radiumIgnore.shouldIgnore(relativePath)) {
          continue;
        }

        try {
          const content = fs.readFileSync(filePath, 'utf8');
          this.baselineFileStates.set(relativePath, content);
          this.lastKnownFileStates.set(relativePath, content);
          snapshotCount++;
        } catch (error) {
          this.log(`Failed to snapshot ${relativePath}: ${error}`);
        }
      }

      this.log(`Snapshot complete: stored ${snapshotCount} source files`);
    } catch (error) {
      this.log(`Error during snapshot: ${error}`);
    }
  }

  private async handleFileChange(absolutePath: string, isNewFile: boolean) {
    const relativePath = path.relative(this.workspaceRoot, absolutePath);
    this.log(`📥 handleFileChange called for: ${relativePath}`);
    
    if (!this.isSourceFile(absolutePath)) {
      this.log(`⏭️  Skipping ${relativePath} - not a source file`);
      return;
    }

    if (this.radiumIgnore.shouldIgnore(relativePath)) {
      this.log(`⏭️  Ignoring file: ${relativePath} (matches radiumignore pattern)`);
      return;
    }

    if (isNewFile) {
      this.filesCreatedThisSession.add(relativePath);
      this.log(`📝 File created this session: ${relativePath}`);
    }

    if (this.pendingChanges.has(absolutePath)) {
      clearTimeout(this.pendingChanges.get(absolutePath)!);
      this.log(`⏱️  Clearing previous pending change for ${relativePath}`);
    }

    this.log(`⏱️  Scheduling processFileChange for ${relativePath} (debounce: ${this.DEBOUNCE_DELAY}ms)`);
    const timeout = setTimeout(async () => {
      this.pendingChanges.delete(absolutePath);
      this.log(`▶️  Debounce complete, processing ${relativePath}...`);
      await this.processFileChange(absolutePath);
    }, this.DEBOUNCE_DELAY);

    this.pendingChanges.set(absolutePath, timeout);
  }

  private async processFileChange(absolutePath: string) {
    const relativePath = path.relative(this.workspaceRoot, absolutePath);
    this.diffCache.delete(relativePath);

    const fullPath = path.join(this.workspaceRoot, relativePath);
    
    // If this is the first time we're seeing this file, store it as baseline without showing changes
    if (!this.lastKnownFileStates.has(relativePath) && !this.filesCreatedThisSession.has(relativePath)) {
      this.log(`First time seeing ${relativePath}, storing as baseline without showing changes`);
      try {
        if (fs.existsSync(fullPath)) {
          const currentContent = fs.readFileSync(fullPath, 'utf8');
          this.baselineFileStates.set(relativePath, currentContent);
          this.lastKnownFileStates.set(relativePath, currentContent);
          this.log(`Stored baseline for ${relativePath}`);
        }
      } catch (error) {
        this.log(`Failed to store initial file state for ${relativePath}: ${error}`);
      }
      return;
    }
    
    // Store baseline if we don't have one yet
    if (!this.baselineFileStates.has(relativePath)) {
      const lastKnown = this.lastKnownFileStates.get(relativePath);
      if (lastKnown) {
        this.baselineFileStates.set(relativePath, lastKnown);
        this.log(`Stored existing state as baseline for ${relativePath}`);
      }
    }

    const diff = await this.getFileDiff(relativePath);
    const hasChanges = diff && diff !== 'No diff available' && diff !== 'Error getting diff' && diff.trim().length > 0;
    
    this.log(`📝 Processing ${relativePath}, hasChanges: ${hasChanges}, diffLength: ${diff?.length || 0}`);
    this.log(`   Baseline exists: ${this.baselineFileStates.has(relativePath)}, LastKnown exists: ${this.lastKnownFileStates.has(relativePath)}`);
    
    if (!hasChanges) {
      this.log(`No changes detected for ${relativePath} - file saved without modifications`);
      return;
    }

    const isNew = this.filesCreatedThisSession.has(relativePath);
    this.log(`File ${relativePath} isNew: ${isNew}`);

    try {
      this.log(`Analyzing diff for semantic changes in ${relativePath}...`);
      this.log(`Diff preview (first 500 chars): ${diff.substring(0, 500)}`);
      
      const semanticChanges = this.analyzer.analyzeDiff(relativePath, diff);

      if (semanticChanges.length === 0) {
        const additions = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
        const deletions = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length;
        this.log(`⚠️ No semantic changes detected for ${relativePath} - the changes might not match any semantic patterns`);
        this.log(`   Diff had ${additions} additions and ${deletions} deletions`);
        this.log(`   💡 Try making a change that includes: if/for/while statements, fetch(), API routes, file I/O, etc.`);
        return;
      }

      this.log(`✅ Detected ${semanticChanges.length} semantic changes in ${relativePath}:`);
      semanticChanges.forEach((change, idx) => {
        this.log(`  ${idx + 1}. [${change.category}] ${change.description} at line ${change.lineNumber}`);
      });

      // Consolidate all changes into a single change entry
      const consolidatedChange = this.consolidateChanges(semanticChanges, relativePath);

      // Store in history
      const history = this.changeHistory.get(relativePath) || [];
      history.push({
        filePath: relativePath,
        changes: [consolidatedChange],
        timestamp: Date.now(),
        diff: diff
      });
      this.changeHistory.set(relativePath, history);

      // Send to webview
      this.log(`📤 Sending consolidated change to webview for ${relativePath}`);
      this.panel.webview.postMessage({
        type: 'semantic:changed',
        data: {
          filePath: relativePath,
          changes: [consolidatedChange],
          timestamp: Date.now(),
          isNew: isNew,
          diff: diff,
          history: history.slice(0, -1) // All previous changes except the latest
        }
      });

      // Update the baseline to the current state so the next change shows only incremental changes
      if (fs.existsSync(fullPath)) {
        const currentContent = fs.readFileSync(fullPath, 'utf8');
        this.baselineFileStates.set(relativePath, currentContent);
        this.lastKnownFileStates.set(relativePath, currentContent);
        this.log(`Updated baseline for ${relativePath} to current state`);
      }
    } catch (error) {
      this.log(`Error processing file change for ${relativePath}: ${error}`);
    }
  }

  private async getFileDiff(filePath: string): Promise<string> {
    const cached = this.diffCache.get(filePath);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.diff;
    }

    try {
      this.log(`Getting diff for: ${filePath}`);
      
      const fullPath = path.join(this.workspaceRoot, filePath);
      
      // If we have a baseline state for this file, diff against the baseline
      if (this.baselineFileStates.has(filePath)) {
        this.log(`Using baseline state for ${filePath}`);
        const baselineContent = this.baselineFileStates.get(filePath)!;
        
        if (fs.existsSync(fullPath)) {
          const currentContent = fs.readFileSync(fullPath, 'utf8');
          
          // Check if content actually changed from baseline
          if (baselineContent === currentContent) {
            this.log(`No changes detected - content identical to baseline state`);
            return '';
          }
          
          // Generate diff between baseline state and current state
          const diff = this.generateDiff(filePath, baselineContent, currentContent);
          this.log(`Generated diff from baseline state, length: ${diff.length}`);
          
          this.diffCache.set(filePath, { diff, timestamp: Date.now() });
          return diff;
        } else {
          return 'No diff available';
        }
      }
      
      // Check if this is a git repository first
      let isGitRepo = false;
      try {
        await exec('git rev-parse --git-dir', { cwd: this.workspaceRoot });
        isGitRepo = true;
      } catch {
        this.log(`Not a git repository, will treat all files as new`);
      }
      
      // If not a git repo, generate full-file diff for all files
      if (!isGitRepo) {
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          const diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n` + 
                       lines.map(line => `+${line}`).join('\n') + '\n';
          
          this.diffCache.set(filePath, { diff, timestamp: Date.now() });
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
          this.log(`Got diff from HEAD for ${filePath}`);
          diff = stdout;
        }
      } catch (headError: any) {
        this.log(`git diff HEAD failed for ${filePath}: ${headError.message}`);
      }

      // If no diff from HEAD, try unstaged diff
      if (!diff) {
        try {
          const { stdout: unstagedDiff } = await exec(`git diff -- "${filePath}"`, {
            cwd: this.workspaceRoot
          });
          
          if (unstagedDiff) {
            this.log(`Got unstaged diff for ${filePath}`);
            diff = unstagedDiff;
          }
        } catch (unstagedError: any) {
          this.log(`git diff unstaged failed for ${filePath}: ${unstagedError.message}`);
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
          this.log(`File ${filePath} is tracked but has no diff`);
        } catch {
          isTracked = false;
          this.log(`File ${filePath} is not tracked`);
        }
        
        // If not tracked, generate a full-file diff
        if (!isTracked) {
          try {
            if (fs.existsSync(fullPath)) {
              const content = fs.readFileSync(fullPath, 'utf8');
              const lines = content.split('\n');
              diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n`;
              lines.forEach((line: string) => {
                diff += `+${line}\n`;
              });
              this.log(`Generated full-file diff for untracked ${filePath}`);
            } else {
              this.log(`File does not exist: ${fullPath}`);
              diff = 'No diff available';
            }
          } catch (error) {
            this.log(`Failed to read new file ${filePath}: ${error}`);
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

      return diff;
    } catch (error: any) {
      this.log(`Failed to get diff for ${filePath}: ${error.message || error}`);
      return 'Error getting diff';
    }
  }

  private generateDiff(filePath: string, oldContent: string, newContent: string): string {
    // Use the Diff library to generate a unified diff
    const patches = Diff.createPatch(filePath, oldContent, newContent, '', '');
    return patches;
  }

  private consolidateChanges(changes: SemanticChange[], filePath: string): SemanticChange {
    // Count changes by category
    const categoryCounts = new Map<string, number>();
    changes.forEach(change => {
      categoryCounts.set(change.category, (categoryCounts.get(change.category) || 0) + 1);
    });

    // Determine primary category (most frequent)
    let primaryCategory: SemanticChangeCategory = 'logic_change';
    let maxCount = 0;
    categoryCounts.forEach((count, category) => {
      if (count > maxCount) {
        maxCount = count;
        primaryCategory = category as SemanticChangeCategory;
      }
    });

    // Build description
    const categoryDescriptions: string[] = [];
    const categoryOrder: SemanticChangeCategory[] = [
      'add_function',
      'delete_function',
      'add_logic',
      'logic_change',
      'delete_code',
      'call_api',
      'expose_api',
      'read_external'
    ];

    categoryOrder.forEach(cat => {
      const count = categoryCounts.get(cat);
      if (count) {
        const names: { [key: string]: string } = {
          'logic_change': 'logic change',
          'add_logic': 'logic addition',
          'delete_code': 'code deletion',
          'read_external': 'external read',
          'call_api': 'API call',
          'expose_api': 'API exposure',
          'add_function': 'function addition',
          'delete_function': 'function deletion'
        };
        const name = names[cat] || cat;
        categoryDescriptions.push(`${count} ${name}${count > 1 ? 's' : ''}`);
      }
    });

    const description = `File modified: ${categoryDescriptions.join(', ')}`;

    // Get first line number for reference
    const firstLineNumber = changes.length > 0 ? changes[0].lineNumber : 1;

    // Collect all comments
    const allComments: string[] = [];
    changes.forEach(change => {
      if (change.comments && change.comments.length > 0) {
        allComments.push(...change.comments);
      }
    });

    // Remove duplicate comments
    const uniqueComments = Array.from(new Set(allComments));

    return {
      category: primaryCategory,
      filePath: filePath,
      lineNumber: firstLineNumber,
      lineContent: `${changes.length} changes detected`,
      description: description,
      comments: uniqueComments.length > 0 ? uniqueComments : undefined
    };
  }

  private isSourceFile(filePath: string): boolean {
    const sourceExtensions = [
      '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
      '.py', '.pyx', '.pyi',
      '.java', '.kt', '.scala', '.groovy',
      '.go', '.rs', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
      '.cs', '.vb', '.fs', '.xaml',
      '.swift', '.m', '.mm',
      '.rb', '.rake',
      '.php',
      '.vue', '.svelte',
      '.html', '.htm', '.xml', '.json', '.yaml', '.yml', '.toml',
      '.css', '.scss', '.sass', '.less',
      '.sh', '.bash', '.zsh', '.fish',
      '.sql', '.graphql', '.proto', '.thrift'
    ];
    return sourceExtensions.some(ext => filePath.endsWith(ext));
  }

  private getHtmlContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Semantic Changes</title>
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

    .file-container {
      position: absolute;
      border: 2px solid var(--vscode-panel-border);
      border-radius: 0;
      background-color: #4c4d4c;
      padding: 85px 10px 5px 10px;
      box-sizing: border-box;
      min-width: 300px;
      max-height: 80vh;
      overflow-y: auto;
      overflow-x: visible;
      transition: max-height 0.3s ease;
    }
    
    .file-container:hover {
      overflow: visible;
    }

    .file-path-label {
      position: absolute;
      top: 35px;
      left: 8px;
      right: 8px;
      font-family: var(--vscode-font-family);
      color: #FFFFFF;
      text-align: center;
      cursor: default;
      max-height: 50px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
    }
    
    .file-directory-path {
      font-size: 14px;
      font-weight: 400;
      opacity: 0.7;
      line-height: 1.1;
      word-break: keep-all;
      word-wrap: break-word;
      white-space: normal;
      overflow: hidden;
      max-height: 22px;
    }
    
    .file-name {
      font-size: 20px;
      font-weight: 700;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }

    .file-stats {
      position: absolute;
      top: 6px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 600;
      font-family: 'Courier New', monospace;
      background: rgba(0, 0, 0, 0.3);
      padding: 4px 8px;
      border-radius: 3px;
      z-index: 5;
    }

    .stat-additions {
      color: #00FF00;
    }

    .stat-deletions {
      color: #FF0000;
    }

    .change-card {
      position: relative;
      padding: 8px 10px;
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
      margin-bottom: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
      box-sizing: border-box;
      max-width: 100%;
      word-wrap: break-word;
      overflow-wrap: break-word;
      transform: scale(1);
    }

    .diff-icon {
      position: absolute;
      bottom: 8px;
      right: 8px;
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      background-color: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.2s ease;
      z-index: 10;
    }

    .diff-icon:hover {
      background-color: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
      transform: scale(1.1);
    }

    .diff-tooltip {
      position: fixed;
      background-color: var(--vscode-editor-background);
      border: 2px solid var(--vscode-button-background);
      border-radius: 4px;
      padding: 12px;
      max-width: 600px;
      max-height: 400px;
      overflow: auto;
      font-family: 'Courier New', monospace;
      font-size: 11px;
      white-space: pre-wrap;
      word-wrap: break-word;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
      z-index: 1000;
      pointer-events: auto;
    }

    .diff-tooltip .diff-line-add {
      color: #00FF00;
      background-color: rgba(0, 255, 0, 0.1);
    }

    .diff-tooltip .diff-line-remove {
      color: #FF0000;
      background-color: rgba(255, 0, 0, 0.1);
    }

    .diff-tooltip .diff-line-context {
      color: var(--vscode-editor-foreground);
      opacity: 0.7;
    }

    .diff-tooltip-header {
      font-weight: bold;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-button-background);
    }

    .change-card.popped {
      transform: scale(1.4);
      border-color: var(--vscode-button-background);
      z-index: 1000;
      position: relative;
    }

    .change-card.latest {
      border-color: var(--vscode-button-background);
      box-shadow: 0 4px 12px rgba(255, 165, 0, 0.4);
      animation: pulseLatest 2s ease-in-out 3;
    }

    @keyframes pulseLatest {
      0%, 100% { 
        border-color: var(--vscode-button-background);
        opacity: 1;
      }
      50% { 
        border-color: #FFD700;
        opacity: 0.9;
      }
    }

    .change-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .category-badge {
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .category-logic_change {
      background-color: rgba(100, 150, 255, 0.2);
      color: #6496ff;
      border: 1px solid #6496ff;
    }

    .category-add_logic {
      background-color: rgba(100, 255, 150, 0.2);
      color: #64ff96;
      border: 1px solid #64ff96;
    }

    .category-delete_code {
      background-color: rgba(255, 100, 100, 0.2);
      color: #ff6464;
      border: 1px solid #ff6464;
    }

    .category-read_external {
      background-color: rgba(255, 200, 100, 0.2);
      color: #ffc864;
      border: 1px solid #ffc864;
    }

    .category-call_api {
      background-color: rgba(150, 100, 255, 0.2);
      color: #9664ff;
      border: 1px solid #9664ff;
    }

    .category-expose_api {
      background-color: rgba(255, 100, 200, 0.2);
      color: #ff64c8;
      border: 1px solid #ff64c8;
    }

    .category-add_function {
      background-color: rgba(150, 255, 100, 0.2);
      color: #96ff64;
      border: 1px solid #96ff64;
    }

    .category-delete_function {
      background-color: rgba(255, 150, 100, 0.2);
      color: #ff9664;
      border: 1px solid #ff9664;
    }

    .change-description {
      font-size: 12px;
      font-weight: 500;
      color: var(--vscode-editor-foreground);
    }

    .change-location {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
      cursor: pointer;
    }

    .change-location:hover {
      color: var(--vscode-button-background);
      text-decoration: underline;
    }

    .change-content {
      font-family: 'Courier New', monospace;
      font-size: 11px;
      background-color: rgba(0, 0, 0, 0.2);
      padding: 6px;
      border-radius: 3px;
      margin-top: 4px;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: break-word;
      max-height: 150px;
      overflow-y: auto;
      overflow-x: auto;
      max-width: 100%;
    }

    .change-timestamp {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
      opacity: 0.7;
    }

    .previous-changes-section {
      margin-top: 6px;
      padding: 8px;
      background-color: rgba(0, 0, 0, 0.2);
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border);
    }

    .previous-changes-toggle {
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 0;
      user-select: none;
    }

    .previous-changes-toggle:hover {
      color: var(--vscode-button-background);
    }

    .toggle-icon {
      transition: transform 0.2s;
      font-size: 10px;
    }

    .toggle-icon.expanded {
      transform: rotate(90deg);
    }

    .previous-changes-list {
      max-height: 0;
      overflow: hidden;
      margin-top: 0;
      padding-top: 0;
      transition: max-height 0.3s ease, margin-top 0.3s ease, padding-top 0.3s ease;
    }

    .previous-changes-list.expanded {
      max-height: 500px;
      overflow-y: auto;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .previous-change-item {
      padding: 8px;
      margin-bottom: 6px;
      background-color: rgba(0, 0, 0, 0.3);
      border-radius: 3px;
      border-left: 2px solid var(--vscode-panel-border);
      font-size: 11px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .previous-change-item:hover {
      background-color: rgba(0, 0, 0, 0.4);
      border-left-color: var(--vscode-button-background);
    }

    .previous-change-item:last-child {
      margin-bottom: 0;
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

    #auto-focus-toggle {
      position: fixed;
      bottom: 70px;
      left: 20px;
      padding: 10px 16px;
      background-color: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-button-border);
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      z-index: 100;
      transition: all 0.2s ease;
      opacity: 0.6;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    #auto-focus-toggle:hover {
      opacity: 1;
      border-color: var(--vscode-foreground);
    }

    #auto-focus-toggle.active {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
      opacity: 1;
    }

    .toggle-checkbox {
      width: 14px;
      height: 14px;
      border: 1px solid currentColor;
      border-radius: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <div id="info">
    <h3>🔍 Semantic Changes</h3>
  </div>
  <div id="zoom-controls">
    <button class="zoom-button" id="zoom-in" title="Zoom In">+</button>
    <div id="zoom-level">100%</div>
    <button class="zoom-button" id="zoom-out" title="Zoom Out">−</button>
    <button class="zoom-button" id="zoom-reset" title="Reset View">⟲</button>
  </div>
  <button id="clear-button" title="Clear all changes">
    <span>🗑️</span>
    <span>Clear All</span>
  </button>
  <button id="auto-focus-toggle" title="Auto-focus on changes">
    <span class="toggle-checkbox"></span>
    <span>Auto-focus on changes</span>
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

    // Pan and zoom state
    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let isPanning = false;
    let startX = 0;
    let startY = 0;
    let autoFocusEnabled = true; // Auto-focus enabled by default

    // File groups tracking
    const fileGroups = new Map(); // filePath -> { container, changes: [], x, y, width }
    const fileOrder = []; // Track file creation order
    const FILE_SPACING = 80;
    const START_X = 100;
    const START_Y = 50;
    
    // Track all timestamp elements for dynamic updates
    const timestampElements = new Map(); // timestamp -> Set of elements

    // Category display names
    const categoryNames = {
      'logic_change': 'Logic Change',
      'add_logic': 'Add Logic',
      'delete_code': 'Delete Code',
      'read_external': 'Read External',
      'call_api': 'Call API',
      'expose_api': 'Expose API',
      'add_function': 'Add Function',
      'delete_function': 'Delete Function'
    };

    // Format relative time
    function formatRelativeTime(timestamp) {
      const now = Date.now();
      const diff = now - timestamp;
      
      const seconds = Math.floor(diff / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);
      
      if (seconds < 60) {
        return seconds === 1 ? '1 second ago' : \`\${seconds} seconds ago\`;
      } else if (minutes < 60) {
        return minutes === 1 ? '1 minute ago' : \`\${minutes} minutes ago\`;
      } else if (hours < 24) {
        return hours === 1 ? '1 hour ago' : \`\${hours} hours ago\`;
      } else {
        return days === 1 ? '1 day ago' : \`\${days} days ago\`;
      }
    }

    function splitPathIntoDirectoryAndFile(filePath) {
      const normalized = filePath.replace(/\\\\/g, '/');
      const parts = normalized.split('/');
      
      if (parts.length === 1) {
        return { directory: '', filename: parts[0] };
      }
      
      const filename = parts[parts.length - 1];
      const directory = parts.slice(0, -1).join('/');
      
      return { directory, filename };
    }

    function repositionAllFiles() {
      let currentX = START_X;
      let currentY = START_Y;
      let rowHeight = 0;
      const CONTAINER_WIDTH = container.clientWidth - 200;

      fileOrder.forEach(filePath => {
        const group = fileGroups.get(filePath);
        if (!group) return;

        const containerWidth = parseInt(group.container.style.width) || 300;
        const containerHeight = parseInt(group.container.style.height) || 200;

        // Check if we need to wrap to next row
        if (currentX + containerWidth > CONTAINER_WIDTH && currentX > START_X) {
          currentX = START_X;
          currentY += rowHeight + FILE_SPACING;
          rowHeight = 0;
        }

        // Update group position
        group.x = currentX;
        group.y = currentY;
        group.container.style.left = currentX + 'px';
        group.container.style.top = currentY + 'px';

        // Track row height
        rowHeight = Math.max(rowHeight, containerHeight);

        // Move to next column
        currentX += containerWidth + FILE_SPACING;
      });
    }

    function calculateDiffStats(diff) {
      if (!diff) return { additions: 0, deletions: 0 };
      
      const lines = diff.split('\\n');
      let additions = 0;
      let deletions = 0;
      
      lines.forEach(line => {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          additions++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          deletions++;
        }
      });
      
      return { additions, deletions };
    }

    function handleSemanticChange(data) {
      const { filePath, changes, timestamp, isNew, history, diff } = data;
      
      // Calculate diff stats
      const diffStats = calculateDiffStats(diff);

      // Get or create file group
      if (!fileGroups.has(filePath)) {
        // Create file container
        const fileContainer = document.createElement('div');
        fileContainer.className = 'file-container';
        fileContainer.style.left = START_X + 'px';
        fileContainer.style.top = START_Y + 'px';
        canvas.appendChild(fileContainer);

        // Create file path label
        const fileLabel = document.createElement('div');
        fileLabel.className = 'file-path-label';

        const { directory, filename } = splitPathIntoDirectoryAndFile(filePath);

        if (directory) {
          const directoryElement = document.createElement('div');
          directoryElement.className = 'file-directory-path';
          directoryElement.textContent = directory;
          fileLabel.appendChild(directoryElement);
        }

        const filenameElement = document.createElement('div');
        filenameElement.className = 'file-name';
        filenameElement.textContent = filename + (isNew ? ' (new)' : '');
        fileLabel.appendChild(filenameElement);

        fileContainer.appendChild(fileLabel);

        // Create stats display
        const statsContainer = document.createElement('div');
        statsContainer.className = 'file-stats';
        
        if (diffStats.additions > 0) {
          const addSpan = document.createElement('span');
          addSpan.className = 'stat-additions';
          addSpan.textContent = '+' + diffStats.additions;
          statsContainer.appendChild(addSpan);
        }
        
        if (diffStats.deletions > 0) {
          const delSpan = document.createElement('span');
          delSpan.className = 'stat-deletions';
          delSpan.textContent = '-' + diffStats.deletions;
          statsContainer.appendChild(delSpan);
        }

        fileContainer.appendChild(statsContainer);

        const newGroup = {
          container: fileContainer,
          changes: [],
          x: START_X,
          y: START_Y,
          width: 300
        };
        fileGroups.set(filePath, newGroup);
        fileOrder.push(filePath);
      }

      const group = fileGroups.get(filePath);

      // Clear existing changes for this update
      group.changes.forEach(card => card.remove());
      group.changes = [];

      // Collect all previous changes (everything except the very latest)
      const allPreviousChanges = [];
      
      // Add remaining current changes (if more than 1)
      if (changes.length > 1) {
        for (let i = 1; i < changes.length; i++) {
          allPreviousChanges.push({ change: changes[i], timestamp: timestamp, diff: diff });
        }
      }
      
      // Add history
      if (history && history.length > 0) {
        history.forEach(historyItem => {
          historyItem.changes.forEach(change => {
            allPreviousChanges.push({ change: change, timestamp: historyItem.timestamp, diff: historyItem.diff });
          });
        });
      }

      // Add "Previous changes" section FIRST (if there are any)
      if (allPreviousChanges.length > 0) {
        const previousSection = createPreviousChangesSection(allPreviousChanges, filePath);
        group.container.appendChild(previousSection);
        group.changes.push(previousSection);
      }

      // Add latest change AFTER previous changes (last one)
      if (changes.length > 0) {
        const latestCard = createChangeCard(changes[0], filePath, timestamp, true, diff);
        group.container.appendChild(latestCard);
        group.changes.push(latestCard);
      }

      // Update container size based on content
      const latestCardHeight = 150; // Approximate height of latest change card
      const previousSectionHeight = allPreviousChanges.length > 0 ? 60 : 0; // Collapsed height
      const containerHeight = 85 + latestCardHeight + previousSectionHeight + 5;
      group.container.style.height = containerHeight + 'px';
      
      // Update stats
      const statsContainer = group.container.querySelector('.file-stats');
      if (statsContainer) {
        statsContainer.innerHTML = '';
        
        if (diffStats.additions > 0) {
          const addSpan = document.createElement('span');
          addSpan.className = 'stat-additions';
          addSpan.textContent = '+' + diffStats.additions;
          statsContainer.appendChild(addSpan);
        }
        
        if (diffStats.deletions > 0) {
          const delSpan = document.createElement('span');
          delSpan.className = 'stat-deletions';
          delSpan.textContent = '-' + diffStats.deletions;
          statsContainer.appendChild(delSpan);
        }
      }

      // Reposition all files
      repositionAllFiles();

      // Auto-focus on the file container
      setTimeout(() => {
        focusOnElement(group.container);
      }, 100);
    }

    function createChangeCard(change, filePath, timestamp, isLatest, diff) {
      const card = document.createElement('div');
      card.className = 'change-card' + (isLatest ? ' latest' : '');
      
      // Add delayed hover effect
      let hoverTimeout = null;
      card.addEventListener('mouseenter', () => {
        hoverTimeout = setTimeout(() => {
          card.classList.add('popped');
        }, 800);
      });
      
      card.addEventListener('mouseleave', () => {
        if (hoverTimeout) {
          clearTimeout(hoverTimeout);
          hoverTimeout = null;
        }
        card.classList.remove('popped');
      });

      const header = document.createElement('div');
      header.className = 'change-header';

      const badge = document.createElement('span');
      badge.className = \`category-badge category-\${change.category}\`;
      badge.textContent = categoryNames[change.category] || change.category;

      const description = document.createElement('span');
      description.className = 'change-description';
      description.textContent = change.description;

      header.appendChild(badge);
      header.appendChild(description);
      card.appendChild(header);

      const location = document.createElement('div');
      location.className = 'change-location';
      location.textContent = \`\${filePath}:\${change.lineNumber}\`;
      location.onclick = () => {
        vscode.postMessage({
          type: 'openFile',
          filePath: filePath,
          line: change.lineNumber
        });
      };
      card.appendChild(location);

      // Only show comments if they exist
      if (change.comments && change.comments.length > 0) {
        const content = document.createElement('div');
        content.className = 'change-content';
        content.style.fontStyle = 'italic';
        content.style.color = 'var(--vscode-descriptionForeground)';
        content.textContent = change.comments.join('\\n');
        card.appendChild(content);
      }

      const timestampEl = document.createElement('div');
      timestampEl.className = 'change-timestamp';
      timestampEl.textContent = formatRelativeTime(timestamp);
      timestampEl.dataset.timestamp = timestamp;
      
      // Track this element for updates
      if (!timestampElements.has(timestamp)) {
        timestampElements.set(timestamp, new Set());
      }
      timestampElements.get(timestamp).add(timestampEl);
      
      card.appendChild(timestampEl);

      // Add diff icon if diff is available
      if (diff) {
        const diffIcon = document.createElement('div');
        diffIcon.className = 'diff-icon';
        diffIcon.innerHTML = '📝';
        diffIcon.title = 'Show code changes';
        
        let tooltip = null;
        let hideTimeout = null;
        
        const showTooltip = () => {
          if (hideTimeout) {
            clearTimeout(hideTimeout);
            hideTimeout = null;
          }
          
          if (tooltip) return; // Already showing
          
          // Create tooltip
          tooltip = document.createElement('div');
          tooltip.className = 'diff-tooltip';
          
          const header = document.createElement('div');
          header.className = 'diff-tooltip-header';
          header.textContent = 'Code Changes:';
          tooltip.appendChild(header);
          
          // Format diff with syntax highlighting
          const diffContent = document.createElement('div');
          const lines = diff.split('\\n');
          lines.forEach(line => {
            const lineDiv = document.createElement('div');
            if (line.startsWith('+') && !line.startsWith('+++')) {
              lineDiv.className = 'diff-line-add';
            } else if (line.startsWith('-') && !line.startsWith('---')) {
              lineDiv.className = 'diff-line-remove';
            } else {
              lineDiv.className = 'diff-line-context';
            }
            lineDiv.textContent = line;
            diffContent.appendChild(lineDiv);
          });
          tooltip.appendChild(diffContent);
          
          document.body.appendChild(tooltip);
          
          // Position tooltip to the left of the icon
          const iconRect = diffIcon.getBoundingClientRect();
          const tooltipRect = tooltip.getBoundingClientRect();
          
          // Always position to the left
          let left = iconRect.left - tooltipRect.width - 10;
          
          // If it goes off screen, adjust
          if (left < 10) {
            left = 10;
          }
          
          // Position vertically centered with the icon
          let top = iconRect.top + (iconRect.height / 2) - (tooltipRect.height / 2);
          
          // Ensure tooltip stays within viewport
          if (top < 10) top = 10;
          if (top + tooltipRect.height > window.innerHeight - 10) {
            top = window.innerHeight - tooltipRect.height - 10;
          }
          
          tooltip.style.left = left + 'px';
          tooltip.style.top = top + 'px';
          
          // Add hover listeners to tooltip
          tooltip.addEventListener('mouseenter', () => {
            if (hideTimeout) {
              clearTimeout(hideTimeout);
              hideTimeout = null;
            }
          });
          
          tooltip.addEventListener('mouseleave', () => {
            hideTimeout = setTimeout(() => {
              if (tooltip) {
                tooltip.remove();
                tooltip = null;
              }
            }, 100);
          });
        };
        
        const hideTooltip = () => {
          hideTimeout = setTimeout(() => {
            if (tooltip) {
              tooltip.remove();
              tooltip = null;
            }
          }, 100);
        };
        
        diffIcon.addEventListener('mouseenter', (e) => {
          e.stopPropagation();
          showTooltip();
        });
        
        diffIcon.addEventListener('mouseleave', (e) => {
          e.stopPropagation();
          hideTooltip();
        });
        
        card.appendChild(diffIcon);
      }

      return card;
    }

    function createPreviousChangesSection(previousChanges, filePath) {
      const section = document.createElement('div');
      section.className = 'previous-changes-section';

      const toggle = document.createElement('div');
      toggle.className = 'previous-changes-toggle';
      
      const toggleText = document.createElement('span');
      toggleText.textContent = \`Previous Changes (\${previousChanges.length})\`;
      
      const toggleIcon = document.createElement('span');
      toggleIcon.className = 'toggle-icon';
      toggleIcon.textContent = '▶';
      
      toggle.appendChild(toggleText);
      toggle.appendChild(toggleIcon);

      const list = document.createElement('div');
      list.className = 'previous-changes-list';

      previousChanges.forEach(item => {
        const change = item.change;
        const timestamp = item.timestamp;
        const itemDiff = item.diff; // Get the specific diff for this change
        
        const changeItem = document.createElement('div');
        changeItem.className = 'previous-change-item';
        changeItem.style.position = 'relative';
        
        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.gap = '8px';
        header.style.alignItems = 'center';
        header.style.marginBottom = '4px';
        
        const badge = document.createElement('span');
        badge.className = \`category-badge category-\${change.category}\`;
        badge.style.fontSize = '9px';
        badge.style.padding = '2px 6px';
        badge.textContent = categoryNames[change.category];
        
        const description = document.createElement('span');
        description.style.fontWeight = '500';
        description.style.fontSize = '11px';
        description.textContent = change.description;
        
        header.appendChild(badge);
        header.appendChild(description);
        
        changeItem.appendChild(header);
        
        // Add comments if they exist
        if (change.comments && change.comments.length > 0) {
          const commentsDiv = document.createElement('div');
          commentsDiv.style.fontFamily = "'Courier New', monospace";
          commentsDiv.style.fontSize = '10px';
          commentsDiv.style.fontStyle = 'italic';
          commentsDiv.style.color = 'var(--vscode-descriptionForeground)';
          commentsDiv.style.backgroundColor = 'rgba(0, 0, 0, 0.2)';
          commentsDiv.style.padding = '4px';
          commentsDiv.style.borderRadius = '2px';
          commentsDiv.style.marginTop = '4px';
          commentsDiv.style.marginBottom = '4px';
          commentsDiv.style.whiteSpace = 'pre-wrap';
          commentsDiv.style.wordWrap = 'break-word';
          commentsDiv.textContent = change.comments.join('\\n');
          changeItem.appendChild(commentsDiv);
        }
        
        const timeDiv = document.createElement('div');
        timeDiv.style.opacity = '0.6';
        timeDiv.style.fontSize = '10px';
        timeDiv.textContent = formatRelativeTime(timestamp);
        timeDiv.dataset.timestamp = timestamp;
        
        // Track this element for updates
        if (!timestampElements.has(timestamp)) {
          timestampElements.set(timestamp, new Set());
        }
        timestampElements.get(timestamp).add(timeDiv);
        
        changeItem.appendChild(timeDiv);
        
        // Add diff icon if diff is available for this specific change
        if (itemDiff) {
          const diffIcon = document.createElement('div');
          diffIcon.className = 'diff-icon';
          diffIcon.innerHTML = '📝';
          diffIcon.title = 'Show code changes';
          diffIcon.style.position = 'absolute';
          diffIcon.style.bottom = '4px';
          diffIcon.style.right = '4px';
          
          let tooltip = null;
          let hideTimeout = null;
          
          const showTooltip = () => {
            if (hideTimeout) {
              clearTimeout(hideTimeout);
              hideTimeout = null;
            }
            
            if (tooltip) return; // Already showing
            
            // Create tooltip
            tooltip = document.createElement('div');
            tooltip.className = 'diff-tooltip';
            
            const header = document.createElement('div');
            header.className = 'diff-tooltip-header';
            header.textContent = 'Code Changes:';
            tooltip.appendChild(header);
            
            // Format diff with syntax highlighting
            const diffContent = document.createElement('div');
            const lines = itemDiff.split('\\n');
            lines.forEach(line => {
              const lineDiv = document.createElement('div');
              if (line.startsWith('+') && !line.startsWith('+++')) {
                lineDiv.className = 'diff-line-add';
              } else if (line.startsWith('-') && !line.startsWith('---')) {
                lineDiv.className = 'diff-line-remove';
              } else {
                lineDiv.className = 'diff-line-context';
              }
              lineDiv.textContent = line;
              diffContent.appendChild(lineDiv);
            });
            tooltip.appendChild(diffContent);
            
            document.body.appendChild(tooltip);
            
            // Position tooltip to the left of the icon
            const iconRect = diffIcon.getBoundingClientRect();
            const tooltipRect = tooltip.getBoundingClientRect();
            
            // Always position to the left
            let left = iconRect.left - tooltipRect.width - 10;
            
            // If it goes off screen, adjust
            if (left < 10) {
              left = 10;
            }
            
            // Position vertically centered with the icon
            let top = iconRect.top + (iconRect.height / 2) - (tooltipRect.height / 2);
            
            // Ensure tooltip stays within viewport
            if (top < 10) top = 10;
            if (top + tooltipRect.height > window.innerHeight - 10) {
              top = window.innerHeight - tooltipRect.height - 10;
            }
            
            tooltip.style.left = left + 'px';
            tooltip.style.top = top + 'px';
            
            // Add hover listeners to tooltip
            tooltip.addEventListener('mouseenter', () => {
              if (hideTimeout) {
                clearTimeout(hideTimeout);
                hideTimeout = null;
              }
            });
            
            tooltip.addEventListener('mouseleave', () => {
              hideTimeout = setTimeout(() => {
                if (tooltip) {
                  tooltip.remove();
                  tooltip = null;
                }
              }, 100);
            });
          };
          
          const hideTooltip = () => {
            hideTimeout = setTimeout(() => {
              if (tooltip) {
                tooltip.remove();
                tooltip = null;
              }
            }, 100);
          };
          
          diffIcon.addEventListener('mouseenter', (e) => {
            e.stopPropagation();
            showTooltip();
          });
          
          diffIcon.addEventListener('mouseleave', (e) => {
            e.stopPropagation();
            hideTooltip();
          });
          
          changeItem.appendChild(diffIcon);
        }
        
        changeItem.onclick = (e) => {
          // Don't trigger if clicking on the diff icon
          if (e.target.closest('.diff-icon')) {
            return;
          }
          vscode.postMessage({
            type: 'openFile',
            filePath: filePath,
            line: change.lineNumber
          });
        };
        
        list.appendChild(changeItem);
      });

      toggle.onclick = (e) => {
        e.stopPropagation();
        list.classList.toggle('expanded');
        toggleIcon.classList.toggle('expanded');
      };

      section.appendChild(toggle);
      section.appendChild(list);

      return section;
    }

    function updateTransform() {
      canvas.style.transform = \`translate(\${translateX}px, \${translateY}px) scale(\${scale})\`;
      zoomLevelEl.textContent = Math.round(scale * 100) + '%';
    }

    // Auto-focus on an element (center it in the view)
    function focusOnElement(element) {
      if (!autoFocusEnabled || !element) return;
      
      // Get element position in canvas coordinates
      const rect = element.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      
      // Calculate center of viewport
      const viewportCenterX = containerRect.width / 2;
      const viewportCenterY = containerRect.height / 2;
      
      // Calculate element center in canvas coordinates
      const elementCenterX = (rect.left + rect.width / 2 - containerRect.left - translateX) / scale;
      const elementCenterY = (rect.top + rect.height / 2 - containerRect.top - translateY) / scale;
      
      // Calculate new translation to center the element
      translateX = viewportCenterX - elementCenterX * scale;
      translateY = viewportCenterY - elementCenterY * scale;
      
      updateTransform();
    }

    // Pan handlers
    container.addEventListener('mousedown', (e) => {
      if (e.target.closest('.zoom-button') || e.target.closest('.change-card') || e.target.closest('.file-box') || e.target.closest('#clear-button') || e.target.closest('#auto-focus-toggle')) {
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

    // Zoom with mouse wheel (or scroll file container if hovering over one)
    container.addEventListener('wheel', (e) => {
      // Check if mouse is over a file container
      const target = e.target;
      const fileContainer = target.closest('.file-container');
      
      if (fileContainer) {
        // If hovering over a file container, scroll it instead of zooming
        // Don't prevent default - let the browser handle the scroll
        return;
      }
      
      // Otherwise, zoom the canvas
      e.preventDefault();
      const delta = -e.deltaY;
      const baseScaleBy = delta > 0 ? 1.03 : 0.97;
      const scaleBy = e.shiftKey ? (delta > 0 ? 1.09 : 0.91) : baseScaleBy;
      const newScale = Math.max(0.1, Math.min(5, scale * scaleBy));

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const canvasX = (mouseX - translateX) / scale;
      const canvasY = (mouseY - translateY) / scale;

      scale = newScale;

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
      fileGroups.forEach(group => {
        if (group.container) {
          group.container.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
          group.container.style.opacity = '0';
          group.container.style.transform = 'scale(0.95)';
          setTimeout(() => group.container.remove(), 300);
        }
      });

      fileGroups.clear();
      fileOrder.length = 0;
      timestampElements.clear();

      vscode.postMessage({ type: 'clearAll' });
    });

    // Auto-focus toggle
    const autoFocusToggle = document.getElementById('auto-focus-toggle');
    if (autoFocusToggle) {
      const toggleCheckbox = autoFocusToggle.querySelector('.toggle-checkbox');
      
      // Initialize toggle state (enabled by default)
      autoFocusToggle.classList.add('active');
      if (toggleCheckbox) {
        toggleCheckbox.textContent = '✓';
      }
      
      autoFocusToggle.addEventListener('click', () => {
        autoFocusEnabled = !autoFocusEnabled;
        
        if (autoFocusEnabled) {
          autoFocusToggle.classList.add('active');
          if (toggleCheckbox) {
            toggleCheckbox.textContent = '✓';
          }
        } else {
          autoFocusToggle.classList.remove('active');
          if (toggleCheckbox) {
            toggleCheckbox.textContent = '';
          }
        }
      });
    }

    // Listen for messages from extension
    window.addEventListener('message', event => {
      const message = event.data;

      switch (message.type) {
        case 'semantic:changed':
          handleSemanticChange(message.data);
          break;
      }
    });

    // Update all timestamps every minute
    setInterval(() => {
      timestampElements.forEach((elements, timestamp) => {
        const relativeTime = formatRelativeTime(timestamp);
        elements.forEach(element => {
          if (element && element.isConnected) {
            element.textContent = relativeTime;
          } else {
            // Remove disconnected elements
            elements.delete(element);
          }
        });
        
        // Clean up empty sets
        if (elements.size === 0) {
          timestampElements.delete(timestamp);
        }
      });
    }, 60000); // Update every minute

    // Error handling
    window.addEventListener('error', (event) => {
      vscode.postMessage({
        type: 'webviewError',
        error: {
          message: event.message,
          stack: event.error ? event.error.stack : ''
        }
      });
    });
  </script>
</body>
</html>`;
  }

  private dispose() {
    SemanticChangesPanel.currentPanel = undefined;

    for (const timeout of this.pendingChanges.values()) {
      clearTimeout(timeout);
    }
    this.pendingChanges.clear();

    // Clear cache
    this.diffCache.clear();

    if (this.watcher) {
      this.watcher.close();
    }

    this.panel.dispose();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}

