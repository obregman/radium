import * as vscode from 'vscode';
import { GraphStore, Session } from '../store/schema';

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private store: GraphStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SessionTreeItem): Thenable<SessionTreeItem[]> {
    if (!element) {
      // Root level - show recent sessions
      const sessions = this.store.getRecentSessions(20);
      return Promise.resolve(sessions.map(s => new SessionTreeItem(s, this.store)));
    } else {
      // Show changes for this session
      return Promise.resolve(element.getChildren());
    }
  }
}

class SessionTreeItem extends vscode.TreeItem {
  constructor(
    public readonly session: Session,
    private store: GraphStore
  ) {
    super(
      SessionTreeItem.formatLabel(session),
      vscode.TreeItemCollapsibleState.Collapsed
    );

    this.tooltip = this.getTooltip();
    this.contextValue = 'session';
    this.iconPath = new vscode.ThemeIcon(
      session.actor === 'LLM' ? 'robot' : 'person'
    );
  }

  private static formatLabel(session: Session): string {
    const date = new Date(session.started_at);
    const time = date.toLocaleTimeString();
    return `${session.actor} - ${time}`;
  }

  private getTooltip(): string {
    const start = new Date(this.session.started_at).toLocaleString();
    const end = this.session.ended_at 
      ? new Date(this.session.ended_at).toLocaleString()
      : 'In progress';
    return `Actor: ${this.session.actor}\nStarted: ${start}\nEnded: ${end}\nOrigin: ${this.session.origin}`;
  }

  getChildren(): SessionTreeItem[] {
    // Return changes as child items
    const changes = this.store.getChangesBySession(this.session.id!);
    return changes.map(change => {
      const file = this.store.getFileByPath(change.file_id.toString());
      const item = new vscode.TreeItem(
        file?.path || `File ${change.file_id}`,
        vscode.TreeItemCollapsibleState.None
      );
      item.iconPath = new vscode.ThemeIcon('file');
      item.tooltip = change.summary || 'No summary';
      item.command = {
        command: 'radium.showChange',
        title: 'Show Change',
        arguments: [change]
      };
      return item as any;
    });
  }
}

export class CodeSlicesTreeProvider implements vscode.TreeDataProvider<CodeSliceItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<CodeSliceItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private store: GraphStore, private workspaceRoot: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CodeSliceItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CodeSliceItem): Thenable<CodeSliceItem[]> {
    if (!element) {
      // Root level - group by file
      const files = this.store.getAllFiles();
      return Promise.resolve(
        files.map(f => new CodeSliceItem(f.path, 'file', this.store, this.workspaceRoot))
      );
    } else if (element.type === 'file') {
      // Show symbols in file
      const nodes = this.store.getNodesByPath(element.label as string);
      return Promise.resolve(
        nodes
          .filter(n => !n.fqname.includes('.')) // Top-level only
          .map(n => new CodeSliceItem(n.name, 'symbol', this.store, this.workspaceRoot, n))
      );
    }
    return Promise.resolve([]);
  }
}

class CodeSliceItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly type: 'file' | 'symbol',
    private store: GraphStore,
    private workspaceRoot: string,
    private node?: any
  ) {
    super(
      label,
      type === 'file' 
        ? vscode.TreeItemCollapsibleState.Collapsed 
        : vscode.TreeItemCollapsibleState.None
    );

    if (type === 'file') {
      this.iconPath = new vscode.ThemeIcon('file');
      this.resourceUri = vscode.Uri.file(`${this.workspaceRoot}/${label}`);
      this.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [this.resourceUri]
      };
    } else {
      this.iconPath = new vscode.ThemeIcon(this.getSymbolIcon());
      if (this.node) {
        this.tooltip = `${this.node.kind}: ${this.node.fqname}`;
        this.description = this.node.kind;
      }
    }
  }

  private getSymbolIcon(): string {
    if (!this.node) return 'symbol-misc';
    
    const iconMap: Record<string, string> = {
      'function': 'symbol-function',
      'class': 'symbol-class',
      'interface': 'symbol-interface',
      'type': 'symbol-interface',
      'variable': 'symbol-variable',
      'constant': 'symbol-constant'
    };

    return iconMap[this.node.kind] || 'symbol-misc';
  }
}

export class IssuesTreeProvider implements vscode.TreeDataProvider<IssueTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<IssueTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private store: GraphStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: IssueTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(_element?: IssueTreeItem): Thenable<IssueTreeItem[]> {
    const issues = this.store.getIssues();
    return Promise.resolve(issues.map(i => new IssueTreeItem(i)));
  }
}

class IssueTreeItem extends vscode.TreeItem {
  constructor(private issue: any) {
    super(issue.message, vscode.TreeItemCollapsibleState.None);

    this.tooltip = `${issue.kind}: ${issue.message}`;
    this.iconPath = new vscode.ThemeIcon(
      issue.severity === 'error' ? 'error' : 
      issue.severity === 'warning' ? 'warning' : 'info'
    );
  }
}

