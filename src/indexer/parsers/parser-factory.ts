import { BaseParser } from './base-parser';
import { LANGUAGE_NAMES } from '../utils/parser-constants';

/**
 * Factory for creating language-specific parsers
 * Creates fresh parser instances to avoid state corruption issues
 *
 * Parser imports are lazy to prevent native module load failures
 * (e.g. incompatible .node binaries) from crashing the entire extension.
 */
export class ParserFactory {
  private static unavailableLanguages = new Set<string>();

  /**
   * Get a fresh parser for the specified language
   * Creates a new parser instance each time to avoid tree-sitter state issues
   */
  static getParser(language: string): BaseParser | null {
    if (this.unavailableLanguages.has(language)) {
      return null;
    }

    try {
      switch (language) {
        case LANGUAGE_NAMES.TSX: {
          const { TypeScriptParser } = require('./typescript-parser');
          return new TypeScriptParser('tsx');
        }

        case LANGUAGE_NAMES.TYPESCRIPT:
        case LANGUAGE_NAMES.JAVASCRIPT: {
          const { TypeScriptParser } = require('./typescript-parser');
          return new TypeScriptParser(language);
        }

        case LANGUAGE_NAMES.PYTHON: {
          const { PythonParser } = require('./python-parser');
          return new PythonParser();
        }

        case LANGUAGE_NAMES.CSHARP: {
          const { CSharpParser } = require('./csharp-parser');
          return new CSharpParser();
        }

        case LANGUAGE_NAMES.GO: {
          const { GoParser } = require('./go-parser');
          return new GoParser();
        }

        case LANGUAGE_NAMES.KOTLIN: {
          const { KotlinParser } = require('./kotlin-parser');
          return new KotlinParser();
        }

        default:
          console.warn(`[Radium] No parser available for language: ${language}`);
          return null;
      }
    } catch (error) {
      console.warn(`[Radium] Failed to load parser for ${language}, disabling:`, error);
      this.unavailableLanguages.add(language);
      return null;
    }
  }

  /**
   * Clear all cached parsers (useful for testing)
   * No-op since we no longer cache parsers
   */
  static clearCache(): void {
    // No-op: parsers are no longer cached
  }
}

