import * as vscode from 'vscode';
import * as chokidar from 'chokidar';
import * as cp from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { RadiumIgnore } from '../config/radium-ignore';
import { CodeParser } from '../indexer/parser';

const exec = promisify(cp.exec);

interface SymbolChange {
  type: 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable' | 'constant';
  name: string;
  changeType: 'added' | 'modified' | 'deleted' | 'value_changed';
  filePath: string;
  startLine: number;
  endLine: number;
  details?: string; // Additional info like "value: 42 -> 100"
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
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private watcher?: chokidar.FSWatcher;
  private workspaceRoot: string;
  private pendingChanges = new Map<string, NodeJS.Timeout>();
  private diffCache = new Map<string, { diff: string; timestamp: number }>();
  private filesCreatedThisSession = new Set<string>();
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

    this.panel.webview.html = this.getHtmlContent(extensionUri);

    this.panel.webview.onDidReceiveMessage(
      message => {
        switch (message.type) {
          case 'clearAll':
            this.filesCreatedThisSession.clear();
            console.log('[Radium Symbol] Cleared session tracking');
            break;
        }
      },
      null,
      this.disposables
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.startWatching();
  }

  public static createOrShow(extensionUri: vscode.Uri, workspaceRoot: string) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SymbolChangesPanel.currentPanel) {
      SymbolChangesPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'symbolChanges',
      'Radium: Visualise Real-time Changes',
      column || vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    SymbolChangesPanel.currentPanel = new SymbolChangesPanel(panel, extensionUri, workspaceRoot);
  }

  private startWatching() {
    this.watcher = chokidar.watch(this.workspaceRoot, {
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/out/**',
        '**/dist/**',
        '**/build/**',
        '**/.radium/**',
        '**/.*'
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

  private async handleFileChange(absolutePath: string, isNewFile: boolean) {
    if (!this.isSourceFile(absolutePath)) {
      return;
    }

    const relativePath = path.relative(this.workspaceRoot, absolutePath);
    
    if (this.radiumIgnore.shouldIgnore(relativePath)) {
      console.log(`[Radium Symbol] Ignoring file: ${relativePath}`);
      return;
    }
    
    if (isNewFile) {
      this.filesCreatedThisSession.add(relativePath);
      console.log(`[Radium Symbol] New file detected: ${relativePath}`);
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

    const diff = await this.getFileDiff(relativePath);
    const hasChanges = diff && diff !== 'No diff available' && diff !== 'Error getting diff' && diff.trim().length > 0;
    
    console.log(`[Radium Symbol] Processing ${relativePath}, hasChanges: ${hasChanges}, diffLength: ${diff?.length || 0}`);
    
    if (!hasChanges) {
      console.log(`[Radium Symbol] No changes detected for ${relativePath}`);
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
    console.log(`[Radium Symbol] File ${relativePath} isNew: ${isNew}`);
    
    // Analyze the diff to extract symbol changes
    const symbolChanges = await this.analyzeDiffForSymbols(relativePath, diff, isNew);
    console.log(`[Radium Symbol] Found ${symbolChanges.symbols.length} symbols in ${relativePath}`);

    // Send each symbol change individually so they get their own boxes
    for (const symbol of symbolChanges.symbols) {
      console.log(`[Radium Symbol] Sending symbol: ${symbol.name} (${symbol.type})`);
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
        const parseResult = await this.parser.parseFile(fullPath, currentContent);
        
        if (parseResult) {
          currentSymbols = parseResult.symbols;
          currentCalls = parseResult.calls;
        }
      }
    } catch (error) {
      console.error(`[Radium Symbol] Failed to parse ${filePath}:`, error);
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

    // Extract variables from diff
    const variables = this.extractVariablesFromDiff(currentContent, addedLines, deletedLines, changedLineNumbers);
    symbols.push(...variables);

    // Track symbols we've already added to avoid duplicates
    const addedSymbolKeys = new Set<string>();
    for (const v of variables) {
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

    // Match symbols to changed lines
    for (const symbol of currentSymbols) {
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
        // For classes, only show if there are direct changes to the class itself
        if (symbol.kind === 'class' && !isNewFile) {
          let hasNestedSymbolChanges = false;
          for (const otherSymbol of currentSymbols) {
            if (otherSymbol === symbol) continue;
            
            const otherStart = this.byteOffsetToLineNumber(fullPath, otherSymbol.range.start);
            const otherEnd = this.byteOffsetToLineNumber(fullPath, otherSymbol.range.end);
            
            if (otherStart >= symbolStartLine && otherEnd <= symbolEndLine) {
              for (let line = otherStart; line <= otherEnd; line++) {
                if (changedLineNumbers.has(line)) {
                  hasNestedSymbolChanges = true;
                  break;
                }
              }
            }
            if (hasNestedSymbolChanges) break;
          }
          
          if (hasNestedSymbolChanges && !hasDirectChanges) {
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
        
        if (isNewFile) {
          changeType = 'added';
          details = this.getChangeDescription('added', symbol.kind, '', 0, 0, parentInfo);
        } else {
          let addedCount = 0;
          let deletedCount = 0;
          for (let line = symbolStartLine; line <= symbolEndLine; line++) {
            if (addedLineNumbers.has(line)) addedCount++;
            if (deletedLineNumbers.has(line)) deletedCount++;
          }
          
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
          details
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

    // Patterns for variable declarations
    const patterns = [
      // TypeScript/JavaScript: const, let, var
      /\b(const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[:=]\s*(.+?)(?:;|$)/g,
      // Python: variable = value
      /^(\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+?)(?:#|$)/g,
      // TypeScript interfaces
      /\binterface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      // TypeScript types
      /\btype\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g
    ];

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
        if (!seenVariables.has(varName)) {
          seenVariables.add(varName);
          variables.push({
            type: varType === 'interface' ? 'interface' : 'type',
            name: varName,
            changeType: 'added',
            filePath: '',
            startLine: lineNum,
            endLine: lineNum,
            details: `Added ${varType}`
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
        
        if (!seenVariables.has(varName)) {
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
            details: description
          });
        }
        continue;
      }

      // Python variable assignment
      const pyVarMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+?)(?:#|$)/);
      if (pyVarMatch && !trimmed.includes('def ') && !trimmed.includes('class ')) {
        const varName = pyVarMatch[1];
        const varValue = pyVarMatch[2].trim();
        
        if (!seenVariables.has(varName)) {
          seenVariables.add(varName);
          variables.push({
            type: 'variable',
            name: varName,
            changeType: 'added',
            filePath: '',
            startLine: lineNum,
            endLine: lineNum,
            details: `Added variable: ${varValue.substring(0, 25)}${varValue.length > 25 ? '...' : ''}`
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
            details: `Value: ${oldShort} → ${newShort}`
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
            details: `Value: ${oldShort} → ${newShort}`
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

  private async getFileDiff(filePath: string): Promise<string> {
    const cached = this.diffCache.get(filePath);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.diff;
    }

    try {
      const { stdout } = await exec(`git diff HEAD -- "${filePath}"`, {
        cwd: this.workspaceRoot
      });

      let diff: string;
      if (stdout) {
        diff = stdout;
      } else {
        const { stdout: unstagedDiff } = await exec(`git diff -- "${filePath}"`, {
          cwd: this.workspaceRoot
        });
        
        if (unstagedDiff) {
          diff = unstagedDiff;
        } else {
          let isTracked = false;
          try {
            await exec(`git ls-files --error-unmatch "${filePath}"`, {
              cwd: this.workspaceRoot
            });
            isTracked = true;
          } catch {
            isTracked = false;
          }
          
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
              } else {
                diff = 'No diff available';
              }
            } catch (error) {
              console.error(`Failed to read new file ${filePath}:`, error);
              diff = 'No diff available';
            }
          } else {
            diff = '';
          }
        }
      }

      this.diffCache.set(filePath, {
        diff: diff,
        timestamp: Date.now()
      });

      return diff;
    } catch (error) {
      console.error(`Failed to get diff for ${filePath}:`, error);
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

  private getHtmlContent(extensionUri: vscode.Uri): string {
    return `<!DOCTYPE html>
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
      padding: 16px 24px;
      background-color: var(--vscode-editor-background);
      border: 3px solid var(--vscode-panel-border);
      border-radius: 12px;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      transition: all 0.3s ease;
      z-index: 10;
      cursor: pointer;
      width: 280px;
      text-align: center;
    }

    .symbol-box.function {
      border-color: #4EC9B0;
      background: linear-gradient(135deg, rgba(78, 201, 176, 0.1) 0%, rgba(78, 201, 176, 0.05) 100%);
    }

    .symbol-box.class {
      border-color: #4FC1FF;
      background: linear-gradient(135deg, rgba(79, 193, 255, 0.1) 0%, rgba(79, 193, 255, 0.05) 100%);
      border-radius: 8px;
    }

    .symbol-box.method {
      border-color: #C586C0;
      background: linear-gradient(135deg, rgba(197, 134, 192, 0.1) 0%, rgba(197, 134, 192, 0.05) 100%);
    }

    .symbol-box.interface {
      border-color: #9CDCFE;
      background: linear-gradient(135deg, rgba(156, 220, 254, 0.1) 0%, rgba(156, 220, 254, 0.05) 100%);
      border-style: dashed;
    }

    .symbol-box.type {
      border-color: #9CDCFE;
      background: linear-gradient(135deg, rgba(156, 220, 254, 0.1) 0%, rgba(156, 220, 254, 0.05) 100%);
      border-style: dashed;
    }

    .symbol-box.variable {
      border-color: #DCDCAA;
      background: linear-gradient(135deg, rgba(220, 220, 170, 0.1) 0%, rgba(220, 220, 170, 0.05) 100%);
      border-radius: 6px;
      min-width: 100px;
      padding: 12px 16px;
    }

    .symbol-box.constant {
      border-color: #D7BA7D;
      background: linear-gradient(135deg, rgba(215, 186, 125, 0.1) 0%, rgba(215, 186, 125, 0.05) 100%);
      border-radius: 6px;
      min-width: 100px;
      padding: 12px 16px;
      border-width: 2px;
    }

    .symbol-box.added {
      animation: pulseGreen 2s ease-in-out infinite;
    }

    .symbol-box.modified {
      animation: pulseYellow 2s ease-in-out infinite;
    }

    .symbol-box.deleted {
      opacity: 0.5;
      border-color: #F48771;
      animation: pulseRed 2s ease-in-out infinite;
    }

    .symbol-box.value_changed {
      animation: pulseOrange 2s ease-in-out infinite;
    }

    @keyframes pulseGreen {
      0%, 100% { box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); }
      50% { box-shadow: 0 4px 24px rgba(78, 201, 176, 0.6); }
    }

    @keyframes pulseYellow {
      0%, 100% { box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); }
      50% { box-shadow: 0 4px 24px rgba(255, 193, 7, 0.6); }
    }

    @keyframes pulseRed {
      0%, 100% { box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); }
      50% { box-shadow: 0 4px 24px rgba(244, 135, 113, 0.6); }
    }

    @keyframes pulseOrange {
      0%, 100% { box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); }
      50% { box-shadow: 0 4px 24px rgba(255, 165, 0, 0.6); }
    }

    .symbol-box:hover {
      transform: scale(1.05);
      z-index: 20;
    }

    .diff-tooltip {
      position: absolute;
      background-color: var(--vscode-editor-background);
      border: 2px solid var(--vscode-button-background);
      border-radius: 8px;
      padding: 16px;
      max-width: 600px;
      max-height: 400px;
      overflow: auto;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
      z-index: 1000;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
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

    .file-path-label {
      position: absolute;
      font-size: 18px;
      font-weight: 700;
      opacity: 0.95;
      margin-bottom: 20px;
      font-family: 'Courier New', monospace;
      color: var(--vscode-button-background);
      white-space: nowrap;
      text-align: center;
    }

    .symbol-label {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 4px;
      text-align: center;
    }

    .symbol-type {
      font-size: 10px;
      opacity: 0.7;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      text-align: center;
    }

    .symbol-details {
      font-size: 9px;
      opacity: 0.6;
      margin-top: 4px;
      font-family: 'Courier New', monospace;
      text-align: center;
      width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
      stroke: var(--vscode-button-background);
      stroke-width: 2;
      fill: none;
      opacity: 0.6;
      marker-end: url(#arrowhead);
    }

    .call-line.animated {
      stroke-dasharray: 8, 4;
      animation: dash 1s linear infinite;
    }

    @keyframes dash {
      to {
        stroke-dashoffset: -12;
      }
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
      margin-bottom: 8px;
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
      z-index: 100;
      transition: all 0.2s ease;
    }

    #clear-button:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
      transform: scale(1.05);
    }
  </style>
</head>
<body>
  <div id="info">
    <h3>📦 Visualise Real-time Changes</h3>
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
          <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
            <polygon points="0 0, 10 3, 0 6" fill="var(--vscode-button-background)" />
          </marker>
        </defs>
      </svg>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const container = document.getElementById('container');
    const canvas = document.getElementById('canvas');
    const svg = document.getElementById('connections');
    const zoomLevelEl = document.getElementById('zoom-level');

    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let isPanning = false;
    let startX = 0;
    let startY = 0;

    const fileGroups = new Map(); // filePath -> { symbols: [], x: number }
    let nextX = 100;
    const FILE_COLUMN_WIDTH = 400;
    const SYMBOL_WIDTH = 220;
    const SYMBOL_HEIGHT = 100;
    const SYMBOL_SPACING_Y = 20;
    const FILE_LABEL_HEIGHT = 60;
    let lastGlowingBox = null; // Track the currently glowing box

    function updateTransform() {
      canvas.style.transform = \`translate(\${translateX}px, \${translateY}px) scale(\${scale})\`;
      zoomLevelEl.textContent = Math.round(scale * 100) + '%';
    }

    function handleSingleSymbolChange(data) {
      const { filePath, symbol, calls, timestamp, isNew, diff } = data;

      // Get or create file group
      if (!fileGroups.has(filePath)) {
        const newGroup = { symbols: new Map(), x: nextX, elements: [], fileLabel: null };
        fileGroups.set(filePath, newGroup);
        nextX += FILE_COLUMN_WIDTH;
        
        // Create file path label at the top of the column (only once)
        const fileLabel = document.createElement('div');
        fileLabel.className = 'file-path-label';
        const fileDisplay = filePath + (isNew ? ' (new)' : '');
        fileLabel.textContent = fileDisplay;
        fileLabel.style.top = '50px';
        canvas.appendChild(fileLabel);
        
        // Calculate center position after the element is added to DOM
        // Symbol box is 280px wide, centered at newGroup.x + 140
        setTimeout(() => {
          const labelWidth = fileLabel.offsetWidth;
          const boxCenterX = newGroup.x + 140; // 280px / 2
          const labelX = boxCenterX - (labelWidth / 2);
          fileLabel.style.left = labelX + 'px';
        }, 0);
        
        newGroup.fileLabel = fileLabel;
      }

      const group = fileGroups.get(filePath);
      
      // Create a unique key based on position (type + line), not name
      // This allows renaming to update the same box
      const symbolKey = \`\${symbol.type}:\${symbol.startLine}\`;
      
      // Check if we need to clean up old keys with different names at the same position
      const keysToRemove = [];
      for (const [key, elements] of group.symbols.entries()) {
        // If same type and line but different key (different name), remove it
        if (key.startsWith(\`\${symbol.type}:\`) && key !== symbolKey) {
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
      
      // Calculate Y position based on number of symbols in this file
      const symbolIndex = Array.from(group.symbols.keys()).indexOf(symbolKey);
      const actualIndex = symbolIndex >= 0 ? symbolIndex : group.symbols.size;
      const y = 50 + FILE_LABEL_HEIGHT + (actualIndex * (SYMBOL_HEIGHT + SYMBOL_SPACING_Y));
      
      const symbolElements = [];
      const newElements = [];
        const box = document.createElement('div');
        box.className = \`symbol-box \${symbol.type}\`;
        box.style.left = group.x + 'px';
        box.style.top = y + 'px';
        
        let detailsHtml = '';
        if (symbol.details) {
          detailsHtml = \`<div class="symbol-details">\${escapeHtml(symbol.details)}</div>\`;
        }
        
        box.innerHTML = \`
          <div class="symbol-label">\${escapeHtml(symbol.name)}</div>
          <div class="symbol-type">\${symbol.type}</div>
          \${detailsHtml}
        \`;
        
        canvas.appendChild(box);
        group.elements.push(box);
        
        // Remove glow from previous box
        if (lastGlowingBox) {
          lastGlowingBox.classList.remove('added', 'modified', 'deleted', 'value_changed');
        }
        
        // Add glow to this new/updated box
        box.classList.add(symbol.changeType);
        lastGlowingBox = box;
        
        // Add hover tooltip for diff
        let hoverTimeout = null;
        let tooltip = null;
        
        box.addEventListener('mouseenter', (e) => {
          // Wait 1 second before showing tooltip
          hoverTimeout = setTimeout(() => {
            if (diff) {
              tooltip = createDiffTooltip(symbol, diff, box);
              canvas.appendChild(tooltip);
              
              // Position tooltip to the right of the box
              const boxX = parseInt(box.style.left);
              const boxY = parseInt(box.style.top);
              
              // Position to the right of the symbol box
              tooltip.style.left = (boxX + 300) + 'px';
              tooltip.style.top = boxY + 'px';
              
              // Show tooltip
              setTimeout(() => tooltip.classList.add('visible'), 10);
            }
          }, 1000);
        });
        
        box.addEventListener('mouseleave', () => {
          // Cancel tooltip if not shown yet
          if (hoverTimeout) {
            clearTimeout(hoverTimeout);
            hoverTimeout = null;
          }
          
          // Hide and remove tooltip
          if (tooltip) {
            tooltip.classList.remove('visible');
            setTimeout(() => {
              if (tooltip && tooltip.parentNode) {
                tooltip.remove();
              }
              tooltip = null;
            }, 200);
          }
        });
        
      canvas.appendChild(box);
      newElements.push(box);
      
      symbolElements.push({
        name: symbol.name,
        element: box,
        x: group.x + SYMBOL_WIDTH / 2,
        y: y + SYMBOL_HEIGHT / 2
      });
      
      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      function createDiffTooltip(symbolData, diffText, symbolBox) {
        const tooltip = document.createElement('div');
        tooltip.className = 'diff-tooltip';
        
        // Create header
        const header = document.createElement('div');
        header.className = 'diff-tooltip-header';
        header.textContent = \`\${symbolData.name} - Changes\`;
        tooltip.appendChild(header);
        
        // Parse and format diff
        const diffContent = document.createElement('div');
        const lines = diffText.split('\\n');
        
        // Find lines relevant to this symbol (if we have line info)
        let relevantLines = lines;
        if (symbolData.startLine && symbolData.endLine) {
          // Try to extract only the relevant portion of the diff
          relevantLines = [];
          let currentLine = 0;
          let inRelevantSection = false;
          
          for (const line of lines) {
            if (line.startsWith('@@')) {
              const match = line.match(/@@ -\\d+(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/);
              if (match) {
                currentLine = parseInt(match[1], 10);
                // Check if this hunk overlaps with symbol range
                inRelevantSection = currentLine <= symbolData.endLine;
              }
              if (inRelevantSection) {
                relevantLines.push(line);
              }
            } else if (inRelevantSection) {
              relevantLines.push(line);
              
              if (line.startsWith('+') && !line.startsWith('+++')) {
                currentLine++;
              } else if (!line.startsWith('-') && !line.startsWith('\\\\')) {
                currentLine++;
              }
              
              // Stop if we've passed the symbol's end line
              if (currentLine > symbolData.endLine + 3) {
                inRelevantSection = false;
              }
            }
          }
          
          // If we didn't find relevant lines, show all
          if (relevantLines.length === 0) {
            relevantLines = lines;
          }
        }
        
        // Format diff lines and track first change
        let firstChangeElement = null;
        for (const line of relevantLines) {
          const diffLine = document.createElement('div');
          diffLine.className = 'diff-line';
          
          if (line.startsWith('+') && !line.startsWith('+++')) {
            diffLine.classList.add('addition');
            if (!firstChangeElement) {
              firstChangeElement = diffLine;
            }
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            diffLine.classList.add('deletion');
            if (!firstChangeElement) {
              firstChangeElement = diffLine;
            }
          } else {
            diffLine.classList.add('context');
          }
          
          diffLine.textContent = line;
          diffContent.appendChild(diffLine);
        }
        
        tooltip.appendChild(diffContent);
        
        // Scroll to the first change after tooltip is rendered
        if (firstChangeElement) {
          setTimeout(() => {
            const tooltipRect = diffContent.getBoundingClientRect();
            const changeRect = firstChangeElement.getBoundingClientRect();
            
            // Calculate scroll position to center the first change
            const scrollTop = firstChangeElement.offsetTop - (diffContent.clientHeight / 2) + (firstChangeElement.clientHeight / 2);
            diffContent.scrollTop = Math.max(0, scrollTop);
          }, 10);
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

      // Draw call relationships
      for (const call of calls) {
        const fromSymbol = symbolElements.find(s => s.name === call.from);
        const toSymbol = symbolElements.find(s => s.name === call.to);
        
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
          
          const path = \`M \${x1} \${y1} Q \${midX} \${midY} \${x2} \${y2}\`;
          line.setAttribute('d', path);
          
          svg.appendChild(line);
          group.elements.push(line);
        }
      }

      group.symbols = symbols;
    }

    // Pan handlers
    container.addEventListener('mousedown', (e) => {
      if (e.target.closest('.zoom-button') || e.target.closest('#clear-button')) {
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

    // Clear button
    document.getElementById('clear-button').addEventListener('click', () => {
      // Remove all symbol boxes and file labels
      fileGroups.forEach(group => {
        // Remove file label
        if (group.fileLabel) {
          group.fileLabel.style.transition = 'opacity 0.3s ease';
          group.fileLabel.style.opacity = '0';
          setTimeout(() => group.fileLabel.remove(), 300);
        }
        
        // Remove all symbol boxes
        group.symbols.forEach(elements => {
          elements.forEach(el => {
            el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
            el.style.opacity = '0';
            el.style.transform = 'scale(0.8)';
            setTimeout(() => el.remove(), 300);
          });
        });
      });

      // Remove all connection lines
      const allLines = Array.from(connectionsContainer.querySelectorAll('path'));
      allLines.forEach(line => {
        line.style.transition = 'opacity 0.3s ease';
        line.style.opacity = '0';
        setTimeout(() => line.remove(), 300);
      });

      // Clear file groups
      fileGroups.clear();

      // Reset next position
      nextX = 100;

      // Notify extension to clear session tracking
      vscode.postMessage({ type: 'clearAll' });

      console.log('[Radium] Cleared all symbols');
    });

    // Listen for messages
    window.addEventListener('message', event => {
      const message = event.data;
      
      switch (message.type) {
        case 'symbol:changed':
          handleSingleSymbolChange(message.data);
          break;
        case 'file:reverted':
        case 'file:deleted':
          const group = fileGroups.get(message.data.filePath);
          if (group) {
            // Remove file label
            if (group.fileLabel) {
              group.fileLabel.style.transition = 'opacity 0.3s ease';
              group.fileLabel.style.opacity = '0';
              setTimeout(() => group.fileLabel.remove(), 300);
            }
            
            // Remove all symbol boxes
            group.symbols.forEach(elements => {
              elements.forEach(el => {
                el.style.transition = 'opacity 0.3s ease';
                el.style.opacity = '0';
                setTimeout(() => el.remove(), 300);
              });
            });
            
            fileGroups.delete(message.data.filePath);
          }
          break;
      }
    });
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

