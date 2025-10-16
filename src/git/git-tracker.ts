import * as vscode from 'vscode';
import { GraphStore } from '../store/schema';

export class GitTracker {
  private store: GraphStore;
  private gitExtension: any;

  constructor(store: GraphStore) {
    this.store = store;
    this.initGitExtension();
  }

  private initGitExtension() {
    const extension = vscode.extensions.getExtension('vscode.git');
    if (extension) {
      if (!extension.isActive) {
        extension.activate().then(api => {
          this.gitExtension = api.getAPI(1);
          this.setupWatchers();
        });
      } else {
        this.gitExtension = extension.exports.getAPI(1);
        this.setupWatchers();
      }
    }
  }

  private setupWatchers() {
    if (!this.gitExtension) return;

    const repository = this.gitExtension.repositories[0];
    if (!repository) return;

    // Watch for state changes
    repository.state.onDidChange(() => {
      this.onRepositoryChange(repository);
    });
  }

  private async onRepositoryChange(repository: any) {
    // Track commits with session metadata
    const head = repository.state.HEAD;
    if (!head?.commit) return;

    console.log('Git state changed:', head.commit);
  }

  async tagCommitWithSession(sessionId: number, message: string): Promise<void> {
    if (!this.gitExtension) {
      console.warn('Git extension not available');
      return;
    }

    const repository = this.gitExtension.repositories[0];
    if (!repository) return;

    try {
      // Get session details
      const session = this.store.getSession(sessionId);
      if (!session) return;

      // Commit with metadata
      const commitMessage = `${message}\n\n[Radium Session: ${sessionId}]`;
      await repository.commit(commitMessage);
    } catch (error) {
      console.error('Failed to commit with session tag:', error);
    }
  }

  async getCommitHistory(filePath: string, limit: number = 10): Promise<any[]> {
    if (!this.gitExtension) return [];

    const repository = this.gitExtension.repositories[0];
    if (!repository) return [];

    try {
      // Get file history using git log
      const commits = await repository.log({ path: filePath, maxEntries: limit });
      return commits || [];
    } catch (error) {
      console.error('Failed to get commit history:', error);
      return [];
    }
  }

  async createSessionBranch(sessionId: number, baseName: string): Promise<string | undefined> {
    if (!this.gitExtension) return undefined;

    const repository = this.gitExtension.repositories[0];
    if (!repository) return undefined;

    try {
      const branchName = `radium/session-${sessionId}-${baseName}`;
      await repository.createBranch(branchName, true);
      return branchName;
    } catch (error) {
      console.error('Failed to create session branch:', error);
      return undefined;
    }
  }
}

