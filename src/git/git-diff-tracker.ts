import * as vscode from 'vscode';
import { GraphStore } from '../store/schema';
import * as cp from 'child_process';
import { promisify } from 'util';

const exec = promisify(cp.exec);

export interface GitDiff {
  filePath: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export class GitDiffTracker {
  private store: GraphStore;
  private workspaceRoot: string;

  constructor(store: GraphStore, workspaceRoot: string) {
    this.store = store;
    this.workspaceRoot = workspaceRoot;
  }

  async getCurrentBranchChanges(): Promise<GitDiff[]> {
    try {
      // Get list of changed files
      const { stdout: statusOutput } = await exec('git status --porcelain', {
        cwd: this.workspaceRoot
      });

      const changes: GitDiff[] = [];
      const lines = statusOutput.trim().split('\n').filter(l => l);

      for (const line of lines) {
        if (line.length < 4) continue;

        const statusCode = line.substring(0, 2).trim();
        const filePath = line.substring(3).trim();

        // Skip if not a tracked source file
        if (!this.isSourceFile(filePath)) continue;

        let status: GitDiff['status'] = 'modified';
        if (statusCode === 'A' || statusCode === '??') status = 'added';
        else if (statusCode === 'D') status = 'deleted';
        else if (statusCode === 'R') status = 'renamed';

        // Get detailed diff stats for the file
        const stats = await this.getDiffStats(filePath, status);

        changes.push({
          filePath,
          status,
          additions: stats.additions,
          deletions: stats.deletions
        });
      }

      return changes;
    } catch (error) {
      console.error('Failed to get git changes:', error);
      return [];
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

  private isSourceFile(filePath: string): boolean {
    const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs'];
    return sourceExtensions.some(ext => filePath.endsWith(ext));
  }

  async createSessionFromGitChanges(): Promise<number | null> {
    const changes = await this.getCurrentBranchChanges();
    
    console.log('[Radium Git] Found', changes.length, 'git changes:', changes.map(c => c.filePath));
    
    if (changes.length === 0) {
      return null;
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

