import Parser from 'tree-sitter';
import { ParseResult, ParsedSymbol } from '../indexer/parsers/base-parser';

/**
 * Code smell metrics for a single file
 */
export interface CodeSmellMetrics {
  score: number;
  lineCount: number;
  functionCount: number;
  avgFunctionLength: number;
  maxFunctionLength: number;
  maxNestingDepth: number;
  importCount: number;
}

/**
 * Thresholds for code smell scoring
 * Each metric has a min (no penalty) and max (full penalty) threshold
 */
interface MetricThresholds {
  min: number;
  max: number;
  weight: number;
}

const THRESHOLDS: Record<string, MetricThresholds> = {
  lineCount: { min: 300, max: 1000, weight: 0.20 },
  functionCount: { min: 10, max: 30, weight: 0.15 },
  avgFunctionLength: { min: 30, max: 100, weight: 0.20 },
  maxFunctionLength: { min: 50, max: 200, weight: 0.15 },
  maxNestingDepth: { min: 4, max: 8, weight: 0.15 },
  importCount: { min: 10, max: 30, weight: 0.15 }
};

/**
 * Analyzes code for various code smell indicators
 */
export class CodeSmellAnalyzer {
  /**
   * Analyze a file and compute code smell metrics
   * Works with data from the parser result plus raw code
   */
  analyze(code: string, parseResult: ParseResult, tree?: Parser.Tree): CodeSmellMetrics {
    const lines = code.split('\n');
    const lineCount = lines.length;
    
    // Extract function-related symbols
    const allFunctionSymbols = parseResult.symbols.filter(s => 
      s.kind === 'function' || s.kind === 'method' || s.kind === 'constructor'
    );
    
    // Filter out special cases that shouldn't be counted as functions for code smell metrics
    const filteredSymbols = this.filterNonFunctionSymbols(allFunctionSymbols, code);
    
    // Filter out nested functions (functions whose range is contained within another function's range)
    const functionSymbols = this.filterNestedFunctions(filteredSymbols);
    const functionCount = functionSymbols.length;
    
    // Calculate function lengths
    const functionLengths = functionSymbols.map(s => {
      const startLine = this.getLineNumber(code, s.range.start);
      const endLine = this.getLineNumber(code, s.range.end);
      return endLine - startLine + 1;
    });
    
    const avgFunctionLength = functionLengths.length > 0 
      ? functionLengths.reduce((a, b) => a + b, 0) / functionLengths.length 
      : 0;
    
    const maxFunctionLength = functionLengths.length > 0 
      ? Math.max(...functionLengths) 
      : 0;
    
    // Calculate max nesting depth from AST if available, otherwise estimate from code
    const maxNestingDepth = tree 
      ? this.calculateNestingDepthFromTree(tree.rootNode)
      : this.estimateNestingDepthFromCode(code);
    
    // Count imports
    const importCount = parseResult.imports.length;
    
    // Calculate composite score
    const score = this.calculateScore({
      lineCount,
      functionCount,
      avgFunctionLength,
      maxFunctionLength,
      maxNestingDepth,
      importCount
    });
    
    return {
      score,
      lineCount,
      functionCount,
      avgFunctionLength,
      maxFunctionLength,
      maxNestingDepth,
      importCount
    };
  }

  /**
   * Calculate composite smell score (0-100)
   */
  private calculateScore(metrics: Omit<CodeSmellMetrics, 'score'>): number {
    let totalScore = 0;
    
    for (const [key, thresholds] of Object.entries(THRESHOLDS)) {
      const value = metrics[key as keyof typeof metrics];
      const metricScore = this.calculateMetricScore(value, thresholds);
      totalScore += metricScore * thresholds.weight;
    }
    
    // Convert to 0-100 scale
    return Math.round(totalScore * 100);
  }

  /**
   * Calculate score for a single metric (0-1)
   */
  private calculateMetricScore(value: number, thresholds: MetricThresholds): number {
    if (value <= thresholds.min) {
      return 0;
    }
    if (value >= thresholds.max) {
      return 1;
    }
    // Linear interpolation between min and max
    return (value - thresholds.min) / (thresholds.max - thresholds.min);
  }

  /**
   * Get line number for a character position
   */
  private getLineNumber(code: string, charIndex: number): number {
    const substring = code.substring(0, charIndex);
    return substring.split('\n').length;
  }

  /**
   * Filter out symbols that shouldn't be counted as functions for code smell metrics
   * - Indexers (C# properties named 'this')
   * - TypeScript/JavaScript getters and setters
   * - Other special cases
   */
  private filterNonFunctionSymbols(functionSymbols: ParsedSymbol[], code: string): ParsedSymbol[] {
    return functionSymbols.filter(s => {
      // Exclude C# indexers (they're named 'this' and are properties, not functions)
      if (s.name === 'this' && s.kind === 'function') {
        return false;
      }
      
      // Exclude TypeScript/JavaScript getters and setters
      // Check the code around the function to see if it's a getter or setter
      if (s.kind === 'function' || s.kind === 'method') {
        // Look for 'get name' or 'set name' pattern before the function
        // Check a reasonable window before the function start
        const searchStart = Math.max(0, s.range.start - 100);
        const searchEnd = Math.min(code.length, s.range.start + 50);
        const context = code.substring(searchStart, searchEnd);
        
        // Match: (optional modifiers) get/set (whitespace) methodName
        // The method name should appear after get/set
        const getterPattern = new RegExp(`\\b(?:public|private|protected|static|readonly|\\s)*\\bget\\s+${s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[\(:]`, 'i');
        const setterPattern = new RegExp(`\\b(?:public|private|protected|static|readonly|\\s)*\\bset\\s+${s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[\(:]`, 'i');
        
        if (getterPattern.test(context) || setterPattern.test(context)) {
          return false;
        }
      }
      
      return true;
    });
  }

  /**
   * Filter out nested functions (functions that are contained within other functions)
   * Only top-level functions should be counted for code smell metrics
   */
  private filterNestedFunctions(functionSymbols: ParsedSymbol[]): ParsedSymbol[] {
    if (functionSymbols.length === 0) {
      return [];
    }

    // Sort by start position, then by end position (descending) to process outer functions first
    const sorted = [...functionSymbols].sort((a, b) => {
      if (a.range.start !== b.range.start) {
        return a.range.start - b.range.start;
      }
      // If same start, prefer longer functions (outer functions)
      return b.range.end - a.range.end;
    });
    
    const topLevelFunctions: ParsedSymbol[] = [];

    for (const func of sorted) {
      // Check if this function is nested inside any already-processed function
      // A function is nested if it's strictly contained within another function's range
      const isNested = topLevelFunctions.some(parent => 
        func.range.start > parent.range.start && 
        func.range.end < parent.range.end
      );

      if (!isNested) {
        topLevelFunctions.push(func);
      }
    }

    return topLevelFunctions;
  }

  /**
   * Calculate max nesting depth by traversing the AST
   */
  private calculateNestingDepthFromTree(node: Parser.SyntaxNode, currentDepth: number = 0): number {
    const nestingTypes = new Set([
      // Control flow
      'if_statement', 'else_clause',
      'for_statement', 'for_in_statement', 'for_of_statement',
      'while_statement', 'do_statement',
      'switch_statement', 'case_clause',
      'try_statement', 'catch_clause',
      // Functions
      'function_declaration', 'function_expression', 'arrow_function',
      'method_definition', 'method_declaration',
      // Classes
      'class_declaration', 'class_definition',
      // Python specific
      'with_statement', 'except_clause',
      // C# specific
      'foreach_statement', 'using_statement', 'lock_statement',
      // Go specific
      'select_statement', 'type_switch_statement',
      // Blocks and scopes
      'block', 'statement_block', 'compound_statement'
    ]);
    
    let maxDepth = currentDepth;
    const isNestingNode = nestingTypes.has(node.type);
    const newDepth = isNestingNode ? currentDepth + 1 : currentDepth;
    
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        const childDepth = this.calculateNestingDepthFromTree(child, newDepth);
        maxDepth = Math.max(maxDepth, childDepth);
      }
    }
    
    return maxDepth;
  }

  /**
   * Estimate nesting depth from code when AST is not available
   * Uses indentation-based heuristics
   */
  private estimateNestingDepthFromCode(code: string): number {
    const lines = code.split('\n');
    let maxDepth = 0;
    let currentDepth = 0;
    
    // Simple brace/indent counting
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
        continue;
      }
      
      // Count opening braces/keywords
      const opens = (trimmed.match(/\{/g) || []).length;
      const closes = (trimmed.match(/\}/g) || []).length;
      
      // Python/indentation-based languages: use leading spaces
      const leadingSpaces = line.length - line.trimStart().length;
      const indentLevel = Math.floor(leadingSpaces / 4); // Assume 4-space indent
      
      currentDepth += opens - closes;
      maxDepth = Math.max(maxDepth, currentDepth, indentLevel);
    }
    
    return maxDepth;
  }
}

// Singleton instance for reuse
let analyzerInstance: CodeSmellAnalyzer | null = null;

export function getCodeSmellAnalyzer(): CodeSmellAnalyzer {
  if (!analyzerInstance) {
    analyzerInstance = new CodeSmellAnalyzer();
  }
  return analyzerInstance;
}

