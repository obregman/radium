import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { watch, FSWatcher } from 'chokidar';
import { GraphStore, Node, Edge, FileRecord } from '../store/schema';
import { CodeParser, ParseResult } from './parser';
import { RadiumIgnore } from '../config/radium-ignore';
import { getCodeSmellAnalyzer } from '../analysis/code-smell-analyzer';

// Stored parse results for deferred edge creation
interface ParsedFileInfo {
  relativePath: string;
  lang: string;
  result: ParseResult;
  nodeMap: Map<string, number>;
}

export class Indexer {
  private store: GraphStore;
  private parser: CodeParser;
  private watcher: FSWatcher | null = null;
  private indexQueue: Set<string> = new Set();
  private isIndexing = false;
  private workspaceRoot: string;
  private radiumIgnore: RadiumIgnore;
  // Store parse results for deferred edge creation during batch indexing
  private pendingEdgeCreation: ParsedFileInfo[] = [];

  constructor(store: GraphStore, workspaceRoot: string) {
    this.store = store;
    this.parser = new CodeParser();
    this.workspaceRoot = workspaceRoot;
    this.radiumIgnore = new RadiumIgnore(workspaceRoot);
  }

  async start(): Promise<void> {
    console.log('INDEXER: start() called');
    
    // Clear existing index before starting fresh
    this.store.clearIndex();
    
    // Initial index
    await this.indexWorkspace();

    // Start watching for changes
    this.startWatching();
    console.log('INDEXER: start() completed');
  }

  private startWatching(): void {
    const patterns = [
      '**/*.ts',
      '**/*.tsx',
      '**/*.js',
      '**/*.jsx',
      '**/*.py',
      '**/*.cs'
    ];

    // Base ignore patterns (always ignored)
    const baseIgnored = [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/.git/**',
      '**/build/**',
      '**/__pycache__/**',
      '**/.venv/**',
      '**/venv/**'
    ];

    // Add radiumignore patterns to the watcher's ignore list
    const radiumPatterns = this.radiumIgnore.getPatterns().map(pattern => {
      // Convert radiumignore patterns to chokidar format
      if (pattern.endsWith('/')) {
        // Directory pattern: convert "debug/" to "**/debug/**"
        return `**/${pattern.slice(0, -1)}/**`;
      } else if (pattern.includes('*')) {
        // Already a glob pattern, ensure it has ** prefix
        return pattern.startsWith('**/') ? pattern : `**/${pattern}`;
      } else {
        // File pattern: convert "file.txt" to "**/file.txt"
        return `**/${pattern}`;
      }
    });

    const ignored = [...baseIgnored, ...radiumPatterns];
    console.log(`INDEXER: Watching with ${ignored.length} ignore patterns (${baseIgnored.length} base + ${radiumPatterns.length} from radiumignore)`);

    this.watcher = watch(patterns, {
      cwd: this.workspaceRoot,
      ignored,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 75
      }
    });

    this.watcher.on('add', (filePath) => this.queueFile(filePath));
    this.watcher.on('change', (filePath) => this.queueFile(filePath));
    this.watcher.on('unlink', (filePath) => this.handleFileDelete(filePath));
  }

  private queueFile(relativePath: string): void {
    // Check if file should be ignored before queueing
    if (this.radiumIgnore.shouldIgnore(relativePath)) {
      console.log(`INDEXER: Skipping ignored file from queue: ${relativePath}`);
      return;
    }
    this.indexQueue.add(relativePath);
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.isIndexing || this.indexQueue.size === 0) {
      return;
    }

    this.isIndexing = true;

    try {
      while (this.indexQueue.size > 0) {
        const files = Array.from(this.indexQueue);
        this.indexQueue.clear();

        for (const file of files) {
          try {
            await this.indexFile(path.join(this.workspaceRoot, file));
          } catch (error) {
            console.error(`Failed to index ${file}:`, error);
          }
        }
      }
    } finally {
      this.isIndexing = false;
    }
  }

  /**
   * Index specific files immediately (useful for indexing new files before they're needed)
   * Uses two-pass approach to ensure cross-file edges are created correctly
   */
  public async indexFiles(filePaths: string[]): Promise<void> {
    console.log(`[Indexer] indexFiles called with ${filePaths.length} files:`, filePaths);
    
    // Clear pending edge creation for this batch
    this.pendingEdgeCreation = [];
    
    // PASS 1: Parse files and create nodes
    for (const filePath of filePaths) {
      try {
        // Convert to absolute path if relative
        const absolutePath = path.isAbsolute(filePath) 
          ? filePath 
          : path.join(this.workspaceRoot, filePath);
        
        console.log(`[Indexer] Pass 1 - Indexing file: ${filePath} -> ${absolutePath}`);
        await this.indexFile(absolutePath, true); // deferEdges = true
        console.log(`[Indexer] Successfully indexed nodes: ${filePath}`);
      } catch (error) {
        console.error(`[Indexer] Failed to index ${filePath}:`, error);
      }
    }
    
    // PASS 2: Create edges now that all nodes exist
    console.log(`[Indexer] Pass 2 - Creating edges for ${this.pendingEdgeCreation.length} files...`);
    this.createDeferredEdges();
    this.store.save();
    
    console.log(`[Indexer] Finished indexing ${filePaths.length} files with edges`);
  }

  private async indexWorkspace(): Promise<void> {
    console.log('INDEXER: Finding source files in workspace:', this.workspaceRoot);
    const files = await this.findSourceFiles();
    console.log(`INDEXER: Found ${files.length} source files to index`);
    
    if (files.length === 0) {
      console.warn('INDEXER: No source files found! Check workspace and file patterns.');
      return;
    }

    // Clear pending edge creation for fresh start
    this.pendingEdgeCreation = [];

    // PASS 1: Parse files and create nodes (defer edge creation)
    console.log('INDEXER: Pass 1 - Parsing files and creating nodes...');
    const batchSize = 50;
    let processed = 0;
    
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, Math.min(i + batchSize, files.length));
      
      for (const file of batch) {
        try {
          await this.indexFile(file, true); // deferEdges = true
          processed++;
          
          // Log progress every 10 files
          if (processed % 10 === 0) {
            console.log(`INDEXER: Pass 1 progress: ${processed}/${files.length} files`);
          }
        } catch (error) {
          console.error(`INDEXER: Failed to index ${file}:`, error);
        }
      }
      
      // Save after each batch to avoid data loss
      this.store.save();
      
      // Small delay between batches to prevent overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    console.log(`INDEXER: Pass 1 complete - processed ${processed}/${files.length} files`);

    // PASS 2: Create edges now that all nodes exist
    console.log(`INDEXER: Pass 2 - Creating edges for ${this.pendingEdgeCreation.length} files...`);
    const edgeStats = this.createDeferredEdges();
    this.store.save();
    
    console.log(`INDEXER: Indexing complete - processed ${processed}/${files.length} files`);
    console.log(`INDEXER: Edge creation stats:`, edgeStats);
  }

  private async findSourceFiles(): Promise<string[]> {
    const patterns = [
      '**/*.ts',
      '**/*.tsx',
      '**/*.js',
      '**/*.jsx',
      '**/*.py',
      '**/*.cs'
    ];

    // Base exclude patterns (always excluded)
    const baseExcludePatterns = [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/.git/**',
      '**/build/**',
      '**/release/**',
      '**/__pycache__/**',
      '**/.venv/**',
      '**/venv/**'
    ];

    // Add radiumignore patterns to VS Code's exclude list
    const radiumPatterns = this.radiumIgnore.getPatterns().map(pattern => {
      if (pattern.endsWith('/')) {
        // Directory pattern: convert "debug/" to "**/debug/**"
        return `**/${pattern.slice(0, -1)}/**`;
      } else if (pattern.includes('*')) {
        // Already a glob pattern, ensure it has ** prefix
        return pattern.startsWith('**/') ? pattern : `**/${pattern}`;
      } else {
        // File pattern: convert "file.txt" to "**/file.txt"
        return `**/${pattern}`;
      }
    });

    const excludePatterns = [...baseExcludePatterns, ...radiumPatterns];

    const files: string[] = [];
    console.log('INDEXER: Searching for files with patterns:', patterns);
    console.log(`INDEXER: Excluding ${excludePatterns.length} patterns (${baseExcludePatterns.length} base + ${radiumPatterns.length} from radiumignore)`);

    for (const pattern of patterns) {
      const found = await vscode.workspace.findFiles(pattern, `{${excludePatterns.join(',')}}`);
      console.log(`INDEXER: Pattern '${pattern}' found ${found.length} files`);
      files.push(...found.map(uri => uri.fsPath));
    }

    console.log(`INDEXER: Total unique files found before additional radiumignore filter: ${files.length}`);
    
    // Double-check with radiumignore (in case VS Code's glob matching differs)
    const filteredFiles = files.filter(filePath => {
      const relativePath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
      const shouldIgnore = this.radiumIgnore.shouldIgnore(relativePath);
      if (shouldIgnore) {
        console.log(`INDEXER: Additional filter caught: ${relativePath}`);
      }
      return !shouldIgnore;
    });
    
    console.log(`INDEXER: Files after radiumignore double-check: ${filteredFiles.length}`);
    if (files.length !== filteredFiles.length) {
      console.log(`INDEXER: Additional filter removed ${files.length - filteredFiles.length} files`);
    }
    
    return filteredFiles;
  }

  /**
   * Index a single file
   * @param filePath Absolute path to the file
   * @param deferEdges If true, store parse results for deferred edge creation instead of creating edges immediately
   */
  private async indexFile(filePath: string, deferEdges: boolean = false): Promise<void> {
    try {
      // Normalize path to use forward slashes (cross-platform)
      const relativePath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, '/');
      
      // Check if file should be ignored
      if (this.radiumIgnore.shouldIgnore(relativePath)) {
        console.log(`INDEXER: Skipping ignored file: ${relativePath}`);
        return;
      }
      
      const lang = this.parser.getLanguage(filePath);
      if (!lang) return;

      // Check if file exists and is readable
      let stats;
      try {
        stats = await fs.promises.stat(filePath);
        // Skip files larger than 1MB to avoid memory issues
        if (stats.size > 1024 * 1024) {
          console.warn(`Skipping large file ${relativePath} (${Math.round(stats.size / 1024)}KB)`);
          return;
        }
      } catch (error) {
        console.warn(`Cannot access file ${relativePath}:`, error);
        return;
      }

      const now = Date.now();

      // Try to parse the file
      let result;
      try {
        result = await this.parser.parseFile(filePath);
      } catch (error) {
        // If parsing fails, still index the file but with empty symbols
        console.warn(`Failed to parse ${relativePath}, indexing without symbols`);
        try {
          const code = await fs.promises.readFile(filePath, 'utf-8');
          const crypto = require('crypto');
          const hash = crypto.createHash('sha256').update(code).digest('hex');
          result = { symbols: [], imports: [], calls: [], hash };
        } catch (readError) {
          console.error(`Cannot read file ${relativePath}:`, readError);
          return;
        }
      }
      
      if (!result) return;

    this.store.beginTransaction();

    try {
      // Check if file changed
      const existingFile = this.store.getFileByPath(relativePath);
      if (existingFile && existingFile.hash === result.hash) {
        // No changes, skip
        this.store.commit();
        return;
      }

      // Update file record
      const fileId = this.store.upsertFile({
        path: relativePath,
        lang,
        hash: result.hash,
        size: stats.size,
        ts: now
      });

      // Analyze code smells
      try {
        const code = await fs.promises.readFile(filePath, 'utf-8');
        const smellAnalyzer = getCodeSmellAnalyzer();
        const smellMetrics = smellAnalyzer.analyze(code, result);
        
        this.store.upsertFileSmell({
          file_id: fileId,
          score: smellMetrics.score,
          line_count: smellMetrics.lineCount,
          function_count: smellMetrics.functionCount,
          avg_function_length: smellMetrics.avgFunctionLength,
          max_function_length: smellMetrics.maxFunctionLength,
          max_nesting_depth: smellMetrics.maxNestingDepth,
          import_count: smellMetrics.importCount,
          ts: now
        });
      } catch (smellError) {
        console.warn(`INDEXER: Failed to analyze code smells for ${relativePath}:`, smellError);
      }

      // Delete old nodes for this file
      this.store.deleteNodesByPath(relativePath);

      // Insert new nodes
      const nodeMap = new Map<string, number>();
      for (const symbol of result.symbols) {
        const nodeId = this.store.insertNode({
          kind: symbol.kind,
          lang,
          name: symbol.name,
          fqname: symbol.fqname,
          path: relativePath,
          range_start: symbol.range.start,
          range_end: symbol.range.end,
          hash: result.hash,
          ts: now
        });
        nodeMap.set(symbol.fqname, nodeId);
      }

      // If deferring edges, store parse info for later edge creation
      if (deferEdges) {
        this.pendingEdgeCreation.push({
          relativePath,
          lang,
          result,
          nodeMap
        });
        this.store.commit();
        return;
      }

      // Create edges immediately (for single-file updates)
      this.createEdgesForFile(relativePath, lang, result, nodeMap);

      this.store.commit();
    } catch (error) {
      this.store.rollback();
      throw error;
    }
    } catch (error) {
      // Catch any errors in the entire indexFile process
      console.error(`INDEXER: Error indexing file ${filePath}:`, error);
      // Don't rethrow - continue with other files
    }
  }

  /**
   * Create edges for a single file's imports and calls
   */
  private createEdgesForFile(
    relativePath: string,
    lang: string,
    result: ParseResult,
    nodeMap: Map<string, number>
  ): void {
    const now = Date.now();

    // Create edges for imports
    for (const imp of result.imports) {
      const importedPath = this.resolveImport(relativePath, imp.source, lang);
      if (!importedPath) {
        console.log(`[Indexer Edge] Could not resolve import '${imp.source}' from ${relativePath}`);
        continue;
      }

      const importedNodes = this.store.getNodesByPath(importedPath);
      
      for (const name of imp.names) {
        const importedNode = importedNodes.find(n => n.name === name);
        if (!importedNode) {
          // Only log if this looks like it should have been found
          if (importedNodes.length > 0) {
            console.log(`[Indexer] ⚠️ Import '${name}' not found in ${importedPath} (from ${relativePath})`);
            console.log(`[Indexer]    Available symbols: ${importedNodes.map(n => n.name).slice(0, 5).join(', ')}${importedNodes.length > 5 ? '...' : ''}`);
          }
          continue;
        }

        // Find the first node in this file (file-level import)
        const firstNode = result.symbols[0];
        if (!firstNode) continue;

        const srcId = nodeMap.get(firstNode.fqname);
        if (!srcId) continue;

        this.store.insertEdge({
          kind: 'imports',
          src: srcId,
          dst: importedNode.id!,
          weight: 1.0,
          ts: now
        });
      }
    }

    // Create edges for calls (simplified - match by name)
    for (const call of result.calls) {
      const callerSymbol = result.symbols.find(
        s => s.range.start <= call.range.start && s.range.end >= call.range.end
      );
      if (!callerSymbol) continue;

      const callerId = nodeMap.get(callerSymbol.fqname);
      if (!callerId) continue;

      // Try to find callee in all nodes
      const allNodes = this.store.getAllNodes();
      
      // For calls like "ClassName.staticMethod", create edges to both:
      // 1. The class itself (ClassName)
      // 2. The method (staticMethod)
      const lastDot = call.callee.lastIndexOf('.');
      if (lastDot !== -1) {
        // Static method call or property access
        const className = call.callee.substring(0, lastDot);
        const methodName = call.callee.substring(lastDot + 1);
        
        // Create edge to the class
        const classNode = allNodes.find(n => 
          n.name === className || n.fqname.endsWith(`.${className}`)
        );
        if (classNode) {
          this.store.insertEdge({
            kind: 'calls',
            src: callerId,
            dst: classNode.id!,
            weight: 1.0,
            ts: now
          });
        }
        
        // Also create edge to the method if it exists
        const methodNode = allNodes.find(n => 
          n.name === methodName || n.fqname.endsWith(`.${methodName}`)
        );
        if (methodNode) {
          this.store.insertEdge({
            kind: 'calls',
            src: callerId,
            dst: methodNode.id!,
            weight: 1.0,
            ts: now
          });
        }
      } else {
        // Simple call without property access
        const calleeNode = allNodes.find(n => 
          n.name === call.callee || n.fqname.endsWith(`.${call.callee}`)
        );
        
        if (calleeNode) {
          this.store.insertEdge({
            kind: 'calls',
            src: callerId,
            dst: calleeNode.id!,
            weight: 1.0,
            ts: now
          });
        }
      }
    }
  }

  /**
   * Create edges for all pending files (pass 2 of two-pass indexing)
   * This is called after all files have been indexed and all nodes exist
   */
  private createDeferredEdges(): { total: number; imports: number; calls: number; failed: number } {
    let edgesCreated = 0;
    let importEdges = 0;
    let callEdges = 0;
    let failedFiles = 0;
    
    for (const fileInfo of this.pendingEdgeCreation) {
      try {
        const beforeEdges = this.store.getAllEdges().length;
        
        // Count import and call edges separately
        const importCount = fileInfo.result.imports.length;
        const callCount = fileInfo.result.calls.length;
        
        this.createEdgesForFile(
          fileInfo.relativePath,
          fileInfo.lang,
          fileInfo.result,
          fileInfo.nodeMap
        );
        
        const afterEdges = this.store.getAllEdges().length;
        const created = afterEdges - beforeEdges;
        edgesCreated += created;
        
        // Estimate breakdown (not perfect but gives an idea)
        if (importCount > 0) importEdges += Math.min(created, importCount);
        if (callCount > 0) callEdges += Math.max(0, created - importCount);
      } catch (error) {
        console.error(`INDEXER: Failed to create edges for ${fileInfo.relativePath}:`, error);
        failedFiles++;
      }
    }
    
    const stats = {
      total: edgesCreated,
      imports: importEdges,
      calls: callEdges,
      failed: failedFiles
    };
    
    console.log(`INDEXER: Created ${edgesCreated} edges (${importEdges} imports, ${callEdges} calls) for ${this.pendingEdgeCreation.length} files`);
    if (failedFiles > 0) {
      console.log(`INDEXER: Failed to create edges for ${failedFiles} files`);
    }
    
    // Clear pending edge creation
    this.pendingEdgeCreation = [];
    
    return stats;
  }

  private resolveImport(fromPath: string, importSource: string, lang: string): string | undefined {
    // Simplified import resolution
    if (importSource.startsWith('.')) {
      // Relative import
      const dir = path.dirname(fromPath);
      const resolved = path.normalize(path.join(dir, importSource)).replace(/\\/g, '/');

      // Try with various extensions
      const extensions = lang === 'python' ? ['.py'] : ['.ts', '.tsx', '.js', '.jsx', '.d.ts'];
      
      for (const ext of extensions) {
        const resolvedPath = resolved + ext;
        const fullPath = path.join(this.workspaceRoot, resolvedPath);
        if (fs.existsSync(fullPath)) {
          console.log(`[Indexer] Resolved import '${importSource}' from ${fromPath} -> ${resolvedPath}`);
          return resolvedPath;
        }
      }

      // Try as directory with index file
      const indexFile = lang === 'python' ? '__init__.py' : 'index.ts';
      const indexPath = path.join(resolved, indexFile).replace(/\\/g, '/');
      const fullIndexPath = path.join(this.workspaceRoot, indexPath);
      if (fs.existsSync(fullIndexPath)) {
        console.log(`[Indexer] Resolved import '${importSource}' from ${fromPath} -> ${indexPath} (index file)`);
        return indexPath;
      }
      
      // Log resolution failure with details
      console.log(`[Indexer] Failed to resolve import '${importSource}' from ${fromPath}`);
      console.log(`[Indexer]   Tried paths: ${extensions.map(ext => resolved + ext).join(', ')}`);
      console.log(`[Indexer]   Tried index: ${indexPath}`);
    } else {
      // Log non-relative imports
      console.log(`[Indexer] Skipping non-relative import '${importSource}' from ${fromPath}`);
    }

    // Absolute/package imports not resolved for now
    return undefined;
  }

  private handleFileDelete(relativePath: string): void {
    this.store.beginTransaction();
    try {
      this.store.deleteNodesByPath(relativePath);
      this.store.commit();
    } catch (error) {
      this.store.rollback();
      console.error(`Failed to delete nodes for ${relativePath}:`, error);
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  getStore(): GraphStore {
    return this.store;
  }
}

