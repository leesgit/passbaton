// SQLite 데이터베이스 초기화 및 관리
import Database, { Database as DatabaseType } from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { ContentFilterPattern } from '../types.js';
import { migrateSchema } from './migrate.js';

// ===== 경로 자동 감지 =====

/**
 * 워크스페이스 루트 자동 감지
 * 우선순위:
 * 1. WORKSPACE_ROOT 환경변수
 * 2. 현재 디렉토리에서 상위 탐색 (.claude/, apps/, turbo.json)
 * 3. 현재 작업 디렉토리
 * 4. 홈 디렉토리 (fallback)
 */
function detectWorkspaceRoot(): string {
  // 1. 환경변수 우선
  if (process.env.WORKSPACE_ROOT) {
    return process.env.WORKSPACE_ROOT;
  }

  // 2. 현재 디렉토리에서 상위로 탐색
  let current = process.cwd();
  const root = path.parse(current).root;

  while (current !== root) {
    // 모노레포 root 감지
    if (fs.existsSync(path.join(current, 'apps'))) {
      return current;
    }
    // .claude 디렉토리가 있으면 여기가 프로젝트 루트
    if (fs.existsSync(path.join(current, '.claude'))) {
      return current;
    }
    // turbo.json + package.json = 모노레포
    if (fs.existsSync(path.join(current, 'turbo.json')) && fs.existsSync(path.join(current, 'package.json'))) {
      return current;
    }
    current = path.dirname(current);
  }

  // 3. 현재 작업 디렉토리 사용 (단일 프로젝트로 간주)
  return process.cwd();
}

/**
 * DB 경로 결정
 * - 워크스페이스 루트의 .claude/sessions.db
 * - 없으면 생성
 */
function getDbPath(workspaceRoot: string): string {
  const claudeDir = path.join(workspaceRoot, '.claude');

  // .claude 디렉토리 생성
  if (!fs.existsSync(claudeDir)) {
    try {
      fs.mkdirSync(claudeDir, { recursive: true });
    } catch {
      // 권한 없으면 홈 디렉토리에 생성
      const homeClaudeDir = path.join(os.homedir(), '.claude');
      if (!fs.existsSync(homeClaudeDir)) {
        fs.mkdirSync(homeClaudeDir, { recursive: true });
      }
      return path.join(homeClaudeDir, 'sessions.db');
    }
  }

  return path.join(claudeDir, 'sessions.db');
}

// 기본 경로 설정
export const WORKSPACE_ROOT = detectWorkspaceRoot();
export const APPS_DIR = path.join(WORKSPACE_ROOT, 'apps');
const DB_PATH = getDbPath(WORKSPACE_ROOT);

// 데이터베이스 인스턴스
export const db: DatabaseType = new Database(DB_PATH);

// Content Filtering 패턴 캐시
export let contentFilterPatterns: ContentFilterPattern[] = [];

// 테이블 생성
export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_work TEXT NOT NULL,
      current_status TEXT,
      next_tasks TEXT,
      modified_files TEXT,
      issues TEXT,
      verification_result TEXT,
      duration_minutes INTEGER
      -- session_id / prompt_id / user_intent 는 여기 두지 않는다. 기존 DB 에서는
      -- CREATE TABLE IF NOT EXISTS 가 no-op 이라 컬럼이 절대 생기지 않는다.
      -- 아래 migrate() 가 ALTER 로 보강한다.
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    CREATE INDEX IF NOT EXISTS idx_sessions_timestamp ON sessions(timestamp);

    CREATE TABLE IF NOT EXISTS work_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      work_type TEXT NOT NULL,
      description TEXT,
      files_pattern TEXT,
      success_rate REAL DEFAULT 0,
      avg_duration_minutes REAL DEFAULT 0,
      count INTEGER DEFAULT 1,
      last_used DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_patterns_project ON work_patterns(project);
    CREATE INDEX IF NOT EXISTS idx_patterns_type ON work_patterns(work_type);

    -- ===== 메모리 시스템 테이블 =====

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      memory_type TEXT NOT NULL DEFAULT 'observation',
      tags TEXT,
      project TEXT,
      importance INTEGER DEFAULT 5,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      access_count INTEGER DEFAULT 0,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

    -- FTS5 전체 텍스트 검색
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      tags,
      content='memories',
      content_rowid='id'
    );

    -- FTS 트리거
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
      INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
    END;

    -- 지식 그래프 관계 테이블
    CREATE TABLE IF NOT EXISTS memory_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      strength REAL DEFAULT 1.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE,
      UNIQUE(source_id, target_id, relation_type)
    );

    CREATE INDEX IF NOT EXISTS idx_relations_source ON memory_relations(source_id);
    CREATE INDEX IF NOT EXISTS idx_relations_target ON memory_relations(target_id);
    CREATE INDEX IF NOT EXISTS idx_relations_type ON memory_relations(relation_type);

    -- ===== 시맨틱 검색용 임베딩 테이블 =====
    CREATE TABLE IF NOT EXISTS embeddings (
      memory_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT DEFAULT 'multilingual-e5-small',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    );

    -- ===== Content Filtering 학습 테이블 =====
    CREATE TABLE IF NOT EXISTS content_filter_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern_type TEXT NOT NULL,
      pattern_description TEXT NOT NULL,
      file_extension TEXT,
      example_context TEXT,
      mitigation_strategy TEXT,
      occurrence_count INTEGER DEFAULT 1,
      last_occurred DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_filter_patterns_type ON content_filter_patterns(pattern_type);

    -- ===== 프로젝트 연속성 시스템 (v2) =====

    -- Layer 1: 프로젝트 고정 컨텍스트
    CREATE TABLE IF NOT EXISTS project_context (
      project TEXT PRIMARY KEY,
      tech_stack TEXT,
      architecture_decisions TEXT,
      code_patterns TEXT,
      special_notes TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Layer 2: 활성 작업 컨텍스트
    CREATE TABLE IF NOT EXISTS active_context (
      project TEXT PRIMARY KEY,
      current_state TEXT,
      active_tasks TEXT,
      recent_files TEXT,
      blockers TEXT,
      last_verification TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Layer 3: 태스크 백로그
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 5,
      related_files TEXT,
      acceptance_criteria TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority DESC);

    -- Layer 3: 솔루션 아카이브 (index.ts의 solutions 테이블과 통일)
    CREATE TABLE IF NOT EXISTS solutions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT,
      error_signature TEXT NOT NULL,
      error_message TEXT,
      solution TEXT NOT NULL,
      related_files TEXT,
      keywords TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_solutions_signature ON solutions(error_signature);
    CREATE INDEX IF NOT EXISTS idx_solutions_project ON solutions(project);

    -- ===== 사용자 지시사항 테이블 =====
    CREATE TABLE IF NOT EXISTS user_directives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      directive TEXT NOT NULL,
      context TEXT,
      source TEXT DEFAULT 'explicit',
      priority TEXT DEFAULT 'normal',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(project, directive)
    );
    CREATE INDEX IF NOT EXISTS idx_directives_project ON user_directives(project);

    -- ===== 파일 접근 빈도 테이블 =====
    CREATE TABLE IF NOT EXISTS hot_paths (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      file_path TEXT NOT NULL,
      access_count INTEGER DEFAULT 1,
      last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP,
      path_type TEXT DEFAULT 'file',
      UNIQUE(project, file_path)
    );
    CREATE INDEX IF NOT EXISTS idx_hot_paths_project ON hot_paths(project);

  `);

  migrateSchema(db);
}

// Content Filter 패턴 로드
export function loadContentFilterPatterns() {
  try {
    const stmt = db.prepare(`
      SELECT id, pattern_type, pattern_description, file_extension, mitigation_strategy
      FROM content_filter_patterns
      ORDER BY occurrence_count DESC
    `);
    const rows = stmt.all() as Array<{
      id: number;
      pattern_type: string;
      pattern_description: string;
      file_extension: string | null;
      mitigation_strategy: string | null;
    }>;
    contentFilterPatterns = rows.map(r => ({
      id: r.id,
      patternType: r.pattern_type,
      patternDescription: r.pattern_description,
      fileExtension: r.file_extension,
      mitigationStrategy: r.mitigation_strategy
    }));
  } catch {
    contentFilterPatterns = [];
  }
}

// ===== 백업 시스템 =====

const BACKUP_DIR = path.join(os.homedir(), '.claude', 'backups');
const MAX_BACKUPS = 5;

/**
 * DB 백업 생성
 * - 최대 5개 유지
 * - 하루에 한 번만 백업
 */
export function createBackup(): string | null {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const today = new Date().toISOString().slice(0, 10);
    const backupPath = path.join(BACKUP_DIR, `sessions-${today}.db`);

    // 오늘 이미 백업했으면 스킵
    if (fs.existsSync(backupPath)) {
      return backupPath;
    }

    // SQLite 백업 (VACUUM INTO)
    db.exec(`VACUUM INTO '${backupPath}'`);

    // 오래된 백업 삭제
    cleanupOldBackups();

    return backupPath;
  } catch {
    return null;
  }
}

/**
 * 오래된 백업 삭제 (MAX_BACKUPS 개수 유지)
 */
function cleanupOldBackups(): void {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('sessions-') && f.endsWith('.db'))
      .map(f => ({
        name: f,
        path: path.join(BACKUP_DIR, f),
        time: fs.statSync(path.join(BACKUP_DIR, f)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time);

    // MAX_BACKUPS 초과분 삭제
    for (const file of files.slice(MAX_BACKUPS)) {
      fs.unlinkSync(file.path);
    }
  } catch {
    // 무시
  }
}

/**
 * 백업에서 복원
 */
export function restoreFromBackup(backupPath: string): boolean {
  try {
    if (!fs.existsSync(backupPath)) {
      return false;
    }

    // 현재 DB 닫기
    db.close();

    // 백업으로 교체
    fs.copyFileSync(backupPath, DB_PATH);

    return true;
  } catch {
    return false;
  }
}

/**
 * 백업 목록 조회
 */
export function listBackups(): Array<{ name: string; path: string; date: string; size: number }> {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      return [];
    }

    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('sessions-') && f.endsWith('.db'))
      .map(f => {
        const filePath = path.join(BACKUP_DIR, f);
        const stat = fs.statSync(filePath);
        return {
          name: f,
          path: filePath,
          date: f.replace('sessions-', '').replace('.db', ''),
          size: stat.size
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

// 초기화
initDatabase();
loadContentFilterPatterns();

// 시작 시 백업 생성 (하루 한 번)
createBackup();
