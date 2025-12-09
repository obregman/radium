import * as vscode from 'vscode';
import * as chokidar from 'chokidar';
import * as path from 'path';
import * as fs from 'fs';
import * as Diff from 'diff';
import { RadiumIgnore } from '../config/radium-ignore';
import { CodeParser } from '../indexer/parser';

interface SymbolChange {
  type: 'function' | 'class' | 'method' | 'interface' | 'type' | 'struct' | 'variable' | 'constant' | 'constructor' | 'file';
  name: string;
  changeType: 'added' | 'modified' | 'deleted' | 'value_changed';
  filePath: string;
  startLine: number;
  endLine: number;
  details?: string; // Additional info like "value: 42 -> 100"
  changeAmount?: number; // Total lines changed (added + deleted)
}

interface CallRelation {
  from: string; // symbol name
  to: string; // symbol name
  filePath: string;
}

interface FileSymbolChanges {
  filePath: string;
  symbols: SymbolChange[];
  calls: CallRelation[];
  timestamp: number;
  isNew: boolean;
  diff?: string; // Full diff for the file
  comments?: string[]; // Extracted comments from the diff
  additions?: number; // Number of lines added
  deletions?: number; // Number of lines deleted
}

export class SymbolChangesPanel {
  public static currentPanel: SymbolChangesPanel | undefined;
  private static outputChannel: vscode.OutputChannel;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private watcher?: chokidar.FSWatcher;
  private workspaceRoot: string;
  private pendingChanges = new Map<string, NodeJS.Timeout>();
  private diffCache = new Map<string, { diff: string; timestamp: number }>();
  private filesCreatedThisSession = new Set<string>();
  private filesWithSymbols = new Set<string>(); // Track files that have had symbols detected
  private lastKnownFileStates = new Map<string, string>(); // filePath -> content snapshot
  private baselineFileStates = new Map<string, string>(); // filePath -> original baseline content
  private lastKnownSymbols = new Map<string, any[]>(); // filePath -> array of symbols
  private radiumIgnore: RadiumIgnore;
  private parser: CodeParser;
  private readonly DEBOUNCE_DELAY = 100;
  private readonly CACHE_TTL = 2000;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    workspaceRoot: string
  ) {
    this.panel = panel;
    this.workspaceRoot = workspaceRoot;
    this.radiumIgnore = new RadiumIgnore(workspaceRoot);
    this.parser = new CodeParser();

    this.panel.webview.html = this.getHtmlContent();

    this.panel.webview.onDidReceiveMessage(
      async message => {
        switch (message.type) {
          case 'clearAll':
            this.filesCreatedThisSession.clear();
            this.filesWithSymbols.clear();
            this.lastKnownFileStates.clear();
            this.baselineFileStates.clear();
            this.log('Cleared session tracking and file states');
            // Re-snapshot all files after clearing
            await this.snapshotAllSourceFiles();
            break;
          case 'openFile':
            // Open the file at the specified line
            const filePath = path.join(this.workspaceRoot, message.filePath);
            try {
              const document = await vscode.workspace.openTextDocument(filePath);
              const editor = await vscode.window.showTextDocument(document);
              // Navigate to the line (convert to 0-based index)
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
          case 'revertSymbolChange':
            // Revert changes to a specific symbol
            await this.revertSymbolChange(message.filePath, message.startLine, message.endLine, message.symbolName);
            break;
          case 'webviewError':
            // Log webview JavaScript errors
            this.log(`❌ WEBVIEW ERROR: ${message.error.message}`);
            this.log(`Stack trace: ${message.error.stack}`);
            vscode.window.showErrorMessage(`Symbol Changes webview error: ${message.error.message}`);
            break;
        }
      },
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    
    // Listen for when files are opened to store their initial state
    vscode.workspace.onDidOpenTextDocument((document) => {
      const filePath = document.uri.fsPath;
      if (this.isSourceFile(filePath) && filePath.startsWith(this.workspaceRoot)) {
        const relativePath = path.relative(this.workspaceRoot, filePath);
        if (!this.radiumIgnore.shouldIgnore(relativePath)) {
          try {
            const content = document.getText();
            // Store as baseline if we don't have one yet
            if (!this.baselineFileStates.has(relativePath)) {
              this.baselineFileStates.set(relativePath, content);
              this.log(`Stored baseline state for: ${relativePath}`);
            }
            // Always update last known state
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
    
    this.log(`Initializing panel, workspace root: ${this.workspaceRoot}`);
    
    this.startWatching();
    
    this.log(`Panel initialization complete`);
  }

  public static createOrShow(extensionUri: vscode.Uri, workspaceRoot: string) {
    // Initialize output channel if not already created
    if (!SymbolChangesPanel.outputChannel) {
      SymbolChangesPanel.outputChannel = vscode.window.createOutputChannel('Radium Symbol Visualization');
    }
    
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SymbolChangesPanel.currentPanel) {
      SymbolChangesPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'symbolChanges',
      'Radium: Symbol real-time visualization',
      column || vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    SymbolChangesPanel.currentPanel = new SymbolChangesPanel(panel, extensionUri, workspaceRoot);
  }

  private log(message: string) {
    SymbolChangesPanel.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  }

  private startWatching() {
    this.log(`Starting file watcher for: ${this.workspaceRoot}`);
    
    // Build ignore patterns: combine default patterns with radiumignore patterns
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
    
    // Add radiumignore patterns to chokidar's ignore list
    const radiumIgnorePatterns = this.radiumIgnore.getPatterns().map(pattern => {
      // Convert radiumignore patterns to chokidar-compatible format
      if (pattern.endsWith('/')) {
        // Directory pattern: convert "dir/" to "**/dir/**"
        const dirName = pattern.slice(0, -1);
        return `**/${dirName}/**`;
      } else if (pattern.includes('*')) {
        // Glob pattern: ensure it has ** prefix for recursive matching
        return pattern.startsWith('**/') ? pattern : `**/${pattern}`;
      } else {
        // Exact file pattern: match anywhere in tree
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
      this.log(`File watcher is ready`);
      
      // Store initial state of all source files in the workspace
      await this.snapshotAllSourceFiles();
    });

    this.watcher.on('error', (error) => {
      this.log(`File watcher error: ${error}`);
    });

    this.watcher.on('change', async (filePath: string) => {
      this.log(`File changed: ${filePath}`);
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
      const wasInSession = this.filesCreatedThisSession.has(relativePath);
      const hadSymbols = this.filesWithSymbols.has(relativePath);
      const wasTracked = this.lastKnownFileStates.has(relativePath);
      
      this.filesCreatedThisSession.delete(relativePath);
      this.filesWithSymbols.delete(relativePath);
      this.lastKnownFileStates.delete(relativePath);
      this.baselineFileStates.delete(relativePath);
      
      // Show deletion if the file was being tracked (had symbols or was created this session)
      if (wasInSession || hadSymbols || wasTracked) {
        const fileName = path.basename(relativePath);
        this.log(`File deleted: ${relativePath}`);
        
        // Send a file deletion symbol
        this.panel.webview.postMessage({
          type: 'symbol:changed',
          data: {
            filePath: relativePath,
            symbol: {
              type: 'file',
              name: fileName,
              changeType: 'deleted',
              filePath: relativePath,
              startLine: 1,
              endLine: 1,
              changeAmount: 1
            },
            calls: [],
            timestamp: Date.now(),
            isNew: false,
            diff: '',
            additions: 0,
            deletions: 0
          }
        });
      }
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
          
          // Also parse and store symbols for deletion detection
          try {
            const parseResult = await this.parser.parseFile(filePath, content);
            if (parseResult && parseResult.symbols.length > 0) {
              this.lastKnownSymbols.set(relativePath, parseResult.symbols);
            }
          } catch (parseError) {
            // Silently ignore parse errors during snapshot
          }
          
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
    const changeDetectedTime = Date.now();
    this.log(`⏱️ File change detected at ${changeDetectedTime}: ${absolutePath}`);
    
    if (!this.isSourceFile(absolutePath)) {
      return;
    }

    const relativePath = path.relative(this.workspaceRoot, absolutePath);
    
    if (this.radiumIgnore.shouldIgnore(relativePath)) {
      this.log(`Ignoring file: ${relativePath}`);
      return;
    }
    
    if (isNewFile) {
      this.filesCreatedThisSession.add(relativePath);
      this.log(`New file detected: ${relativePath}`);
    }

    if (this.pendingChanges.has(absolutePath)) {
      clearTimeout(this.pendingChanges.get(absolutePath)!);
    }

    const timeout = setTimeout(async () => {
      const processingStartTime = Date.now();
      this.log(`⏱️ Processing started at ${processingStartTime} (${processingStartTime - changeDetectedTime}ms after detection)`);
      this.pendingChanges.delete(absolutePath);
      await this.processFileChange(absolutePath);
      const processingEndTime = Date.now();
      this.log(`⏱️ Processing completed at ${processingEndTime} (took ${processingEndTime - processingStartTime}ms)`);
    }, this.DEBOUNCE_DELAY);

    this.pendingChanges.set(absolutePath, timeout);
  }

  private async processFileChange(absolutePath: string) {
    const relativePath = path.relative(this.workspaceRoot, absolutePath);
    this.diffCache.delete(relativePath);

    const fullPath = path.join(this.workspaceRoot, relativePath);
    
    // If this is the first time we're seeing this file, store it as baseline
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
    
    this.log(`Processing ${relativePath}, hasChanges: ${hasChanges}, diffLength: ${diff?.length || 0}`);
    
    if (!hasChanges) {
      this.log(`No changes detected for ${relativePath} - file saved without modifications, keeping existing symbols`);
      // Don't send file:reverted - just skip processing since there are no new changes
      // This keeps the existing symbol boxes visible
      return;
    }

    const isNew = this.filesCreatedThisSession.has(relativePath);
    this.log(`File ${relativePath} isNew: ${isNew}`);
    
    // Analyze the diff to extract symbol changes
    const symbolChanges = await this.analyzeDiffForSymbols(relativePath, diff, isNew);
    this.log(`Found ${symbolChanges.symbols.length} symbols in ${relativePath}`);

    // If no symbols detected, send a fallback "file changed" box ONLY if this file has never had symbols
    if (symbolChanges.symbols.length === 0) {
      if (!this.filesWithSymbols.has(relativePath)) {
        this.log(`No symbols detected in ${relativePath}, sending file changed fallback`);
        const fileName = path.basename(relativePath);
        this.panel.webview.postMessage({
          type: 'symbol:changed',
          data: {
            filePath: relativePath,
            symbol: {
              type: 'file',
              name: fileName,
              changeType: isNew ? 'added' : 'modified',
              filePath: relativePath,
              startLine: 1,
              endLine: 1,
              changeAmount: 1
            },
            calls: [],
            timestamp: Date.now(),
            isNew: isNew,
            diff: diff,
            comments: symbolChanges.comments || [],
            additions: symbolChanges.additions || 0,
            deletions: symbolChanges.deletions || 0
          }
        });
      } else {
        // Even if we skip the FILE fallback, still show comments if they exist
        if (symbolChanges.comments && symbolChanges.comments.length > 0) {
          this.log(`No symbols in current change for ${relativePath}, but found ${symbolChanges.comments.length} comments - sending them`);
          const fileName = path.basename(relativePath);
          this.panel.webview.postMessage({
            type: 'symbol:changed',
            data: {
              filePath: relativePath,
              symbol: {
                type: 'file',
                name: fileName,
                changeType: isNew ? 'added' : 'modified',
                filePath: relativePath,
                startLine: 1,
                endLine: 1,
                changeAmount: 1
              },
              calls: [],
              timestamp: Date.now(),
              isNew: isNew,
              diff: diff,
              comments: symbolChanges.comments,
              additions: symbolChanges.additions || 0,
              deletions: symbolChanges.deletions || 0
            }
          });
        } else {
          this.log(`No symbols in current change for ${relativePath}, but file has symbols from previous changes - skipping FILE fallback`);
        }
      }
    } else {
      // Mark this file as having symbols
      this.filesWithSymbols.add(relativePath);
      
      // Remove any FILE fallback boxes for this file since we now have actual symbols
      this.panel.webview.postMessage({
        type: 'file:remove-fallback',
        data: {
          filePath: relativePath
        }
      });
      
      // Send each symbol change individually so they get their own boxes
      for (const symbol of symbolChanges.symbols) {
        this.log(`Sending symbol: ${symbol.name} (${symbol.type})`);
        this.panel.webview.postMessage({
          type: 'symbol:changed',
          data: {
            filePath: relativePath,
            symbol: symbol,
            calls: symbolChanges.calls.filter(c => c.from === symbol.name || c.to === symbol.name),
            timestamp: Date.now(),
            isNew: isNew,
            diff: diff,
            comments: symbolChanges.comments || [],
            additions: symbolChanges.additions || 0,
            deletions: symbolChanges.deletions || 0
          }
        });
      }
    }
    
    // Update the baseline to the current state so the next change shows only incremental changes
    // This ensures each change is isolated and not cumulative
    try {
      if (fs.existsSync(fullPath)) {
        const currentContent = fs.readFileSync(fullPath, 'utf8');
        this.baselineFileStates.set(relativePath, currentContent);
        this.lastKnownFileStates.set(relativePath, currentContent);
        this.log(`Updated baseline for ${relativePath} to current state`);
      }
    } catch (error) {
      this.log(`Failed to update baseline for ${relativePath}: ${error}`);
    }
  }

  private isNoiseChange(addedLines: Map<number, string>, deletedLines: Map<number, string>): boolean {
    // Check if changes are only whitespace/comments
    const normalizeCode = (text: string) => {
      return text
        .replace(/\/\/.*$/gm, '') // Remove single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
        .replace(/#.*$/gm, '') // Remove Python comments
        .replace(/\s+/g, ' ') // Normalize whitespace
        .trim();
    };

    const addedCode = Array.from(addedLines.values()).map(normalizeCode).join('');
    const deletedCode = Array.from(deletedLines.values()).map(normalizeCode).join('');

    // If normalized code is identical or both empty, it's noise
    return addedCode === deletedCode || (addedCode === '' && deletedCode === '');
  }

  private async analyzeDiffForSymbols(
    filePath: string, 
    diff: string, 
    isNewFile: boolean
  ): Promise<FileSymbolChanges> {
    const symbols: SymbolChange[] = [];
    const calls: CallRelation[] = [];

    // Parse the current file to get all symbols
    const fullPath = path.join(this.workspaceRoot, filePath);
    let currentSymbols: any[] = [];
    let currentCalls: any[] = [];
    let currentContent = '';

    // Special logging for .xaml.cs files
    const isXamlCs = filePath.endsWith('.xaml.cs');
    if (isXamlCs) {
      this.log(`[XAML.CS] Processing file: ${filePath}`);
      this.log(`[XAML.CS] Diff length: ${diff.length}`);
    }

    try {
      if (fs.existsSync(fullPath)) {
        currentContent = fs.readFileSync(fullPath, 'utf8');
        this.log(`Parsing file ${filePath}, content length: ${currentContent.length}`);
        
        // Check file extension
        const ext = filePath.split('.').pop();
        this.log(`File extension: ${ext}`);
        
        // Check for lambda expressions in C# files
        if (ext === 'cs' && currentContent.includes('=>')) {
          this.log(`[C#] File contains lambda expressions (=>)`);
          const lambdaCount = (currentContent.match(/=>/g) || []).length;
          this.log(`[C#] Lambda count: ${lambdaCount}`);
        }
        
        this.log(`Calling parser.parseFile for ${fullPath}`);
        const parseResult = await this.parser.parseFile(fullPath, currentContent);
        this.log(`Parser returned: ${parseResult ? 'result object' : 'null'}`);
        
        if (parseResult) {
          this.log(`Parse result: ${parseResult.symbols.length} symbols, ${parseResult.calls.length} calls`);
          if (parseResult.symbols.length > 0) {
            this.log(`First few symbols: ${parseResult.symbols.slice(0, 3).map(s => `${s.kind}:${s.name}`).join(', ')}`);
            
            // Extra logging for C# files with lambdas
            if (ext === 'cs' && currentContent.includes('=>')) {
              this.log(`[C#] All symbols detected: ${parseResult.symbols.map(s => `${s.kind}:${s.name} (lines ${this.byteOffsetToLineNumber(fullPath, s.range.start)}-${this.byteOffsetToLineNumber(fullPath, s.range.end)})`).join(', ')}`);
            }
          } else {
            this.log(`No symbols found - checking why...`);
            this.log(`Parse result hash: ${parseResult.hash}`);
          }
          currentSymbols = parseResult.symbols;
          currentCalls = parseResult.calls;
        } else {
          this.log(`Parse result is null for ${filePath} - language not supported?`);
        }
      }
    } catch (error) {
      this.log(`Failed to parse ${filePath}: ${error}`);
    }

    // Parse diff to understand what changed
    const diffLines = diff.split('\n');
    const changedLineNumbers = new Set<number>();
    const addedLineNumbers = new Set<number>();
    const deletedLineNumbers = new Set<number>();
    const addedLines = new Map<number, string>(); // line number -> content
    const deletedLines = new Map<number, string>(); // line number -> content
    
    let currentLineNumber = 0;
    let deletedLineCounter = 0; // Count actual deleted lines
    
    for (const line of diffLines) {
      // Parse hunk headers to track line numbers
      if (line.startsWith('@@')) {
        const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          currentLineNumber = parseInt(match[1], 10);
        }
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        addedLineNumbers.add(currentLineNumber);
        changedLineNumbers.add(currentLineNumber);
        addedLines.set(currentLineNumber, line.substring(1));
        currentLineNumber++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        // Use a unique counter for deleted lines since they don't have line numbers in the new file
        deletedLineNumbers.add(deletedLineCounter);
        deletedLines.set(deletedLineCounter, line.substring(1));
        deletedLineCounter++;
      } else if (!line.startsWith('\\')) {
        currentLineNumber++;
      }
    }

    // Check if this is just noise (whitespace/comments only)
    if (this.isNoiseChange(addedLines, deletedLines)) {
      this.log(`Skipping noise-only change in ${filePath}`);
      return {
        filePath,
        symbols: [],
        calls: [],
        timestamp: Date.now(),
        isNew: isNewFile,
        diff: diff
      };
    }

    // Extract comments from diff
    const comments = this.extractCommentsFromDiff(addedLines, deletedLines, filePath);
    this.log(`Extracted ${comments.length} new comments from diff`);
    
    // Variable detection disabled - not displaying variable boxes
    // const variables = this.extractVariablesFromDiff(currentContent, addedLines, deletedLines, changedLineNumbers);
    // const treeSymbolNames = new Set(currentSymbols.map(s => s.name));
    // const filteredVariables = variables.filter(v => !treeSymbolNames.has(v.name));
    // this.log(`Extracted ${variables.length} variables from diff, ${filteredVariables.length} after filtering duplicates with tree-sitter`);
    // symbols.push(...filteredVariables);

    // Track symbols we've already added to avoid duplicates
    const addedSymbolKeys = new Set<string>();
    // Variable tracking disabled
    // for (const v of filteredVariables) {
    //   addedSymbolKeys.add(`${v.type}:${v.name}:${v.startLine}`);
    // }

    // Find parent symbols for context
    const symbolParents = new Map<any, any>();
    for (const symbol of currentSymbols) {
      const symbolStartLine = this.byteOffsetToLineNumber(fullPath, symbol.range.start);
      const symbolEndLine = this.byteOffsetToLineNumber(fullPath, symbol.range.end);
      
      // Find parent (containing) symbol
      for (const potentialParent of currentSymbols) {
        if (potentialParent === symbol) continue;
        
        const parentStart = this.byteOffsetToLineNumber(fullPath, potentialParent.range.start);
        const parentEnd = this.byteOffsetToLineNumber(fullPath, potentialParent.range.end);
        
        // Check if this symbol is nested within the potential parent
        if (symbolStartLine > parentStart && symbolEndLine < parentEnd) {
          // This is a parent, but check if there's a closer parent
          const existingParent = symbolParents.get(symbol);
          if (!existingParent) {
            symbolParents.set(symbol, potentialParent);
          } else {
            const existingParentStart = this.byteOffsetToLineNumber(fullPath, existingParent.range.start);
            const existingParentEnd = this.byteOffsetToLineNumber(fullPath, existingParent.range.end);
            // If this parent is smaller (more specific), use it instead
            if ((parentEnd - parentStart) < (existingParentEnd - existingParentStart)) {
              symbolParents.set(symbol, potentialParent);
            }
          }
        }
      }
    }

    // Match symbols to changed lines - prioritize innermost (most specific) symbols
    // Build a map of changed lines to the most specific symbol containing them
    const lineToMostSpecificSymbol = new Map<number, any>();
    
    // Extra logging for C# files with lambdas
    const ext = filePath.split('.').pop();
    if (ext === 'cs' && currentContent.includes('=>')) {
      this.log(`[C#] Changed line numbers: ${Array.from(changedLineNumbers).sort((a, b) => a - b).join(', ')}`);
    }
    
    for (const line of changedLineNumbers) {
      let mostSpecificSymbol = null;
      let smallestRange = Infinity;
      
      for (const symbol of currentSymbols) {
        const symbolStartLine = this.byteOffsetToLineNumber(fullPath, symbol.range.start);
        const symbolEndLine = this.byteOffsetToLineNumber(fullPath, symbol.range.end);
        
        if (line >= symbolStartLine && line <= symbolEndLine) {
          const range = symbolEndLine - symbolStartLine;
          if (range < smallestRange) {
            smallestRange = range;
            mostSpecificSymbol = symbol;
          }
        }
      }
      
      if (mostSpecificSymbol) {
        lineToMostSpecificSymbol.set(line, mostSpecificSymbol);
        
        // Extra logging for C# files with lambdas
        if (ext === 'cs' && currentContent.includes('=>')) {
          this.log(`[C#] Line ${line} matched to symbol: ${mostSpecificSymbol.name} (${mostSpecificSymbol.kind})`);
        }
      } else {
        // Log when a changed line doesn't match any symbol
        if (ext === 'cs' && currentContent.includes('=>')) {
          this.log(`[C#] WARNING: Line ${line} did not match any symbol!`);
        }
      }
    }
    
    this.log(`Line to symbol mapping: ${Array.from(lineToMostSpecificSymbol.entries()).map(([line, sym]) => `${line} -> ${sym.name} (${sym.kind})`).join(', ')}`);
    
    // Log all symbols detected by parser for debugging
    this.log(`All symbols detected: ${currentSymbols.map(s => `${s.kind}:${s.name}`).join(', ')}`);
    
    // Now process only symbols that are the most specific for at least one changed line
    const symbolsToProcess = new Set(lineToMostSpecificSymbol.values());
    this.log(`Symbols to process (${symbolsToProcess.size}): ${Array.from(symbolsToProcess).map(s => `${s.kind}:${s.name}`).join(', ')}`);
    
    for (const symbol of symbolsToProcess) {
      const symbolStartLine = this.byteOffsetToLineNumber(fullPath, symbol.range.start);
      const symbolEndLine = this.byteOffsetToLineNumber(fullPath, symbol.range.end);
      
      // Check if this symbol overlaps with changed lines
      let hasChanges = false;
      let hasDirectChanges = false;
      
      for (let line = symbolStartLine; line <= symbolEndLine; line++) {
        if (changedLineNumbers.has(line)) {
          hasChanges = true;
          if (line > symbolStartLine + 2) {
            hasDirectChanges = true;
          }
          break;
        }
      }
      
      if (hasChanges || isNewFile) {
        // For classes, only show if there are direct changes to the class itself (not in nested functions/methods)
        if (symbol.kind === 'class' && !isNewFile) {
          // Check if all changes are within nested symbols (functions/methods)
          let allChangesAreInNestedSymbols = true;
          
          for (let line = symbolStartLine; line <= symbolEndLine; line++) {
            if (changedLineNumbers.has(line)) {
              // Check if this changed line is inside a nested symbol
              let isInNestedSymbol = false;
              
              for (const otherSymbol of currentSymbols) {
                if (otherSymbol === symbol) continue;
                
                const otherStart = this.byteOffsetToLineNumber(fullPath, otherSymbol.range.start);
                const otherEnd = this.byteOffsetToLineNumber(fullPath, otherSymbol.range.end);
                
                // Check if this other symbol is nested within our class
                if (otherStart >= symbolStartLine && otherEnd <= symbolEndLine) {
                  // Check if the changed line is within this nested symbol
                  if (line >= otherStart && line <= otherEnd) {
                    isInNestedSymbol = true;
                    break;
                  }
                }
              }
              
              // If we found a change that's NOT in a nested symbol, the class has direct changes
              if (!isInNestedSymbol) {
                allChangesAreInNestedSymbols = false;
                break;
              }
            }
          }
          
          // Skip the class if all changes are in nested symbols
          if (allChangesAreInNestedSymbols) {
            continue;
          }
        }
        
        const symbolKey = `${symbol.kind}:${symbol.fqname || symbol.name}:${symbolStartLine}`;
        if (addedSymbolKeys.has(symbolKey)) {
          continue;
        }
        addedSymbolKeys.add(symbolKey);
        
        let changeType: 'added' | 'modified' | 'deleted' = 'modified';
        let details = '';
        const parentSymbol = symbolParents.get(symbol);
        const parentInfo = parentSymbol ? { kind: parentSymbol.kind, name: parentSymbol.name } : undefined;
        
        let changeAmount = 0;
        
        if (isNewFile) {
          changeType = 'added';
          details = this.getChangeDescription('added', symbol.kind, '', 0, 0, parentInfo);
          // For new files, use the symbol's line span as change amount
          changeAmount = Math.max(1, symbolEndLine - symbolStartLine);
        } else {
          let addedCount = 0;
          let deletedCount = 0;
          for (let line = symbolStartLine; line <= symbolEndLine; line++) {
            if (addedLineNumbers.has(line)) addedCount++;
            if (deletedLineNumbers.has(line)) deletedCount++;
          }
          
          // Calculate total change amount
          changeAmount = addedCount + deletedCount;
          
          // If both adds and deletes exist, it's a modification (e.g., rename)
          // Only classify as 'added' if mostly added lines AND no deletions
          if (addedCount > (symbolEndLine - symbolStartLine) * 0.8 && deletedCount === 0) {
            changeType = 'added';
            details = this.getChangeDescription('added', symbol.kind, symbol.name, addedCount, deletedCount, parentInfo);
          } else if (deletedCount > (symbolEndLine - symbolStartLine) * 0.8 && addedCount === 0) {
            changeType = 'deleted';
            details = this.getChangeDescription('deleted', symbol.kind, symbol.name, addedCount, deletedCount, parentInfo);
          } else {
            changeType = 'modified';
            details = this.getChangeDescription('modified', symbol.kind, symbol.name, addedCount, deletedCount, parentInfo);
          }
        }
        
        // Skip variables and constants - only show functions, classes, interfaces, etc.
        if (symbol.kind !== 'variable' && symbol.kind !== 'constant') {
          symbols.push({
            type: symbol.kind as any,
            name: symbol.name,
            changeType,
            filePath,
            startLine: symbolStartLine,
            endLine: symbolEndLine,
            details,
            changeAmount: Math.max(1, changeAmount) // Ensure at least 1
          });
        }
      }
    }

    // Extract call relationships between symbols
    const symbolNames = new Set(symbols.map(s => s.name));
    
    // Detect new function calls in added lines
    for (const [lineNum, lineContent] of addedLines) {
      // Find which symbol contains this line
      const containingSymbol = symbols.find(s => 
        lineNum >= s.startLine && lineNum <= s.endLine
      );
      
      if (containingSymbol) {
        // Extract function calls from the line
        const callMatches = lineContent.matchAll(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g);
        for (const match of callMatches) {
          const calleeName = match[1];
          
          // Check if this is a call to another changed symbol
          if (symbolNames.has(calleeName) && calleeName !== containingSymbol.name) {
            // Check if we don't already have this call
            const existingCall = calls.find(c => 
              c.from === containingSymbol.name && c.to === calleeName
            );
            
            if (!existingCall) {
              calls.push({
                from: containingSymbol.name,
                to: calleeName,
                filePath
              });
            }
          }
        }
      }
    }
    
    // Also check existing calls from parser
    for (const call of currentCalls) {
      const callLine = this.byteOffsetToLineNumber(fullPath, call.range.start);
      
      // Only include if this call is in a changed line
      if (!changedLineNumbers.has(callLine)) {
        continue;
      }
      
      // Find which symbol contains this call
      const containingSymbol = symbols.find(s => 
        callLine >= s.startLine && callLine <= s.endLine
      );
      
      if (containingSymbol) {
        // Extract the called function name (handle method calls like obj.method)
        const calleeName = call.callee.split('.').pop() || call.callee;
        
        // Only add if the callee is one of our changed symbols
        if (symbolNames.has(calleeName) && calleeName !== containingSymbol.name) {
          // Check if we don't already have this call
          const existingCall = calls.find(c => 
            c.from === containingSymbol.name && c.to === calleeName
          );
          
          if (!existingCall) {
            calls.push({
              from: containingSymbol.name,
              to: calleeName,
              filePath
            });
          }
        }
      }
    }

    // Detect completely deleted symbols by comparing with previous state
    if (!isNewFile && this.lastKnownSymbols.has(filePath)) {
      const previousSymbols = this.lastKnownSymbols.get(filePath)!;
      const currentSymbolKeys = new Set(currentSymbols.map(s => `${s.kind}:${s.name}`));
      
      this.log(`Checking for deleted symbols in ${filePath}`);
      this.log(`Previous symbols: ${previousSymbols.length}, Current symbols: ${currentSymbols.length}`);
      
      for (const prevSymbol of previousSymbols) {
        const prevSymbolKey = `${prevSymbol.kind}:${prevSymbol.name}`;
        
        // If this symbol existed before but doesn't exist now, it was deleted
        if (!currentSymbolKeys.has(prevSymbolKey)) {
          this.log(`Detected deleted symbol: ${prevSymbol.name} (${prevSymbol.kind})`);
          
          // Map parser kinds to symbol types
          let symbolType: SymbolChange['type'] = 'function';
          if (prevSymbol.kind === 'class') symbolType = 'class';
          else if (prevSymbol.kind === 'struct') symbolType = 'struct';
          else if (prevSymbol.kind === 'interface') symbolType = 'interface';
          else if (prevSymbol.kind === 'type') symbolType = 'type';
          else if (prevSymbol.kind === 'function') symbolType = 'function';
          else if (prevSymbol.kind === 'constructor') symbolType = 'constructor';
          else if (prevSymbol.kind === 'variable') symbolType = 'variable';
          else if (prevSymbol.kind === 'constant') symbolType = 'constant';
          
          const startLine = this.byteOffsetToLineNumber(fullPath, prevSymbol.range.start);
          const endLine = this.byteOffsetToLineNumber(fullPath, prevSymbol.range.end);
          
          symbols.push({
            type: symbolType,
            name: prevSymbol.name,
            changeType: 'deleted',
            filePath: filePath,
            startLine: startLine,
            endLine: endLine,
            details: this.getChangeDescription('deleted', prevSymbol.kind, prevSymbol.name, 0, endLine - startLine, undefined),
            changeAmount: Math.max(1, endLine - startLine)
          });
        }
      }
    }
    
    // Store current symbols for next comparison
    this.lastKnownSymbols.set(filePath, currentSymbols);

    // Calculate total additions and deletions for the file
    const additions = addedLineNumbers.size;
    const deletions = deletedLineNumbers.size;

    return {
      filePath,
      symbols,
      calls,
      timestamp: Date.now(),
      isNew: isNewFile,
      diff: diff,
      comments: comments,
      additions: additions,
      deletions: deletions
    };
  }

  private getChangeDescription(
    changeType: 'added' | 'modified' | 'deleted' | 'value_changed',
    symbolKind: string,
    symbolName: string,
    addedLines: number,
    deletedLines: number,
    parentSymbol?: { kind: string; name: string }
  ): string {
    const kindLabel = symbolKind.toLowerCase();
    
    switch (changeType) {
      case 'added':
        if (parentSymbol) {
          const parentKind = parentSymbol.kind.toLowerCase();
          return `${this.capitalize(kindLabel)} added to ${parentKind}`;
        }
        return `${this.capitalize(kindLabel)} added`;
      
      case 'deleted':
        if (parentSymbol) {
          const parentKind = parentSymbol.kind.toLowerCase();
          return `${this.capitalize(kindLabel)} removed from ${parentKind}`;
        }
        return `${this.capitalize(kindLabel)} removed`;
      
      case 'modified':
        if (addedLines > 0 && deletedLines === 0) {
          if (parentSymbol) {
            return `Code added to ${kindLabel}`;
          }
          return `Code added to ${kindLabel}`;
        } else if (deletedLines > 0 && addedLines === 0) {
          return `Code removed from ${kindLabel}`;
        } else if (addedLines > 0 && deletedLines > 0) {
          return `Code changed in ${kindLabel}`;
        } else {
          return `${this.capitalize(kindLabel)} modified`;
        }
      
      case 'value_changed':
        return `Value changed`;
      
      default:
        return `${this.capitalize(kindLabel)} changed`;
    }
  }

  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  private extractCommentsFromDiff(addedLines: Map<number, string>, deletedLines: Map<number, string>, filePath: string): string[] {
    const newComments: string[] = [];
    const oldComments = new Set<string>();
    const ext = filePath.split('.').pop()?.toLowerCase();
    
    // Helper function to extract comment text from a line
    const extractCommentText = (trimmed: string): string | null => {
      // JavaScript/TypeScript/C-style comments
      if (ext === 'js' || ext === 'ts' || ext === 'jsx' || ext === 'tsx' || 
          ext === 'c' || ext === 'cpp' || ext === 'java' || ext === 'cs' ||
          ext === 'go' || ext === 'rs' || ext === 'swift') {
        // Single-line comments (handles // and ///)
        if (trimmed.startsWith('//')) {
          // Remove all leading slashes and trim
          const comment = trimmed.replace(/^\/+\s*/, '').trim();
          if (comment.length > 0) {
            return comment;
          }
        }
        // Multi-line comments (handles /* and /**)
        const multiLineMatch = trimmed.match(/\/\*+\s*(.+?)\s*\*\//);
        if (multiLineMatch) {
          // Remove any leading * characters
          const comment = multiLineMatch[1].replace(/^\*+\s*/, '').trim();
          if (comment.length > 0) {
            return comment;
          }
        }
      }
      
      // Python/Ruby/Shell comments
      if (ext === 'py' || ext === 'rb' || ext === 'sh' || ext === 'bash') {
        if (trimmed.startsWith('#')) {
          // Remove all leading # and trim
          const comment = trimmed.replace(/^#+\s*/, '').trim();
          if (comment.length > 0 && !comment.startsWith('!')) { // Skip shebangs
            return comment;
          }
        }
      }
      
      // HTML/XML/XAML comments
      if (ext === 'html' || ext === 'xml' || ext === 'svg' || ext === 'xaml') {
        const htmlCommentMatch = trimmed.match(/<!--\s*(.+?)\s*-->/);
        if (htmlCommentMatch) {
          return htmlCommentMatch[1].trim();
        }
      }
      
      return null;
    };
    
    // First, collect all comments from deleted lines
    for (const [lineNum, lineContent] of deletedLines) {
      const trimmed = lineContent.trim();
      const comment = extractCommentText(trimmed);
      if (comment) {
        oldComments.add(comment);
      }
    }
    
    // Then, collect only NEW comments from added lines (not in deleted lines)
    for (const [lineNum, lineContent] of addedLines) {
      const trimmed = lineContent.trim();
      const comment = extractCommentText(trimmed);
      if (comment && !oldComments.has(comment)) {
        newComments.push(comment);
      }
    }
    
    return newComments;
  }

  private extractVariablesFromDiff(
    content: string,
    addedLines: Map<number, string>,
    deletedLines: Map<number, string>,
    changedLineNumbers: Set<number>
  ): SymbolChange[] {
    const variables: SymbolChange[] = [];
    const seenVariables = new Set<string>();

    // First, collect all variable names that existed before
    // Check BOTH deleted lines AND the current file content (for unchanged existing code)
    const existingVariables = new Set<string>();
    
    // Scan deleted lines
    for (const [lineNum, lineContent] of deletedLines) {
      const trimmed = lineContent.trim();
      
      // Check for variable declarations in deleted lines
      const varMatch = trimmed.match(/\b(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[:=]/);
      if (varMatch) {
        existingVariables.add(varMatch[2]);
      }
      
      // Check for interface/type in deleted lines
      const typeMatch = trimmed.match(/\b(interface|type)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (typeMatch) {
        existingVariables.add(typeMatch[2]);
      }
      
      // Python variables
      const pyVarMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=/);
      if (pyVarMatch && !trimmed.includes('def ') && !trimmed.includes('class ')) {
        existingVariables.add(pyVarMatch[1]);
      }
    }
    
    // Scan current file content for existing variables (to catch unchanged code)
    const contentLines = content.split('\n');
    for (let i = 0; i < contentLines.length; i++) {
      const lineNum = i + 1;
      // Skip lines that are being added (they're new)
      if (addedLines.has(lineNum)) continue;
      
      const trimmed = contentLines[i].trim();
      
      // TypeScript/JavaScript variable declarations
      const varMatch = trimmed.match(/\b(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[:=]/);
      if (varMatch) {
        existingVariables.add(varMatch[2]);
      }
      
      // Check for interface/type
      const typeMatch = trimmed.match(/\b(interface|type)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (typeMatch) {
        existingVariables.add(typeMatch[2]);
      }
      
      // Python variables
      const pyVarMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=/);
      if (pyVarMatch && !trimmed.includes('def ') && !trimmed.includes('class ')) {
        existingVariables.add(pyVarMatch[1]);
      }
    }

    // Check added lines for new variables
    for (const [lineNum, lineContent] of addedLines) {
      const trimmed = lineContent.trim();
      
      // Skip comments and imports
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || 
          trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
        continue;
      }

      // Check for interface/type declarations
      const interfaceMatch = trimmed.match(/\b(interface|type)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (interfaceMatch) {
        const varName = interfaceMatch[2];
        const varType = interfaceMatch[1];
        // Only add if it's truly new (not in deleted lines)
        if (!seenVariables.has(varName) && !existingVariables.has(varName)) {
          seenVariables.add(varName);
          variables.push({
            type: varType === 'interface' ? 'interface' : 'type',
            name: varName,
            changeType: 'added',
            filePath: '',
            startLine: lineNum,
            endLine: lineNum,
            details: `Added ${varType}`,
            changeAmount: 1
          });
        }
        continue;
      }

      // Check for variable declarations (skip destructuring patterns)
      const varMatch = trimmed.match(/\b(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[:=]\s*(.+?)(?:;|$)/);
      if (varMatch) {
        const varType = varMatch[1];
        const varName = varMatch[2];
        const varValue = varMatch[3].trim();
        
        // Skip destructuring patterns (e.g., const { error } = ..., const [a, b] = ...)
        if (varName.startsWith('{') || varName.startsWith('[') || 
            trimmed.match(/\b(const|let|var)\s*[{[]/)) {
          continue;
        }
        
        // Skip if this is a function declaration (arrow function or function expression)
        if (varValue.startsWith('function') || 
            varValue.includes('=>') || 
            varValue.startsWith('async ') ||
            varValue.match(/^\([^)]*\)\s*=>/)) {
          continue;
        }
        
        // Try to determine context (inside class, interface, function, etc.)
        const context = this.detectVariableContext(content, lineNum);
        
        // Skip if variable is inside a function (only show file-level or class-level variables)
        if (context === null) {
          // context is null when inside a function - skip this variable
          continue;
        }
        
        // Only add if it's truly new (not in deleted lines)
        if (!seenVariables.has(varName) && !existingVariables.has(varName)) {
          seenVariables.add(varName);
          const varKind = varType === 'const' ? 'constant' : 'variable';
          let description = '';
          
          if (context === 'file-level') {
            description = `${this.capitalize(varKind)} added`;
          } else if (context && typeof context === 'object') {
            description = `${this.capitalize(varKind)} added to ${context.type.toLowerCase()}`;
          } else {
            description = `${this.capitalize(varKind)} added`;
          }
          
          variables.push({
            type: varKind,
            name: varName,
            changeType: 'added',
            filePath: '',
            startLine: lineNum,
            endLine: lineNum,
            details: description,
            changeAmount: 1
          });
        }
        continue;
      }

      // Python variable assignment
      const pyVarMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+?)(?:#|$)/);
      if (pyVarMatch && !trimmed.includes('def ') && !trimmed.includes('class ')) {
        const varName = pyVarMatch[1];
        const varValue = pyVarMatch[2].trim();
        
        // Check if variable is inside a function (skip if it is)
        const context = this.detectVariableContext(content, lineNum);
        if (context === null) {
          // Inside a function - skip this variable
          continue;
        }
        
        // Only add if it's truly new (not in deleted lines)
        if (!seenVariables.has(varName) && !existingVariables.has(varName)) {
          seenVariables.add(varName);
          variables.push({
            type: 'variable',
            name: varName,
            changeType: 'added',
            filePath: '',
            startLine: lineNum,
            endLine: lineNum,
            details: `Added variable: ${varValue.substring(0, 25)}${varValue.length > 25 ? '...' : ''}`,
            changeAmount: 1
          });
        }
      }

      // C# variable declarations (e.g., int x = 5; string name = "test";)
      const csharpVarMatch = trimmed.match(/\b(int|string|bool|double|float|decimal|long|short|byte|char|object|var|[A-Z][a-zA-Z0-9_<>,\[\]]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+?)(?:;|$)/);
      if (csharpVarMatch) {
        const varType = csharpVarMatch[1];
        const varName = csharpVarMatch[2];
        const varValue = csharpVarMatch[3].trim();
        
        // Skip if this looks like a method call or lambda
        if (varValue.includes('=>') || varValue.match(/^\w+\s*\(/)) {
          continue;
        }
        
        // Check if variable is inside a function (skip if it is)
        const context = this.detectVariableContext(content, lineNum);
        if (context === null) {
          // Inside a function - skip this variable
          continue;
        }
        
        // Only add if it's truly new (not in deleted lines)
        if (!seenVariables.has(varName) && !existingVariables.has(varName)) {
          seenVariables.add(varName);
          const varKind = varType === 'const' ? 'constant' : 'variable';
          let description = '';
          
          if (context === 'file-level') {
            description = `${this.capitalize(varKind)} added`;
          } else if (context && typeof context === 'object') {
            description = `${this.capitalize(varKind)} added to ${context.type.toLowerCase()}`;
          } else {
            description = `${this.capitalize(varKind)} added`;
          }
          
          variables.push({
            type: varKind,
            name: varName,
            changeType: 'added',
            filePath: '',
            startLine: lineNum,
            endLine: lineNum,
            details: description,
            changeAmount: 1
          });
        }
      }
    }

    // Check for value changes (variable exists in both added and deleted)
    const deletedVars = new Map<string, string>();
    for (const [lineNum, lineContent] of deletedLines) {
      const trimmed = lineContent.trim();
      // Skip destructuring patterns
      if (trimmed.match(/\b(const|let|var)\s*[{[]/)) {
        continue;
      }
      const varMatch = trimmed.match(/\b(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[:=]\s*(.+?)(?:;|$)/);
      if (varMatch) {
        deletedVars.set(varMatch[2], varMatch[3].trim());
      }
      
      const pyVarMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+?)(?:#|$)/);
      if (pyVarMatch && !trimmed.includes('def ') && !trimmed.includes('class ')) {
        deletedVars.set(pyVarMatch[1], pyVarMatch[2].trim());
      }
    }

    // Find value changes
    for (const [lineNum, lineContent] of addedLines) {
      const trimmed = lineContent.trim();
      // Skip destructuring patterns
      if (trimmed.match(/\b(const|let|var)\s*[{[]/)) {
        continue;
      }
      const varMatch = trimmed.match(/\b(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[:=]\s*(.+?)(?:;|$)/);
      
      if (varMatch) {
        const varName = varMatch[2];
        const newValue = varMatch[3].trim();
        const oldValue = deletedVars.get(varName);
        
        if (oldValue && oldValue !== newValue && !seenVariables.has(varName)) {
          // Check if variable is inside a function (skip if it is)
          const context = this.detectVariableContext(content, lineNum);
          if (context === null) {
            // Inside a function - skip this variable
            continue;
          }
          
          seenVariables.add(varName);
          const oldShort = oldValue.substring(0, 15);
          const newShort = newValue.substring(0, 15);
          const varKind = varMatch[1] === 'const' ? 'constant' : 'variable';
          variables.push({
            type: varKind,
            name: varName,
            changeType: 'value_changed',
            filePath: '',
            startLine: lineNum,
            endLine: lineNum,
            details: `Value: ${oldShort} → ${newShort}`,
            changeAmount: 1
          });
        }
      }
      
      const pyVarMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_$]*)\s*=\s*(.+?)(?:#|$)/);
      if (pyVarMatch && !trimmed.includes('def ') && !trimmed.includes('class ')) {
        const varName = pyVarMatch[1];
        const newValue = pyVarMatch[2].trim();
        const oldValue = deletedVars.get(varName);
        
        if (oldValue && oldValue !== newValue && !seenVariables.has(varName)) {
          // Check if variable is inside a function (skip if it is)
          const context = this.detectVariableContext(content, lineNum);
          if (context === null) {
            // Inside a function - skip this variable
            continue;
          }
          
          seenVariables.add(varName);
          const oldShort = oldValue.substring(0, 15);
          const newShort = newValue.substring(0, 15);
          variables.push({
            type: 'variable',
            name: varName,
            changeType: 'value_changed',
            filePath: '',
            startLine: lineNum,
            endLine: lineNum,
            details: `Value: ${oldShort} → ${newShort}`,
            changeAmount: 1
          });
        }
      }
    }

    return variables;
  }

  private detectVariableContext(content: string, lineNumber: number): { type: string; name: string } | null | 'file-level' {
    const lines = content.split('\n');
    
    // Look backwards from the line to find containing structure
    let braceDepth = 0;
    let foundFunction = false;
    let foundClass = false;
    let classInfo: { type: string; name: string } | null = null;
    
    for (let i = lineNumber - 1; i >= 0; i--) {
      const line = lines[i];
      
      // Check for patterns BEFORE counting braces
      if (braceDepth === 0) {
        // Check for function first (more specific) - if found, variable is in function
        const functionMatch = line.match(/\b(function|async\s+function)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
        if (functionMatch) {
          foundFunction = true;
          break; // Variable is inside a function
        }
        
        // Arrow functions (e.g., const fn = () => { or const fn = (x) => {)
        const arrowMatch = line.match(/=\s*\([^)]*\)\s*=>/);
        if (arrowMatch) {
          foundFunction = true;
          break; // Variable is inside an arrow function
        }
        
        // C# method definitions with return types (e.g., public void MethodName() { or private int GetValue(string x) {)
        const csharpMethodMatch = line.match(/\b(public|private|protected|internal|static|virtual|override|async|sealed|abstract)?\s*(void|int|string|bool|double|float|decimal|long|short|byte|char|object|var|[A-Z][a-zA-Z0-9_<>,\[\]]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)\s*\{?/);
        if (csharpMethodMatch) {
          foundFunction = true;
          break; // Variable is inside a C# method
        }
        
        // Method definitions (e.g., methodName() { or methodName(params) {)
        const methodMatch = line.match(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*[:{]/);
        if (methodMatch) {
          foundFunction = true;
          break; // Variable is inside a method/function
        }
        
        // Check for class/interface
        const classMatch = line.match(/\b(class|interface)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
        if (classMatch) {
          foundClass = true;
          classInfo = { type: classMatch[1], name: classMatch[2] };
          // Don't break - keep looking for functions inside the class
        }
      }
      
      // Count braces to track nesting (going backward, so we reverse the logic)
      // When going backwards: '}' increases depth (we're entering a scope), '{' decreases it (we're exiting)
      for (const char of line) {
        if (char === '}') braceDepth++;
        if (char === '{') braceDepth--;
      }
      
      // Stop if we've exited the containing scope (braceDepth < 0 means we've gone too far out)
      if (braceDepth < 0) break;
    }
    
    // If inside a function, return null (skip this variable)
    if (foundFunction) {
      return null;
    }
    
    // If inside a class but not inside a function, return class info
    if (foundClass && classInfo) {
      return classInfo;
    }
    
    // File-level variable (not inside any function or class)
    return 'file-level';
  }

  private byteOffsetToLineNumber(filePath: string, byteOffset: number): number {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      // Count actual newlines in the content up to the byte offset
      // This handles both LF (\n) and CRLF (\r\n) correctly
      let lineCount = 1; // Start at line 1
      for (let i = 0; i < Math.min(byteOffset, content.length); i++) {
        if (content[i] === '\n') {
          lineCount++;
        }
      }
      return lineCount;
    } catch {
      return 0;
    }
  }

  private generateDiff(filePath: string, oldContent: string, newContent: string): string {
    // Use the diff library to generate a proper unified diff
    const patch = Diff.createPatch(filePath, oldContent, newContent, '', '', { context: 3 });
    return patch;
  }

  private async getFileDiff(filePath: string): Promise<string> {
    const cached = this.diffCache.get(filePath);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.diff;
    }

    try {
      this.log(`Getting diff for: ${filePath}`);
      
      const fullPath = path.join(this.workspaceRoot, filePath);
      
      // If we have a baseline state for this file, diff against the baseline (not lastKnown)
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
      
      // If no baseline, treat as new file
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
    } catch (error: any) {
      this.log(`Failed to get diff for ${filePath}: ${error.message || error}`);
      return 'Error getting diff';
    }
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
      '.vue', '.svelte'
    ];
    return sourceExtensions.some(ext => filePath.endsWith(ext));
  }

  private async revertSymbolChange(relativeFilePath: string, startLine: number, endLine: number, symbolName: string): Promise<void> {
    const fullPath = path.join(this.workspaceRoot, relativeFilePath);
    
    try {
      // Get the baseline state for this file
      const baselineState = this.baselineFileStates.get(fullPath);
      
      if (!baselineState) {
        vscode.window.showWarningMessage(`Cannot revert: No baseline state found for ${symbolName}`);
        this.log(`No baseline state found for ${fullPath}`);
        return;
      }

      // Read current file content
      const currentContent = fs.readFileSync(fullPath, 'utf8');
      const currentLines = currentContent.split('\n');
      
      // Get baseline lines
      const baselineLines = baselineState.split('\n');
      
      // Calculate the range to revert (0-based)
      const startIdx = Math.max(0, startLine - 1);
      const endIdx = Math.min(currentLines.length, endLine);
      
      // Make sure we have enough lines in baseline
      if (endIdx > baselineLines.length) {
        vscode.window.showWarningMessage(`Cannot revert: Symbol ${symbolName} extends beyond baseline file length`);
        return;
      }
      
      // Replace the lines with baseline content
      const newLines = [
        ...currentLines.slice(0, startIdx),
        ...baselineLines.slice(startIdx, endIdx),
        ...currentLines.slice(endIdx)
      ];
      
      const newContent = newLines.join('\n');
      
      // Write the reverted content
      fs.writeFileSync(fullPath, newContent, 'utf8');
      
      this.log(`Reverted changes to ${symbolName} in ${relativeFilePath} (lines ${startLine}-${endLine})`);
      vscode.window.showInformationMessage(`✓ Reverted changes to ${symbolName}`);
      
      // Update the baseline state to current state after revert
      // This prevents the symbol from reappearing as changed
      this.baselineFileStates.set(fullPath, newContent);
      
    } catch (error) {
      this.log(`Failed to revert symbol ${symbolName}: ${error}`);
      vscode.window.showErrorMessage(`Failed to revert ${symbolName}: ${error}`);
    }
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private getHtmlContent(): string {
    const buttonLabel = '🗑️ Clear All';
    const buttonTitle = 'Clear all symbols';
    
    // Generate a nonce for the inline script
    const nonce = this.getNonce();
    
    // Get the webview's CSP source
    const cspSource = this.panel.webview.cspSource;
    
    return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource} 'nonce-${nonce}' 'unsafe-eval'; img-src ${cspSource} data: https:; font-src ${cspSource} data:;">
  <title>Symbol Changes</title>
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

    .symbol-box {
      position: absolute;
      padding: 26px 14px 14px 14px;
      background-color: transparent;
      border: 1.5px solid transparent;
      border-radius: 0;
      font-size: 11px;
      font-weight: 400;
      box-shadow: none;
      transition: all 0.2s ease;
      z-index: 10;
      cursor: pointer;
      box-sizing: border-box; /* Ensure width/height include padding and border */
      /* NO min-width/min-height - sizes are set dynamically via inline styles based on change amount */
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      white-space: nowrap;
      overflow: hidden;
      word-wrap: break-word;
    }

    /* Highlight effect for newly added/updated symbols */
    .symbol-box.highlight {
      box-shadow: inset 0 0 0 4px #FFD700;
    }

    /* Glowing light blue border for change detection */
    .symbol-box.change-detected {
      border: 4px solid #87CEEB;
      box-shadow: 0 0 20px #87CEEB, 0 0 40px #87CEEB, inset 0 0 20px rgba(135, 206, 235, 0.3);
      animation: glowPulse 1s ease-in-out infinite;
    }

    @keyframes glowPulse {
      0%, 100% { 
        box-shadow: 0 0 20px #87CEEB, 0 0 40px #87CEEB, inset 0 0 20px rgba(135, 206, 235, 0.3);
      }
      50% { 
        box-shadow: 0 0 30px #87CEEB, 0 0 60px #87CEEB, inset 0 0 30px rgba(135, 206, 235, 0.5);
      }
    }

    .symbol-type-label {
      position: absolute;
      top: 4px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      color: #000000;
      opacity: 0.85;
      letter-spacing: 0.5px;
      white-space: nowrap;
      z-index: 1;
      pointer-events: none;
    }

    .symbol-size-label {
      position: absolute;
      top: -18px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 9px;
      font-weight: 500;
      font-family: 'Courier New', monospace;
      color: var(--vscode-descriptionForeground);
      opacity: 0.6;
      white-space: nowrap;
      z-index: 1;
      pointer-events: none;
      background: var(--vscode-editor-background);
      padding: 1px 3px;
    }

    /* Base styles for all symbol types */
    .symbol-box.function,
    .symbol-box.class,
    .symbol-box.method,
    .symbol-box.constructor,
    .symbol-box.struct,
    .symbol-box.variable,
    .symbol-box.constant,
    .symbol-box.file {
      /* border-color remains transparent from .symbol-box base style */
    }

    /* Interface and type get dashed borders */
    .symbol-box.interface,
    .symbol-box.type {
      border-style: dashed;
      border-color: transparent;
    }

    /* Constants get thicker borders */
    .symbol-box.constant {
      border-width: 2px;
    }

    /* File boxes have minimum width */
    .symbol-box.file {
      min-width: 120px;
    }

    /* Permanent background colors by change type */
    .symbol-box[data-change-type="added"] {
      background: #90EE90; /* Light green for new symbols */
    }

    .symbol-box[data-change-type="modified"] {
      background: #dfe85d; /* Yellow-green for changed symbols */
    }

    .symbol-box[data-change-type="deleted"] {
      background: #FFB6C1; /* Light red for deleted symbols */
      opacity: 1;
    }

    .symbol-box[data-change-type="deleted"] .symbol-name,
    .symbol-box[data-change-type="deleted"] .symbol-type-label,
    .symbol-box[data-change-type="deleted"] .change-symbol {
      color: #000000; /* Black text for deleted symbols */
    }

    .symbol-box[data-change-type="value_changed"] {
      background: #dfe85d; /* Yellow-green for value changed */
    }

    /* Temporary pulsing animations (removed after 3 seconds) */
    .symbol-box.added {
      animation: pulseGreen 3s ease-in-out infinite;
    }

    .symbol-box.modified {
      animation: pulseYellow 3s ease-in-out infinite;
    }

    .symbol-box.deleted {
      animation: pulseRed 3s ease-in-out infinite;
    }

    .symbol-box.value_changed {
      animation: pulseYellow 3s ease-in-out infinite;
    }

    @keyframes pulseGreen {
      0%, 100% { border-color: #32CD32; opacity: 1; }
      50% { border-color: #7FFF7F; opacity: 0.85; }
    }

    @keyframes pulseYellow {
      0%, 100% { border-color: #FFD700; opacity: 1; }
      50% { border-color: #FFED4E; opacity: 0.85; }
    }

    @keyframes pulseRed {
      0%, 100% { border-color: #FF6B6B; opacity: 1; }
      50% { border-color: #FFB6C1; opacity: 0.85; }
    }

    .symbol-box:hover {
      transform: scale(1.03);
      z-index: 20;
      border-width: 2px;
      cursor: pointer;
    }

    .diff-tooltip {
      position: fixed;
      background-color: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 12px;
      max-width: 600px;
      max-height: 400px;
      overflow: auto;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      z-index: 1000;
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      white-space: pre-wrap;
      word-wrap: break-word;
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: none;
      transform: scale(1);
    }

    .diff-tooltip.visible {
      opacity: 1;
      pointer-events: auto;
    }

    .diff-tooltip-header {
      font-weight: bold;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-button-background);
    }

    .diff-tooltip .diff-line {
      font-family: 'Courier New', monospace;
      line-height: 1.4;
    }

    .diff-tooltip .diff-line.addition {
      background-color: rgba(0, 255, 0, 0.1);
      color: #90ee90;
    }

    .diff-tooltip .diff-line.deletion {
      background-color: rgba(255, 0, 0, 0.1);
      color: #ff6b6b;
    }

    .diff-tooltip .diff-line.context {
      color: var(--vscode-editor-foreground);
      opacity: 0.7;
    }

    .diff-tooltip .diff-line.context[style*="font-weight: bold"] {
      text-align: center;
    }

    .file-container {
      position: absolute;
      border: 2px solid var(--vscode-panel-border);
      border-radius: 0;
      background-color: #4c4d4c;
      padding: 85px 2px 10px 2px;
      box-sizing: border-box; /* Width/height includes border and padding */
      /* Make this the positioning context for child symbol boxes */
      /* Child elements with position:absolute will be relative to this container */
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
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
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

    .file-path-tooltip {
      position: fixed;
      background-color: var(--vscode-editorHoverWidget-background, #252526);
      color: var(--vscode-editorHoverWidget-foreground, #cccccc);
      border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
      border-radius: 3px;
      padding: 4px 8px;
      font-size: 12px;
      font-family: var(--vscode-font-family);
      white-space: nowrap;
      z-index: 10000;
      pointer-events: none;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
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

    .symbol-content {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      white-space: nowrap;
    }

    .symbol-name {
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
      text-align: center;
      color: #000000;
    }

    .change-symbol {
      font-size: 12px;
      font-weight: 600;
      opacity: 0.7;
      flex-shrink: 0;
      color: #000000;
    }


    svg {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 1;
    }

    .call-line {
      stroke: var(--vscode-panel-border);
      stroke-width: 1;
      fill: none;
      opacity: 0.3;
      marker-end: url(#arrowhead);
    }

    .call-line.animated {
      stroke-dasharray: 4, 3;
      animation: dash 2s linear infinite;
    }

    @keyframes dash {
      to {
        stroke-dashoffset: -7;
      }
    }

    #info {
      position: fixed;
      top: 16px;
      right: 16px;
      padding: 8px 12px;
      background-color: transparent;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      font-size: 11px;
      z-index: 100;
    }

    #info h3 {
      margin-bottom: 0;
      font-size: 11px;
      font-weight: 400;
      color: var(--vscode-foreground);
      opacity: 0.6;
    }

    #zoom-controls {
      position: fixed;
      bottom: 16px;
      right: 16px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      z-index: 100;
    }

    .zoom-button {
      width: 32px;
      height: 32px;
      background-color: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      font-size: 14px;
      font-weight: 400;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      opacity: 0.6;
    }

    .zoom-button:hover {
      opacity: 1;
      border-color: var(--vscode-foreground);
    }

    #zoom-level {
      text-align: center;
      font-size: 9px;
      opacity: 0.5;
      padding: 2px;
    }

    #clear-button {
      position: fixed;
      bottom: 16px;
      left: 16px;
      padding: 6px 10px;
      background-color: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      font-size: 11px;
      font-weight: 400;
      cursor: pointer;
      z-index: 100;
      transition: all 0.15s ease;
      opacity: 0.6;
    }

    #clear-button:hover {
      opacity: 1;
      border-color: var(--vscode-foreground);
    }

    #auto-focus-toggle {
      position: fixed;
      bottom: 50px;
      left: 16px;
      padding: 6px 10px;
      background-color: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      font-size: 11px;
      font-weight: 400;
      cursor: pointer;
      z-index: 100;
      transition: all 0.15s ease;
      opacity: 0.6;
      display: flex;
      align-items: center;
      gap: 6px;
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
      width: 12px;
      height: 12px;
      border: 1px solid currentColor;
      border-radius: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
    }

    .comment-overlay {
      position: absolute;
      background-color: rgba(216, 191, 216, 0.95);
      color: #000000;
      padding: 12px 16px;
      border-radius: 4px;
      font-size: 20px;
      font-weight: 400;
      font-style: italic;
      min-width: 200px;
      max-width: 400px;
      text-align: left;
      z-index: 15;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      pointer-events: auto;
      white-space: pre-wrap;
      word-wrap: break-word;
      line-height: 1.4;
      transition: opacity 0.3s ease;
    }

    .comment-overlay.fading {
      animation: fadeOut 0.5s ease-in-out forwards;
    }

    @keyframes fadeOut {
      0% { opacity: 1; transform: translateY(0); }
      100% { opacity: 0; transform: translateY(-5px); }
    }

    .context-menu {
      position: fixed;
      background-color: var(--vscode-menu-background);
      border: 1px solid var(--vscode-menu-border);
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      z-index: 10000;
      min-width: 180px;
      padding: 4px 0;
      display: none;
    }

    .context-menu.visible {
      display: block;
    }

    .context-menu-item {
      padding: 6px 16px;
      cursor: pointer;
      font-size: 13px;
      color: var(--vscode-menu-foreground);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .context-menu-item:hover {
      background-color: var(--vscode-menu-selectionBackground);
      color: var(--vscode-menu-selectionForeground);
    }

    .context-menu-separator {
      height: 1px;
      background-color: var(--vscode-menu-separatorBackground);
      margin: 4px 0;
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
  
  <button id="clear-button" title="${buttonTitle}">
    ${buttonLabel}
  </button>
  
  <button id="auto-focus-toggle" title="Auto-focus on changes">
    <span class="toggle-checkbox"></span>
    <span>Auto-focus on changes</span>
  </button>

  <div id="context-menu" class="context-menu">
    <div class="context-menu-item" id="context-explain">
      📝 Explain latest change
    </div>
    <div class="context-menu-separator"></div>
    <div class="context-menu-item" id="context-revert">
      ↩️ Revert change
    </div>
  </div>
  
  <div id="container">
    <div id="canvas">
      <svg id="connections">
        <defs>
          <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="2.5" orient="auto">
            <polygon points="0 0, 8 2.5, 0 5" fill="var(--vscode-panel-border)" opacity="0.5" />
          </marker>
        </defs>
      </svg>
    </div>
  </div>

  <script nonce="${nonce}">
    console.log('[Symbol Changes] Script tag loaded');
    (function() {
      console.log('[Symbol Changes] IIFE started');
      // Acquire VS Code API once at the top (can only be called once!)
      const vscode = acquireVsCodeApi();
      console.log('[Symbol Changes] VS Code API acquired');
      
      // Global error handler
      window.addEventListener('error', (event) => {
        console.error('[Symbol Changes] Global error:', event.error);
        console.error('[Symbol Changes] Error message:', event.message);
        console.error('[Symbol Changes] Error at:', event.filename, event.lineno, event.colno);
        
        vscode.postMessage({
          type: 'webviewError',
          error: {
            message: event.message || 'Unknown error',
            stack: event.error?.stack || 'No stack trace',
            location: event.filename + ':' + event.lineno + ':' + event.colno
          }
        });
      });
      
      // Unhandled promise rejection handler
      window.addEventListener('unhandledrejection', (event) => {
        console.error('[Symbol Changes] Unhandled promise rejection:', event.reason);
        
        vscode.postMessage({
          type: 'webviewError',
          error: {
            message: 'Unhandled promise rejection: ' + (event.reason?.message || event.reason),
            stack: event.reason?.stack || 'No stack trace'
          }
        });
      });
      
      try {
        console.log('[Symbol Changes] Initializing view...');
        
        // Cross-platform path utilities
        function getFileName(filePath) {
          // Normalize to forward slashes, then get the last part
          const normalized = filePath.replace(/\\/g, '/');
          return normalized.split('/').pop() || filePath;
        }
        
        function splitPath(filePath) {
          // Normalize to forward slashes, then split
          const normalized = filePath.replace(/\\/g, '/');
          return normalized.split('/');
        }
        
        function formatPathForDisplay(filePath) {
          // Normalize to forward slashes for consistent display
          const normalized = filePath.replace(/\\/g, '/');
          // Split on slashes and rejoin with slash + line break for proper wrapping
          const parts = normalized.split('/');
          return parts.join('/\u200B'); // Zero-width space allows breaking after /
        }
        
        function splitPathIntoDirectoryAndFile(filePath) {
          // Normalize to forward slashes
          const normalized = filePath.replace(/\\/g, '/');
          const parts = normalized.split('/');
          
          if (parts.length === 1) {
            // No directory, just filename
            return { directory: '', filename: parts[0] };
          }
          
          // Last part is filename, rest is directory
          const filename = parts[parts.length - 1];
          const directory = parts.slice(0, -1).join('/');
          
          return { directory, filename };
        }
        
        function adjustFileLabelFontSize(label, containerWidth) {
          // Start with a reasonable font size
          let fontSize = 16;
          const minFontSize = 10;
          const maxFontSize = 18;
          
          // Set initial font size
          label.style.fontSize = fontSize + 'px';
          
          // Measure and adjust if needed
          // Allow some iterations to find the best fit
          let iterations = 0;
          while (iterations < 10) {
            const scrollHeight = label.scrollHeight;
            const maxHeight = 50; // Match CSS max-height
            
            if (scrollHeight > maxHeight && fontSize > minFontSize) {
              // Text is too tall, reduce font size
              fontSize -= 1;
              label.style.fontSize = fontSize + 'px';
            } else if (scrollHeight < maxHeight * 0.7 && fontSize < maxFontSize) {
              // Text is too small, we can increase font size
              fontSize += 1;
              label.style.fontSize = fontSize + 'px';
            } else {
              // Good fit
              break;
            }
            iterations++;
          }
        }
        
        // vscode API already acquired at the top
        const container = document.getElementById('container');
        const canvas = document.getElementById('canvas');
        const svg = document.getElementById('connections');
        const zoomLevelEl = document.getElementById('zoom-level');

        if (!container || !canvas || !svg || !zoomLevelEl) {
          console.error('[Symbol Changes] Failed to find required DOM elements');
          return;
        }

        console.log('[Symbol Changes] DOM elements found successfully');

        let scale = 1;
        let translateX = 0;
        let translateY = 0;
        let isPanning = false;
        let startX = 0;
        let startY = 0;

        const fileGroups = new Map(); // filePath -> { symbols: [], x: number, width: number }
        const fileOrder = []; // Track file creation order
        let nextX = 100;
        const SYMBOL_SPACING = 20; // Minimum spacing between symbols (legacy)
        const FILE_LABEL_HEIGHT = 85; // Height of header area (stats + file path)
        const START_Y = 50 + FILE_LABEL_HEIGHT; // Where symbols start
        const FILE_SPACING = 80; // Spacing between file columns (reduced for row layout)
        const SYMBOL_WIDTH = 150; // Approximate symbol width (for estimates)
        let lastGlowingBox = null; // Track the currently glowing box
        let repositionTimeout = null; // Debounce repositioning
        let autoFocusEnabled = true; // Auto focus on changes by default

        // Context menu setup
        const contextMenu = document.getElementById('context-menu');
        const contextExplain = document.getElementById('context-explain');
        const contextRevert = document.getElementById('context-revert');
        
        // Hide context menu when clicking elsewhere
        document.addEventListener('click', () => {
          if (contextMenu) {
            contextMenu.classList.remove('visible');
          }
        });

        // Handle "Explain latest change" menu item
        if (contextExplain && contextMenu) {
          contextExplain.addEventListener('click', (e) => {
          e.stopPropagation();
          
          const symbolName = contextMenu.dataset.symbolName;
          const symbolType = contextMenu.dataset.symbolType;
          const changeType = contextMenu.dataset.symbolChangeType;
          const startLine = contextMenu.dataset.symbolStartLine;
          const endLine = contextMenu.dataset.symbolEndLine;
          const changeAmount = contextMenu.dataset.symbolChangeAmount;
          const filePath = contextMenu.dataset.filePath;
          const diff = contextMenu.dataset.diff;
          
          // Create the prompt text
          const prompt = 'Please explain the following change. Do not change any code, just reply.\\n\\n' +
            'Symbol: ' + symbolName + '\\n' +
            'Type: ' + symbolType + '\\n' +
            'Change Type: ' + changeType + '\\n' +
            'File: ' + filePath + '\\n' +
            'Lines: ' + startLine + '-' + endLine + '\\n' +
            'Lines Changed: ' + changeAmount + '\\n\\n' +
            'Diff:\\n' + diff;
          
          // Copy to clipboard
          navigator.clipboard.writeText(prompt).then(() => {
            console.log('[Symbol Changes] Copied explanation prompt to clipboard');
            
            // Show a brief notification
            const notification = document.createElement('div');
            notification.style.position = 'fixed';
            notification.style.top = '20px';
            notification.style.left = '50%';
            notification.style.transform = 'translateX(-50%)';
            notification.style.backgroundColor = 'var(--vscode-notifications-background)';
            notification.style.color = 'var(--vscode-notifications-foreground)';
            notification.style.padding = '12px 20px';
            notification.style.borderRadius = '4px';
            notification.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
            notification.style.zIndex = '20000';
            notification.style.fontSize = '13px';
            notification.textContent = '✓ Copied to clipboard';
            document.body.appendChild(notification);
            
            setTimeout(() => {
              notification.style.transition = 'opacity 0.3s ease';
              notification.style.opacity = '0';
              setTimeout(() => notification.remove(), 300);
            }, 2000);
          }).catch(err => {
            console.error('[Symbol Changes] Failed to copy to clipboard:', err);
          });
          
          contextMenu.classList.remove('visible');
          });
        }

        // Handle "Revert change" menu item
        if (contextRevert && contextMenu) {
          contextRevert.addEventListener('click', (e) => {
          e.stopPropagation();
          
          const filePath = contextMenu.dataset.filePath;
          const startLine = parseInt(contextMenu.dataset.symbolStartLine, 10);
          const endLine = parseInt(contextMenu.dataset.symbolEndLine, 10);
          const symbolName = contextMenu.dataset.symbolName;
          
          // Send message to extension to revert the change
          vscode.postMessage({
            type: 'revertSymbolChange',
            filePath: filePath,
            startLine: startLine,
            endLine: endLine,
            symbolName: symbolName
          });
          
          contextMenu.classList.remove('visible');
          });
        }

        function updateTransform() {
          canvas.style.transform = 'translate(' + translateX + 'px, ' + translateY + 'px) scale(' + scale + ')';
          zoomLevelEl.textContent = Math.round(scale * 100) + '%';
        }

        // Auto-focus on an element (center it in the view)
        function focusOnElement(element) {
          if (!autoFocusEnabled || !element) return;
          
          // Get element position in canvas coordinates (using current scale)
          const rect = element.getBoundingClientRect();
          const canvasRect = canvas.getBoundingClientRect();
          
          // Calculate element center in original canvas coordinates
          const elementCenterX = (rect.left + rect.width / 2 - canvasRect.left) / scale;
          const elementCenterY = (rect.top + rect.height / 2 - canvasRect.top) / scale;
          
          // Calculate viewport center
          const viewportCenterX = container.clientWidth / 2;
          const viewportCenterY = container.clientHeight / 2;
          
          // Calculate required translation to center the element (keeping current zoom)
          translateX = viewportCenterX - elementCenterX * scale;
          translateY = viewportCenterY - elementCenterY * scale;
          
          // Smooth transition
          canvas.classList.remove('no-transition');
          updateTransform();
        }

        // Helper function to calculate symbol weight (importance)
        function getSymbolWeight(type) {
          // Higher weight = more important, shown first
          if (type === 'class') return 5;
          if (type === 'struct') return 5;
          if (type === 'interface' || type === 'type') return 4;
          if (type === 'function' || type === 'method') return 3;
          if (type === 'constant') return 2;
          if (type === 'variable') return 1;
          if (type === 'file') return 0; // Fallback file boxes have lowest weight
          return 1;
        }

        // Helper function to get change symbol
        function getChangeSymbol(changeType) {
          if (changeType === 'added') return '*';
          if (changeType === 'modified' || changeType === 'value_changed') return '~';
          if (changeType === 'deleted') return '-';
          return '';
        }

        // Constants for sizing - 3 discrete sizes
        const SMALL_SIZE = { width: 120, height: 40 };
        const MEDIUM_SIZE = { width: 200, height: 65 };
        const LARGE_SIZE = { width: 300, height: 95 };

        // Calculate box dimensions based on change amount
        // Returns one of three discrete sizes: small, medium, or large
        function calculateBoxSize(changeAmount, symbolName) {
          // Ensure we have a valid change amount
          const amount = Math.max(1, changeAmount || 1);
          
          // Determine size based on thresholds
          let size;
          if (amount <= 10) {
            size = SMALL_SIZE;
          } else if (amount <= 50) {
            size = MEDIUM_SIZE;
          } else {
            size = LARGE_SIZE;
          }
          
          // If symbol name is provided, ensure width is sufficient to fit the text
          let width = size.width;
          if (symbolName) {
            // Estimate text width: roughly 7-8 pixels per character at base font size
            // Add padding for the box (28px left+right padding) + some margin
            const estimatedTextWidth = symbolName.length * 8 + 40;
            width = Math.max(width, estimatedTextWidth);
          }
          
          return { 
            width: width, 
            height: size.height 
          };
        }

        // Bin-packing algorithm using Guillotine with Best Area Fit
        // Returns positions plus packed content width/height
        function packSymbols(symbolsMap, containerWidth) {
          // Convert map to array and extract symbol data with change amounts
          const symbolsArray = [];
          for (const [symbolKey, elements] of symbolsMap.entries()) {
            if (elements && elements.length > 0) {
              const box = elements[0];
              const changeAmount = parseInt(box.dataset.changeAmount || '1', 10);
              // Get symbol name from the box for width calculation
              const symbolNameElement = box.querySelector('.symbol-name');
              const symbolName = symbolNameElement ? symbolNameElement.textContent : '';
              const size = calculateBoxSize(changeAmount, symbolName);
              
              // Set the size on the box first so we can measure it accurately
              box.style.width = size.width + 'px';
              box.style.height = size.height + 'px';
              
              // Get the actual rendered dimensions (includes border, padding due to box-sizing: border-box)
              // Use offsetWidth/offsetHeight which includes border and padding
              const actualWidth = box.offsetWidth || size.width;
              const actualHeight = box.offsetHeight || size.height;
              
              symbolsArray.push({
                key: symbolKey,
                element: box,
                changeAmount: changeAmount,
                width: actualWidth,
                height: actualHeight
              });
            }
          }
          
          // Sort by area descending (largest first for better packing)
          symbolsArray.sort((a, b) => {
            const areaA = a.width * a.height;
            const areaB = b.width * b.height;
            return areaB - areaA;
          });
          
          const PADDING = 4;
          const positions = [];
          
          // Free rectangles (available spaces)
          const freeRects = [{ x: 0, y: 0, width: containerWidth, height: 100000 }];
          
          // Find best rectangle for a box using Best Area Fit
          function findBestRect(boxWidth, boxHeight) {
            let bestRect = null;
            let bestAreaFit = Infinity;
            let bestShortSideFit = Infinity;
            
            for (const rect of freeRects) {
              // Check if box fits
              if (rect.width >= boxWidth + PADDING && rect.height >= boxHeight + PADDING) {
                const areaFit = rect.width * rect.height - boxWidth * boxHeight;
                const leftoverHoriz = rect.width - boxWidth;
                const leftoverVert = rect.height - boxHeight;
                const shortSideFit = Math.min(leftoverHoriz, leftoverVert);
                
                if (areaFit < bestAreaFit || (areaFit === bestAreaFit && shortSideFit < bestShortSideFit)) {
                  bestRect = rect;
                  bestAreaFit = areaFit;
                  bestShortSideFit = shortSideFit;
                }
              }
            }
            
            return bestRect;
          }
          
          // Split a rectangle after placing a box
          function splitRect(usedRect, boxX, boxY, boxWidth, boxHeight) {
            const newRects = [];
            
            // Remove the used rectangle
            const index = freeRects.indexOf(usedRect);
            if (index > -1) {
              freeRects.splice(index, 1);
            }
            
            // Create new rectangles from the leftover space
            // Right side
            if (boxX + boxWidth + PADDING < usedRect.x + usedRect.width) {
              newRects.push({
                x: boxX + boxWidth + PADDING,
                y: usedRect.y,
                width: usedRect.x + usedRect.width - (boxX + boxWidth + PADDING),
                height: usedRect.height
              });
            }
            
            // Bottom side
            if (boxY + boxHeight + PADDING < usedRect.y + usedRect.height) {
              newRects.push({
                x: usedRect.x,
                y: boxY + boxHeight + PADDING,
                width: usedRect.width,
                height: usedRect.y + usedRect.height - (boxY + boxHeight + PADDING)
              });
            }
            
            // Add new rectangles
            for (const newRect of newRects) {
              // Check if this rectangle is not contained within another
              let isContained = false;
              for (const existingRect of freeRects) {
                if (newRect.x >= existingRect.x && 
                    newRect.y >= existingRect.y &&
                    newRect.x + newRect.width <= existingRect.x + existingRect.width &&
                    newRect.y + newRect.height <= existingRect.y + existingRect.height) {
                  isContained = true;
                  break;
                }
              }
              
              if (!isContained) {
                freeRects.push(newRect);
              }
            }
            
            // Remove rectangles that overlap with the placed box
            for (let i = freeRects.length - 1; i >= 0; i--) {
              const rect = freeRects[i];
              if (!(boxX + boxWidth + PADDING <= rect.x ||
                    boxX >= rect.x + rect.width ||
                    boxY + boxHeight + PADDING <= rect.y ||
                    boxY >= rect.y + rect.height)) {
                // Overlaps, need to split or remove
                freeRects.splice(i, 1);
                
                // Create non-overlapping parts
                // Left part
                if (rect.x < boxX) {
                  freeRects.push({
                    x: rect.x,
                    y: rect.y,
                    width: boxX - rect.x,
                    height: rect.height
                  });
                }
                // Right part
                if (rect.x + rect.width > boxX + boxWidth + PADDING) {
                  freeRects.push({
                    x: boxX + boxWidth + PADDING,
                    y: rect.y,
                    width: rect.x + rect.width - (boxX + boxWidth + PADDING),
                    height: rect.height
                  });
                }
                // Top part
                if (rect.y < boxY) {
                  freeRects.push({
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: boxY - rect.y
                  });
                }
                // Bottom part
                if (rect.y + rect.height > boxY + boxHeight + PADDING) {
                  freeRects.push({
                    x: rect.x,
                    y: boxY + boxHeight + PADDING,
                    width: rect.width,
                    height: rect.y + rect.height - (boxY + boxHeight + PADDING)
                  });
                }
              }
            }
          }
          
          // Place each box
          for (const symbol of symbolsArray) {
            const rect = findBestRect(symbol.width, symbol.height);
            
            if (rect) {
              positions.push({
                key: symbol.key,
                element: symbol.element,
                x: rect.x,
                y: rect.y,
                width: symbol.width,
                height: symbol.height
              });
              
              splitRect(rect, rect.x, rect.y, symbol.width, symbol.height);
            } else {
              // Fallback: place at bottom
              const maxY = positions.length > 0 ? Math.max(...positions.map(p => p.y + p.height)) : 0;
              positions.push({
                key: symbol.key,
                element: symbol.element,
                x: 0,
                y: maxY + PADDING,
                width: symbol.width,
                height: symbol.height
              });
            }
          }
          
          // Compute packed content dimensions
          let contentW = 0;
          let contentH = 0;
          if (positions.length > 0) {
            for (const p of positions) {
              contentW = Math.max(contentW, p.x + p.width);
              contentH = Math.max(contentH, p.y + p.height);
            }
          }
          
          return { positions, contentW, contentH };
        }

        // Helper function to wrap file path at slashes for better display
        function wrapFilePath(filePath, maxWidth = 600) {
          // Simple heuristic: if path is longer than ~80 chars, wrap at middle /
          if (filePath.length <= 80) {
            return filePath;
          }
          
          // Split at slashes and try to fit in 2 lines
          const parts = splitPath(filePath);
          if (parts.length <= 2) {
            return filePath; // Can't split meaningfully
          }
          
          // Find a good split point (around middle)
          const targetLength = filePath.length / 2;
          let currentLength = 0;
          let splitIndex = 0;
          
          for (let i = 0; i < parts.length - 1; i++) {
            currentLength += parts[i].length + 1; // +1 for the /
            if (currentLength >= targetLength) {
              splitIndex = i + 1;
              break;
            }
          }
          
          if (splitIndex > 0 && splitIndex < parts.length) {
            const line1 = parts.slice(0, splitIndex).join('/');
            const line2 = parts.slice(splitIndex).join('/');
            return line1 + '\n' + line2;
          }
          
          return filePath;
        }

        // Helper function to calculate optimal container width for packing
        function calculateOptimalContainerWidth(symbolsMap, labelWidth) {
          if (symbolsMap.size === 0) return 400;
          
          // Calculate total area needed for all symbols
          let totalArea = 0;
          let maxSymbolWidth = 0;
          
          for (const [symbolKey, elements] of symbolsMap.entries()) {
            if (elements && elements.length > 0) {
              const box = elements[0];
              const changeAmount = parseInt(box.dataset.changeAmount || '1', 10);
              // Get symbol name from the box for width calculation
              const symbolNameElement = box.querySelector('.symbol-name');
              const symbolName = symbolNameElement ? symbolNameElement.textContent : '';
              const size = calculateBoxSize(changeAmount, symbolName);
              totalArea += size.width * size.height;
              maxSymbolWidth = Math.max(maxSymbolWidth, size.width);
            }
          }
          
          // No padding between symbols
          // totalArea is just sum of symbol areas
          
          // Base width from area; prefer wider layout
          let candidateW = Math.sqrt(totalArea) * 1.35;
          
          // Ensure container is at least as wide as the largest symbol and label width
          const minWidth = Math.max(maxSymbolWidth, labelWidth || 300);
          candidateW = Math.max(minWidth, Math.min(candidateW, 900));
          
          // Small iterative refinement (3-4 steps) to balance width/height
          let bestW = candidateW;
          let bestArea = Number.POSITIVE_INFINITY;
          for (let i = 0; i < 4; i++) {
            const innerW = Math.max(minWidth, bestW);
            const packed = packSymbols(symbolsMap, innerW);
            const totalH = packed.contentH + 40; // include top padding only
            const area = bestW * totalH;
            if (area < bestArea) {
              bestArea = area;
            } else {
              // If area worsened, revert last change slightly
              bestW = Math.max(minWidth, bestW * 1.05);
              break;
            }
            // Adjust width for next iteration
            if (totalH > 2.2 * bestW) {
              bestW = Math.min(900, bestW * 1.15);
            } else {
              bestW = Math.max(minWidth, bestW * 0.9);
            }
          }
          return Math.max(minWidth, Math.min(bestW, 900));
        }

        // Helper function to reposition all files using brick-packing layout
        function repositionAllFiles() {
          const CONTAINER_WIDTH = 1400; // Max width before wrapping
          const FILE_PADDING = 12; // Padding between file containers
          const START_X = 80;
          const START_Y = 50;
          
          let currentX = START_X;
          let currentY = START_Y;
          let rowHeight = 0;
          
          // Use fileOrder array to maintain creation order
          fileOrder.forEach(filePath => {
            const group = fileGroups.get(filePath);
            if (!group) return;
            
            // Calculate label width estimate
            let labelWidth = 300;
            if (group.fileLabel) {
              const measured = group.fileLabel.offsetWidth || 0;
              const estimate = (group.fileLabel.textContent || '').length * 7 + 30;
              labelWidth = Math.max(300, measured || estimate);
            }
            
            // Calculate optimal container width for packing
            const optimalWidth = calculateOptimalContainerWidth(group.symbols, labelWidth);
            group.width = optimalWidth;
            
            // Update all symbol positions in this file to get the height
            repositionFileSymbols(group);
            
            // Get the actual height from the container
            const containerHeight = parseInt(group.fileContainer.style.height) || 100;
            
            // Check if we need to wrap to next row
            if (currentX + group.width > CONTAINER_WIDTH && currentX > START_X) {
              currentX = START_X;
              currentY += rowHeight + FILE_PADDING;
              rowHeight = 0;
            }
            
            // Update group position
            group.x = currentX;
            group.y = currentY;
            
            // Update file container position
            if (group.fileContainer) {
              group.fileContainer.style.left = currentX + 'px';
              group.fileContainer.style.top = currentY + 'px';
            }
            
            // Track row height
            rowHeight = Math.max(rowHeight, containerHeight);
            
            // Move to next position in row
            currentX += group.width + FILE_PADDING;
          });
        }

        // Helper function to get symbol category for row-based layout
        function getSymbolCategory(type) {
          if (type === 'variable' || type === 'constant') return 'variables';
          if (type === 'interface' || type === 'type') return 'types';
          if (type === 'class' || type === 'struct') return 'classes';
          if (type === 'function' || type === 'method') return 'functions';
          return 'other';
        }

        // Helper function to reposition all symbols in a file group using bin-packing layout
        function repositionFileSymbols(group) {
          if (group.symbols.size === 0) {
            // Empty container - set minimum size based on label width
            let labelMinWidth = 300;
            if (group.fileLabel) {
              const measured = group.fileLabel.scrollWidth || 0;
              const estimate = (group.fileLabel.textContent || '').length * 8 + 20;
              labelMinWidth = Math.max(300, measured || estimate);
            }
            group.fileContainer.style.width = labelMinWidth + 'px';
            group.fileContainer.style.height = '100px';
            group.width = labelMinWidth;
            return;
          }
          
          // Use bin-packing algorithm to position symbols based on change amount
          const availableWidth = group.width; // No side padding - use full width
          console.log('[Layout] Packing symbols, containerWidth:', group.width, 'availableWidth:', availableWidth);
          const packed = packSymbols(group.symbols, availableWidth);
          console.log('[Layout] Packed result - contentW:', packed.contentW, 'contentH:', packed.contentH, 'positions:', packed.positions.length);
          
          // Calculate exact container dimensions needed
          let maxWidth = 0;
          let maxHeight = 0;
          
          // Apply positions to each symbol (relative to container)
          for (const pos of packed.positions) {
            const box = pos.element;
            
            // Position relative to file container (accounting for 85px top padding and 2px left padding)
            box.style.left = (pos.x + 2) + 'px'; // Add 2px for left padding
            box.style.top = (pos.y + 85) + 'px'; // Add 85px for label space
            
            // Ensure the box has the correct size
            box.style.width = pos.width + 'px';
            box.style.height = pos.height + 'px';
            
            // Set font size based on discrete box size
            // Small: 11px, Medium: 14px, Large: 17px
            let fontSize = 11;
            if (pos.height >= LARGE_SIZE.height) {
              fontSize = 17;
            } else if (pos.height >= MEDIUM_SIZE.height) {
              fontSize = 14;
            }
            
            // Apply font size to symbol name
            const symbolName = box.querySelector('.symbol-name');
            if (symbolName) {
              symbolName.style.fontSize = fontSize + 'px';
            }
            
            // Update size label to show dimensions
            const sizeLabel = box.querySelector('.symbol-size-label');
            if (sizeLabel) {
              const changeAmount = box.dataset.changeAmount || '1';
              sizeLabel.textContent = pos.width + 'x' + pos.height + ' (' + changeAmount + 'L)';
            }
            
            console.log('[Layout] Positioned symbol:', pos.element.dataset.changeAmount, 'lines, size:', pos.width, 'x', pos.height, 'at', pos.x, ',', pos.y);
            
            // Track max dimensions
            maxWidth = Math.max(maxWidth, pos.x + pos.width);
            maxHeight = Math.max(maxHeight, pos.y + pos.height);
            
            // Store symbol position for connections (absolute coordinates)
            const absoluteX = group.x + pos.x + pos.width / 2;
            const absoluteY = group.y + 85 + pos.y + pos.height / 2; // group.y container top + 85px label padding + pos.y
            
            // Get the actual symbol name from the box content
            const nameSpan = box.querySelector('.symbol-name');
            if (nameSpan) {
              const displayName = nameSpan.textContent.replace('()', ''); // Remove () suffix
              group.symbolPositions.set(displayName, {
                name: displayName,
                element: box,
                x: absoluteX,
                y: absoluteY
              });
            }
          }
          
          // Calculate minimum width needed for the file path label
          let labelMinWidth = 300; // Default minimum
          if (group.fileLabel) {
            // Measure the label's actual text width
            const measured = group.fileLabel.scrollWidth || 0;
            const estimate = (group.fileLabel.textContent || '').length * 8 + 20;
            labelMinWidth = Math.max(300, measured || estimate);
          }
          
          // Resize container to fit all symbols AND the label
          // Container has box-sizing: border-box, so width/height includes border (2px each side = 4px total)
          // and padding (85px top, 10px bottom). The content area for symbols is the full width/height minus these.
          // Since symbols are positioned in the content area, we set container size to exactly match packed size.
          // Add extra padding to ensure symbols don't touch borders or overflow
          // IMPORTANT: With box-sizing: border-box, the total height must account for:
          //   - 85px top padding (where label and stats live)
          //   - packed.contentH (actual symbol content height)
          //   - 10px bottom padding
          //   - 4px borders (2px top + 2px bottom)
          const finalWidth = Math.max(packed.contentW + 4, labelMinWidth); // Add 4px horizontal padding
          const finalHeight = packed.contentH + 85 + 10 + 4; // 85px label padding + 10px bottom padding + 4px borders
          
          console.log('[Layout] Final container size:', finalWidth, 'x', finalHeight, '(label min:', labelMinWidth, ', packed:', packed.contentW, 'x', packed.contentH, ')');
          group.fileContainer.style.width = finalWidth + 'px';
          group.fileContainer.style.height = finalHeight + 'px';
          
          // No need to adjust font size anymore - using fixed sizes for directory and filename
          
          // Update group width for file spacing calculations
          group.width = finalWidth;
        }

        function handleSingleSymbolChange(data) {
          console.log('[Symbol Changes] handleSingleSymbolChange called', data);
          const { filePath, symbol, calls, timestamp, isNew, diff } = data;

      // Get or create file group
      if (!fileGroups.has(filePath)) {
        // Create file container box
        const fileContainer = document.createElement('div');
        fileContainer.className = 'file-container';
        fileContainer.style.left = nextX + 'px';
        fileContainer.style.top = '50px'; // Initial position, will be updated by repositionAllFiles
        canvas.appendChild(fileContainer);
        
        // Create file path label inside the container
        const fileLabel = document.createElement('div');
        fileLabel.className = 'file-path-label';
        
        // Split path into directory and filename
        const { directory, filename } = splitPathIntoDirectoryAndFile(filePath);
        
        // Create directory path element (if there is a directory)
        if (directory) {
          const directoryElement = document.createElement('div');
          directoryElement.className = 'file-directory-path';
          directoryElement.textContent = directory;
          
          // Add tooltip on hover for truncated paths
          let pathTooltipTimeout = null;
          let pathTooltip = null;
          
          directoryElement.addEventListener('mouseenter', (e) => {
            // Only show tooltip if text is truncated
            if (directoryElement.scrollWidth > directoryElement.clientWidth) {
              pathTooltipTimeout = setTimeout(() => {
                pathTooltip = document.createElement('div');
                pathTooltip.className = 'file-path-tooltip';
                pathTooltip.textContent = directory;
                document.body.appendChild(pathTooltip);
                
                // Position near the element
                const rect = directoryElement.getBoundingClientRect();
                pathTooltip.style.left = rect.left + 'px';
                pathTooltip.style.top = (rect.bottom + 4) + 'px';
              }, 1000);
            }
          });
          
          directoryElement.addEventListener('mouseleave', () => {
            if (pathTooltipTimeout) {
              clearTimeout(pathTooltipTimeout);
              pathTooltipTimeout = null;
            }
            if (pathTooltip) {
              pathTooltip.remove();
              pathTooltip = null;
            }
          });
          
          fileLabel.appendChild(directoryElement);
        }
        
        // Create filename element
        const filenameElement = document.createElement('div');
        filenameElement.className = 'file-name';
        filenameElement.textContent = filename + (isNew ? ' (new)' : '');
        fileLabel.appendChild(filenameElement);
        
        fileContainer.appendChild(fileLabel);
        
        // Create stats display in top right corner if we have additions/deletions
        const additions = data.additions || 0;
        const deletions = data.deletions || 0;
        
        if (additions > 0 || deletions > 0) {
          // Create stats container
          const statsContainer = document.createElement('div');
          statsContainer.className = 'file-stats';
          
          if (additions > 0) {
            const addSpan = document.createElement('span');
            addSpan.className = 'stat-additions';
            addSpan.textContent = '+' + additions;
            statsContainer.appendChild(addSpan);
          }
          
          if (deletions > 0) {
            const delSpan = document.createElement('span');
            delSpan.className = 'stat-deletions';
            delSpan.textContent = '-' + deletions;
            statsContainer.appendChild(delSpan);
          }
          
          fileContainer.appendChild(statsContainer);
        }
        
        const newGroup = { 
          symbols: new Map(), 
          symbolPositions: new Map(), // Track symbol positions for connections
          x: nextX,
          y: 50, // Initial y position, will be updated by repositionAllFiles
          width: 400, // Initial width, will grow
          elements: [], 
          fileLabel: fileLabel,
          fileContainer: fileContainer
        };
        fileGroups.set(filePath, newGroup);
        fileOrder.push(filePath); // Track creation order
      }

      const group = fileGroups.get(filePath);
      
      // Accumulate stats for this file (independent counters)
      const additions = data.additions || 0;
      const deletions = data.deletions || 0;
      
      // Initialize stats if not present
      if (!group.stats) {
        group.stats = { additions: 0, deletions: 0 };
      }
      
      // Accumulate additions and deletions independently
      // Each change adds to the counters, they never subtract from each other
      if (additions > 0) {
        group.stats.additions += additions;
      }
      if (deletions > 0) {
        group.stats.deletions += deletions;
      }
      
      // Update or create the stats display in top right corner
      if (group.stats.additions > 0 || group.stats.deletions > 0) {
        // Check if stats container already exists
        let statsContainer = group.fileContainer.querySelector('.file-stats');
        
        if (!statsContainer) {
          // Create new stats container
          statsContainer = document.createElement('div');
          statsContainer.className = 'file-stats';
          group.fileContainer.appendChild(statsContainer);
        } else {
          // Clear existing stats
          statsContainer.innerHTML = '';
        }
        
        // Add updated stats
        if (group.stats.additions > 0) {
          const addSpan = document.createElement('span');
          addSpan.className = 'stat-additions';
          addSpan.textContent = '+' + group.stats.additions;
          statsContainer.appendChild(addSpan);
        }
        
        if (group.stats.deletions > 0) {
          const delSpan = document.createElement('span');
          delSpan.className = 'stat-deletions';
          delSpan.textContent = '-' + group.stats.deletions;
          statsContainer.appendChild(delSpan);
        }
      }
      
      // Create a unique key based on symbol type and name
      // This ensures only one box per symbol regardless of line number changes
      const symbolKey = symbol.type + ':' + symbol.name;
      
      // Remove old box for this specific symbol if it exists
      // This handles updates to the same symbol (e.g., adding lines to a function)
      if (group.symbols.has(symbolKey)) {
        const oldElements = group.symbols.get(symbolKey);
        oldElements.forEach(el => el.remove());
        group.symbols.delete(symbolKey);
      }
      
      // Also check for and remove any symbols with the same name but different type
      // (e.g., if a function was converted to a method)
      const keysToRemove = [];
      for (const [key, elements] of group.symbols.entries()) {
        const [keyType, keyName] = key.split(':');
        if (keyName === symbol.name && key !== symbolKey) {
          keysToRemove.push(key);
          elements.forEach(el => el.remove());
        }
      }
      keysToRemove.forEach(key => group.symbols.delete(key));
      
      // Create the symbol box
      const newElements = [];
      const box = document.createElement('div');
      box.className = 'symbol-box ' + symbol.type;
      
      // Store changeAmount and changeType in dataset for later use
      const changeAmount = symbol.changeAmount || 1;
      box.dataset.changeAmount = String(changeAmount);
      box.dataset.changeType = symbol.changeType; // Store change type for permanent color
      
      // Size will be calculated and applied during repositioning
      // Don't set size here - let the packing algorithm handle it
      
      // Add () suffix for functions and methods
      const displayName = (symbol.type === 'function' || symbol.type === 'method') 
        ? symbol.name + '()' 
        : symbol.name;
      
      // Add type label at the top with change type
      const typeLabel = document.createElement('div');
      typeLabel.className = 'symbol-type-label';
      
      // Format change type for display (change type comes first)
      let changeTypeText = '';
      if (symbol.changeType === 'added') changeTypeText = 'New';
      else if (symbol.changeType === 'modified') changeTypeText = 'Changed';
      else if (symbol.changeType === 'deleted') changeTypeText = 'Deleted';
      else if (symbol.changeType === 'value_changed') changeTypeText = 'Changed';
      
      typeLabel.textContent = changeTypeText + ' ' + symbol.type;
      box.appendChild(typeLabel);
      
      // Add size label above the box (for debugging)
      const sizeLabel = document.createElement('div');
      sizeLabel.className = 'symbol-size-label';
      // Size will be set during repositioning when actual dimensions are known
      sizeLabel.textContent = ''; // Will be updated later
      box.appendChild(sizeLabel);
      
      // Symbol content: just the name (no change symbol)
      const contentWrapper = document.createElement('div');
      contentWrapper.className = 'symbol-content';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'symbol-name';
      nameSpan.textContent = displayName;

      contentWrapper.appendChild(nameSpan);
      box.appendChild(contentWrapper);
      
      // Append to file container (not canvas)
      group.fileContainer.appendChild(box);
      
      group.elements.push(box);
      newElements.push(box);
        
        // Remove glow from previous box
        if (lastGlowingBox) {
          lastGlowingBox.classList.remove('added', 'modified', 'deleted', 'value_changed');
        }
        
        // Add glow to this new/updated box
        box.classList.add(symbol.changeType);
        lastGlowingBox = box;
        
        // Remove glow after 3 seconds
        setTimeout(() => {
          box.classList.remove('added', 'modified', 'deleted', 'value_changed');
        }, 3000);
        
        // Add glowing light blue border for change detection
        box.classList.add('change-detected');
        
        // Remove the glowing border after 4 seconds
        setTimeout(() => {
          box.classList.remove('change-detected');
        }, 4000);
        
        // Make the symbol box glow three times with one second in between
        let glowCount = 0;
        const glowInterval = setInterval(() => {
          box.classList.add('highlight');
          setTimeout(() => {
            box.classList.remove('highlight');
          }, 500); // Glow duration: 500ms
          
          glowCount++;
          if (glowCount >= 3) {
            clearInterval(glowInterval);
          }
        }, 1000); // 1 second between each glow
        
        // Auto-focus on the new symbol after a brief delay to allow repositioning
        setTimeout(() => {
          focusOnElement(box);
        }, 100);
        
        // Add click handler to open file at symbol line
        box.addEventListener('click', (e) => {
          e.stopPropagation(); // Prevent pan/zoom from interfering
          vscode.postMessage({
            type: 'openFile',
            filePath: filePath,
            line: symbol.startLine
          });
        });

        // Add right-click handler for context menu
        box.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          
          const contextMenu = document.getElementById('context-menu');
          
          // Store current symbol data on the context menu for later use
          contextMenu.dataset.symbolName = symbol.name;
          contextMenu.dataset.symbolType = symbol.type;
          contextMenu.dataset.symbolChangeType = symbol.changeType;
          contextMenu.dataset.symbolStartLine = symbol.startLine;
          contextMenu.dataset.symbolEndLine = symbol.endLine;
          contextMenu.dataset.symbolChangeAmount = symbol.changeAmount || '1';
          contextMenu.dataset.filePath = filePath;
          contextMenu.dataset.diff = diff || '';
          
          // Position context menu at cursor
          contextMenu.style.left = e.clientX + 'px';
          contextMenu.style.top = e.clientY + 'px';
          contextMenu.classList.add('visible');
        });
        
        // Add hover tooltip for diff
        let hoverTimeout = null;
        let tooltip = null;
        let isHoveringTooltip = false;
        
        let lastMouseX = 0;
        let lastMouseY = 0;
        
        box.addEventListener('mousemove', (e) => {
          lastMouseX = e.clientX;
          lastMouseY = e.clientY;
        });
        
        box.addEventListener('mouseenter', (e) => {
          lastMouseX = e.clientX;
          lastMouseY = e.clientY;
          
          // Wait 1 second before showing tooltip
          hoverTimeout = setTimeout(() => {
            if (diff) {
              tooltip = createDiffTooltip(symbol, diff, box);
              document.body.appendChild(tooltip);
              
              // Position tooltip near the cursor using fixed positioning
              // This ensures the tooltip stays at a consistent size regardless of zoom
              tooltip.style.left = (lastMouseX + 15) + 'px';
              tooltip.style.top = (lastMouseY + 15) + 'px';
              
              // Ensure tooltip doesn't go off-screen
              const tooltipRect = tooltip.getBoundingClientRect();
              if (tooltipRect.right > window.innerWidth) {
                tooltip.style.left = (window.innerWidth - tooltipRect.width - 10) + 'px';
              }
              if (tooltipRect.bottom > window.innerHeight) {
                tooltip.style.top = (window.innerHeight - tooltipRect.height - 10) + 'px';
              }
              
              // Show tooltip
              setTimeout(() => tooltip.classList.add('visible'), 10);
              
              // Keep tooltip open when hovering over it
              tooltip.addEventListener('mouseenter', () => {
                isHoveringTooltip = true;
              });
              
              tooltip.addEventListener('mouseleave', () => {
                isHoveringTooltip = false;
                // Hide and remove tooltip when leaving it
                tooltip.classList.remove('visible');
                setTimeout(() => {
                  if (tooltip && tooltip.parentNode) {
                    tooltip.remove();
                  }
                  tooltip = null;
                }, 200);
              });
            }
          }, 1000);
        });
        
        box.addEventListener('mouseleave', () => {
          // Cancel tooltip if not shown yet
          if (hoverTimeout) {
            clearTimeout(hoverTimeout);
            hoverTimeout = null;
          }
          
          // Only hide tooltip if not hovering over it
          setTimeout(() => {
            if (tooltip && !isHoveringTooltip) {
              tooltip.classList.remove('visible');
              setTimeout(() => {
                if (tooltip && tooltip.parentNode) {
                  tooltip.remove();
                }
                tooltip = null;
              }, 200);
            }
          }, 100);
        });

      function createDiffTooltip(symbolData, diffText, symbolBox) {
        const tooltip = document.createElement('div');
        tooltip.className = 'diff-tooltip';
        
        // Create header
        const header = document.createElement('div');
        header.className = 'diff-tooltip-header';
        header.textContent = symbolData.name + ' - Changes';
        tooltip.appendChild(header);
        
        // Parse and format diff
        const diffContent = document.createElement('div');
        const lines = diffText.split('\n');
        
        // Track line numbers and find relevant sections
        let currentLine = 0;
        let firstRelevantChangeElement = null;
        let firstChangeInSymbolRange = null;
        const symbolStart = symbolData.startLine || 0;
        const symbolEnd = symbolData.endLine || Number.MAX_SAFE_INTEGER;
        
        for (const line of lines) {
          const diffLine = document.createElement('div');
          diffLine.className = 'diff-line';
          
          // Track line numbers from hunk headers
          if (line.startsWith('@@')) {
            const match = line.match(/@@ -\\d+(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/);
            if (match) {
              currentLine = parseInt(match[1], 10);
            }
            diffLine.classList.add('context');
            diffLine.style.fontWeight = 'bold';
            diffLine.style.color = 'var(--vscode-textPreformat-foreground)';
          } else if (line.startsWith('+') && !line.startsWith('+++')) {
            diffLine.classList.add('addition');
            
            // Check if this change is within the symbol's range
            if (currentLine >= symbolStart && currentLine <= symbolEnd) {
              if (!firstChangeInSymbolRange) {
                firstChangeInSymbolRange = diffLine;
              }
            }
            if (!firstRelevantChangeElement) {
              firstRelevantChangeElement = diffLine;
            }
            currentLine++;
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            diffLine.classList.add('deletion');
            
            // Deletions don't increment line number but are relevant
            if (currentLine >= symbolStart - 1 && currentLine <= symbolEnd) {
              if (!firstChangeInSymbolRange) {
                firstChangeInSymbolRange = diffLine;
              }
            }
            if (!firstRelevantChangeElement) {
              firstRelevantChangeElement = diffLine;
            }
          } else if (line.startsWith('---') || line.startsWith('+++')) {
            diffLine.classList.add('context');
            diffLine.style.opacity = '0.5';
          } else if (!line.startsWith('\\')) {
            diffLine.classList.add('context');
            currentLine++;
          }
          
          diffLine.textContent = line;
          diffContent.appendChild(diffLine);
        }
        
        tooltip.appendChild(diffContent);
        
        // Scroll to the most relevant change after tooltip is rendered
        const targetElement = firstChangeInSymbolRange || firstRelevantChangeElement;
        if (targetElement) {
          setTimeout(() => {
            // Calculate scroll position to show the change near the top (1/3 down)
            const scrollTop = targetElement.offsetTop - (diffContent.clientHeight / 3);
            diffContent.scrollTop = Math.max(0, scrollTop);
          }, 50);
        }
        
        // Prevent tooltip from closing when hovering over it
        tooltip.addEventListener('mouseenter', (e) => {
          e.stopPropagation();
        });
        
        // Allow scrolling inside tooltip
        tooltip.addEventListener('wheel', (e) => {
          e.stopPropagation();
        }, { passive: true });
        
        return tooltip;
      }
      
      // Store the elements for this symbol
      group.symbols.set(symbolKey, newElements);
      
      // Immediately reposition this file's symbols to prevent overlapping
      // Use requestAnimationFrame to ensure DOM has updated with the new box
      requestAnimationFrame(() => {
        repositionFileSymbols(group);
        
        // After repositioning symbols, also reposition all file containers
        // This ensures the global layout is updated immediately
        requestAnimationFrame(() => {
          repositionAllFiles();
        });
      });

      // Draw call relationships using stored symbol positions
      for (const call of calls) {
        const fromSymbol = group.symbolPositions.get(call.from);
        const toSymbol = group.symbolPositions.get(call.to);
        
        if (fromSymbol && toSymbol) {
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          line.setAttribute('class', 'call-line animated');
          
          // Create curved path
          const x1 = fromSymbol.x;
          const y1 = fromSymbol.y;
          const x2 = toSymbol.x;
          const y2 = toSymbol.y;
          
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2 - 50;
          
          const path = 'M ' + x1 + ' ' + y1 + ' Q ' + midX + ' ' + midY + ' ' + x2 + ' ' + y2;
          line.setAttribute('d', path);
          
          svg.appendChild(line);
          group.elements.push(line);
        }
      }
    }

        // Pan handlers - MUST be at top level, not inside handleSingleSymbolChange
        console.log('[Symbol Changes] Registering pan handlers...');
        container.addEventListener('mousedown', (e) => {
          console.log('[Symbol Changes] Mousedown event');
          if (e.target.closest('.zoom-button') || e.target.closest('#clear-button') || e.target.closest('#auto-focus-toggle')) {
            console.log('[Symbol Changes] Mousedown on button, ignoring');
            return;
          }
          isPanning = true;
          startX = e.clientX - translateX;
          startY = e.clientY - translateY;
          container.classList.add('panning');
          canvas.classList.add('no-transition');
          console.log('[Symbol Changes] Panning started');
        });

        container.addEventListener('mousemove', (e) => {
          if (!isPanning) return;
          translateX = e.clientX - startX;
          translateY = e.clientY - startY;
          updateTransform();
        });

        container.addEventListener('mouseup', () => {
          if (isPanning) {
            console.log('[Symbol Changes] Panning stopped (mouseup)');
            isPanning = false;
            container.classList.remove('panning');
            canvas.classList.remove('no-transition');
          }
        });

        container.addEventListener('mouseleave', () => {
          if (isPanning) {
            console.log('[Symbol Changes] Panning stopped (mouseleave)');
            isPanning = false;
            container.classList.remove('panning');
            canvas.classList.remove('no-transition');
          }
        });

        // Zoom with mouse wheel
        container.addEventListener('wheel', (e) => {
          e.preventDefault();
          console.log('[Symbol Changes] Wheel event triggered, deltaY:', e.deltaY);
          
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
        }, { passive: false });

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

        // Clear button
        document.getElementById('clear-button').addEventListener('click', () => {
          // Remove all file containers
          fileGroups.forEach(group => {
            // Remove entire file container (includes label and all symbols)
            if (group.fileContainer) {
              group.fileContainer.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
              group.fileContainer.style.opacity = '0';
              group.fileContainer.style.transform = 'scale(0.95)';
              setTimeout(() => group.fileContainer.remove(), 300);
            }
            
            // Remove any other elements in the group (connections, etc.)
            group.elements.forEach(el => {
              if (el && el.parentNode && el.parentNode !== group.fileContainer) {
                el.style.transition = 'opacity 0.3s ease';
                el.style.opacity = '0';
                setTimeout(() => el.remove(), 300);
              }
            });
          });

          // Remove all connection lines from SVG
          const allLines = Array.from(svg.querySelectorAll('path'));
          allLines.forEach(line => {
            line.style.transition = 'opacity 0.3s ease';
            line.style.opacity = '0';
            setTimeout(() => line.remove(), 300);
          });

          // Clear file groups
          fileGroups.clear();
          fileOrder.length = 0; // Clear file order array

          // Reset next position
          nextX = 80;

          // Notify extension to clear session tracking
          vscode.postMessage({ type: 'clearAll' });

          console.log('[Symbol Changes] Cleared all symbols');
        });

        // Auto-focus toggle
        console.log('[Symbol Changes] Setting up auto-focus toggle...');
        const autoFocusToggle = document.getElementById('auto-focus-toggle');
        console.log('[Symbol Changes] Auto-focus toggle element:', autoFocusToggle);
        if (autoFocusToggle) {
          const toggleCheckbox = autoFocusToggle.querySelector('.toggle-checkbox');
          console.log('[Symbol Changes] Toggle checkbox element:', toggleCheckbox);
          
          // Initialize toggle state (enabled by default)
          autoFocusToggle.classList.add('active');
          if (toggleCheckbox) {
            toggleCheckbox.textContent = '✓';
          }
          console.log('[Symbol Changes] Auto-focus toggle initialized as active');
          
          autoFocusToggle.addEventListener('click', () => {
            console.log('[Symbol Changes] Auto-focus toggle clicked!');
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
            
            console.log('[Symbol Changes] Auto-focus', autoFocusEnabled ? 'enabled' : 'disabled');
          });
          console.log('[Symbol Changes] Auto-focus toggle click listener attached');
        } else {
          console.error('[Symbol Changes] Auto-focus toggle element not found!');
        }

        // Listen for messages
        window.addEventListener('message', event => {
          const message = event.data;
          console.log('[Symbol Changes] Message received:', message.type);
          
          switch (message.type) {
            case 'symbol:changed':
              console.log('[Symbol Changes] Processing symbol:changed message', message.data);
              
              // Handle the symbol change first to ensure file container exists
              handleSingleSymbolChange(message.data);
              
              // Display comments AFTER repositioning is complete (wait for layout to settle)
              if (message.data.comments && message.data.comments.length > 0) {
                // Wait for repositioning to complete (50ms debounce + 10ms buffer)
                setTimeout(() => {
                  // Remove leading slashes and join with newline character
                  const cleanedComments = message.data.comments.map(comment => {
                    // Remove leading // or / or /* or * characters
                    return comment.replace(/^[\s]*[\/\*]+[\s]*/, '');
                  });
                  const commentText = cleanedComments.join('\n');
                  
                  const overlay = document.createElement('div');
                  overlay.className = 'comment-overlay';
                  overlay.textContent = commentText;
                  
                  // Calculate duration based on text length (4-8 seconds)
                  // Roughly 150 chars = 4 seconds, 600+ chars = 8 seconds
                  const charCount = commentText.length;
                  const duration = Math.min(8000, Math.max(4000, 4000 + (charCount / 150) * 1000));
                  
                  // Track hover state
                  let isHovering = false;
                  let hideTimeout = null;
                  
                  // Hover handlers to keep popup open
                  overlay.addEventListener('mouseenter', () => {
                    isHovering = true;
                    if (hideTimeout) {
                      clearTimeout(hideTimeout);
                      hideTimeout = null;
                    }
                    overlay.classList.remove('fading');
                  });
                  
                  overlay.addEventListener('mouseleave', () => {
                    isHovering = false;
                    // Start fade out when mouse leaves
                    overlay.classList.add('fading');
                    setTimeout(() => {
                      overlay.remove();
                    }, 500); // Match fadeOut animation duration
                  });
                  
                  // Position below the file container (gray box containing all symbols)
                  const filePath = message.data.filePath;
                  const group = fileGroups.get(filePath);
                  
                  if (group && group.fileContainer) {
                    // Append to canvas so it moves with pan/zoom
                    canvas.appendChild(overlay);
                    
                    // Position below the file container using updated layout
                    const containerHeight = parseInt(group.fileContainer.style.height || '100');
                    const left = group.x;
                    const top = group.y + containerHeight;
                    
                    overlay.style.left = left + 'px';
                    overlay.style.top = (top + 20) + 'px'; // 20px gap below file container
                  } else {
                    // Fallback: append to body if file container not found
                    console.warn('[Symbol Changes] File container not found for comments, filePath:', filePath);
                    document.body.appendChild(overlay);
                  }
                  
                  // Auto-hide after calculated duration (if not hovering)
                  hideTimeout = setTimeout(() => {
                    if (!isHovering) {
                      overlay.classList.add('fading');
                      setTimeout(() => {
                        overlay.remove();
                      }, 500); // Match fadeOut animation duration
                    }
                  }, duration);
                }, 60); // Wait for repositioning (50ms) + small buffer
              }
              break;
            case 'file:remove-fallback':
              console.log('[Symbol Changes] Removing FILE fallback box for', message.data.filePath);
              const fallbackGroup = fileGroups.get(message.data.filePath);
              if (fallbackGroup && fallbackGroup.symbols) {
                // Remove FILE type symbols from this file's group
                // The key format is 'type:name', so for file it's 'file:filename'
                const fileName = getFileName(message.data.filePath);
                const fileSymbolKey = 'file:' + fileName;
                if (fallbackGroup.symbols.has(fileSymbolKey)) {
                  const elements = fallbackGroup.symbols.get(fileSymbolKey);
                  if (elements) {
                    elements.forEach(el => el.remove());
                  }
                  fallbackGroup.symbols.delete(fileSymbolKey);
                  console.log('[Symbol Changes] Removed FILE fallback box:', fileSymbolKey);
                  
                  // Reposition remaining symbols in the file container
                  repositionFileSymbols(fallbackGroup);
                  repositionAllFiles();
                }
              }
              break;
            case 'file:reverted':
            case 'file:deleted':
              console.log('[Symbol Changes] Processing file deletion/revert', message.data.filePath);
              const group = fileGroups.get(message.data.filePath);
              if (group) {
                // Remove entire file container
                if (group.fileContainer) {
                  group.fileContainer.style.transition = 'opacity 0.3s ease';
                  group.fileContainer.style.opacity = '0';
                  setTimeout(() => group.fileContainer.remove(), 300);
                }
                
                fileGroups.delete(message.data.filePath);
                
                // Remove from file order
                const orderIndex = fileOrder.indexOf(message.data.filePath);
                if (orderIndex > -1) {
                  fileOrder.splice(orderIndex, 1);
                }
              }
              break;
          }
        });

        console.log('[Symbol Changes] View initialized successfully');
        console.log('[Symbol Changes] Message listener registered');
        console.log('[Symbol Changes] Pan/zoom handlers registered');
      } catch (error) {
        console.error('[Symbol Changes] Initialization error:', error);
        console.error('[Symbol Changes] Error message:', error.message);
        console.error('[Symbol Changes] Stack trace:', error.stack);
        
        // Send error to extension host for logging (vscode API already acquired at the top)
        vscode.postMessage({
          type: 'webviewError',
          error: {
            message: error.message,
            stack: error.stack,
            toString: error.toString()
          }
        });
      }
    })();
  </script>
</body>
</html>`;
  }

  private dispose() {
    SymbolChangesPanel.currentPanel = undefined;

    for (const timeout of this.pendingChanges.values()) {
      clearTimeout(timeout);
    }
    this.pendingChanges.clear();

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

