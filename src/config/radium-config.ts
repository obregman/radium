import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface ComponentConfig {
  name: string;
  description?: string;
  files: string[];
}

export interface RadiumConfig {
  projectSpec: {
    components: Record<string, ComponentConfig>;
  };
}

export class RadiumConfigLoader {
  private workspaceRoot: string;
  private config: RadiumConfig | null = null;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Load radium.yaml configuration file if it exists
   */
  load(): RadiumConfig | null {
    const configPath = path.join(this.workspaceRoot, 'radium.yaml');
    
    if (!fs.existsSync(configPath)) {
      console.log('[Radium Config] No radium.yaml found at project root');
      return null;
    }

    try {
      const fileContent = fs.readFileSync(configPath, 'utf8');
      const rawConfig = yaml.load(fileContent) as any;

      // Parse and validate the configuration
      this.config = this.parseConfig(rawConfig);
      console.log(`[Radium Config] Loaded configuration with ${Object.keys(this.config.projectSpec.components).length} components`);
      
      return this.config;
    } catch (error) {
      console.error('[Radium Config] Failed to load radium.yaml:', error);
      return null;
    }
  }

  private parseConfig(rawConfig: any): RadiumConfig {
    if (!rawConfig || !rawConfig['project-spec']) {
      throw new Error('Invalid radium.yaml: missing project-spec');
    }

    const projectSpec = rawConfig['project-spec'];
    
    if (!projectSpec.components || !Array.isArray(projectSpec.components)) {
      throw new Error('Invalid radium.yaml: components must be an array');
    }

    const components: Record<string, ComponentConfig> = {};

    // Parse components array into a keyed object
    for (const componentItem of projectSpec.components) {
      // Each item is an object with a single key (the component name)
      const componentName = Object.keys(componentItem)[0];
      const componentData = componentItem[componentName];

      if (!componentData.name || !componentData.files) {
        console.warn(`[Radium Config] Skipping invalid component: ${componentName}`);
        continue;
      }

      components[componentName] = {
        name: componentData.name,
        description: componentData.description,
        files: Array.isArray(componentData.files) ? componentData.files : []
      };
    }

    return {
      projectSpec: {
        components
      }
    };
  }

  /**
   * Get the loaded configuration
   */
  getConfig(): RadiumConfig | null {
    return this.config;
  }

  /**
   * Get component that a file belongs to
   */
  getComponentForFile(filePath: string): { key: string; component: ComponentConfig } | null {
    if (!this.config) {
      return null;
    }

    for (const [key, component] of Object.entries(this.config.projectSpec.components)) {
      for (const filePattern of component.files) {
        // Support both exact matches and glob-like patterns
        if (this.matchesPattern(filePath, filePattern)) {
          return { key, component };
        }
      }
    }

    return null;
  }

  private matchesPattern(filePath: string, pattern: string): boolean {
    // Normalize paths for comparison
    const normalizedPath = filePath.replace(/\\/g, '/');
    const normalizedPattern = pattern.replace(/\\/g, '/');

    // Exact match
    if (normalizedPath === normalizedPattern) {
      return true;
    }

    // Wildcard pattern support
    if (normalizedPattern.includes('*')) {
      const regexPattern = normalizedPattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*');
      
      const regex = new RegExp(`^${regexPattern}$`);
      return regex.test(normalizedPath);
    }

    // Prefix match (for directory patterns)
    if (normalizedPath.startsWith(normalizedPattern)) {
      return true;
    }

    return false;
  }

  /**
   * Check if configuration is loaded
   */
  hasConfig(): boolean {
    return this.config !== null;
  }
}

