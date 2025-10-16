import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as fs from 'fs';

export class DatabaseAdapter {
  private db: SqlJsDatabase | null = null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    const SQL = await initSqlJs();
    
    // Try to load existing database
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }
  }

  exec(sql: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    if (!this.db) throw new Error('Database not initialized');
    return new PreparedStatement(this.db, sql);
  }

  close(): void {
    if (this.db) {
      // Save database to file
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, data);
      this.db.close();
      this.db = null;
    }
  }

  save(): void {
    if (this.db) {
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, data);
    }
  }
}

class PreparedStatement {
  constructor(private db: SqlJsDatabase, private sql: string) {}

  run(...params: any[]): { lastInsertRowid: number; changes: number } {
    this.db.run(this.sql, params);
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const lastInsertRowid = result[0]?.values[0]?.[0] as number || 0;
    return { lastInsertRowid, changes: 1 };
  }

  get(...params: any[]): any {
    const result = this.db.exec(this.sql, params);
    if (result.length === 0 || result[0].values.length === 0) {
      return undefined;
    }
    
    const columns = result[0].columns;
    const values = result[0].values[0];
    const row: any = {};
    
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = values[i];
    }
    
    return row;
  }

  all(...params: any[]): any[] {
    const result = this.db.exec(this.sql, params);
    if (result.length === 0) {
      return [];
    }
    
    const columns = result[0].columns;
    const rows: any[] = [];
    
    for (const values of result[0].values) {
      const row: any = {};
      for (let i = 0; i < columns.length; i++) {
        row[columns[i]] = values[i];
      }
      rows.push(row);
    }
    
    return rows;
  }
}

