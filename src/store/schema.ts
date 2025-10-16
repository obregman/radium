import { DatabaseAdapter } from './sql-adapter';

export interface Node {
  id?: number;
  kind: string;
  lang: string;
  name: string;
  fqname: string;
  path: string;
  range_start: number;
  range_end: number;
  hash: string;
  ts: number;
}

export interface Edge {
  id?: number;
  kind: EdgeKind;
  src: number;
  dst: number;
  weight: number;
  ts: number;
}

export type EdgeKind = 'imports' | 'calls' | 'inherits' | 'defines' | 'modifies' | 'tests' | 'owns' | 'mentions';

export interface FileRecord {
  id?: number;
  path: string;
  lang: string;
  hash: string;
  size: number;
  ts: number;
}

export interface Session {
  id?: number;
  actor: 'user' | 'LLM' | 'mixed';
  actor_version?: string;
  origin: string;
  started_at: number;
  ended_at?: number;
}

export interface Change {
  id?: number;
  session_id: number;
  file_id: number;
  hunks_json: string;
  summary?: string;
  ts: number;
}

export interface Issue {
  id?: number;
  session_id?: number;
  severity: 'error' | 'warning' | 'info';
  kind: string;
  message: string;
  node_id?: number;
  file_id?: number;
  ts: number;
}

export interface Metric {
  id?: number;
  node_id: number;
  kind: string;
  value: number;
  ts: number;
}

export class GraphStore {
  private db: DatabaseAdapter;
  private initialized = false;

  constructor(dbPath: string) {
    this.db = new DatabaseAdapter(dbPath);
  }

  async init(): Promise<void> {
    await this.db.init();
    this.initSchema();
    this.initialized = true;
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS node (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        lang TEXT NOT NULL,
        name TEXT NOT NULL,
        fqname TEXT NOT NULL,
        path TEXT NOT NULL,
        range_start INTEGER NOT NULL,
        range_end INTEGER NOT NULL,
        hash TEXT NOT NULL,
        ts INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_node_path ON node(path);
      CREATE INDEX IF NOT EXISTS idx_node_fqname ON node(fqname);

      CREATE TABLE IF NOT EXISTS edge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        src INTEGER NOT NULL,
        dst INTEGER NOT NULL,
        weight REAL DEFAULT 1.0,
        ts INTEGER NOT NULL,
        FOREIGN KEY(src) REFERENCES node(id) ON DELETE CASCADE,
        FOREIGN KEY(dst) REFERENCES node(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_edge_src_dst_kind ON edge(src, dst, kind);

      CREATE TABLE IF NOT EXISTS file (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        lang TEXT NOT NULL,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        ts INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_file_path ON file(path);

      CREATE TABLE IF NOT EXISTS session (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        actor_version TEXT,
        origin TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS change (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        file_id INTEGER NOT NULL,
        hunks_json TEXT NOT NULL,
        summary TEXT,
        ts INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE,
        FOREIGN KEY(file_id) REFERENCES file(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_change_session ON change(session_id);

      CREATE TABLE IF NOT EXISTS issue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER,
        severity TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        node_id INTEGER,
        file_id INTEGER,
        ts INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES session(id) ON DELETE CASCADE,
        FOREIGN KEY(node_id) REFERENCES node(id) ON DELETE CASCADE,
        FOREIGN KEY(file_id) REFERENCES file(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS metric (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        value REAL NOT NULL,
        ts INTEGER NOT NULL,
        FOREIGN KEY(node_id) REFERENCES node(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_metric_node ON metric(node_id);
    `);
  }

  // Node operations
  insertNode(node: Node): number {
    const stmt = this.db.prepare(`
      INSERT INTO node (kind, lang, name, fqname, path, range_start, range_end, hash, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      node.kind, node.lang, node.name, node.fqname, node.path,
      node.range_start, node.range_end, node.hash, node.ts
    );
    return result.lastInsertRowid as number;
  }

  getNodesByPath(filePath: string): Node[] {
    const stmt = this.db.prepare('SELECT * FROM node WHERE path = ?');
    return stmt.all(filePath) as Node[];
  }

  getNodeById(id: number): Node | undefined {
    const stmt = this.db.prepare('SELECT * FROM node WHERE id = ?');
    return stmt.get(id) as Node | undefined;
  }

  getAllNodes(): Node[] {
    const stmt = this.db.prepare('SELECT * FROM node');
    return stmt.all() as Node[];
  }

  deleteNodesByPath(filePath: string): void {
    const stmt = this.db.prepare('DELETE FROM node WHERE path = ?');
    stmt.run(filePath);
  }

  // Edge operations
  insertEdge(edge: Edge): number {
    const stmt = this.db.prepare(`
      INSERT INTO edge (kind, src, dst, weight, ts)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(edge.kind, edge.src, edge.dst, edge.weight, edge.ts);
    return result.lastInsertRowid as number;
  }

  getEdgesByNode(nodeId: number): { outgoing: Edge[], incoming: Edge[] } {
    const outStmt = this.db.prepare('SELECT * FROM edge WHERE src = ?');
    const inStmt = this.db.prepare('SELECT * FROM edge WHERE dst = ?');
    return {
      outgoing: outStmt.all(nodeId) as Edge[],
      incoming: inStmt.all(nodeId) as Edge[]
    };
  }

  getAllEdges(): Edge[] {
    const stmt = this.db.prepare('SELECT * FROM edge');
    return stmt.all() as Edge[];
  }

  // File operations
  upsertFile(file: FileRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO file (path, lang, hash, size, ts)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        lang = excluded.lang,
        hash = excluded.hash,
        size = excluded.size,
        ts = excluded.ts
    `);
    const result = stmt.run(file.path, file.lang, file.hash, file.size, file.ts);
    return result.lastInsertRowid as number;
  }

  getFileByPath(filePath: string): FileRecord | undefined {
    const stmt = this.db.prepare('SELECT * FROM file WHERE path = ?');
    return stmt.get(filePath) as FileRecord | undefined;
  }

  getAllFiles(): FileRecord[] {
    const stmt = this.db.prepare('SELECT * FROM file');
    return stmt.all() as FileRecord[];
  }

  // Session operations
  createSession(session: Session): number {
    const stmt = this.db.prepare(`
      INSERT INTO session (actor, actor_version, origin, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      session.actor,
      session.actor_version || null,
      session.origin,
      session.started_at,
      session.ended_at || null
    );
    return result.lastInsertRowid as number;
  }

  endSession(sessionId: number, endedAt: number): void {
    const stmt = this.db.prepare('UPDATE session SET ended_at = ? WHERE id = ?');
    stmt.run(endedAt, sessionId);
  }

  getSession(sessionId: number): Session | undefined {
    const stmt = this.db.prepare('SELECT * FROM session WHERE id = ?');
    return stmt.get(sessionId) as Session | undefined;
  }

  getRecentSessions(limit: number = 20): Session[] {
    const stmt = this.db.prepare('SELECT * FROM session ORDER BY started_at DESC LIMIT ?');
    return stmt.all(limit) as Session[];
  }

  // Change operations
  insertChange(change: Change): number {
    const stmt = this.db.prepare(`
      INSERT INTO change (session_id, file_id, hunks_json, summary, ts)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      change.session_id,
      change.file_id,
      change.hunks_json,
      change.summary || null,
      change.ts
    );
    return result.lastInsertRowid as number;
  }

  getChangesBySession(sessionId: number): Change[] {
    const stmt = this.db.prepare('SELECT * FROM change WHERE session_id = ?');
    return stmt.all(sessionId) as Change[];
  }

  // Issue operations
  insertIssue(issue: Issue): number {
    const stmt = this.db.prepare(`
      INSERT INTO issue (session_id, severity, kind, message, node_id, file_id, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      issue.session_id || null,
      issue.severity,
      issue.kind,
      issue.message,
      issue.node_id || null,
      issue.file_id || null,
      issue.ts
    );
    return result.lastInsertRowid as number;
  }

  getIssues(filters?: { sessionId?: number; severity?: string }): Issue[] {
    let query = 'SELECT * FROM issue WHERE 1=1';
    const params: any[] = [];

    if (filters?.sessionId) {
      query += ' AND session_id = ?';
      params.push(filters.sessionId);
    }
    if (filters?.severity) {
      query += ' AND severity = ?';
      params.push(filters.severity);
    }

    query += ' ORDER BY ts DESC';
    const stmt = this.db.prepare(query);
    return stmt.all(...params) as Issue[];
  }

  // Metric operations
  insertMetric(metric: Metric): number {
    const stmt = this.db.prepare(`
      INSERT INTO metric (node_id, kind, value, ts)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(metric.node_id, metric.kind, metric.value, metric.ts);
    return result.lastInsertRowid as number;
  }

  getMetricsByNode(nodeId: number): Metric[] {
    const stmt = this.db.prepare('SELECT * FROM metric WHERE node_id = ?');
    return stmt.all(nodeId) as Metric[];
  }

  // Utility
  close(): void {
    this.db.close();
  }

  save(): void {
    this.db.save();
  }

  beginTransaction(): void {
    this.db.prepare('BEGIN').run();
  }

  commit(): void {
    this.db.prepare('COMMIT').run();
    this.db.save();
  }

  rollback(): void {
    this.db.prepare('ROLLBACK').run();
  }
}

