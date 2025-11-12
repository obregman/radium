/**
 * Shared constants for code parsing
 */

export const MAX_FILE_SIZE = 200000; // 200KB

export const LANGUAGE_EXTENSIONS: Record<string, string> = {
  'ts': 'typescript',
  'tsx': 'tsx',
  'js': 'javascript',
  'jsx': 'javascript',
  'py': 'python',
  'cs': 'csharp',
  'go': 'go'
};

export const LANGUAGE_NAMES = {
  TYPESCRIPT: 'typescript',
  TSX: 'tsx',
  JAVASCRIPT: 'javascript',
  PYTHON: 'python',
  CSHARP: 'csharp',
  GO: 'go'
} as const;

export type LanguageName = typeof LANGUAGE_NAMES[keyof typeof LANGUAGE_NAMES];

