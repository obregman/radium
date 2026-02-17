import * as vscode from 'vscode';
import * as cp from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const exec = promisify(cp.exec);

/**
 * Represents a single commit in the git history
 */
export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  message: string;
  timestamp: Date;
  changes: GitFileChange[];
}

/**
 * Represents a file change in a commit
 */
export interface GitFileChange {
  path: string;
  action: 'add' | 'modify' | 'delete' | 'rename';
  additions: number;
  deletions: number;
  oldPath?: string; // For renames
}

/**
 * Represents a frame in the timeline (aggregated commits)
 */
export interface TimelineFrame {
  index: number;
  label: string;
  timestamp: Date;
  commits: GitCommit[];
  fileTree: TreeNode;
  stats: FrameStats;
  newFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
}

/**
 * Statistics for a frame
 */
export interface FrameStats {
  totalFiles: number;
  totalLines: number;
  totalCommits: number;
  totalContributors: number;
}

/**
 * Tree node representing file/directory structure
 */
export interface TreeNode {
  id: string;
  name: string;
  path: string;
  isDir: boolean;
  lines: number;
  files: number;
  children: Map<string, TreeNode>;
  addedAt?: Date;
  modifiedAt?: Date;
  lastAuthor?: string;
  changeCount: number;
  isNew?: boolean;
  isModified?: boolean;
  isDeleted?: boolean;
  parent?: string;
}

/**
 * Interval for grouping commits
 */
export type TimelineInterval = 'day' | 'week' | 'month';

/**
 * GitHistoryTracker - Fetches and processes git history for timeline visualization
 */
export class GitHistoryTracker {
  private workspaceRoot: string;
  private static outputChannel: vscode.OutputChannel;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    
    if (!GitHistoryTracker.outputChannel) {
      GitHistoryTracker.outputChannel = vscode.window.createOutputChannel('Radium Git Timeline');
    }
  }

  private log(message: string): void {
    GitHistoryTracker.outputChannel.appendLine(`[GitTimeline] ${message}`);
  }

  /**
   * Get all commits from the repository
   */
  async getCommits(limit?: number): Promise<GitCommit[]> {
    try {
      const limitArg = limit ? `-n ${limit}` : '';
      
      // Get commit metadata with custom format
      const { stdout } = await exec(
        `git log ${limitArg} --pretty=format:"%H|%h|%an|%ae|%s|%aI" --name-status`,
        { cwd: this.workspaceRoot, maxBuffer: 50 * 1024 * 1024 }
      );

      const commits: GitCommit[] = [];
      const lines = stdout.split('\n');
      let currentCommit: GitCommit | null = null;

      for (const line of lines) {
        if (line.includes('|') && line.split('|').length >= 6) {
          // This is a commit header line
          if (currentCommit) {
            commits.push(currentCommit);
          }

          const parts = line.split('|');
          currentCommit = {
            hash: parts[0],
            shortHash: parts[1],
            author: parts[2],
            email: parts[3],
            message: parts[4],
            timestamp: new Date(parts[5]),
            changes: []
          };
        } else if (currentCommit && line.trim()) {
          // This is a file change line
          const match = line.match(/^([AMDRT])\d*\t(.+?)(?:\t(.+))?$/);
          if (match) {
            const [, status, filePath, newPath] = match;
            let action: GitFileChange['action'] = 'modify';
            
            switch (status) {
              case 'A': action = 'add'; break;
              case 'M': action = 'modify'; break;
              case 'D': action = 'delete'; break;
              case 'R': action = 'rename'; break;
              case 'T': action = 'modify'; break;
            }

            currentCommit.changes.push({
              path: newPath || filePath,
              action,
              additions: 0,
              deletions: 0,
              oldPath: status === 'R' ? filePath : undefined
            });
          }
        }
      }

      if (currentCommit) {
        commits.push(currentCommit);
      }

      this.log(`Fetched ${commits.length} commits`);
      return commits;
    } catch (error) {
      this.log(`Error fetching commits: ${error}`);
      return [];
    }
  }

  /**
   * Get detailed stats for a commit's changes
   */
  async getCommitStats(hash: string): Promise<Map<string, { additions: number; deletions: number }>> {
    try {
      const { stdout } = await exec(
        `git show --numstat --format="" ${hash}`,
        { cwd: this.workspaceRoot }
      );

      const stats = new Map<string, { additions: number; deletions: number }>();
      const lines = stdout.trim().split('\n');

      for (const line of lines) {
        const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (match) {
          const [, adds, dels, filePath] = match;
          stats.set(filePath, {
            additions: adds === '-' ? 0 : parseInt(adds, 10),
            deletions: dels === '-' ? 0 : parseInt(dels, 10)
          });
        }
      }

      return stats;
    } catch {
      return new Map();
    }
  }

  /**
   * Build timeline frames by grouping commits by interval
   */
  async buildTimeline(interval: TimelineInterval = 'week', maxFrames?: number): Promise<TimelineFrame[]> {
    this.log(`Building timeline with interval: ${interval}`);
    
    const commits = await this.getCommits();
    if (commits.length === 0) {
      this.log('No commits found');
      return [];
    }

    // Sort commits by timestamp (oldest first)
    commits.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // Group commits by interval
    const groups = this.groupCommitsByInterval(commits, interval);
    this.log(`Grouped into ${groups.length} intervals`);

    // Build frames
    const frames: TimelineFrame[] = [];
    const cumulativeTree = this.createEmptyTree();
    const allContributors = new Set<string>();
    let totalCommits = 0;

    for (let i = 0; i < groups.length; i++) {
      if (maxFrames && i >= maxFrames) break;

      const group = groups[i];
      const frameChanges = { new: new Set<string>(), modified: new Set<string>(), deleted: new Set<string>() };

      // Process each commit in the group
      for (const commit of group.commits) {
        totalCommits++;
        allContributors.add(commit.author);

        for (const change of commit.changes) {
          if (!this.isSourceFile(change.path)) continue;

          switch (change.action) {
            case 'add':
              this.addFileToTree(cumulativeTree, change.path, commit);
              frameChanges.new.add(change.path);
              break;
            case 'modify':
              this.updateFileInTree(cumulativeTree, change.path, commit);
              frameChanges.modified.add(change.path);
              break;
            case 'delete':
              this.removeFileFromTree(cumulativeTree, change.path);
              frameChanges.deleted.add(change.path);
              break;
            case 'rename':
              if (change.oldPath) {
                this.removeFileFromTree(cumulativeTree, change.oldPath);
              }
              this.addFileToTree(cumulativeTree, change.path, commit);
              frameChanges.new.add(change.path);
              break;
          }
        }
      }

      // Calculate stats
      const stats = this.calculateTreeStats(cumulativeTree);

      frames.push({
        index: i,
        label: this.formatIntervalLabel(group.start, interval),
        timestamp: group.start,
        commits: group.commits,
        fileTree: this.cloneTree(cumulativeTree),
        stats: {
          totalFiles: stats.files,
          totalLines: stats.lines,
          totalCommits,
          totalContributors: allContributors.size
        },
        newFiles: Array.from(frameChanges.new),
        modifiedFiles: Array.from(frameChanges.modified),
        deletedFiles: Array.from(frameChanges.deleted)
      });

      // Clear change markers for next frame
      this.clearChangeMarkers(cumulativeTree);
    }

    this.log(`Built ${frames.length} frames`);
    return frames;
  }

  /**
   * Group commits by time interval
   */
  private groupCommitsByInterval(commits: GitCommit[], interval: TimelineInterval): { start: Date; commits: GitCommit[] }[] {
    const groups: { start: Date; commits: GitCommit[] }[] = [];
    let currentGroup: { start: Date; commits: GitCommit[] } | null = null;

    for (const commit of commits) {
      const intervalStart = this.getIntervalStart(commit.timestamp, interval);

      if (!currentGroup || intervalStart.getTime() !== currentGroup.start.getTime()) {
        if (currentGroup) {
          groups.push(currentGroup);
        }
        currentGroup = { start: intervalStart, commits: [] };
      }

      currentGroup.commits.push(commit);
    }

    if (currentGroup) {
      groups.push(currentGroup);
    }

    return groups;
  }

  /**
   * Get the start of an interval for a given date
   */
  private getIntervalStart(date: Date, interval: TimelineInterval): Date {
    const result = new Date(date);
    result.setHours(0, 0, 0, 0);

    switch (interval) {
      case 'day':
        break;
      case 'week':
        const day = result.getDay();
        result.setDate(result.getDate() - day);
        break;
      case 'month':
        result.setDate(1);
        break;
    }

    return result;
  }

  /**
   * Format interval label for display
   */
  private formatIntervalLabel(date: Date, interval: TimelineInterval): string {
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];

    switch (interval) {
      case 'day':
        return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
      case 'week':
        return `Week of ${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
      case 'month':
        return `${months[date.getMonth()]} ${date.getFullYear()}`;
    }
  }

  /**
   * Create an empty tree node
   */
  private createEmptyTree(): TreeNode {
    return {
      id: 'root',
      name: 'Repository',
      path: '',
      isDir: true,
      lines: 0,
      files: 0,
      children: new Map(),
      changeCount: 0
    };
  }

  /**
   * Add a file to the tree
   * Only marks files as new (not directories)
   */
  private addFileToTree(tree: TreeNode, filePath: string, commit: GitCommit): void {
    const parts = filePath.split('/');
    let current = tree;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join('/');

      if (!current.children.has(part)) {
        current.children.set(part, {
          id: currentPath,
          name: part,
          path: currentPath,
          isDir: !isFile,
          lines: 0,
          files: isFile ? 1 : 0,
          children: new Map(),
          addedAt: commit.timestamp,
          modifiedAt: commit.timestamp,
          lastAuthor: commit.author,
          changeCount: 1,
          isNew: isFile, // Only mark files as new, not directories
          parent: current.id
        });
      }

      const node = current.children.get(part)!;
      if (!isFile) {
        node.files++;
      }
      current = node;
    }
  }

  /**
   * Update a file in the tree
   * Only marks files as modified (not directories), increments changeCount for size scaling
   */
  private updateFileInTree(tree: TreeNode, filePath: string, commit: GitCommit): void {
    const parts = filePath.split('/');
    let current = tree;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      
      if (!current.children.has(part)) {
        // File doesn't exist, add it
        this.addFileToTree(tree, filePath, commit);
        return;
      }

      const node = current.children.get(part)!;
      const isFile = i === parts.length - 1;
      
      // Only mark files as modified, not directories
      if (isFile) {
        node.modifiedAt = commit.timestamp;
        node.lastAuthor = commit.author;
        node.changeCount++;
        node.isModified = true;
      }

      current = node;
    }
  }

  /**
   * Remove a file from the tree
   */
  private removeFileFromTree(tree: TreeNode, filePath: string): void {
    const parts = filePath.split('/');
    let current = tree;
    const parents: { node: TreeNode; childName: string }[] = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      
      if (!current.children.has(part)) {
        return; // File doesn't exist
      }

      if (i < parts.length - 1) {
        parents.push({ node: current, childName: part });
      }

      current = current.children.get(part)!;
    }

    // Remove the file
    const lastPart = parts[parts.length - 1];
    const parent = parents.length > 0 ? parents[parents.length - 1].node : tree;
    parent.children.delete(lastPart);

    // Update file counts and remove empty directories
    for (let i = parents.length - 1; i >= 0; i--) {
      const { node, childName } = parents[i];
      const child = node.children.get(childName);
      if (child) {
        child.files--;
        if (child.files === 0 && child.children.size === 0) {
          node.children.delete(childName);
        }
      }
    }
  }

  /**
   * Clear change markers from tree
   */
  private clearChangeMarkers(tree: TreeNode): void {
    tree.isNew = false;
    tree.isModified = false;
    tree.isDeleted = false;

    for (const child of tree.children.values()) {
      this.clearChangeMarkers(child);
    }
  }

  /**
   * Clone a tree (deep copy)
   */
  private cloneTree(tree: TreeNode): TreeNode {
    const clone: TreeNode = {
      ...tree,
      children: new Map()
    };

    for (const [key, child] of tree.children) {
      clone.children.set(key, this.cloneTree(child));
    }

    return clone;
  }

  /**
   * Calculate stats for a tree
   */
  private calculateTreeStats(tree: TreeNode): { files: number; lines: number } {
    let files = 0;
    let lines = 0;

    const traverse = (node: TreeNode) => {
      if (!node.isDir) {
        files++;
        lines += node.lines;
      }
      for (const child of node.children.values()) {
        traverse(child);
      }
    };

    traverse(tree);
    return { files, lines };
  }

  /**
   * Convert tree to flat node array for visualization
   */
  treeToNodes(tree: TreeNode): any[] {
    const nodes: any[] = [];

    const traverse = (node: TreeNode, depth: number) => {
      // Skip root node
      if (node.id !== 'root') {
        nodes.push({
          id: node.id,
          name: node.name,
          path: node.path,
          isDir: node.isDir,
          lines: node.lines,
          files: node.files,
          addedAt: node.addedAt?.toISOString(),
          modifiedAt: node.modifiedAt?.toISOString(),
          lastAuthor: node.lastAuthor,
          changeCount: node.changeCount,
          isNew: node.isNew,
          isModified: node.isModified,
          parent: node.parent || 'root',
          depth
        });
      }

      for (const child of node.children.values()) {
        traverse(child, depth + 1);
      }
    };

    traverse(tree, 0);
    return nodes;
  }

  /**
   * Check if a file is a source file
   */
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
      '.sql', '.graphql', '.proto', '.thrift',
      '.md', '.markdown'
    ];
    return sourceExtensions.some(ext => filePath.endsWith(ext));
  }

  /**
   * Get list of contributors
   */
  async getContributors(): Promise<string[]> {
    try {
      const { stdout } = await exec(
        'git log --format="%an" | sort -u',
        { cwd: this.workspaceRoot }
      );
      return stdout.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Get repository date range
   */
  async getDateRange(): Promise<{ start: Date; end: Date } | null> {
    try {
      const { stdout: firstCommit } = await exec(
        'git log --reverse --format="%aI" | head -1',
        { cwd: this.workspaceRoot }
      );
      const { stdout: lastCommit } = await exec(
        'git log -1 --format="%aI"',
        { cwd: this.workspaceRoot }
      );

      return {
        start: new Date(firstCommit.trim()),
        end: new Date(lastCommit.trim())
      };
    } catch {
      return null;
    }
  }
}
