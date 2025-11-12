import * as fs from 'fs';
import * as crypto from 'crypto';
import { ParserFactory } from './parsers/parser-factory';
import { LANGUAGE_EXTENSIONS } from './utils/parser-constants';
import { extractSymbolsWithRegex } from './utils/regex-fallback';

// Re-export types for backward compatibility
export type { ParsedSymbol, ImportDeclaration, CallSite, ParseResult } from './parsers/base-parser';
import type { ParseResult } from './parsers/base-parser';

/**
 * Main parser facade that delegates to language-specific parsers
 * Maintains backward compatibility with existing code
 */
export class CodeParser {
  constructor() {
    // No initialization needed - parsers are created on-demand by factory
  }

  getLanguage(filePath: string): string | undefined {
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (!ext) return undefined;

    const language = LANGUAGE_EXTENSIONS[ext];
    
    // Log for debugging .xaml.cs files
    if (filePath.includes('.xaml.cs')) {
      console.log(`[Radium Parser] .xaml.cs file detected: ${filePath}, extension: ${ext}, language: ${language}`);
    }

    return language;
  }

  async parseFile(filePath: string, content?: string): Promise<ParseResult | null> {
    const lang = this.getLanguage(filePath);
    if (!lang) {
      console.warn(`[Radium] No language detected for file: ${filePath}`);
      return null;
    }

    const code = content ?? await fs.promises.readFile(filePath, 'utf-8');
    const hash = crypto.createHash('sha256').update(code).digest('hex');

    // Get the appropriate language parser from factory
    const parser = ParserFactory.getParser(lang);
    if (!parser) {
      console.warn(`[Radium] No parser available for language: ${lang} (file: ${filePath})`);
      return null;
    }

    try {
      // Delegate to the language-specific parser
      const result = await parser.parse(filePath, code);
      
      // If parsing failed (returned null), try regex fallback
      if (result === null) {
        console.warn(`[Radium] Tree-sitter parse failed for ${filePath}, attempting fallback extraction`);
        try {
          const symbols = extractSymbolsWithRegex(code, filePath);
          return { symbols, imports: [], calls: [], hash };
        } catch (fallbackError) {
          console.warn(`[Radium] Fallback extraction also failed:`, fallbackError);
          return { symbols: [], imports: [], calls: [], hash };
        }
      }

      return result;
    } catch (error) {
      console.error(`[Radium] Unexpected error parsing file ${filePath}:`, error);
      return { symbols: [], imports: [], calls: [], hash };
    }
  }
}
