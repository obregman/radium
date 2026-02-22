import Parser from 'tree-sitter';
import { BaseParser, ParsedSymbol, ImportDeclaration, CallSite } from './base-parser';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Kotlin = require('tree-sitter-kotlin');

/**
 * Parser for Kotlin files
 */
export class KotlinParser extends BaseParser {
  constructor() {
    super(Kotlin, 'kotlin');
  }

  protected extractSymbols(
    node: Parser.SyntaxNode,
    code: string,
    symbols: ParsedSymbol[],
    imports: ImportDeclaration[],
    calls: CallSite[],
    filePath: string,
    namespace: string = ''
  ): void {
    // Function declarations (fun name(...))
    if (node.type === 'function_declaration') {
      const nameNode = this.findChildByType(node, 'simple_identifier');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        
        // Check for extension function (has receiver type)
        const receiverNode = node.childForFieldName('receiver');
        let fqname = namespace ? `${namespace}.${name}` : name;
        
        if (receiverNode) {
          const receiverType = code.slice(receiverNode.startIndex, receiverNode.endIndex);
          fqname = `${receiverType}.${name}`;
        }
        
        symbols.push({
          kind: 'function',
          name,
          fqname,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }
    // Class declarations
    else if (node.type === 'class_declaration') {
      const nameNode = this.findChildByType(node, 'type_identifier');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        const fqname = namespace ? `${namespace}.${name}` : name;
        
        // Check if it's an enum class
        const modifiersNode = this.findChildByType(node, 'modifiers');
        const isEnum = modifiersNode && code.slice(modifiersNode.startIndex, modifiersNode.endIndex).includes('enum');
        
        symbols.push({
          kind: isEnum ? 'type' : 'class',
          name,
          fqname,
          range: { start: node.startIndex, end: node.endIndex }
        });
        
        // Recurse into class body with new namespace
        const bodyNode = this.findChildByType(node, 'class_body') || this.findChildByType(node, 'enum_class_body');
        if (bodyNode) {
          this.extractSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname);
        }
        return;
      }
    }
    // Object declarations (singleton)
    else if (node.type === 'object_declaration') {
      const nameNode = this.findChildByType(node, 'type_identifier');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        const fqname = namespace ? `${namespace}.${name}` : name;
        
        symbols.push({
          kind: 'class',
          name,
          fqname,
          range: { start: node.startIndex, end: node.endIndex }
        });
        
        // Recurse into object body with new namespace
        const bodyNode = this.findChildByType(node, 'class_body');
        if (bodyNode) {
          this.extractSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname);
        }
        return;
      }
    }
    // Companion object
    else if (node.type === 'companion_object') {
      // Companion objects can have a name or be anonymous
      const nameNode = this.findChildByType(node, 'type_identifier');
      const name = nameNode ? code.slice(nameNode.startIndex, nameNode.endIndex) : 'Companion';
      const fqname = namespace ? `${namespace}.${name}` : name;
      
      symbols.push({
        kind: 'class',
        name,
        fqname,
        range: { start: node.startIndex, end: node.endIndex }
      });
      
      // Recurse into companion object body
      const bodyNode = this.findChildByType(node, 'class_body');
      if (bodyNode) {
        this.extractSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname);
      }
      return;
    }
    // Interface declarations
    else if (node.type === 'interface_declaration') {
      const nameNode = this.findChildByType(node, 'type_identifier');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        const fqname = namespace ? `${namespace}.${name}` : name;
        
        symbols.push({
          kind: 'interface',
          name,
          fqname,
          range: { start: node.startIndex, end: node.endIndex }
        });
        
        // Recurse into interface body
        const bodyNode = this.findChildByType(node, 'class_body');
        if (bodyNode) {
          this.extractSymbols(bodyNode, code, symbols, imports, calls, filePath, fqname);
        }
        return;
      }
    }
    // Property declarations (val/var)
    else if (node.type === 'property_declaration') {
      // Find the variable declaration which contains the identifier
      const varDeclNode = this.findChildByType(node, 'variable_declaration');
      if (varDeclNode) {
        const nameNode = this.findChildByType(varDeclNode, 'simple_identifier');
        if (nameNode) {
          const name = code.slice(nameNode.startIndex, nameNode.endIndex);
          
          // Check if this is a function property (has lambda value)
          const delegateNode = this.findChildByType(node, 'property_delegate');
          const lambdaNode = this.findChildByType(node, 'lambda_literal') || 
                            this.findChildByType(node, 'anonymous_function');
          
          const isFunctionValue = lambdaNode !== null;
          
          symbols.push({
            kind: isFunctionValue ? 'function' : 'variable',
            name: isFunctionValue ? name + '()' : name,
            fqname: namespace ? `${namespace}.${name}` : name,
            range: { start: node.startIndex, end: node.endIndex }
          });
        }
      } else {
        // Try direct simple_identifier for simpler property declarations
        const nameNode = this.findChildByType(node, 'simple_identifier');
        if (nameNode) {
          const name = code.slice(nameNode.startIndex, nameNode.endIndex);
          symbols.push({
            kind: 'variable',
            name,
            fqname: namespace ? `${namespace}.${name}` : name,
            range: { start: node.startIndex, end: node.endIndex }
          });
        }
      }
    }
    // Type alias
    else if (node.type === 'type_alias') {
      const nameNode = this.findChildByType(node, 'type_identifier');
      if (nameNode) {
        const name = code.slice(nameNode.startIndex, nameNode.endIndex);
        symbols.push({
          kind: 'type',
          name,
          fqname: namespace ? `${namespace}.${name}` : name,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }
    // Secondary constructor
    else if (node.type === 'secondary_constructor') {
      symbols.push({
        kind: 'constructor',
        name: 'constructor',
        fqname: namespace ? `${namespace}.constructor` : 'constructor',
        range: { start: node.startIndex, end: node.endIndex }
      });
    }
    // Import declarations
    else if (node.type === 'import_header') {
      const identifierNode = this.findChildByType(node, 'identifier');
      if (identifierNode) {
        const source = code.slice(identifierNode.startIndex, identifierNode.endIndex);
        const aliasNode = this.findChildByType(node, 'import_alias');
        const names: string[] = [];
        
        if (aliasNode) {
          const aliasIdentifier = this.findChildByType(aliasNode, 'simple_identifier');
          if (aliasIdentifier) {
            names.push(code.slice(aliasIdentifier.startIndex, aliasIdentifier.endIndex));
          }
        } else {
          // Extract the last part of the import path as the name
          const parts = source.split('.');
          names.push(parts[parts.length - 1]);
        }
        
        imports.push({
          source,
          names,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }
    // Call expressions
    else if (node.type === 'call_expression') {
      // Get the callee (navigation_expression or simple_identifier)
      const firstChild = node.children[0];
      if (firstChild) {
        const callee = code.slice(firstChild.startIndex, firstChild.endIndex);
        calls.push({
          callee,
          range: { start: node.startIndex, end: node.endIndex }
        });
      }
    }
    // Package declaration (for namespace)
    else if (node.type === 'package_header') {
      const identifierNode = this.findChildByType(node, 'identifier');
      if (identifierNode) {
        const packageName = code.slice(identifierNode.startIndex, identifierNode.endIndex);
        namespace = packageName;
      }
    }

    // Recurse to children
    for (const child of node.children) {
      this.extractSymbols(child, code, symbols, imports, calls, filePath, namespace);
    }
  }

  /**
   * Helper to find a child node by type
   */
  private findChildByType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
    for (const child of node.children) {
      if (child.type === type) {
        return child;
      }
    }
    return null;
  }
}
