import * as vscode from 'vscode';
import { GraphStore } from '../store/schema';
import * as cp from 'child_process';
import { promisify } from 'util';
import { Indexer } from '../indexer/indexer';

const exec = promisify(cp.exec);

export interface GitDiff {
  filePath: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  diff?: string;
}

export class GitDiffTracker {
  private store: GraphStore;
  private workspaceRoot: string;
  private indexer?: Indexer;
  private static outputChannel: vscode.OutputChannel;

  constructor(store: GraphStore, workspaceRoot: string, indexer?: Indexer) {
    this.store = store;
    this.workspaceRoot = workspaceRoot;
    this.indexer = indexer;
    
    // Initialize output channel if needed
    if (!GitDiffTracker.outputChannel) {
      GitDiffTracker.outputChannel = vscode.window.createOutputChannel('Radium Git');
    }
  }

  async getChangesVsRemote(): Promise<GitDiff[]> {
    try {
      // Get the remote tracking branch
      const { stdout: trackingBranch } = await exec('git rev-parse --abbrev-ref --symbolic-full-name @{u}', {
        cwd: this.workspaceRoot
      });
      
      const remoteBranch = trackingBranch.trim();
      if (!remoteBranch) {
        console.warn('[Radium Git] No remote tracking branch found');
        return this.getCurrentBranchChanges();
      }

      console.log(`[Radium Git] Comparing against remote: ${remoteBranch}`);

      // Get list of changed files compared to remote
      const { stdout: diffOutput } = await exec(`git diff --name-status ${remoteBranch}...HEAD`, {
        cwd: this.workspaceRoot
      });

      const changes: GitDiff[] = [];
      const lines = diffOutput.trim().split('\n').filter(l => l);
      
      console.log(`[Radium Git] Raw diff output lines: ${lines.length}`);

      for (const line of lines) {
        if (line.length < 2) continue;

        const parts = line.split('\t');
        const statusCode = parts[0].trim();
        const filePath = parts[1]?.trim();

        if (!filePath) continue;

        console.log(`[Radium Git] Processing: ${filePath}, isSource: ${this.isSourceFile(filePath)}`);

        // Skip if not a tracked source file
        if (!this.isSourceFile(filePath)) {
          console.log(`[Radium Git] Skipping non-source file: ${filePath}`);
          continue;
        }

        let status: GitDiff['status'] = 'modified';
        if (statusCode === 'A') status = 'added';
        else if (statusCode === 'D') status = 'deleted';
        else if (statusCode.startsWith('R')) status = 'renamed';

        // Get detailed diff stats for the file
        const stats = await this.getRemoteDiffStats(filePath, remoteBranch, status);

        changes.push({
          filePath,
          status,
          additions: stats.additions,
          deletions: stats.deletions
        });
      }

      return changes;
    } catch (error) {
      console.warn('[Radium Git] Failed to get changes vs remote, falling back to local changes:', error);
      return this.getCurrentBranchChanges();
    }
  }

  async getCurrentBranchChanges(): Promise<GitDiff[]> {
    try {
      // Get list of changed files
      const { stdout: statusOutput } = await exec('git status --porcelain', {
        cwd: this.workspaceRoot
      });

      const changes: GitDiff[] = [];
      const lines = statusOutput.split('\n').filter(l => l.trim());

      for (const line of lines) {
        if (line.length < 4) continue;

        const statusCode = line.substring(0, 2).trim();
        let filePath = line.substring(3).trim();
        
        // Normalize path to use forward slashes
        filePath = filePath.replace(/\\/g, '/');
        
        console.log(`[Radium Git] Found changed file: "${filePath}" (status: ${statusCode})`);

        // Skip if not a tracked source file
        if (!this.isSourceFile(filePath)) {
          console.log(`[Radium Git] Skipping non-source file: ${filePath}`);
          continue;
        }

        let status: GitDiff['status'] = 'modified';
        if (statusCode === 'A' || statusCode === '??') status = 'added';
        else if (statusCode === 'D') status = 'deleted';
        else if (statusCode === 'R') status = 'renamed';

        // Get detailed diff stats and actual diff content
        const stats = await this.getDiffStats(filePath, status);
        const diffContent = await this.getActualDiff(filePath, status);

        changes.push({
          filePath,
          status,
          additions: stats.additions,
          deletions: stats.deletions,
          diff: diffContent
        });
      }
      
      console.log(`[Radium Git] Total changes found: ${changes.length}`, changes.map(c => c.filePath));

      return changes;
    } catch (error) {
      console.error('Failed to get git changes:', error);
      return [];
    }
  }

  private async getRemoteDiffStats(filePath: string, remoteBranch: string, status: string): Promise<{ additions: number; deletions: number }> {
    try {
      if (status === 'added') {
        // For new files, count lines in current version
        const { stdout } = await exec(`git diff --numstat ${remoteBranch}...HEAD -- "${filePath}"`, {
          cwd: this.workspaceRoot
        });
        
        if (!stdout) return { additions: 0, deletions: 0 };
        
        const [additions, deletions] = stdout.trim().split(/\s+/).map(n => parseInt(n) || 0);
        return { additions, deletions };
      }

      if (status === 'deleted') {
        return { additions: 0, deletions: 0 };
      }

      // Get diff stats compared to remote
      const { stdout } = await exec(`git diff --numstat ${remoteBranch}...HEAD -- "${filePath}"`, {
        cwd: this.workspaceRoot
      });

      if (!stdout) return { additions: 0, deletions: 0 };

      const [additions, deletions] = stdout.trim().split(/\s+/).map(n => parseInt(n) || 0);
      return { additions, deletions };
    } catch {
      return { additions: 0, deletions: 0 };
    }
  }

  private async getDiffStats(filePath: string, status: string): Promise<{ additions: number; deletions: number }> {
    try {
      if (status === 'added') {
        // For new files, count all lines as additions
        const { stdout } = await exec(`git diff --cached --numstat -- "${filePath}"`, {
          cwd: this.workspaceRoot
        });
        
        if (!stdout) {
          // Untracked file
          const { stdout: wcOutput } = await exec(`wc -l "${filePath}"`, {
            cwd: this.workspaceRoot
          });
          const lines = parseInt(wcOutput.trim().split(/\s+/)[0]) || 0;
          return { additions: lines, deletions: 0 };
        }
      }

      if (status === 'deleted') {
        return { additions: 0, deletions: 0 };
      }

      // Get diff stats
      const { stdout } = await exec(`git diff --numstat HEAD -- "${filePath}"`, {
        cwd: this.workspaceRoot
      });

      if (!stdout) return { additions: 0, deletions: 0 };

      const [additions, deletions] = stdout.trim().split(/\s+/).map(n => parseInt(n) || 0);
      return { additions, deletions };
    } catch {
      return { additions: 0, deletions: 0 };
    }
  }

  private async getActualDiff(filePath: string, status: string): Promise<string> {
    try {
      if (status === 'deleted') {
        return 'File deleted';
      }

      if (status === 'added') {
        // For new files, show the entire file content as a diff
        try {
          const { stdout } = await exec(`git diff --cached -- "${filePath}"`, {
            cwd: this.workspaceRoot
          });
          if (stdout) {
            return stdout;
          }
          // If not staged, show the file content directly
          const fs = require('fs');
          const path = require('path');
          const fullPath = path.join(this.workspaceRoot, filePath);
          if (fs.existsSync(fullPath)) {
            const content = fs.readFileSync(fullPath, 'utf8');
            // Format as a diff-like output
            const lines = content.split('\n');
            let diffOutput = `+++ ${filePath}\n`;
            lines.forEach((line: string) => {
              diffOutput += `+${line}\n`;
            });
            return diffOutput;
          }
        } catch (error) {
          console.error(`Failed to get content for new file ${filePath}:`, error);
        }
      }

      // Get the actual diff with context
      const { stdout } = await exec(`git diff HEAD -- "${filePath}"`, {
        cwd: this.workspaceRoot
      });

      if (!stdout) {
        // Try unstaged changes
        const { stdout: unstagedDiff } = await exec(`git diff -- "${filePath}"`, {
          cwd: this.workspaceRoot
        });
        return unstagedDiff || 'No changes';
      }

      return stdout;
    } catch (error) {
      console.error(`Failed to get diff for ${filePath}:`, error);
      return 'Error getting diff';
    }
  }

  private isSourceFile(filePath: string): boolean {
    const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.cs', '.swift', '.kt', '.rb', '.php'];
    return sourceExtensions.some(ext => filePath.endsWith(ext));
  }

  async createSessionFromGitChanges(): Promise<number | null> {
    const changes = await this.getCurrentBranchChanges();
    
    if (changes.length === 0) {
      return null;
    }

    // Index new files before creating session
    if (this.indexer) {
      const newFiles = changes.filter(c => c.status === 'added').map(c => c.filePath);
      if (newFiles.length > 0) {
        console.log(`[Radium Git] Found ${newFiles.length} new files to index:`, newFiles);
        await this.indexer.indexFiles(newFiles);
        console.log(`[Radium Git] Finished indexing new files`);
        
        // Verify files were indexed
        for (const filePath of newFiles) {
          const file = this.store.getFileByPath(filePath);
          console.log(`[Radium Git] After indexing, file "${filePath}" in store:`, file ? 'YES' : 'NO');
        }
      }
    } else {
      console.warn('[Radium Git] No indexer available - new files will not be indexed');
    }

    // Get current branch name
    let branchName = 'unknown';
    try {
      const { stdout } = await exec('git rev-parse --abbrev-ref HEAD', {
        cwd: this.workspaceRoot
      });
      branchName = stdout.trim();
    } catch {
      // Ignore
    }

    // Create session
    const sessionId = this.store.createSession({
      actor: 'user',
      actor_version: branchName,
      origin: 'git-diff',
      started_at: Date.now()
    });

    // Record changes
    let recordedCount = 0;
    for (const change of changes) {
      const file = this.store.getFileByPath(change.filePath);
      console.log(`[Radium Git] Looking for "${change.filePath}" - found:`, file ? 'YES' : 'NO');
      
      if (!file) {
        console.warn(`[Radium Git] File "${change.filePath}" not in index, skipping`);
        continue;
      }

      this.store.insertChange({
        session_id: sessionId,
        file_id: file.id!,
        hunks_json: JSON.stringify({
          filePath: change.filePath,
          beforeHash: '',
          afterHash: '',
          diff: change.diff || '',
          hunks: [{
            start: 0,
            end: change.additions + change.deletions,
            type: 'modify',
            text: `+${change.additions} -${change.deletions}`
          }]
        }),
        summary: `${change.status}: +${change.additions} -${change.deletions}`,
        ts: Date.now()
      });
      recordedCount++;
    }

    console.log(`[Radium Git] Recorded ${recordedCount}/${changes.length} changes`);

    this.store.endSession(sessionId, Date.now());
    this.store.save();

    return sessionId;
  }

  async createSessionFromRemoteChanges(): Promise<number | null> {
    let changes;
    try {
      changes = await this.getChangesVsRemote();
      
      console.log('[Radium Git] Found', changes.length, 'changes vs remote:', changes.map(c => c.filePath));
      
      if (changes.length === 0) {
        console.log('[Radium Git] No changes found vs remote');
        return null;
      }
    } catch (error) {
      console.error('[Radium Git] Error getting changes vs remote:', error);
      return null;
    }

    // Index new files before creating session
    if (this.indexer) {
      const newFiles = changes.filter(c => c.status === 'added').map(c => c.filePath);
      if (newFiles.length > 0) {
        console.log(`[Radium Git] Indexing ${newFiles.length} new files:`, newFiles);
        await this.indexer.indexFiles(newFiles);
      }
    }

    // Get current branch name
    let branchName = 'unknown';
    try {
      const { stdout } = await exec('git rev-parse --abbrev-ref HEAD', {
        cwd: this.workspaceRoot
      });
      branchName = stdout.trim();
    } catch {
      // Ignore
    }

    // Create session
    const sessionId = this.store.createSession({
      actor: 'user',
      actor_version: branchName,
      origin: 'git-remote-diff',
      started_at: Date.now()
    });

    const allFiles = this.store.getAllFiles();
    console.log('[Radium Git] All indexed files:', allFiles.map(f => f.path));

    // Record changes
    let recordedCount = 0;
    for (const change of changes) {
      const file = this.store.getFileByPath(change.filePath);
      console.log(`[Radium Git] Looking for "${change.filePath}" - found:`, file ? 'YES' : 'NO');
      
      if (!file) {
        console.warn(`[Radium Git] File "${change.filePath}" not in index, skipping`);
        continue;
      }

      this.store.insertChange({
        session_id: sessionId,
        file_id: file.id!,
        hunks_json: JSON.stringify({
          filePath: change.filePath,
          beforeHash: '',
          afterHash: '',
          diff: change.diff || '',
          hunks: [{
            start: 0,
            end: change.additions + change.deletions,
            type: 'modify',
            text: `+${change.additions} -${change.deletions}`
          }]
        }),
        summary: `${change.status}: +${change.additions} -${change.deletions}`,
        ts: Date.now()
      });
      recordedCount++;
    }

    console.log(`[Radium Git] Recorded ${recordedCount}/${changes.length} changes`);

    this.store.endSession(sessionId, Date.now());
    this.store.save();

    return sessionId;
  }

  async getChangedFiles(): Promise<string[]> {
    const changes = await this.getCurrentBranchChanges();
    return changes.map(c => c.filePath);
  }
}

