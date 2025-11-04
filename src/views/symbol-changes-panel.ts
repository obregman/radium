import * as vscode from 'vscode';
import * as chokidar from 'chokidar';
import * as cp from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as Diff from 'diff';
import { RadiumIgnore } from '../config/radium-ignore';
import { CodeParser } from '../indexer/parser';

const exec = promisify(cp.exec);

interface SymbolChange {
  type: 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable' | 'constant' | 'constructor' | 'file';
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
  private lastKnownFileStates = new Map<string, string>(); // filePath -> content snapshot
  private baselineFileStates = new Map<string, string>(); // filePath -> original baseline content
  private radiumIgnore: RadiumIgnore;
  private parser: CodeParser;
  private readonly DEBOUNCE_DELAY = 300;
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
            this.lastKnownFileStates.clear();
            this.baselineFileStates.clear();
            this.log('Cleared session tracking and file states');
            // Re-snapshot all files after clearing
            await this.snapshotAllSourceFiles();
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
        stabilityThreshold: 200,
        pollInterval: 100
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
      this.filesCreatedThisSession.delete(relativePath);
      
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
      this.pendingChanges.delete(absolutePath);
      await this.processFileChange(absolutePath);
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
      this.log(`No changes detected for ${relativePath}`);
      this.panel.webview.postMessage({
        type: 'file:reverted',
        data: {
          filePath: relativePath,
          timestamp: Date.now()
        }
      });
      return;
    }

    const isNew = this.filesCreatedThisSession.has(relativePath);
    this.log(`File ${relativePath} isNew: ${isNew}`);
    
    // Analyze the diff to extract symbol changes
    const symbolChanges = await this.analyzeDiffForSymbols(relativePath, diff, isNew);
    this.log(`Found ${symbolChanges.symbols.length} symbols in ${relativePath}`);

    // If no symbols detected, send a fallback "file changed" box
    if (symbolChanges.symbols.length === 0) {
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
          diff: diff
        }
      });
    } else {
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
            diff: diff
          }
        });
      }
    }
    
    // Store the current file state as the new baseline for future comparisons
    try {
      if (fs.existsSync(fullPath)) {
        const currentContent = fs.readFileSync(fullPath, 'utf8');
        this.lastKnownFileStates.set(relativePath, currentContent);
        this.log(`Stored file state for ${relativePath}`);
      }
    } catch (error) {
      this.log(`Failed to store file state for ${relativePath}: ${error}`);
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

    try {
      if (fs.existsSync(fullPath)) {
        currentContent = fs.readFileSync(fullPath, 'utf8');
        this.log(`Parsing file ${filePath}, content length: ${currentContent.length}`);
        
        // Check file extension
        const ext = filePath.split('.').pop();
        this.log(`File extension: ${ext}`);
        
        this.log(`Calling parser.parseFile for ${fullPath}`);
        const parseResult = await this.parser.parseFile(fullPath, currentContent);
        this.log(`Parser returned: ${parseResult ? 'result object' : 'null'}`);
        
        if (parseResult) {
          this.log(`Parse result: ${parseResult.symbols.length} symbols, ${parseResult.calls.length} calls`);
          if (parseResult.symbols.length > 0) {
            this.log(`First few symbols: ${parseResult.symbols.slice(0, 3).map(s => `${s.kind}:${s.name}`).join(', ')}`);
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
        deletedLineNumbers.add(currentLineNumber);
        changedLineNumbers.add(currentLineNumber);
        deletedLines.set(currentLineNumber, line.substring(1));
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

    // Extract variables from diff (only for things tree-sitter doesn't catch well)
    const variables = this.extractVariablesFromDiff(currentContent, addedLines, deletedLines, changedLineNumbers);
    
    // Filter out variables that are already detected by tree-sitter as symbols
    const treeSymbolNames = new Set(currentSymbols.map(s => s.name));
    const filteredVariables = variables.filter(v => !treeSymbolNames.has(v.name));
    
    this.log(`Extracted ${variables.length} variables from diff, ${filteredVariables.length} after filtering duplicates with tree-sitter`);
    symbols.push(...filteredVariables);

    // Track symbols we've already added to avoid duplicates
    const addedSymbolKeys = new Set<string>();
    for (const v of filteredVariables) {
      addedSymbolKeys.add(`${v.type}:${v.name}:${v.startLine}`);
    }

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
      }
    }
    
    this.log(`Line to symbol mapping: ${Array.from(lineToMostSpecificSymbol.entries()).map(([line, sym]) => `${line} -> ${sym.name} (${sym.kind})`).join(', ')}`);
    
    // Now process only symbols that are the most specific for at least one changed line
    const symbolsToProcess = new Set(lineToMostSpecificSymbol.values());
    
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

    return {
      filePath,
      symbols,
      calls,
      timestamp: Date.now(),
      isNew: isNewFile,
      diff: diff
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

      // Check for variable declarations
      const varMatch = trimmed.match(/\b(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[:=]\s*(.+?)(?:;|$)/);
      if (varMatch) {
        const varType = varMatch[1];
        const varName = varMatch[2];
        const varValue = varMatch[3].trim();
        
        // Skip if this is a function declaration (arrow function or function expression)
        if (varValue.startsWith('function') || 
            varValue.includes('=>') || 
            varValue.startsWith('async ') ||
            varValue.match(/^\([^)]*\)\s*=>/)) {
          continue;
        }
        
        // Only add if it's truly new (not in deleted lines)
        if (!seenVariables.has(varName) && !existingVariables.has(varName)) {
          seenVariables.add(varName);
          const varKind = varType === 'const' ? 'constant' : 'variable';
          
          // Try to determine context (inside class, interface, etc.)
          const context = this.detectVariableContext(content, lineNum);
          let description = '';
          
          if (context) {
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
    }

    // Check for value changes (variable exists in both added and deleted)
    const deletedVars = new Map<string, string>();
    for (const [lineNum, lineContent] of deletedLines) {
      const trimmed = lineContent.trim();
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
      const varMatch = trimmed.match(/\b(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[:=]\s*(.+?)(?:;|$)/);
      
      if (varMatch) {
        const varName = varMatch[2];
        const newValue = varMatch[3].trim();
        const oldValue = deletedVars.get(varName);
        
        if (oldValue && oldValue !== newValue && !seenVariables.has(varName)) {
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

  private detectVariableContext(content: string, lineNumber: number): { type: string; name: string } | null {
    const lines = content.split('\n');
    
    // Look backwards from the line to find containing structure
    let braceDepth = 0;
    
    for (let i = lineNumber - 1; i >= 0; i--) {
      const line = lines[i];
      
      // Count braces to track nesting (going backward, so reversed)
      for (const char of line) {
        if (char === '{') braceDepth++;
        if (char === '}') braceDepth--;
      }
      
      // Only check at the same nesting level (braceDepth === 0)
      if (braceDepth === 0) {
        // Check for function first (more specific) - if found, variable is in function
        const functionMatch = line.match(/\b(function|async\s+function)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
        if (functionMatch) {
          return null; // Variable is inside a function
        }
        
        // Arrow functions or method definitions
        const methodMatch = line.match(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*[:{]/);
        if (methodMatch) {
          return null; // Variable is inside a method/function
        }
        
        // Check for class/interface
        const classMatch = line.match(/\b(class|interface)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
        if (classMatch) {
          return { type: classMatch[1], name: classMatch[2] };
        }
      }
      
      // Stop if we've exited the containing scope
      if (braceDepth > 0) break;
    }
    
    return null;
  }

  private byteOffsetToLineNumber(filePath: string, byteOffset: number): number {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.substring(0, byteOffset).split('\n');
      return lines.length;
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
      
      // If we have a stored state for this file, diff against that instead of git
      if (this.lastKnownFileStates.has(filePath)) {
        this.log(`Using stored state for ${filePath}`);
        const lastKnownContent = this.lastKnownFileStates.get(filePath)!;
        
        if (fs.existsSync(fullPath)) {
          const currentContent = fs.readFileSync(fullPath, 'utf8');
          
          // Check if content actually changed
          if (lastKnownContent === currentContent) {
            this.log(`No changes detected - content identical to stored state`);
            return '';
          }
          
          // Generate diff between last known state and current state
          const diff = this.generateDiff(filePath, lastKnownContent, currentContent);
          this.log(`Generated diff from stored state, length: ${diff.length}`);
          
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
            const fullPath = path.join(this.workspaceRoot, filePath);
            if (fs.existsSync(fullPath)) {
              const content = fs.readFileSync(fullPath, 'utf8');
              const lines = content.split('\n');
              // Generate proper git-style diff format with hunk header
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

  private getHtmlContent(): string {
    return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
      padding: 20px 8px 6px 8px;
      background-color: transparent;
      border: 1.5px solid var(--vscode-panel-border);
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

    .symbol-type-label {
      position: absolute;
      top: 4px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 8px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      opacity: 0.8;
      letter-spacing: 0.8px;
      white-space: nowrap;
      z-index: 1;
      pointer-events: none;
    }

    .symbol-size-label {
      position: absolute;
      top: -18px;
      left: 2px;
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

    .symbol-box.function {
      border-color: #4EC9B0;
      background: rgba(78, 201, 176, 0.03);
    }

    .symbol-box.class {
      border-color: #4FC1FF;
      background: rgba(79, 193, 255, 0.03);
    }

    .symbol-box.method {
      border-color: #C586C0;
      background: rgba(197, 134, 192, 0.03);
    }

    .symbol-box.interface {
      border-color: #9CDCFE;
      background: rgba(156, 220, 254, 0.02);
      border-style: dashed;
    }

    .symbol-box.type {
      border-color: #9CDCFE;
      background: rgba(156, 220, 254, 0.02);
      border-style: dashed;
    }

    .symbol-box.variable {
      border-color: #DCDCAA;
      background: rgba(220, 220, 170, 0.03);
    }

    .symbol-box.constant {
      border-color: #D7BA7D;
      background: rgba(215, 186, 125, 0.03);
      border-width: 2px;
    }

    .symbol-box.file {
      border-color: #858585;
      background: rgba(133, 133, 133, 0.05);
      border-style: solid;
      min-width: 120px;
    }

    .symbol-box.added {
      animation: pulseGreen 3s ease-in-out infinite;
    }

    .symbol-box.modified {
      animation: pulseYellow 3s ease-in-out infinite;
    }

    .symbol-box.deleted {
      opacity: 0.4;
      border-color: #F48771;
      animation: pulseRed 3s ease-in-out infinite;
    }

    .symbol-box.value_changed {
      animation: pulseOrange 3s ease-in-out infinite;
    }

    @keyframes pulseGreen {
      0%, 100% { border-color: #4EC9B0; opacity: 1; }
      50% { border-color: #6EDDC0; opacity: 0.85; }
    }

    @keyframes pulseYellow {
      0%, 100% { border-color: #DCDCAA; opacity: 1; }
      50% { border-color: #ECECC0; opacity: 0.85; }
    }

    @keyframes pulseRed {
      0%, 100% { border-color: #F48771; opacity: 0.4; }
      50% { border-color: #FF9B85; opacity: 0.3; }
    }

    @keyframes pulseOrange {
      0%, 100% { border-color: #D7BA7D; opacity: 1; }
      50% { border-color: #E7CA8D; opacity: 0.85; }
    }

    .symbol-box:hover {
      transform: scale(1.03);
      z-index: 20;
      border-width: 2px;
    }

    .diff-tooltip {
      position: absolute;
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
      font-size: 11px;
      white-space: pre-wrap;
      word-wrap: break-word;
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: none;
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

    .file-container {
      position: absolute;
      border: 2px solid var(--vscode-panel-border);
      border-radius: 0;
      background-color: rgba(0, 0, 0, 0.1);
      padding: 40px 0 0 0;
      box-sizing: border-box; /* Width/height includes border and padding */
      /* Make this the positioning context for child symbol boxes */
      /* Child elements with position:absolute will be relative to this container */
    }

    .file-path-label {
      position: absolute;
      top: 10px;
      left: 0;
      right: 0;
      font-size: 13px;
      font-weight: 600;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      text-align: center;
      line-height: 1.3;
      word-break: break-word;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      padding: 0 8px;
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
      font-weight: 400;
      white-space: nowrap;
      text-align: center;
    }

    .change-symbol {
      font-size: 12px;
      font-weight: 600;
      opacity: 0.7;
      flex-shrink: 0;
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
  
  <button id="clear-button" title="Clear all symbols">
    🗑️ Clear All
  </button>
  
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

  <script>
    (function() {
      try {
        console.log('[Symbol Changes] Initializing view...');
        
        const vscode = acquireVsCodeApi();
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
        const FILE_LABEL_HEIGHT = 45;
        const START_Y = 50 + FILE_LABEL_HEIGHT; // Where symbols start
        const FILE_SPACING = 80; // Spacing between file columns (reduced for row layout)
        const SYMBOL_WIDTH = 150; // Approximate symbol width (for estimates)
        let lastGlowingBox = null; // Track the currently glowing box
        let repositionTimeout = null; // Debounce repositioning

        function updateTransform() {
          canvas.style.transform = 'translate(' + translateX + 'px, ' + translateY + 'px) scale(' + scale + ')';
          zoomLevelEl.textContent = Math.round(scale * 100) + '%';
        }

        // Helper function to calculate symbol weight (importance)
        function getSymbolWeight(type) {
          // Higher weight = more important, shown first
          if (type === 'class') return 5;
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

        // Constants for sizing
        const MIN_WIDTH = 100;         // Minimum box width (100px)
        const MIN_HEIGHT = 30;         // Minimum box height (30px) - 10:3 ratio
        const MAX_WIDTH = 400;         // Maximum box width (400px)
        const MAX_HEIGHT = 120;        // Maximum box height (120px) - maintains 10:3 ratio
        const MIN_CHANGE_AMOUNT = 1;   // Smallest change to visualize

        // Calculate box dimensions based on change amount
        function calculateBoxSize(changeAmount) {
          // Ensure we have a valid change amount
          const amount = Math.max(MIN_CHANGE_AMOUNT, changeAmount || MIN_CHANGE_AMOUNT);
          
          // Special case: minimum change gets minimum size
          if (amount === 1) {
            return { width: MIN_WIDTH, height: MIN_HEIGHT };
          }
          
          // Use logarithmic scaling for better visual distribution
          // Scale from 1 to 100: log(amount)/log(100) gives 0 at amount=1, 1 at amount=100
          const scale = Math.log(amount) / Math.log(100);
          const clampedScale = Math.max(0, Math.min(1, scale));
          
          // Calculate width and height maintaining 10:3 ratio
          const width = MIN_WIDTH + (MAX_WIDTH - MIN_WIDTH) * clampedScale;
          const height = MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * clampedScale;
          
          return { 
            width: Math.round(width), 
            height: Math.round(height) 
          };
        }

        // Bin-packing algorithm for tight symbol layout (NFDH)
        // Returns positions plus packed content width/height
        function packSymbols(symbolsMap, containerWidth) {
          // Convert map to array and extract symbol data with change amounts
          const symbolsArray = [];
          for (const [symbolKey, elements] of symbolsMap.entries()) {
            if (elements && elements.length > 0) {
              const box = elements[0];
              const changeAmount = parseInt(box.dataset.changeAmount || '1', 10);
              const size = calculateBoxSize(changeAmount);
              symbolsArray.push({
                key: symbolKey,
                element: box,
                changeAmount: changeAmount,
                width: size.width,
                height: size.height
              });
            }
          }
          
          // Sort by height descending, then by width descending (largest first for better packing)
          symbolsArray.sort((a, b) => {
            if (b.height !== a.height) return b.height - a.height;
            return b.width - a.width;
          });
          
          const positions = [];
          let currentX = 0;
          let currentY = 0;
          let rowHeight = 0;
          const PADDING = 0; // No padding - symbols touch each other
          
          for (const symbol of symbolsArray) {
            // Check if we need to wrap to next row
            if (currentX + symbol.width > containerWidth && currentX > 0) {
              currentX = 0;
              currentY += rowHeight + PADDING;
              rowHeight = 0;
            }
            
            positions.push({
              key: symbol.key,
              element: symbol.element,
              x: currentX,
              y: currentY,
              width: symbol.width,
              height: symbol.height
            });
            
            currentX += symbol.width + PADDING;
            rowHeight = Math.max(rowHeight, symbol.height);
          }
          // Compute packed content dimensions
          let contentW = 0;
          let contentH = 0;
          // Determine max right edge and total height from shelves
          // Re-run a lightweight pass over positions to compute content width/height
          if (positions.length > 0) {
            let shelves = new Map(); // y -> {h, maxRight}
            for (const p of positions) {
              const right = p.x + p.width;
              contentW = Math.max(contentW, right);
              const shelf = shelves.get(p.y) || { h: 0 };
              shelf.h = Math.max(shelf.h, p.height);
              shelves.set(p.y, shelf);
            }
            // Sum shelf heights in order of y
            const ys = Array.from(shelves.keys()).sort((a,b)=>a-b);
            for (let i = 0; i < ys.length; i++) {
              contentH += shelves.get(ys[i]).h;
              if (i < ys.length - 1) contentH += PADDING;
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
          const parts = filePath.split('/');
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
              const size = calculateBoxSize(changeAmount);
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

        // Helper function to reposition all files based on their actual widths
        function repositionAllFiles() {
          let currentX = 80;
          
          // Use fileOrder array to maintain creation order
          fileOrder.forEach(filePath => {
            const group = fileGroups.get(filePath);
            if (!group) return;
            
            // Update group position
            group.x = currentX;
            
            // Calculate label width estimate
            let labelWidth = 300;
            if (group.fileLabel) {
              // Prefer actual rendered width; fallback to text length estimate
              const measured = group.fileLabel.offsetWidth || 0;
              const estimate = (group.fileLabel.textContent || '').length * 7 + 30;
              labelWidth = Math.max(300, measured || estimate);
            }
            // Calculate optimal container width for packing
            const optimalWidth = calculateOptimalContainerWidth(group.symbols, labelWidth);
            group.width = optimalWidth;
            
            // Update file container position
            if (group.fileContainer) {
              group.fileContainer.style.left = currentX + 'px';
            }
            
            // Update all symbol positions in this file
            // This will also set the exact container width and height
            repositionFileSymbols(group);
            
            // Move to next file position (use the actual width from repositionFileSymbols)
            currentX += group.width + FILE_SPACING;
          });
        }

        // Helper function to get symbol category for row-based layout
        function getSymbolCategory(type) {
          if (type === 'variable' || type === 'constant') return 'variables';
          if (type === 'interface' || type === 'type') return 'types';
          if (type === 'class') return 'classes';
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
            
            // Position relative to file container (accounting for 40px top padding)
            box.style.left = pos.x + 'px';
            box.style.top = (pos.y + 40) + 'px'; // Add 40px for label space
            
            // Ensure the box has the correct size
            box.style.width = pos.width + 'px';
            box.style.height = pos.height + 'px';
            
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
            const absoluteY = 50 + 40 + pos.y + pos.height / 2; // 50px container top + 40px label padding + pos.y
            
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
          // and padding (40px top). The content area for symbols is the full width/height minus these.
          // Since symbols are positioned in the content area, we set container size to exactly match packed size.
          const finalWidth = Math.max(packed.contentW, labelMinWidth);
          const finalHeight = packed.contentH + 40;
          
          console.log('[Layout] Final container size:', finalWidth, 'x', finalHeight, '(label min:', labelMinWidth, ', packed:', packed.contentW, 'x', packed.contentH, ')');
          group.fileContainer.style.width = finalWidth + 'px';
          group.fileContainer.style.height = finalHeight + 'px';
          
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
        fileContainer.style.top = '50px';
        canvas.appendChild(fileContainer);
        
        // Create file path label inside the container
        const fileLabel = document.createElement('div');
        fileLabel.className = 'file-path-label';
        const fileDisplay = filePath + (isNew ? ' (new)' : '');
        fileLabel.textContent = fileDisplay;
        fileContainer.appendChild(fileLabel);
        
        const newGroup = { 
          symbols: new Map(), 
          symbolPositions: new Map(), // Track symbol positions for connections
          x: nextX, 
          width: 400, // Initial width, will grow
          elements: [], 
          fileLabel: fileLabel,
          fileContainer: fileContainer
        };
        fileGroups.set(filePath, newGroup);
        fileOrder.push(filePath); // Track creation order
      }

      const group = fileGroups.get(filePath);
      
      // Create a unique key based on position (type + line), not name
      // This allows renaming to update the same box
      const symbolKey = symbol.type + ':' + symbol.startLine;
      
      // Check if we need to clean up old keys with different names at the same position
      const keysToRemove = [];
      for (const [key, elements] of group.symbols.entries()) {
        // If same type and line but different key (different name), remove it
        if (key.startsWith(symbol.type + ':') && key !== symbolKey) {
          const oldLine = key.split(':')[1];
          if (oldLine === String(symbol.startLine)) {
            keysToRemove.push(key);
            elements.forEach(el => el.remove());
          }
        }
      }
      keysToRemove.forEach(key => group.symbols.delete(key));
      
      // Remove old box for this specific symbol if it exists
      if (group.symbols.has(symbolKey)) {
        const oldElements = group.symbols.get(symbolKey);
        oldElements.forEach(el => el.remove());
      }
      
      // Create the symbol box
      const newElements = [];
      const box = document.createElement('div');
      box.className = 'symbol-box ' + symbol.type;
      
      // Store changeAmount in dataset for later use
      const changeAmount = symbol.changeAmount || 1;
      box.dataset.changeAmount = String(changeAmount);
      
      // Size will be calculated and applied during repositioning
      // Don't set size here - let the packing algorithm handle it
      
      // Get change symbol using the global helper function
      const changeSymbol = getChangeSymbol(symbol.changeType);
      
      // Add () suffix for functions and methods
      const displayName = (symbol.type === 'function' || symbol.type === 'method') 
        ? symbol.name + '()' 
        : symbol.name;
      
      // Add type label at the top
      const typeLabel = document.createElement('div');
      typeLabel.className = 'symbol-type-label';
      typeLabel.textContent = symbol.type;
      box.appendChild(typeLabel);
      
      // Add size label above the box (for debugging)
      const sizeLabel = document.createElement('div');
      sizeLabel.className = 'symbol-size-label';
      // Size will be set during repositioning when actual dimensions are known
      sizeLabel.textContent = ''; // Will be updated later
      box.appendChild(sizeLabel);
      
      // Symbol content: name and change symbol
      const contentWrapper = document.createElement('div');
      contentWrapper.className = 'symbol-content';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'symbol-name';
      nameSpan.textContent = displayName;

      const changeSpan = document.createElement('span');
      changeSpan.className = 'change-symbol';
      changeSpan.textContent = changeSymbol;

      contentWrapper.appendChild(nameSpan);
      contentWrapper.appendChild(changeSpan);
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
        
        // Add hover tooltip for diff
        let hoverTimeout = null;
        let tooltip = null;
        let isHoveringTooltip = false;
        
        box.addEventListener('mouseenter', (e) => {
          // Wait 1 second before showing tooltip
          hoverTimeout = setTimeout(() => {
            if (diff) {
              tooltip = createDiffTooltip(symbol, diff, box);
              canvas.appendChild(tooltip);
              
              // Position tooltip to the right of the box
              const boxRect = box.getBoundingClientRect();
              const canvasRect = canvas.getBoundingClientRect();
              
              // Calculate position relative to canvas
              const boxX = parseInt(box.style.left);
              const boxY = parseInt(box.style.top);
              const boxWidth = box.offsetWidth;
              
              // Position to the right of the symbol box with some spacing
              tooltip.style.left = (boxX + boxWidth + 10) + 'px';
              tooltip.style.top = boxY + 'px';
              
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
      
      // Debounce repositioning to wait for all symbols to be added
      // This is critical because symbols are sent one at a time from the backend
      if (repositionTimeout) {
        clearTimeout(repositionTimeout);
      }
      repositionTimeout = setTimeout(() => {
        repositionAllFiles();
        repositionTimeout = null;
      }, 50); // Wait 50ms for batching

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
          if (e.target.closest('.zoom-button') || e.target.closest('#clear-button')) {
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

        // Listen for messages
        window.addEventListener('message', event => {
          const message = event.data;
          console.log('[Symbol Changes] Message received:', message.type);
          
          switch (message.type) {
            case 'symbol:changed':
              console.log('[Symbol Changes] Processing symbol:changed message', message.data);
              handleSingleSymbolChange(message.data);
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
        console.error('[Symbol Changes] Stack trace:', error.stack);
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

