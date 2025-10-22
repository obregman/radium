import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export type RequirementStatus = 'not-started' | 'in-progress' | 'implemented' | 'verified';

export interface Requirement {
  id: string;
  text: string;
  status: RequirementStatus;
}

export interface FeatureBlock {
  name: string;
  description?: string;
  requirements: Requirement[];
}

export interface RequirementsConfig {
  requirements: Record<string, FeatureBlock>;
}

export class RequirementsConfigLoader {
  private workspaceRoot: string;
  private config: RequirementsConfig | null = null;
  private configPath: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.configPath = path.join(this.workspaceRoot, 'radium-req.yaml');
  }

  /**
   * Load radium-req.yaml configuration file if it exists
   */
  load(): RequirementsConfig | null {
    if (!fs.existsSync(this.configPath)) {
      console.log('[Requirements Config] No radium-req.yaml found at project root');
      this.config = { requirements: {} };
      return this.config;
    }

    try {
      const fileContent = fs.readFileSync(this.configPath, 'utf8');
      const rawConfig = yaml.load(fileContent) as any;

      this.config = this.parseConfig(rawConfig);
      const totalRequirements = Object.values(this.config.requirements).reduce(
        (sum, featureBlock) => sum + featureBlock.requirements.length, 
        0
      );
      console.log(`[Requirements Config] Loaded ${totalRequirements} requirements across ${Object.keys(this.config.requirements).length} features`);
      
      return this.config;
    } catch (error) {
      console.error('[Requirements Config] Failed to load radium-req.yaml:', error);
      this.config = { requirements: {} };
      return this.config;
    }
  }

  private parseConfig(rawConfig: any): RequirementsConfig {
    if (!rawConfig || !rawConfig.spec) {
      return { requirements: {} };
    }

    const requirementsArray = rawConfig.spec.requirements;
    
    if (!Array.isArray(requirementsArray)) {
      return { requirements: {} };
    }

    const requirements: Record<string, FeatureBlock> = {};

    for (const reqItem of requirementsArray) {
      const featureKey = Object.keys(reqItem)[0];
      const featureData = reqItem[featureKey];

      if (!featureData) {
        console.warn(`[Requirements Config] Invalid feature data for: ${featureKey}`);
        continue;
      }

      // Parse feature block with name, description, and requirements
      const name = featureData.name || featureKey.replace(/-/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase());
      const description = featureData.description || '';
      const reqList = featureData.requirements || [];

      if (!Array.isArray(reqList)) {
        console.warn(`[Requirements Config] Invalid requirements for feature: ${featureKey}`);
        continue;
      }

      requirements[featureKey] = {
        name,
        description,
        requirements: reqList.map((req: any) => ({
          id: req.id || this.generateId(),
          text: req.text || '',
          status: this.validateStatus(req.status)
        }))
      };
    }

    return { requirements };
  }

  private validateStatus(status: any): RequirementStatus {
    const validStatuses: RequirementStatus[] = ['not-started', 'in-progress', 'implemented', 'verified'];
    if (validStatuses.includes(status)) {
      return status;
    }
    return 'not-started';
  }

  private generateId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Save requirements configuration to radium-req.yaml
   */
  save(): boolean {
    if (!this.config) {
      console.error('[Requirements Config] No config to save');
      return false;
    }

    try {
      const requirementsArray = Object.entries(this.config.requirements).map(([featureKey, reqs]) => ({
        [featureKey]: reqs
      }));

      console.log('[Requirements Config] Saving config with', requirementsArray.length, 'features');
      console.log('[Requirements Config] Config path:', this.configPath);

      const yamlContent = yaml.dump({
        spec: {
          requirements: requirementsArray
        }
      }, {
        indent: 2,
        lineWidth: -1
      });

      console.log('[Requirements Config] YAML content length:', yamlContent.length);
      fs.writeFileSync(this.configPath, yamlContent, 'utf8');
      console.log('[Requirements Config] Saved radium-req.yaml successfully');
      return true;
    } catch (error) {
      console.error('[Requirements Config] Failed to save radium-req.yaml:', error);
      return false;
    }
  }

  /**
   * Get the loaded configuration
   */
  getConfig(): RequirementsConfig | null {
    return this.config;
  }

  /**
   * Get feature block for a specific feature
   */
  getFeatureBlock(featureKey: string): FeatureBlock | null {
    if (!this.config) {
      return null;
    }
    return this.config.requirements[featureKey] || null;
  }

  /**
   * Get requirements for a specific feature
   */
  getRequirements(featureKey: string): Requirement[] {
    if (!this.config) {
      return [];
    }
    const featureBlock = this.config.requirements[featureKey];
    return featureBlock ? featureBlock.requirements : [];
  }

  /**
   * Add a requirement to a feature
   */
  addRequirement(featureKey: string, text: string): Requirement {
    if (!this.config) {
      this.config = { requirements: {} };
    }

    if (!this.config.requirements[featureKey]) {
      // Create new feature block if it doesn't exist
      this.config.requirements[featureKey] = {
        name: featureKey.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        description: '',
        requirements: []
      };
    }

    const newRequirement: Requirement = {
      id: this.generateId(),
      text,
      status: 'not-started'
    };

    this.config.requirements[featureKey].requirements.push(newRequirement);
    this.save();

    return newRequirement;
  }

  /**
   * Update a feature block
   */
  updateFeatureBlock(featureKey: string, updates: Partial<FeatureBlock>): boolean {
    if (!this.config || !this.config.requirements[featureKey]) {
      return false;
    }

    this.config.requirements[featureKey] = {
      ...this.config.requirements[featureKey],
      ...updates
    };
    this.save();

    return true;
  }

  /**
   * Update a requirement
   */
  updateRequirement(featureKey: string, requirementId: string, updates: Partial<Requirement>): boolean {
    if (!this.config || !this.config.requirements[featureKey]) {
      return false;
    }

    const requirements = this.config.requirements[featureKey].requirements;
    const index = requirements.findIndex(r => r.id === requirementId);

    if (index === -1) {
      return false;
    }

    requirements[index] = { ...requirements[index], ...updates };
    this.save();

    return true;
  }

  /**
   * Delete a requirement
   */
  deleteRequirement(featureKey: string, requirementId: string): boolean {
    if (!this.config || !this.config.requirements[featureKey]) {
      console.error(`[Requirements Config] Cannot delete requirement: feature '${featureKey}' not found`);
      return false;
    }

    const requirements = this.config.requirements[featureKey].requirements;
    const index = requirements.findIndex(r => r.id === requirementId);

    if (index === -1) {
      console.error(`[Requirements Config] Cannot delete requirement: requirement '${requirementId}' not found in feature '${featureKey}'`);
      return false;
    }

    console.log(`[Requirements Config] Deleting requirement '${requirementId}' from feature '${featureKey}'`);
    requirements.splice(index, 1);
    
    const saved = this.save();
    if (!saved) {
      console.error('[Requirements Config] Failed to save after deleting requirement');
      return false;
    }

    return true;
  }

  /**
   * Check if configuration is loaded
   */
  hasConfig(): boolean {
    return this.config !== null;
  }
}

