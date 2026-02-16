import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export type FeatureStatus = 'completed' | 'in_progress' | 'planned';

export interface FeatureCapability {
  name: string;
  description?: string;
  files: string[];
}

export interface FeatureConfig {
  name: string;
  description?: string;
  status: FeatureStatus;
  capabilities: Record<string, FeatureCapability>;
  files: string[];
}

export interface AppConfig {
  name: string;
  description?: string;
  features: string[];
}

export interface FeaturesConfig {
  apps: Record<string, AppConfig>;
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
    const configPath = path.join(this.workspaceRoot, '.radium', 'radium-features.yaml');
    
    console.log(`[Radium Features] Looking for config at: ${configPath}`);
    
    if (!fs.existsSync(configPath)) {
      console.log('[Radium Features] No radium-features.yaml found in .radium directory');
      return null;
    }

    try {
      const fileContent = fs.readFileSync(configPath, 'utf8');
      const rawConfig = yaml.load(fileContent) as any;

      this.config = this.parseConfig(rawConfig);
      const featureCount = Object.keys(this.config.features).length;
      const appCount = Object.keys(this.config.apps).length;
      console.log(`[Radium Features] ✓ Loaded configuration with ${featureCount} features and ${appCount} apps`);
      
      return this.config;
    } catch (error) {
      console.error('[Radium Features] Failed to load radium-features.yaml:', error);
      return null;
    }
  }

  private parseConfig(rawConfig: any): FeaturesConfig {
    if (!rawConfig || !rawConfig.spec) {
      throw new Error('Invalid radium-features.yaml: missing spec');
    }

    const spec = rawConfig.spec;
    const apps: Record<string, AppConfig> = {};
    const features: Record<string, FeatureConfig> = {};

    // Parse apps (optional)
    if (spec.apps && Array.isArray(spec.apps)) {
      for (const appItem of spec.apps) {
        const appKey = Object.keys(appItem)[0];
        const appData = appItem[appKey];

        if (!appData.name) {
          console.warn(`[Radium Features] Skipping invalid app: ${appKey}`);
          continue;
        }

        apps[appKey] = {
          name: appData.name,
          description: appData.description,
          features: Array.isArray(appData.features) ? appData.features : []
        };
      }
    }

    // Parse features (required)
    if (!spec.features || !Array.isArray(spec.features)) {
      throw new Error('Invalid radium-features.yaml: features must be an array');
    }

    for (const featureItem of spec.features) {
      const featureKey = Object.keys(featureItem)[0];
      const featureData = featureItem[featureKey];

      if (!featureData.name) {
        console.warn(`[Radium Features] Skipping invalid feature: ${featureKey}`);
        continue;
      }

      const capabilities: Record<string, FeatureCapability> = {};

      // Parse capabilities (optional)
      if (featureData.capabilities && Array.isArray(featureData.capabilities)) {
        for (const capItem of featureData.capabilities) {
          const capKey = Object.keys(capItem)[0];
          const capData = capItem[capKey];

          if (!capData.name) {
            console.warn(`[Radium Features] Skipping invalid capability: ${capKey}`);
            continue;
          }

          capabilities[capKey] = {
            name: capData.name,
            description: capData.description,
            files: Array.isArray(capData.files) ? capData.files : []
          };
        }
      }

      features[featureKey] = {
        name: featureData.name,
        description: featureData.description,
        status: this.parseStatus(featureData.status),
        capabilities,
        files: Array.isArray(featureData.files) ? featureData.files : []
      };
    }

    return { apps, features };
  }

  private parseStatus(status: string | undefined): FeatureStatus {
    if (status === 'completed' || status === 'in_progress' || status === 'planned') {
      return status;
    }
    return 'planned';
  }

  /**
   * Get the loaded configuration
   */
  getConfig(): FeaturesConfig | null {
    return this.config;
  }

  /**
   * Get a specific feature by key
   */
  getFeature(key: string): FeatureConfig | null {
    if (!this.config) {
      return null;
    }
    return this.config.features[key] || null;
  }

  /**
   * Get all files associated with a feature (including capability files)
   */
  getFilesForFeature(featureKey: string): string[] {
    const feature = this.getFeature(featureKey);
    if (!feature) {
      return [];
    }

    const files = new Set<string>(feature.files);

    for (const capability of Object.values(feature.capabilities)) {
      for (const file of capability.files) {
        files.add(file);
      }
    }

    return Array.from(files);
  }

  /**
   * Get the app that contains a feature
   */
  getAppForFeature(featureKey: string): { key: string; app: AppConfig } | null {
    if (!this.config) {
      return null;
    }

    for (const [key, app] of Object.entries(this.config.apps)) {
      if (app.features.includes(featureKey)) {
        return { key, app };
      }
    }

    return null;
  }

  /**
   * Check if configuration is loaded
   */
  hasConfig(): boolean {
    return this.config !== null;
  }

  /**
   * Get all features grouped by app, plus ungrouped features
   */
  getFeaturesGroupedByApp(): {
    apps: Array<{ key: string; app: AppConfig; features: Array<{ key: string; feature: FeatureConfig }> }>;
    ungroupedFeatures: Array<{ key: string; feature: FeatureConfig }>;
  } {
    if (!this.config) {
      return { apps: [], ungroupedFeatures: [] };
    }

    const groupedFeatureKeys = new Set<string>();
    const apps: Array<{ key: string; app: AppConfig; features: Array<{ key: string; feature: FeatureConfig }> }> = [];

    // Group features by app
    for (const [appKey, app] of Object.entries(this.config.apps)) {
      const appFeatures: Array<{ key: string; feature: FeatureConfig }> = [];
      
      for (const featureKey of app.features) {
        const feature = this.config.features[featureKey];
        if (feature) {
          appFeatures.push({ key: featureKey, feature });
          groupedFeatureKeys.add(featureKey);
        }
      }

      if (appFeatures.length > 0) {
        apps.push({ key: appKey, app, features: appFeatures });
      }
    }

    // Collect ungrouped features
    const ungroupedFeatures: Array<{ key: string; feature: FeatureConfig }> = [];
    for (const [featureKey, feature] of Object.entries(this.config.features)) {
      if (!groupedFeatureKeys.has(featureKey)) {
        ungroupedFeatures.push({ key: featureKey, feature });
      }
    }

    return { apps, ungroupedFeatures };
  }
}
