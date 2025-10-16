import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { watch, FSWatcher } from 'chokidar';
import { GraphStore, Node, Edge, FileRecord } from '../store/schema';
import { CodeParser, ParseResult } from './parser';

export class Indexer {
  private store: GraphStore;
  private parser: CodeParser;
  private watcher: FSWatcher | null = null;
  private indexQueue: Set<string> = new Set();
  private isIndexing = false;
  private workspaceRoot: string;

  constructor(store: GraphStore, workspaceRoot: string) {
    this.store = store;
    this.parser = new CodeParser();
    this.workspaceRoot = workspaceRoot;
  }

  async start(): Promise<void> {
    // Initial index
    await this.indexWorkspace();

    // Start watching for changes
    this.startWatching();
  }

  private startWatching(): void {
    const patterns = [
      '**/*.ts',
      '**/*.tsx',
      '**/*.js',
      '**/*.jsx',
      '**/*.py'
    ];

    const ignored = [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/.git/**',
      '**/build/**',
      '**/__pycache__/**',
      '**/.venv/**',
      '**/venv/**'
    ];

    this.watcher = watch(patterns, {
      cwd: this.workspaceRoot,
      ignored,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    });

    this.watcher.on('add', (filePath) => this.queueFile(filePath));
    this.watcher.on('change', (filePath) => this.queueFile(filePath));
    this.watcher.on('unlink', (filePath) => this.handleFileDelete(filePath));
  }

  private queueFile(relativePath: string): void {
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

  private async indexWorkspace(): Promise<void> {
    const files = await this.findSourceFiles();
    
    console.log(`Indexing ${files.length} files...`);

    for (const file of files) {
      try {
        await this.indexFile(file);
      } catch (error) {
        console.error(`Failed to index ${file}:`, error);
      }
    }

    console.log('Initial indexing complete');
  }

  private async findSourceFiles(): Promise<string[]> {
    const patterns = [
      '**/*.ts',
      '**/*.tsx',
      '**/*.js',
      '**/*.jsx',
      '**/*.py'
    ];

    const excludePatterns = [
      '**/node_modules/**',
      '**/out/**',
      '**/dist/**',
      '**/.git/**',
      '**/build/**',
      '**/__pycache__/**',
      '**/.venv/**',
      '**/venv/**'
    ];

    const files: string[] = [];

    for (const pattern of patterns) {
      const found = await vscode.workspace.findFiles(pattern, `{${excludePatterns.join(',')}}`);
      files.push(...found.map(uri => uri.fsPath));
    }

    return files;
  }

  private async indexFile(filePath: string): Promise<void> {
    const relativePath = path.relative(this.workspaceRoot, filePath);
    const lang = this.parser.getLanguage(filePath);
    if (!lang) return;

    // Parse the file
    const result = await this.parser.parseFile(filePath);
    if (!result) return;

    const stats = await fs.promises.stat(filePath);
    const now = Date.now();

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

      // Create edges for imports
      for (const imp of result.imports) {
        const importedPath = this.resolveImport(relativePath, imp.source, lang);
        if (!importedPath) continue;

        const importedNodes = this.store.getNodesByPath(importedPath);
        for (const name of imp.names) {
          const importedNode = importedNodes.find(n => n.name === name);
          if (!importedNode) continue;

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

      this.store.commit();
    } catch (error) {
      this.store.rollback();
      throw error;
    }
  }

  private resolveImport(fromPath: string, importSource: string, lang: string): string | undefined {
    // Simplified import resolution
    if (importSource.startsWith('.')) {
      // Relative import
      const dir = path.dirname(fromPath);
      const resolved = path.normalize(path.join(dir, importSource));

      // Try with various extensions
      const extensions = lang === 'python' ? ['.py'] : ['.ts', '.tsx', '.js', '.jsx', '.d.ts'];
      
      for (const ext of extensions) {
        const resolvedPath = resolved + ext;
        if (fs.existsSync(path.join(this.workspaceRoot, resolvedPath))) {
          return resolvedPath;
        }
      }

      // Try as directory with index file
      const indexFile = lang === 'python' ? '__init__.py' : 'index.ts';
      const indexPath = path.join(resolved, indexFile);
      if (fs.existsSync(path.join(this.workspaceRoot, indexPath))) {
        return indexPath;
      }
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

