import * as assert from 'assert';
import { CodeParser } from '../../src/indexer/parser';

suite('Static Method Call Detection', () => {
  let parser: CodeParser;

  setup(() => {
    parser = new CodeParser();
  });

  test('should detect static method calls on classes', async () => {
    const code = `
export class WebContentExtractor {
  public static getInstance(): WebContentExtractor {
    return new WebContentExtractor();
  }
}

export class WebSearchService {
  private contentExtractor: WebContentExtractor;
  
  private constructor() {
    this.contentExtractor = WebContentExtractor.getInstance();
  }
}
`;
    const result = await parser.parseFile('test.ts', code);
    
    assert.ok(result, 'Result should not be null');
    
    console.log('\n=== All detected calls ===');
    result!.calls.forEach((call, index) => {
      console.log(`${index + 1}. callee: "${call.callee}"`);
    });
    
    // Should detect WebContentExtractor.getInstance as a call
    const staticMethodCall = result!.calls.find(c => 
      c.callee.includes('WebContentExtractor') || c.callee.includes('getInstance')
    );
    
    assert.ok(staticMethodCall, 'Should detect static method call WebContentExtractor.getInstance()');
    console.log('\nStatic method call detected:', staticMethodCall?.callee);
  });

  test('should detect class reference from static method call', async () => {
    const code = `
export class ConfigService {
  public static getInstance(): ConfigService {
    return new ConfigService();
  }
}

export class MyService {
  private config = ConfigService.getInstance();
}
`;
    const result = await parser.parseFile('test.ts', code);
    
    assert.ok(result, 'Result should not be null');
    
    console.log('\n=== All detected calls ===');
    result!.calls.forEach((call, index) => {
      console.log(`${index + 1}. callee: "${call.callee}"`);
    });
    
    // The call should reference ConfigService somehow
    const hasConfigServiceReference = result!.calls.some(c => 
      c.callee.includes('ConfigService')
    );
    
    assert.ok(hasConfigServiceReference, 'Should detect reference to ConfigService class');
  });

  test('should detect WebContentExtractor usage via static method', async () => {
    const code = `
export class WebContentExtractor {
  private static instance: WebContentExtractor;
  
  public static getInstance(): WebContentExtractor {
    if (!this.instance) {
      this.instance = new WebContentExtractor();
    }
    return this.instance;
  }
}

export class WebSearchService {
  private contentExtractor: WebContentExtractor;
  
  private constructor() {
    this.contentExtractor = WebContentExtractor.getInstance();
  }
}
`;
    const result = await parser.parseFile('test.ts', code);
    
    assert.ok(result, 'Result should not be null');
    
    console.log('\n=== All detected calls ===');
    result!.calls.forEach((call, index) => {
      console.log(`${index + 1}. callee: "${call.callee}"`);
    });
    
    // Should detect WebContentExtractor.getInstance call
    const staticCall = result!.calls.find(c => 
      c.callee === 'WebContentExtractor.getInstance'
    );
    
    assert.ok(staticCall, 'Should detect WebContentExtractor.getInstance() call');
    console.log('\nThis call will create edges to both WebContentExtractor class and getInstance method');
  });
});

