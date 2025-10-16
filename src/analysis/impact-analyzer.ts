import { GraphStore, Node, Edge } from '../store/schema';

export interface ImpactResult {
  node: Node;
  fanIn: Node[];
  fanOut: Node[];
  transitiveImpact: number;
  risk: 'low' | 'medium' | 'high';
  affectedTests: Node[];
}

export class ImpactAnalyzer {
  constructor(private store: GraphStore) {}

  analyzeNode(nodeId: number): ImpactResult | null {
    const node = this.store.getNodeById(nodeId);
    if (!node) return null;

    const edges = this.store.getEdgesByNode(nodeId);
    
    // Get fan-in (who depends on this)
    const fanIn = edges.incoming.map(e => this.store.getNodeById(e.src)).filter(n => n) as Node[];
    
    // Get fan-out (what this depends on)
    const fanOut = edges.outgoing.map(e => this.store.getNodeById(e.dst)).filter(n => n) as Node[];

    // Calculate transitive impact
    const transitiveImpact = this.calculateTransitiveImpact(nodeId, new Set());

    // Find affected tests
    const affectedTests = this.findAffectedTests(nodeId);

    // Calculate risk
    const risk = this.calculateRisk(fanIn.length, fanOut.length, transitiveImpact, affectedTests.length);

    return {
      node,
      fanIn,
      fanOut,
      transitiveImpact,
      risk,
      affectedTests
    };
  }

  private calculateTransitiveImpact(nodeId: number, visited: Set<number>): number {
    if (visited.has(nodeId)) return 0;
    visited.add(nodeId);

    const edges = this.store.getEdgesByNode(nodeId);
    let count = edges.incoming.length;

    for (const edge of edges.incoming) {
      count += this.calculateTransitiveImpact(edge.src, visited);
    }

    return count;
  }

  private findAffectedTests(nodeId: number): Node[] {
    const allEdges = this.store.getAllEdges();
    const testEdges = allEdges.filter(e => e.kind === 'tests' && e.dst === nodeId);
    
    return testEdges
      .map(e => this.store.getNodeById(e.src))
      .filter(n => n) as Node[];
  }

  private calculateRisk(
    fanInCount: number,
    fanOutCount: number,
    transitiveImpact: number,
    testCount: number
  ): 'low' | 'medium' | 'high' {
    // Simple heuristic
    const impactScore = fanInCount * 2 + transitiveImpact;
    const testCoverage = testCount > 0 ? 1 : 0;

    if (impactScore > 20 && testCoverage === 0) return 'high';
    if (impactScore > 10 || testCoverage === 0) return 'medium';
    return 'low';
  }

  findPathBetween(srcId: number, dstId: number): Node[] {
    const queue: [number, number[]][] = [[srcId, [srcId]]];
    const visited = new Set<number>([srcId]);
    const allEdges = this.store.getAllEdges();

    // Build adjacency map
    const adjacency = new Map<number, number[]>();
    for (const edge of allEdges) {
      if (!adjacency.has(edge.src)) {
        adjacency.set(edge.src, []);
      }
      adjacency.get(edge.src)!.push(edge.dst);
    }

    // BFS
    while (queue.length > 0) {
      const [current, path] = queue.shift()!;

      if (current === dstId) {
        return path.map(id => this.store.getNodeById(id)).filter(n => n) as Node[];
      }

      const neighbors = adjacency.get(current) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push([neighbor, [...path, neighbor]]);
        }
      }
    }

    return [];
  }

  getHotspots(limit: number = 10): Node[] {
    const allNodes = this.store.getAllNodes();
    const allEdges = this.store.getAllEdges();

    // Count incoming edges (dependencies)
    const incomingCount = new Map<number, number>();
    for (const edge of allEdges) {
      incomingCount.set(edge.dst, (incomingCount.get(edge.dst) || 0) + 1);
    }

    // Sort by incoming edges
    const sorted = allNodes
      .map(n => ({
        node: n,
        count: incomingCount.get(n.id!) || 0
      }))
      .sort((a, b) => b.count - a.count);

    return sorted.slice(0, limit).map(s => s.node);
  }
}

