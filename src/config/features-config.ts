import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface FlowItem {
  type: 'user' | 'window' | 'system' | 'api' | 'database';
  name: string;
  description?: string;
}

export interface FeatureConfig {
  name: string;
  description?: string;
  status?: 'planned' | 'in-progress' | 'completed' | 'deprecated';
  owner?: string;
  components?: string[];
  dependencies?: string[];
  flow?: FlowItem[];
}

export interface FeaturesConfig {
  features: Record<string, FeatureConfig>;
}

export class FeaturesConfigLoader {
  private workspaceRoot: string;
  private config: FeaturesConfig | null = null;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Load radium-features.yaml configuration file if it exists
   */
  load(): FeaturesConfig | null {
    const configPath = path.join(this.workspaceRoot, 'radium-features.yaml');
    
    if (!fs.existsSync(configPath)) {
      console.log('[Features Config] No radium-features.yaml found at project root');
      return null;
    }

    try {
      const fileContent = fs.readFileSync(configPath, 'utf8');
      const rawConfig = yaml.load(fileContent) as any;

      // Parse and validate the configuration
      this.config = this.parseConfig(rawConfig);
      console.log(`[Features Config] Loaded configuration with ${Object.keys(this.config.features).length} features`);
      
      return this.config;
    } catch (error) {
      console.error('[Features Config] Failed to load radium-features.yaml:', error);
      return null;
    }
  }

  private parseConfig(rawConfig: any): FeaturesConfig {
    if (!rawConfig || !rawConfig.spec || !rawConfig.spec.features) {
      throw new Error('Invalid radium-features.yaml: missing spec.features');
    }

    const featuresArray = rawConfig.spec.features;
    
    if (!Array.isArray(featuresArray)) {
      throw new Error('Invalid radium-features.yaml: features must be an array');
    }

    const features: Record<string, FeatureConfig> = {};

    // Check if this is a hierarchical structure (with type/name/children)
    // or a flat structure (with feature keys)
    const isHierarchical = featuresArray.length > 0 && 
                          featuresArray[0].type !== undefined && 
                          featuresArray[0].name !== undefined;

    if (isHierarchical) {
      // Parse hierarchical structure - flatten the tree
      this.parseHierarchicalFeatures(featuresArray, features, []);
    } else {
      // Parse flat structure with feature keys
      for (const featureItem of featuresArray) {
        const featureKey = Object.keys(featureItem)[0];
        const featureData = featureItem[featureKey];

        if (!featureData.name) {
          console.warn(`[Features Config] Skipping invalid feature: ${featureKey} - missing name`);
          continue;
        }

        features[featureKey] = {
          name: featureData.name,
          description: featureData.description,
          status: featureData.status || 'in-progress',
          owner: featureData.owner,
          components: Array.isArray(featureData.components) ? featureData.components : [],
          dependencies: Array.isArray(featureData.dependencies) ? featureData.dependencies : [],
          flow: Array.isArray(featureData.flow) ? featureData.flow : undefined
        };
      }
    }

    return { features };
  }

  private parseHierarchicalFeatures(
    items: any[], 
    features: Record<string, FeatureConfig>, 
    parentPath: string[]
  ): void {
    for (const item of items) {
      if (!item.name) continue;

      // Create a unique key from the name
      const key = this.createKey(item.name);
      const fullKey = parentPath.length > 0 
        ? `${parentPath.join('-')}-${key}` 
        : key;

      // Determine status based on type
      let status: 'planned' | 'in-progress' | 'completed' | 'deprecated' = 'in-progress';
      if (item.status) {
        status = item.status;
      } else if (item.type === 'screen') {
        status = 'in-progress'; // Screens are typically in progress
      } else if (item.type === 'action') {
        status = 'completed'; // Actions are typically completed
      }

      features[fullKey] = {
        name: item.name,
        description: item.description,
        status: status,
        owner: item.owner,
        components: [], // Hierarchical structure doesn't map to components
        dependencies: parentPath.length > 0 ? [parentPath.join('-')] : []
      };

      // Recursively parse children
      if (item.children && Array.isArray(item.children)) {
        this.parseHierarchicalFeatures(
          item.children, 
          features, 
          [...parentPath, key]
        );
      }
    }
  }

  private createKey(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Get the loaded configuration
   */
  getConfig(): FeaturesConfig | null {
    return this.config;
  }

  /**
   * Get feature by key
   */
  getFeature(key: string): FeatureConfig | null {
    if (!this.config) {
      return null;
    }
    return this.config.features[key] || null;
  }

  /**
   * Get all features with a specific status
   */
  getFeaturesByStatus(status: string): Array<{ key: string; feature: FeatureConfig }> {
    if (!this.config) {
      return [];
    }

    return Object.entries(this.config.features)
      .filter(([_, feature]) => feature.status === status)
      .map(([key, feature]) => ({ key, feature }));
  }

  /**
   * Get features that depend on a specific component
   */
  getFeaturesByComponent(componentKey: string): Array<{ key: string; feature: FeatureConfig }> {
    if (!this.config) {
      return [];
    }

    return Object.entries(this.config.features)
      .filter(([_, feature]) => feature.components?.includes(componentKey))
      .map(([key, feature]) => ({ key, feature }));
  }

  /**
   * Check if configuration is loaded
   */
  hasConfig(): boolean {
    return this.config !== null;
  }
}

