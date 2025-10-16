import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { GraphStore, Session, Change } from '../store/schema';
import diff = require('fast-diff');

export interface LLMPlan {
  intent: 'add feature' | 'refactor' | 'fix bug' | 'other';
  rationale: string;
  edits: FileEdit[];
  tests?: string[];
  risk?: 'low' | 'medium' | 'high';
}

export interface FileEdit {
  path: string;
  operations: EditOperation[];
}

export interface EditOperation {
  type: 'replace' | 'insert' | 'delete';
  range?: { start: [number, number]; end: [number, number] };
  text: string;
}

export interface Hunk {
  start: number;
  end: number;
  type: 'insert' | 'delete' | 'modify';
  text: string;
}

export interface HunkData {
  filePath: string;
  beforeHash: string;
  afterHash: string;
  hunks: Hunk[];
}

export interface PreviewResult {
  sessionId: number;
  changes: Map<string, { before: string; after: string; hunks: HunkData }>;
  issues: string[];
}

export class LLMOrchestrator {
  private store: GraphStore;
  private workspaceRoot: string;

  constructor(store: GraphStore, workspaceRoot: string) {
    this.store = store;
    this.workspaceRoot = workspaceRoot;
  }

  async previewPlan(plan: LLMPlan): Promise<PreviewResult> {
    const sessionId = this.store.createSession({
      actor: 'LLM',
      actor_version: plan.rationale,
      origin: 'preview',
      started_at: Date.now()
    });

    const changes = new Map<string, { before: string; after: string; hunks: HunkData }>();
    const issues: string[] = [];

    for (const fileEdit of plan.edits) {
      try {
        const filePath = path.join(this.workspaceRoot, fileEdit.path);
        const uri = vscode.Uri.file(filePath);

        // Read current content
        let before = '';
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          before = doc.getText();
        } catch {
          // File doesn't exist, start with empty
          before = '';
        }

        // Apply operations
        const after = this.applyOperations(before, fileEdit.operations);

        // Generate hunks
        const hunks = this.generateHunks(before, after);
        const beforeHash = crypto.createHash('sha256').update(before).digest('hex');
        const afterHash = crypto.createHash('sha256').update(after).digest('hex');

        changes.set(fileEdit.path, {
          before,
          after,
          hunks: {
            filePath: fileEdit.path,
            beforeHash,
            afterHash,
            hunks
          }
        });
      } catch (error) {
        issues.push(`Failed to preview ${fileEdit.path}: ${error}`);
      }
    }

    return { sessionId, changes, issues };
  }

  async applyPlan(preview: PreviewResult, plan: LLMPlan): Promise<void> {
    const edit = new vscode.WorkspaceEdit();

    // Apply all changes
    for (const [relativePath, change] of preview.changes) {
      const filePath = path.join(this.workspaceRoot, relativePath);
      const uri = vscode.Uri.file(filePath);

      // Create full file edit
      let doc: vscode.TextDocument | null = null;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        doc = null;
      }
      
      if (doc) {
        // Replace entire document
        const fullRange = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length)
        );
        edit.replace(uri, fullRange, change.after);
      } else {
        // Create new file
        edit.createFile(uri, { ignoreIfExists: true });
        edit.insert(uri, new vscode.Position(0, 0), change.after);
      }
    }

    // Apply workspace edit
    const success = await vscode.workspace.applyEdit(edit);

    if (!success) {
      throw new Error('Failed to apply workspace edits');
    }

    // Record changes in store
    this.store.beginTransaction();
    try {
      // Update session
      this.store.endSession(preview.sessionId, Date.now());

      // Record each change
      for (const [relativePath, changeData] of preview.changes) {
        const fileRecord = this.store.getFileByPath(relativePath);
        if (!fileRecord) continue;

        this.store.insertChange({
          session_id: preview.sessionId,
          file_id: fileRecord.id!,
          hunks_json: JSON.stringify(changeData.hunks),
          summary: plan.rationale,
          ts: Date.now()
        });
      }

      this.store.commit();
    } catch (error) {
      this.store.rollback();
      throw error;
    }

    // Save all documents
    await vscode.workspace.saveAll();
  }

  async undoSession(sessionId: number): Promise<void> {
    const changes = this.store.getChangesBySession(sessionId);
    const edit = new vscode.WorkspaceEdit();

    for (const change of changes) {
      try {
        const hunksData: HunkData = JSON.parse(change.hunks_json);
        const filePath = path.join(this.workspaceRoot, hunksData.filePath);
        const uri = vscode.Uri.file(filePath);

        // Reconstruct before state
        const doc = await vscode.workspace.openTextDocument(uri);
        const currentText = doc.getText();

        // Simple approach: revert to before hash if available
        // In production, would need more sophisticated merging
        const fullRange = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(currentText.length)
        );

        // For now, just record that we attempted rollback
        // Full implementation would reconstruct from hunks
        console.warn(`Rollback for ${hunksData.filePath} - requires manual implementation`);
      } catch (error) {
        console.error(`Failed to undo change for session ${sessionId}:`, error);
      }
    }

    const success = await vscode.workspace.applyEdit(edit);
    if (!success) {
      throw new Error('Failed to undo session');
    }

    await vscode.workspace.saveAll();
  }

  private applyOperations(content: string, operations: EditOperation[]): string {
    const lines = content.split('\n');

    // Sort operations by position (reverse order to handle indices correctly)
    const sorted = [...operations].sort((a, b) => {
      if (!a.range || !b.range) return 0;
      if (a.range.start[0] !== b.range.start[0]) {
        return b.range.start[0] - a.range.start[0];
      }
      return b.range.start[1] - a.range.start[1];
    });

    for (const op of sorted) {
      if (op.type === 'replace' && op.range) {
        const startLine = op.range.start[0];
        const startCol = op.range.start[1];
        const endLine = op.range.end[0];
        const endCol = op.range.end[1];

        const before = lines.slice(0, startLine);
        const after = lines.slice(endLine + 1);
        const replacementLines = op.text.split('\n');

        // Handle partial line replacements
        if (startLine === endLine) {
          const line = lines[startLine] || '';
          const newLine = line.slice(0, startCol) + op.text + line.slice(endCol);
          lines[startLine] = newLine;
        } else {
          const firstPart = (lines[startLine] || '').slice(0, startCol);
          const lastPart = (lines[endLine] || '').slice(endCol);
          
          replacementLines[0] = firstPart + replacementLines[0];
          replacementLines[replacementLines.length - 1] += lastPart;

          lines.splice(startLine, endLine - startLine + 1, ...replacementLines);
        }
      } else if (op.type === 'insert' && op.range) {
        const startLine = op.range.start[0];
        const startCol = op.range.start[1];
        const insertLines = op.text.split('\n');

        if (insertLines.length === 1) {
          const line = lines[startLine] || '';
          lines[startLine] = line.slice(0, startCol) + op.text + line.slice(startCol);
        } else {
          const line = lines[startLine] || '';
          const before = line.slice(0, startCol);
          const after = line.slice(startCol);

          insertLines[0] = before + insertLines[0];
          insertLines[insertLines.length - 1] += after;

          lines.splice(startLine, 1, ...insertLines);
        }
      } else if (op.type === 'delete' && op.range) {
        const startLine = op.range.start[0];
        const startCol = op.range.start[1];
        const endLine = op.range.end[0];
        const endCol = op.range.end[1];

        if (startLine === endLine) {
          const line = lines[startLine] || '';
          lines[startLine] = line.slice(0, startCol) + line.slice(endCol);
        } else {
          const firstPart = (lines[startLine] || '').slice(0, startCol);
          const lastPart = (lines[endLine] || '').slice(endCol);
          lines.splice(startLine, endLine - startLine + 1, firstPart + lastPart);
        }
      }
    }

    return lines.join('\n');
  }

  private generateHunks(before: string, after: string): Hunk[] {
    const diffs = diff(before, after);
    const hunks: Hunk[] = [];
    let position = 0;

    for (const [type, text] of diffs) {
      if (type === diff.INSERT) {
        hunks.push({
          start: position,
          end: position,
          type: 'insert',
          text
        });
      } else if (type === diff.DELETE) {
        hunks.push({
          start: position,
          end: position + text.length,
          type: 'delete',
          text
        });
        position += text.length;
      } else {
        // EQUAL - skip but advance position
        position += text.length;
      }
    }

    // Merge adjacent hunks of the same type
    const merged: Hunk[] = [];
    for (const hunk of hunks) {
      const last = merged[merged.length - 1];
      if (last && last.type === hunk.type && last.end === hunk.start) {
        last.end = hunk.end;
        last.text += hunk.text;
      } else {
        merged.push(hunk);
      }
    }

    return merged;
  }
}

