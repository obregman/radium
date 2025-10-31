import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';

export class RadiumIgnore {
  private patterns: string[] = [];
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.load();
  }

  /**
   * Load radiumignore file from .radium directory
   */
  private load(): void {
    const ignorePath = path.join(this.workspaceRoot, '.radium', 'radiumignore');
    
    if (!fs.existsSync(ignorePath)) {
      console.log('[Radium Ignore] No radiumignore file found');
      return;
    }

    try {
      const content = fs.readFileSync(ignorePath, 'utf8');
      this.patterns = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#')); // Remove empty lines and comments

      console.log(`[Radium Ignore] Loaded ${this.patterns.length} patterns:`, this.patterns);
    } catch (error) {
      console.error('[Radium Ignore] Failed to load radiumignore:', error);
    }
  }

  /**
   * Reload the ignore patterns from disk
   */
  reload(): void {
    this.patterns = [];
    this.load();
  }

  /**
   * Check if a file path should be ignored
   * @param filePath - Relative path from workspace root
   */
  shouldIgnore(filePath: string): boolean {
    if (this.patterns.length === 0) {
      return false;
    }

    // Normalize path to use forward slashes
    const normalizedPath = filePath.replace(/\\/g, '/');

    for (const pattern of this.patterns) {
      // Handle directory patterns (ending with /)
      if (pattern.endsWith('/')) {
        const dirPattern = pattern.slice(0, -1);
        // Check if path starts with directory or is inside it
        if (normalizedPath.startsWith(dirPattern + '/') || normalizedPath === dirPattern) {
          console.log(`[Radium Ignore] Ignoring ${filePath} (matches directory pattern: ${pattern})`);
          return true;
        }
      }
      // Handle glob patterns (with wildcards)
      else if (pattern.includes('*')) {
        // Use minimatch for glob pattern matching
        // Add ** prefix if pattern doesn't start with it (to match anywhere in tree)
        const globPattern = pattern.startsWith('**/') ? pattern : `**/${pattern}`;
        if (minimatch(normalizedPath, globPattern)) {
          console.log(`[Radium Ignore] Ignoring ${filePath} (matches glob pattern: ${pattern})`);
          return true;
        }
      }
      // Handle exact file matches
      else {
        if (normalizedPath === pattern || normalizedPath.endsWith('/' + pattern)) {
          console.log(`[Radium Ignore] Ignoring ${filePath} (matches exact pattern: ${pattern})`);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get all loaded patterns
   */
  getPatterns(): string[] {
    return [...this.patterns];
  }

  /**
   * Check if any patterns are loaded
   */
  hasPatterns(): boolean {
    return this.patterns.length > 0;
  }
}

