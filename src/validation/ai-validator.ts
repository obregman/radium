import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Requirement, RequirementStatus } from '../config/requirements-config';
import { FeatureConfig } from '../config/features-config';

export interface ValidationResult {
  requirementId: string;
  status: RequirementStatus;
  confidence: number;
  reasoning: string;
}

type AIProvider = 'cursor' | 'copilot' | 'claude';

export class AIValidator {
  private workspaceRoot: string;
  private provider: AIProvider;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.provider = this.getConfiguredProvider();
  }

  private getConfiguredProvider(): AIProvider {
    const config = vscode.workspace.getConfiguration('radium.devMode');
    return config.get<AIProvider>('aiProvider', 'copilot');
  }

  /**
   * Validate a single requirement using AI
   */
  async validateRequirement(
    requirement: Requirement,
    feature: FeatureConfig,
    featureKey: string
  ): Promise<ValidationResult> {
    const prompt = this.buildValidationPrompt(requirement, feature, featureKey);

    try {
      // Use VS Code's language model API (available in newer versions)
      const response = await this.callAI(prompt);
      return this.parseAIResponse(requirement.id, response);
    } catch (error) {
      console.error('[AI Validator] Validation failed:', error);
      
      // Fallback: preserve current status and indicate failure
      return {
        requirementId: requirement.id,
        status: requirement.status || 'not-started',
        confidence: 0,
        reasoning: `Validation failed: ${error}`
      };
    }
  }

  /**
   * Validate all requirements for a feature
   */
  async validateFeatureRequirements(
    requirements: Requirement[],
    feature: FeatureConfig,
    featureKey: string
  ): Promise<ValidationResult[]> {
    const results: ValidationResult[] = [];

    for (const requirement of requirements) {
      const result = await this.validateRequirement(requirement, feature, featureKey);
      results.push(result);
      
      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return results;
  }

  private buildValidationPrompt(
    requirement: Requirement,
    feature: FeatureConfig,
    featureKey: string
  ): string {
    const componentsList = feature.components?.join(', ') || 'none specified';
    
    // Gather context from component files
    const componentContext = this.gatherComponentContext(feature.components || []);
    
    let prompt = `Analyze the codebase for feature "${feature.name}" (key: ${featureKey}).

Components involved: ${componentsList}
${feature.description ? `Description: ${feature.description}` : ''}

Requirement to validate:
"${requirement.text}"
`;

    // Add component file context if available
    if (componentContext) {
      prompt += `\n${componentContext}\n`;
    }

    prompt += `
Based on your knowledge of the codebase, determine if this requirement is fully implemented.

Respond ONLY with a JSON object in this exact format:
{
  "status": "implemented" | "in-progress" | "not-started",
  "confidence": <number 0-100>,
  "reasoning": "<brief explanation>"
}

Guidelines:
- "implemented": Feature is fully working and tested
- "in-progress": Partially implemented or incomplete
- "not-started": No implementation found
- Confidence: Your certainty level (0-100%)
- Reasoning: 1-2 sentences explaining your assessment`;

    return prompt;
  }

  /**
   * Gather context from component files to provide to AI
   */
  private gatherComponentContext(components: string[]): string {
    if (!components || components.length === 0) {
      return '';
    }

    const contextParts: string[] = [];
    const maxFileSize = 5000; // Max characters per file to include

    for (const component of components.slice(0, 5)) { // Limit to first 5 components
      try {
        const fullPath = path.join(this.workspaceRoot, component);
        
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const truncated = content.length > maxFileSize 
            ? content.substring(0, maxFileSize) + '\n... (truncated)'
            : content;
          
          contextParts.push(`\n--- File: ${component} ---\n${truncated}\n`);
        }
      } catch (error) {
        console.warn(`[AI Validator] Could not read component file: ${component}`, error);
      }
    }

    if (contextParts.length > 0) {
      return '\nRelevant code context:\n' + contextParts.join('\n');
    }

    return '';
  }

  private async callAI(prompt: string): Promise<string> {
    console.log(`[AI Validator] Using provider: ${this.provider}`);

    switch (this.provider) {
      case 'cursor':
        return await this.callCursorAI(prompt);
      case 'copilot':
        return await this.callCopilotAI(prompt);
      case 'claude':
        return await this.callClaudeAI(prompt);
      default:
        throw new Error(`Unknown AI provider: ${this.provider}`);
    }
  }

  /**
   * Call Cursor AI using the Composer API
   */
  private async callCursorAI(prompt: string): Promise<string> {
    try {
      // Cursor uses VS Code's language model API with vendor 'cursor'
      const models = await vscode.lm.selectChatModels({
        vendor: 'cursor',
        family: 'gpt-4'
      });

      if (models && models.length > 0) {
        const model = models[0];
        console.log(`[AI Validator] Using Cursor model: ${model.name}`);
        
        const messages = [
          vscode.LanguageModelChatMessage.User(prompt)
        ];

        const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
        
        let fullResponse = '';
        for await (const chunk of response.text) {
          fullResponse += chunk;
        }
        
        console.log('[AI Validator] Cursor response received');
        return fullResponse;
      }

      console.log('[AI Validator] No Cursor models available, trying fallback');
      // Try any available model as fallback
      return await this.callAnyAvailableModel(prompt);
    } catch (error) {
      console.error('[AI Validator] Cursor AI call failed:', error);
      return await this.fallbackToManualInput(prompt);
    }
  }

  /**
   * Call GitHub Copilot using VS Code's language model API
   */
  private async callCopilotAI(prompt: string): Promise<string> {
    try {
      const models = await vscode.lm.selectChatModels({
        vendor: 'copilot',
        family: 'gpt-4'
      });

      if (models && models.length > 0) {
        const model = models[0];
        console.log(`[AI Validator] Using Copilot model: ${model.name}`);
        
        const messages = [
          vscode.LanguageModelChatMessage.User(prompt)
        ];

        const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
        
        let fullResponse = '';
        for await (const chunk of response.text) {
          fullResponse += chunk;
        }
        
        console.log('[AI Validator] Copilot response received');
        return fullResponse;
      }

      console.log('[AI Validator] No Copilot models available, trying fallback');
      return await this.callAnyAvailableModel(prompt);
    } catch (error) {
      console.error('[AI Validator] Copilot AI call failed:', error);
      return await this.fallbackToManualInput(prompt);
    }
  }

  /**
   * Call Claude API (placeholder for future implementation)
   */
  private async callClaudeAI(prompt: string): Promise<string> {
    // For now, Claude integration requires API key configuration
    vscode.window.showWarningMessage('Claude API integration not yet implemented. Please configure API key in settings.');
    return await this.fallbackToManualInput(prompt);
  }

  /**
   * Try to use any available language model
   */
  private async callAnyAvailableModel(prompt: string): Promise<string> {
    try {
      // Try to get any available model without vendor filter
      const models = await vscode.lm.selectChatModels();

      if (models && models.length > 0) {
        const model = models[0];
        console.log(`[AI Validator] Using fallback model: ${model.vendor}/${model.name}`);
        
        const messages = [
          vscode.LanguageModelChatMessage.User(prompt)
        ];

        const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
        
        let fullResponse = '';
        for await (const chunk of response.text) {
          fullResponse += chunk;
        }
        
        return fullResponse;
      }
    } catch (error) {
      console.log('[AI Validator] No language models available:', error);
    }

    return await this.fallbackToManualInput(prompt);
  }

  /**
   * Fallback to manual input when no AI provider is available
   */
  private async fallbackToManualInput(prompt: string): Promise<string> {
    const userResponse = await vscode.window.showInputBox({
      prompt: 'AI validation requires manual input. Please paste the AI response:',
      placeHolder: 'Paste AI response here...',
      ignoreFocusOut: true,
      value: prompt,
      valueSelection: [0, prompt.length]
    });

    if (!userResponse) {
      throw new Error('User cancelled validation');
    }

    return userResponse;
  }

  private parseAIResponse(requirementId: string, response: string): ValidationResult {
    try {
      // Try to extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }

      const parsed = JSON.parse(jsonMatch[0]);

      const status = this.normalizeStatus(parsed.status);
      const confidence = Math.max(0, Math.min(100, parsed.confidence || 0));

      return {
        requirementId,
        status,
        confidence,
        reasoning: parsed.reasoning || 'No reasoning provided'
      };
    } catch (error) {
      console.error('[AI Validator] Failed to parse AI response:', error);
      
      // Try to infer from text
      const lowerResponse = response.toLowerCase();
      let status: RequirementStatus = 'not-started';
      let confidence = 50;

      if (lowerResponse.includes('implemented') || lowerResponse.includes('complete')) {
        status = 'implemented';
        confidence = 70;
      } else if (lowerResponse.includes('in progress') || lowerResponse.includes('partial')) {
        status = 'in-progress';
        confidence = 60;
      }

      return {
        requirementId,
        status,
        confidence,
        reasoning: response.substring(0, 200)
      };
    }
  }

  private normalizeStatus(status: string): RequirementStatus {
    const normalized = status.toLowerCase().replace(/[_-]/g, '');
    
    if (normalized.includes('implemented') || normalized.includes('complete') || normalized.includes('verified')) {
      return 'implemented';
    } else if (normalized.includes('inprogress') || normalized.includes('progress') || normalized.includes('partial')) {
      return 'in-progress';
    }
    
    return 'not-started';
  }
}

