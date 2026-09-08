#!/usr/bin/env node
/**
 * Project Manager MCP v5
 *
 * 24개 도구 + 자동 컨텍스트 주입 (Prompts)
 *
 * 카테고리:
 * 1. 세션/컨텍스트 (4개): session_start, session_end, session_history, search_sessions
 * 2. 프로젝트 관리 (4개): project_status, project_init, project_analyze, list_projects
 * 3. 태스크/백로그 (4개): task_add, task_update, task_list, task_suggest
 * 4. 솔루션 아카이브 (3개): solution_record, solution_find, solution_suggest
 * 5. 검증/품질 (3개): verify_build, verify_test, verify_all
 * 6. 메모리 시스템 (5개): memory_store, memory_search, memory_get, memory_related, memory_stats
 * 7. 지식 그래프 (2개): graph_connect, graph_explore
 * 8. 자동 주입 (Prompts): project-context, recent-memories, error-solutions
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  CallToolResult,
  ListPromptsRequestSchema,
  GetPromptRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import { mkdirSync, existsSync } from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { tokenizeQuery, buildFtsQuery } from './utils/tokenize.js';
import { migrateSchema } from './db/migrate.js';

// @xenova/transformers - 동적 import (sharp 의존성 문제 방지)
let transformersModule: { pipeline: unknown; env: Record<string, unknown> } | null = null;

async function loadTransformers() {
  if (transformersModule) return transformersModule;
  try {
    // @ts-ignore - transformers.js
    const mod = await import('@xenova/transformers');
    mod.env.cacheDir = path.join(process.env.HOME || '/tmp', '.cache', 'transformers');
    mod.env.allowLocalModels = true;
    transformersModule = mod;
    return mod;
  } catch {
    return null;
  }
}

// 기본 경로 설정 (자동 감지)
function detectWorkspaceRoot(): string {
  // 1. 환경변수가 설정되어 있으면 사용
  if (process.env.WORKSPACE_ROOT) {
    return process.env.WORKSPACE_ROOT;
  }

  // 2. 현재 디렉토리에서 상위로 탐색하며 apps/ 또는 .claude/ 디렉토리 찾기
  let current = process.cwd();
  const root = path.parse(current).root;

  while (current !== root) {
    // apps/ 디렉토리가 있으면 여기가 workspace root
    if (existsSync(path.join(current, 'apps'))) {
      return current;
    }
    // .claude/ 디렉토리가 있으면 여기가 workspace root
    if (existsSync(path.join(current, '.claude'))) {
      return current;
    }
    // package.json + turbo.json이 있으면 모노레포 루트
    if (existsSync(path.join(current, 'package.json')) && existsSync(path.join(current, 'turbo.json'))) {
      return current;
    }
    current = path.dirname(current);
  }

  // 3. 못 찾으면 현재 디렉토리 사용 (경고 출력)
  console.error('Warning: WORKSPACE_ROOT not set and could not auto-detect. Using current directory.');
  console.error('Set WORKSPACE_ROOT environment variable in your MCP config for best results.');
  return process.cwd();
}

const WORKSPACE_ROOT = detectWorkspaceRoot();
const APPS_DIR = path.join(WORKSPACE_ROOT, 'apps');
const CLAUDE_DIR = path.join(WORKSPACE_ROOT, '.claude');
const DB_PATH = path.join(CLAUDE_DIR, 'sessions.db');

// 모노레포 vs 단일 프로젝트 모드 감지
const IS_MONOREPO = existsSync(APPS_DIR);
const DEFAULT_PROJECT = IS_MONOREPO ? null : path.basename(WORKSPACE_ROOT);

// ===== 디렉토리 생성 (동기) =====
if (!existsSync(CLAUDE_DIR)) {
  mkdirSync(CLAUDE_DIR, { recursive: true });
}

// ===== SQLite 데이터베이스 초기화 =====
const db = new Database(DB_PATH);

// v5 스키마 - 세션 + 메모리 분류 체계 + 지식 그래프
db.exec(`
  -- 세션 테이블 (핵심)
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    last_work TEXT,
    current_status TEXT,
    next_tasks TEXT,
    modified_files TEXT,
    issues TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
  CREATE INDEX IF NOT EXISTS idx_sessions_timestamp ON sessions(timestamp DESC);

  -- 프로젝트 컨텍스트 (고정)
  CREATE TABLE IF NOT EXISTS project_context (
    project TEXT PRIMARY KEY,
    tech_stack TEXT,
    architecture_decisions TEXT,
    code_patterns TEXT,
    special_notes TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 활성 컨텍스트 (자주 변경)
  CREATE TABLE IF NOT EXISTS active_context (
    project TEXT PRIMARY KEY,
    current_state TEXT,
    active_tasks TEXT,
    recent_files TEXT,
    blockers TEXT,
    last_verification TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 태스크 백로그
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending',
    priority INTEGER DEFAULT 5,
    related_files TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project, status);

  -- 솔루션 아카이브
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

  -- ===== v4: 메모리 시스템 (mcp-memory-service 스타일) =====

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
  CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);

  -- FTS5 전체 텍스트 검색
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    tags,
    content='memories',
    content_rowid='id'
  );

  -- FTS 트리거 (이미 있으면 무시)
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

  -- ===== v4: 지식 그래프 관계 =====

  CREATE TABLE IF NOT EXISTS memory_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    relation_type TEXT NOT NULL,
    strength REAL DEFAULT 1.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, target_id, relation_type)
  );
  CREATE INDEX IF NOT EXISTS idx_relations_source ON memory_relations(source_id);
  CREATE INDEX IF NOT EXISTS idx_relations_target ON memory_relations(target_id);
  CREATE INDEX IF NOT EXISTS idx_relations_type ON memory_relations(relation_type);

  -- ===== v4: 통합 임베딩 테이블 =====

  CREATE TABLE IF NOT EXISTS embeddings_v4 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    embedding BLOB NOT NULL,
    model TEXT DEFAULT 'multilingual-e5-small',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(entity_type, entity_id)
  );
  CREATE INDEX IF NOT EXISTS idx_embeddings_v4_entity ON embeddings_v4(entity_type, entity_id);

  -- ===== v6: 사용자 지시사항 =====
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

  -- ===== v6: 파일 접근 빈도 =====
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

// 스키마 보강 — CREATE TABLE IF NOT EXISTS 는 기존 DB 의 컬럼을 늘리지 못한다.
// 정본은 db/migrate.ts 하나다 (이 레포에는 sessions 를 만드는 코드가 네 군데 있다).
migrateSchema(db);

// ===== 임베딩 엔진 =====
let embeddingPipeline: unknown = null;

async function initEmbedding() {
  if (embeddingPipeline) return;
  try {
    const mod = await loadTransformers();
    if (!mod) return;
    embeddingPipeline = await (mod.pipeline as Function)('feature-extraction', 'Xenova/multilingual-e5-small');
  } catch (error) {
    console.error('Failed to load embedding model:', error);
  }
}

// 백그라운드 로드
initEmbedding();

async function generateEmbedding(text: string, type: 'query' | 'passage' = 'query'): Promise<number[] | null> {
  if (!embeddingPipeline) await initEmbedding();
  if (!embeddingPipeline) return null;

  try {
    const prefixedText = `${type}: ${text}`;
    const output = await (embeddingPipeline as (text: string, options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>)(
      prefixedText,
      { pooling: 'mean', normalize: true }
    );
    return Array.from(output.data);
  } catch {
    return null;
  }
}

function parseTags(tags: string | null): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    return tags.split(',').map(t => t.trim()).filter(Boolean);
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ===== 임베딩 저장 (재시도 포함) =====

async function storeEmbeddingWithRetry(
  db: ReturnType<typeof Database>,
  entityType: string,
  entityId: number | bigint,
  text: string,
  retries = 2
): Promise<void> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const embedding = await generateEmbedding(text, 'passage');
      if (embedding) {
        const buffer = Buffer.from(new Float32Array(embedding).buffer);
        db.prepare('INSERT OR REPLACE INTO embeddings_v4 (entity_type, entity_id, embedding) VALUES (?, ?, ?)')
          .run(entityType, entityId, buffer);
        return;
      }
    } catch { /* retry */ }
    if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
  }
}

// ===== 유틸리티 함수 =====

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectPlatform(projectPath: string): Promise<string> {
  if (await fileExists(path.join(projectPath, 'pubspec.yaml'))) return 'flutter';
  if (await fileExists(path.join(projectPath, 'build.gradle.kts'))) return 'android';
  if (await fileExists(path.join(projectPath, 'package.json'))) return 'web';
  return 'unknown';
}

async function detectTechStack(projectPath: string): Promise<Record<string, string>> {
  const stack: Record<string, string> = {};

  // Flutter
  if (await fileExists(path.join(projectPath, 'pubspec.yaml'))) {
    stack.framework = 'Flutter';
    const content = await fs.readFile(path.join(projectPath, 'pubspec.yaml'), 'utf-8');
    if (content.includes('flutter_riverpod')) stack.state = 'Riverpod';
    if (content.includes('provider:')) stack.state = 'Provider';
    if (content.includes('bloc:')) stack.state = 'BLoC';
  }

  // Web (Next.js, etc.)
  const pkgPath = path.join(projectPath, 'package.json');
  if (await fileExists(pkgPath)) {
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
    if (pkg.dependencies?.next) stack.framework = 'Next.js';
    else if (pkg.dependencies?.react) stack.framework = 'React';
    else if (pkg.dependencies?.vue) stack.framework = 'Vue';
    if (pkg.dependencies?.typescript || pkg.devDependencies?.typescript) stack.language = 'TypeScript';
  }

  return stack;
}

function runCommand(cmd: string, cwd: string): { success: boolean; output: string } {
  try {
    const output = execSync(cmd, { cwd, encoding: 'utf-8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
    return { success: true, output };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return { success: false, output: e.stdout || e.stderr || e.message || 'Unknown error' };
  }
}

// ===== 프로젝트 경로 헬퍼 (모노레포/단일 프로젝트 호환) =====

function getProjectPath(project: string): string {
  // 단일 프로젝트 모드: 프로젝트명이 workspace 이름과 같으면 루트 반환
  if (!IS_MONOREPO && project === DEFAULT_PROJECT) {
    return WORKSPACE_ROOT;
  }
  // 모노레포 모드: apps/ 하위 경로
  return path.join(APPS_DIR, project);
}

function resolveProject(project: string | undefined): string {
  // 프로젝트명이 없으면 기본 프로젝트 사용 (단일 프로젝트 모드)
  if (!project && DEFAULT_PROJECT) {
    return DEFAULT_PROJECT;
  }
  return project || 'default';
}

// ===== MCP 서버 =====
const server = new Server(
  { name: 'project-manager-v5', version: '5.0.0' },
  {
    capabilities: {
      tools: { listChanged: true },
      prompts: { listChanged: true }  // 자동 주입용 prompts 기능 활성화
    }
  }
);

// ===== 메모리 타입 정의 =====
const MEMORY_TYPES = {
  observation: '관찰/발견 - 코드베이스에서 발견한 패턴, 구조, 특이점',
  decision: '의사결정 - 아키텍처, 라이브러리 선택 등 중요 결정',
  learning: '학습 - 새로 알게 된 지식, 베스트 프랙티스',
  error: '에러/해결 - 발생한 에러와 해결 방법',
  pattern: '패턴 - 반복되는 코드 패턴, 컨벤션'
} as const;

const RELATION_TYPES = {
  related_to: '관련됨 - 일반적인 관계',
  causes: '원인 - A가 B를 발생시킴',
  solves: '해결 - A가 B를 해결함',
  depends_on: '의존 - A가 B에 의존함',
  contradicts: '상충 - A와 B가 충돌함',
  extends: '확장 - A가 B를 확장함',
  example_of: '예시 - A가 B의 예시임'
} as const;

// ===== 18개 도구 정의 =====

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const tools: Tool[] = [
  // ===== 1. 세션/컨텍스트 (4개) =====
  {
    name: 'session_start',
    description: 'Load project context at the beginning of a session. Typically auto-invoked by the SessionStart hook, but can be called manually. Returns the project\'s tech stack, recent activity, pending tasks, and active blockers as a compressed context payload (~650 tokens). Read-only — does not modify any state. Use this instead of project_status when you need the full session bootstrap context.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (must match a directory under apps/)' },
        compact: { type: 'boolean', description: 'Return compressed format (default: true). Set false for verbose output.' }
      },
      required: ['project']
    }
  },
  {
    name: 'session_end',
    description: 'Save the current session state before ending a conversation. Persists a summary, completed work, next steps, modified files, and blockers to SQLite. The saved state is automatically restored by session_start in the next session. Side effects: writes to the sessions table and updates the active_context record for the project. Idempotent — calling multiple times overwrites the previous session record.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (must match a directory under apps/)' },
        summary: { type: 'string', description: 'One-line summary of this session' },
        workDone: { type: 'string', description: 'Description of completed work' },
        nextSteps: { type: 'array', items: { type: 'string' }, description: 'Ordered list of next tasks to pick up' },
        modifiedFiles: { type: 'array', items: { type: 'string' }, description: 'Files modified during this session' },
        blockers: { type: 'string', description: 'Current blockers or issues (null if none)' }
      },
      required: ['project', 'summary']
    }
  },
  {
    name: 'session_history',
    description: 'Retrieve past session records for a project. Returns an array of session objects ordered by most recent first, each containing summary, work done, modified files, and verification results. Read-only. Use search_sessions instead when you need semantic/keyword matching rather than a chronological list.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (must match a directory under apps/)' },
        limit: { type: 'number', description: 'Max records to return (default: 5)' },
        days: { type: 'number', description: 'Only return sessions from the last N days (default: 7)' }
      },
      required: ['project']
    }
  },
  {
    name: 'search_sessions',
    description: 'Semantic search across session history using multilingual embeddings (94+ languages). Finds past sessions by meaning, not just keywords — e.g. "when I worked on authentication" matches sessions about login, OAuth, JWT. Falls back to FTS5 keyword search when embeddings are unavailable. Read-only. Use session_history instead when you just need the N most recent sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        project: { type: 'string', description: 'Filter by project (optional)' },
        limit: { type: 'number', description: 'Max results to return (default: 5)' }
      },
      required: ['query']
    }
  },

  // ===== 2. 프로젝트 관리 (4개) =====
  {
    name: 'project_status',
    description: 'Get a project\'s current status including completion percentage, task breakdown (pending/in-progress/done/blocked), recent session activity, and active blockers. Read-only. Returns a structured JSON object. Use session_start instead when bootstrapping a new conversation; use this for mid-session status checks.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (must match a directory under apps/)' }
      },
      required: ['project']
    }
  },
  {
    name: 'project_init',
    description: 'Initialize a new project in the continuity system. Creates records in the project_context and active_context tables. Auto-detects tech stack from package.json/pubspec.yaml/build.gradle if present. Side effects: writes to SQLite. Idempotent — safe to call on an already-initialized project (updates existing record). Call this once when adding a new project, then use session_start for subsequent sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (must match a directory under apps/)' },
        techStack: { type: 'object', description: 'Tech stack override {framework, language, database, ...}. Omit for auto-detection.' },
        description: { type: 'string', description: 'Human-readable project description' }
      },
      required: ['project']
    }
  },
  {
    name: 'project_analyze',
    description: 'Auto-detect a project\'s tech stack, framework, platform (Web/Android/Flutter/Server), directory structure, and dependency count by scanning its files. Read-only — does not persist results. Returns a structured analysis object. Use project_init to persist the detected configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (must match a directory under apps/)' }
      },
      required: ['project']
    }
  },
  {
    name: 'list_projects',
    description: 'List all projects under the apps/ directory with their platform type (Web/Android/Flutter), initialization status, and whether session context exists. Read-only. Returns an array of project summary objects. No parameters required.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },

  // ===== 3. 태스크/백로그 (4개) =====
  {
    name: 'task_add',
    description: 'Add a new task to a project\'s backlog. Tasks are persisted in SQLite with priority ranking and optional file associations. Side effects: inserts into the tasks table. Returns the created task ID. Use task_list to view existing tasks before adding duplicates. Use task_suggest to auto-generate tasks from code comments (TODO/FIXME).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (must match a directory under apps/)' },
        title: { type: 'string', description: 'Task title (concise, actionable)' },
        description: { type: 'string', description: 'Detailed description (optional)' },
        priority: { type: 'number', description: 'Priority 1-10 where 10 is highest (default: 5)' },
        relatedFiles: { type: 'array', items: { type: 'string' }, description: 'Associated file paths (optional)' }
      },
      required: ['project', 'title']
    }
  },
  {
    name: 'task_update',
    description: 'Update a task\'s status. Valid transitions: pending → in_progress → done, or any state → blocked. Setting status to "done" automatically records a completion timestamp. Side effects: updates the tasks table. Idempotent. Returns success/failure and whether the row was actually modified.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'number', description: 'Task ID (from task_add or task_list)' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'blocked'], description: 'New status' },
        note: { type: 'string', description: 'Optional note (e.g. completion summary or block reason)' }
      },
      required: ['taskId', 'status']
    }
  },
  {
    name: 'task_list',
    description: 'List tasks for a project, filtered by status. Returns an array of task objects with id, title, description, status, priority, related files, and timestamps, plus a summary count by status. Read-only. Default filter is "pending" — pass status="all" to see everything.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (must match a directory under apps/)' },
        status: { type: 'string', enum: ['all', 'pending', 'in_progress', 'done', 'blocked'], description: 'Status filter (default: "pending")' }
      },
      required: ['project']
    }
  },
  {
    name: 'task_suggest',
    description: 'Scan project source files for TODO, FIXME, HACK, and XXX comments and return them as suggested tasks. Read-only — does not create tasks automatically. Review the suggestions and use task_add to persist the ones you want. Optionally scope the scan to a specific subdirectory.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (must match a directory under apps/)' },
        path: { type: 'string', description: 'Subdirectory path to limit the scan (optional, e.g. "src/components")' }
      },
      required: ['project']
    }
  },

  // ===== 4. 솔루션 아카이브 (3개) =====
  {
    name: 'solution_record',
    description: 'Record an error-solution pair in the solution archive. Associates an error signature (the searchable key), optional full error message, the fix, and related files. Automatically extracts keywords for FTS5 indexing. Side effects: inserts into the solutions table. Use solution_find to check for existing solutions before recording a duplicate.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (optional — omit for cross-project solutions)' },
        errorSignature: { type: 'string', description: 'Error pattern/signature used as the search key (e.g. "ENOENT: no such file", "WorkManager not initialized")' },
        errorMessage: { type: 'string', description: 'Full error message or stack trace (optional)' },
        solution: { type: 'string', description: 'Step-by-step fix description' },
        relatedFiles: { type: 'array', items: { type: 'string' }, description: 'Files that were modified to fix the error' }
      },
      required: ['errorSignature', 'solution']
    }
  },
  {
    name: 'solution_find',
    description: 'Search the solution archive for previously resolved errors. Matches against error signatures, messages, and keywords using FTS5. Set semantic=true to enable embedding-based similarity search for better recall across different error phrasings. Read-only. Returns matched solutions with their fix descriptions and related files. Use solution_suggest instead if you want AI-powered fix recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Error message, signature, or natural language description of the problem' },
        project: { type: 'string', description: 'Filter by project (optional — also includes cross-project solutions)' },
        limit: { type: 'number', description: 'Max results to return (default: 3)' },
        semantic: { type: 'boolean', description: 'Enable semantic/embedding search for fuzzy matching (default: false)' }
      },
      required: ['query']
    }
  },
  {
    name: 'solution_suggest',
    description: 'Get AI-powered fix suggestions for a current error based on the solution archive. Retrieves the most relevant past solutions and generates a contextual recommendation. Read-only. Use solution_find for direct archive lookup without AI synthesis; use solution_record after fixing an error to grow the archive.',
    inputSchema: {
      type: 'object',
      properties: {
        errorMessage: { type: 'string', description: 'The current error message or stack trace' },
        project: { type: 'string', description: 'Project name for context (optional)' }
      },
      required: ['errorMessage']
    }
  },

  // ===== 5. 검증/품질 (3개) =====
  {
    name: 'verify_build',
    description: 'Run the project\'s build command (auto-detected per platform: "pnpm build" for Web, "flutter build" for Flutter, "./gradlew assembleDebug" for Android). Side effects: executes a shell command in the project directory with a 5-minute timeout. Returns {success, output} with the last 1000 chars of stdout/stderr. Use verify_all to run build + test + lint together.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (must match a directory under apps/)' }
      },
      required: ['project']
    }
  },
  {
    name: 'verify_test',
    description: 'Run the project\'s test suite (auto-detected per platform: "pnpm test:run" for Web, "flutter test" for Flutter, "./gradlew test" for Android). Optionally scope to a specific test file or directory. Side effects: executes a shell command with a 5-minute timeout. Returns {success, output}. Use verify_all to run build + test + lint together.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (must match a directory under apps/)' },
        testPath: { type: 'string', description: 'Specific test file or directory to run (optional — runs all tests if omitted)' }
      },
      required: ['project']
    }
  },
  {
    name: 'verify_all',
    description: 'Run build, test, and lint sequentially for a project. Auto-detects platform-specific commands. Side effects: executes up to 3 shell commands with 5-minute timeouts each. Returns per-gate results and an overall pass/fail status. Use this as a quality gate before committing or ending a session. Use verify_build or verify_test individually when you only need one check.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name (must match a directory under apps/)' },
        stopOnFail: { type: 'boolean', description: 'Abort remaining gates on first failure (default: false — runs all gates)' }
      },
      required: ['project']
    }
  },

  // ===== 6. 메모리 시스템 (4개) - v4 신규 =====
  {
    name: 'memory_store',
    description: 'Store a piece of knowledge in the memory system. Memories are typed (observation, decision, learning, error, pattern), tagged, and automatically embedded for semantic retrieval. Side effects: inserts into the memories table and asynchronously generates a vector embedding. If relatedTo is provided, also creates a knowledge graph edge. Returns the new memory ID. Use memory_search to verify no duplicate exists before storing.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The knowledge content to store' },
        type: {
          type: 'string',
          enum: ['observation', 'decision', 'learning', 'error', 'pattern'],
          description: 'Memory type: observation (discovery/finding), decision (architecture/tech choice), learning (new knowledge), error (error encountered), pattern (code convention)'
        },
        project: { type: 'string', description: 'Associated project name (optional — omit for cross-project knowledge)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for filtering (e.g. ["auth", "performance"])' },
        importance: { type: 'number', description: 'Importance score 1-10 where 10 is critical (default: 5)' },
        relatedTo: { type: 'number', description: 'ID of an existing memory to link via knowledge graph (optional)' }
      },
      required: ['content', 'type']
    }
  },
  {
    name: 'memory_search',
    description: 'Search stored memories using FTS5 full-text search or semantic/embedding similarity. Default mode returns compact index entries (id, type, truncated content) to save tokens — set detail=true for full content. Supports filtering by type, project, tags, and minimum importance. Read-only. Use memory_get to fetch full content for specific IDs found in search results. Use memory_related to explore graph connections from a known memory.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        type: {
          type: 'string',
          enum: ['observation', 'decision', 'learning', 'error', 'pattern', 'all'],
          description: 'Filter by memory type (default: "all")'
        },
        project: { type: 'string', description: 'Filter by project (optional)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags — matches if any tag is present (optional)' },
        semantic: { type: 'boolean', description: 'Use embedding-based semantic search instead of keyword FTS5 (default: false)' },
        minImportance: { type: 'number', description: 'Minimum importance threshold 1-10 (default: 1)' },
        limit: { type: 'number', description: 'Max results to return (default: 10)' },
        detail: { type: 'boolean', description: 'Return full content per memory (default: false — returns compact index only)' }
      },
      required: ['query']
    }
  },
  {
    name: 'memory_get',
    description: 'Retrieve full content for one or more memories by ID. Designed as a follow-up to memory_search: first search to find relevant IDs, then use memory_get to load full details. Read-only. Accepts up to 20 IDs per call. Returns an array of complete memory objects including content, type, tags, importance, timestamps, and access count.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'number' }, description: 'Array of memory IDs to retrieve (max 20)' }
      },
      required: ['ids']
    }
  },
  {
    name: 'memory_related',
    description: 'Find memories related to a given memory using knowledge graph traversal and/or semantic similarity. Combines two strategies: (1) graph edges created via graph_connect or memory_store\'s relatedTo, and (2) cosine similarity between embeddings. Read-only. Use graph_explore for pure graph traversal with depth control; use memory_search for text-based search.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'number', description: 'The anchor memory ID to find relations for' },
        includeGraph: { type: 'boolean', description: 'Include knowledge graph connections (default: true)' },
        includeSemantic: { type: 'boolean', description: 'Include semantically similar memories via embeddings (default: true)' },
        limit: { type: 'number', description: 'Max results to return (default: 10)' }
      },
      required: ['memoryId']
    }
  },
  {
    name: 'memory_stats',
    description: 'Get aggregate statistics about the memory system: total count, breakdown by type (observation/decision/learning/error/pattern), breakdown by project, top 5 most accessed memories, and 5 most recent entries. Read-only. Useful for understanding memory distribution and system health. Optionally scope to a single project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Scope statistics to a single project (optional — omit for global stats)' }
      }
    }
  },

  // ===== 7. 지식 그래프 (2개) - v4 신규 =====
  {
    name: 'graph_connect',
    description: 'Create a directed edge between two memories in the knowledge graph. Supports 7 relation types for structured knowledge organization. Side effects: inserts or replaces a row in memory_relations (upsert on sourceId+targetId+relation). Use memory_related to discover existing connections; use graph_explore to traverse the graph from a starting node.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'number', description: 'Source memory ID (the "from" node)' },
        targetId: { type: 'number', description: 'Target memory ID (the "to" node)' },
        relation: {
          type: 'string',
          enum: ['related_to', 'causes', 'solves', 'depends_on', 'contradicts', 'extends', 'example_of'],
          description: 'Edge type: related_to (general association), causes (A causes B), solves (A fixes B), depends_on (A requires B), contradicts (A conflicts with B), extends (A builds on B), example_of (A demonstrates B)'
        },
        strength: { type: 'number', description: 'Connection strength 0.0-1.0 (default: 1.0). Lower values indicate weaker associations.' }
      },
      required: ['sourceId', 'targetId', 'relation']
    }
  },
  {
    name: 'graph_explore',
    description: 'Traverse the knowledge graph from a starting memory using depth-first search. Returns all connected memories up to the specified depth, with their relation types, strengths, and directions. Read-only. Supports filtering by relation type and traversal direction. Use memory_related instead for a combined graph+semantic approach; use graph_connect to add new edges.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: { type: 'number', description: 'Starting memory ID for graph traversal' },
        depth: { type: 'number', description: 'Maximum traversal depth 1-4 (default: 2). Higher values return more results but may be slower.' },
        relation: {
          type: 'string',
          enum: ['related_to', 'causes', 'solves', 'depends_on', 'contradicts', 'extends', 'example_of', 'all'],
          description: 'Filter by relation type (default: "all")'
        },
        direction: {
          type: 'string',
          enum: ['outgoing', 'incoming', 'both'],
          description: 'Traversal direction — outgoing (A→B), incoming (B→A), or both (default: "both")'
        }
      },
      required: ['memoryId']
    }
  }
];

// ===== 도구 핸들러 =====

async function handleTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    switch (name) {
      // ===== 세션/컨텍스트 =====
      case 'session_start': {
        const project = args.project as string;
        const compact = args.compact !== false;

        // 모노레포 모드에서만 프로젝트 디렉토리 체크
        // 단일 프로젝트 모드나 DB에 이미 데이터가 있으면 스킵
        if (IS_MONOREPO) {
          const projectPath = getProjectPath(project);
          if (!await fileExists(projectPath)) {
            // DB에 컨텍스트가 있는지 확인 (디렉토리 없어도 컨텍스트는 있을 수 있음)
            const hasContext = db.prepare('SELECT 1 FROM project_context WHERE project = ?').get(project)
              || db.prepare('SELECT 1 FROM active_context WHERE project = ?').get(project)
              || db.prepare('SELECT 1 FROM sessions WHERE project = ? LIMIT 1').get(project);
            if (!hasContext) {
              return { content: [{ type: 'text', text: `Project not found: ${project}` }] };
            }
          }
        }

        // 고정 컨텍스트
        const fixedRow = db.prepare('SELECT * FROM project_context WHERE project = ?').get(project) as Record<string, unknown> | undefined;

        // 활성 컨텍스트
        const activeRow = db.prepare('SELECT * FROM active_context WHERE project = ?').get(project) as Record<string, unknown> | undefined;

        // 최근 세션 (빈 세션 skip)
        const lastSession = db.prepare(`
          SELECT * FROM sessions
          WHERE project = ?
            AND last_work != 'Session ended'
            AND last_work != 'Session work completed'
            AND last_work != 'Session started'
            AND last_work != ''
          ORDER BY timestamp DESC LIMIT 1
        `).get(project) as Record<string, unknown> | undefined;

        // 미완료 태스크
        const pendingTasks = db.prepare(`
          SELECT id, title, status, priority FROM tasks
          WHERE project = ? AND status IN ('pending', 'in_progress')
          ORDER BY priority DESC LIMIT 5
        `).all(project) as Array<{ id: number; title: string; status: string; priority: number }>;

        // 사용자 지시사항
        let directives: Array<{ directive: string; priority: string }> = [];
        try {
          directives = db.prepare(`
            SELECT directive, priority FROM user_directives
            WHERE project = ? ORDER BY priority DESC, created_at DESC LIMIT 10
          `).all(project) as Array<{ directive: string; priority: string }>;
        } catch { /* table may not exist */ }

        // Hot paths
        let hotPaths: Array<{ file_path: string; access_count: number }> = [];
        try {
          hotPaths = db.prepare(`
            SELECT file_path, access_count FROM hot_paths
            WHERE project = ? AND last_accessed > datetime('now', '-7 days')
            ORDER BY access_count DESC LIMIT 10
          `).all(project) as Array<{ file_path: string; access_count: number }>;
        } catch { /* table may not exist */ }

        if (compact) {
          const lines: string[] = [`# ${project} Context`];

          if (fixedRow?.tech_stack) {
            const stack = JSON.parse(fixedRow.tech_stack as string);
            lines.push(`**Stack**: ${Object.entries(stack).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
          }

          if (activeRow?.current_state) {
            lines.push(`**State**: ${activeRow.current_state}`);
          }

          if (lastSession?.last_work) {
            lines.push(`**Last**: ${lastSession.last_work}`);
          }

          if (pendingTasks.length > 0) {
            lines.push(`**Tasks**: ${pendingTasks.map(t => `[P${t.priority}] ${t.title}`).join(' | ')}`);
          }

          if (activeRow?.blockers) {
            lines.push(`**Blocker**: ${activeRow.blockers}`);
          }

          if (directives.length > 0) {
            lines.push(`**Directives**: ${directives.map(d => `${d.priority === 'high' ? '🔴' : '📎'} ${d.directive}`).join(' | ')}`);
          }

          if (hotPaths.length > 0) {
            lines.push(`**Hot Files**: ${hotPaths.slice(0, 5).map(h => `${h.file_path.split('/').pop()}(${h.access_count}x)`).join(', ')}`);
          }

          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              project,
              fixed: fixedRow ? {
                techStack: fixedRow.tech_stack ? JSON.parse(fixedRow.tech_stack as string) : {},
                architectureDecisions: fixedRow.architecture_decisions ? JSON.parse(fixedRow.architecture_decisions as string) : [],
                codePatterns: fixedRow.code_patterns ? JSON.parse(fixedRow.code_patterns as string) : []
              } : null,
              active: activeRow ? {
                currentState: activeRow.current_state,
                activeTasks: activeRow.active_tasks ? JSON.parse(activeRow.active_tasks as string) : [],
                recentFiles: activeRow.recent_files ? JSON.parse(activeRow.recent_files as string) : [],
                blockers: activeRow.blockers,
                lastVerification: activeRow.last_verification
              } : null,
              lastSession: lastSession ? {
                summary: lastSession.last_work,
                workDone: lastSession.current_status,
                nextSteps: lastSession.next_tasks ? JSON.parse(lastSession.next_tasks as string) : [],
                timestamp: lastSession.timestamp
              } : null,
              pendingTasks,
              directives: directives.length > 0 ? directives : undefined,
              hotPaths: hotPaths.length > 0 ? hotPaths : undefined
            }, null, 2)
          }]
        };
      }

      case 'session_end': {
        const project = args.project as string;
        // v1: summary, v2: currentState — 둘 다 호환
        const summary = (args.summary || args.currentState || 'Session ended') as string;
        const workDone = (args.workDone || args.currentState) as string | undefined;
        const rawNextSteps = args.nextSteps;
        const nextSteps: string[] | undefined = Array.isArray(rawNextSteps) ? rawNextSteps : undefined;
        const rawModifiedFiles = args.modifiedFiles || args.recentFiles;
        const modifiedFiles: string[] | undefined = Array.isArray(rawModifiedFiles) ? rawModifiedFiles : undefined;
        const blockers = args.blockers as string | undefined;
        const techStack = args.techStack as Record<string, string> | undefined;

        if (!project) {
          return { content: [{ type: 'text', text: 'Error: project is required' }] };
        }

        // 빈 세션 방지
        const emptyPatterns = ['Session ended', 'Session work completed', 'Session started', ''];
        if (emptyPatterns.includes(summary) && (!modifiedFiles || modifiedFiles.length === 0)) {
          return { content: [{ type: 'text', text: `⏭️ Skipped empty session for ${project}` }] };
        }

        // 세션 저장
        db.prepare(`
          INSERT INTO sessions (project, last_work, current_status, next_tasks, modified_files, issues)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          project,
          summary,
          workDone || summary,
          nextSteps ? JSON.stringify(nextSteps) : null,
          modifiedFiles ? JSON.stringify(modifiedFiles) : null,
          blockers || null
        );

        // 활성 컨텍스트 업데이트
        db.prepare(`
          INSERT OR REPLACE INTO active_context (project, current_state, recent_files, blockers, updated_at)
          VALUES (?, ?, ?, ?, datetime('now'))
        `).run(
          project,
          summary,
          modifiedFiles ? JSON.stringify(modifiedFiles) : null,
          blockers || null
        );

        // techStack 저장 (있으면)
        if (techStack && Object.keys(techStack).length > 0) {
          const existing = db.prepare('SELECT tech_stack FROM project_context WHERE project = ?').get(project) as { tech_stack: string } | undefined;
          let merged = existing?.tech_stack ? JSON.parse(existing.tech_stack) : {};
          merged = { ...merged, ...techStack };
          const json = JSON.stringify(merged);
          db.prepare(`
            INSERT INTO project_context (project, tech_stack, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(project) DO UPDATE SET tech_stack = ?, updated_at = CURRENT_TIMESTAMP
          `).run(project, json, json);
        }

        return { content: [{ type: 'text', text: `✅ Session saved for ${project}\nSummary: ${summary}\nWork: ${workDone || summary}\nFiles: ${modifiedFiles?.length || 0}\nBlockers: ${blockers || 'none'}${techStack ? '\nTech stack updated' : ''}` }] };
      }

      case 'session_history': {
        const project = args.project as string;
        const limit = (args.limit as number) || 5;
        const days = (args.days as number) || 7;

        const sessions = db.prepare(`
          SELECT * FROM sessions
          WHERE project = ? AND timestamp > datetime('now', '-' || ? || ' days')
          ORDER BY timestamp DESC LIMIT ?
        `).all(project, days, limit) as Array<Record<string, unknown>>;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(sessions.map(s => ({
              id: s.id,
              summary: s.last_work,
              workDone: s.current_status,
              nextSteps: s.next_tasks ? JSON.parse(s.next_tasks as string) : [],
              timestamp: s.timestamp
            })), null, 2)
          }]
        };
      }

      case 'search_sessions': {
        const query = args.query as string;
        const project = args.project as string | undefined;
        const limit = (args.limit as number) || 5;

        // 시맨틱 검색 (임베딩 사용)
        const queryEmbedding = await generateEmbedding(query);

        if (!queryEmbedding) {
          // 폴백: 키워드 검색 (기존 스키마: last_work, current_status)
          const sql = project
            ? 'SELECT * FROM sessions WHERE project = ? AND (last_work LIKE ? OR current_status LIKE ?) ORDER BY timestamp DESC LIMIT ?'
            : 'SELECT * FROM sessions WHERE last_work LIKE ? OR current_status LIKE ? ORDER BY timestamp DESC LIMIT ?';

          const params = project
            ? [project, `%${query}%`, `%${query}%`, limit]
            : [`%${query}%`, `%${query}%`, limit];

          const results = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        }

        // 모든 세션 가져와서 유사도 계산
        const allSessions = db.prepare(
          project
            ? 'SELECT * FROM sessions WHERE project = ? ORDER BY timestamp DESC LIMIT 100'
            : 'SELECT * FROM sessions ORDER BY timestamp DESC LIMIT 100'
        ).all(...(project ? [project] : [])) as Array<Record<string, unknown>>;

        // 사전 캐시된 임베딩 활용 (없으면 on-the-fly 생성 후 캐시)
        const scored = await Promise.all(allSessions.map(async (s) => {
          const sessionId = s.id as number;
          // 캐시된 임베딩 확인
          const cached = db.prepare(
            'SELECT embedding FROM embeddings_v4 WHERE entity_type = ? AND entity_id = ?'
          ).get('session', sessionId) as { embedding: Buffer } | undefined;

          let emb: number[] | null = null;
          if (cached?.embedding) {
            emb = Array.from(new Float32Array(cached.embedding.buffer, cached.embedding.byteOffset, cached.embedding.byteLength / 4));
          } else {
            const text = `${s.last_work} ${s.current_status || ''}`;
            emb = await generateEmbedding(text, 'passage');
            // 생성 성공 시 캐시 저장
            if (emb) {
              const buffer = Buffer.from(new Float32Array(emb).buffer);
              db.prepare('INSERT OR REPLACE INTO embeddings_v4 (entity_type, entity_id, embedding) VALUES (?, ?, ?)')
                .run('session', sessionId, buffer);
            }
          }
          const similarity = emb ? cosineSimilarity(queryEmbedding, emb) : 0;
          return { ...s, similarity };
        }));

        scored.sort((a, b) => (b.similarity as number) - (a.similarity as number));
        const top = scored.slice(0, limit) as Array<Record<string, unknown> & { similarity: number }>;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify(top.map(s => ({
              id: s.id,
              project: s.project,
              summary: s.last_work,
              similarity: Math.round(s.similarity * 100) + '%',
              timestamp: s.timestamp
            })), null, 2)
          }]
        };
      }

      // ===== 프로젝트 관리 =====
      case 'project_status': {
        const project = args.project as string;
        const projectPath = getProjectPath(project);

        if (!await fileExists(projectPath)) {
          const hasData = db.prepare('SELECT 1 FROM active_context WHERE project = ?').get(project)
            || db.prepare('SELECT 1 FROM sessions WHERE project = ? LIMIT 1').get(project);
          if (!hasData) {
            return { content: [{ type: 'text', text: `Project not found: ${project}` }] };
          }
        }

        // 태스크 통계
        const taskStats = db.prepare(`
          SELECT status, COUNT(*) as count FROM tasks WHERE project = ? GROUP BY status
        `).all(project) as Array<{ status: string; count: number }>;

        // 최근 세션
        const recentSessions = db.prepare(`
          SELECT last_work as summary, timestamp FROM sessions WHERE project = ? ORDER BY timestamp DESC LIMIT 3
        `).all(project) as Array<{ summary: string; timestamp: string }>;

        // 활성 컨텍스트
        const active = db.prepare('SELECT * FROM active_context WHERE project = ?').get(project) as Record<string, unknown> | undefined;

        // 진행도 계산
        const done = taskStats.find(t => t.status === 'done')?.count || 0;
        const total = taskStats.reduce((sum, t) => sum + t.count, 0);
        const progress = total > 0 ? Math.round((done / total) * 100) : 0;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              project,
              progress: `${progress}%`,
              tasks: {
                done,
                inProgress: taskStats.find(t => t.status === 'in_progress')?.count || 0,
                pending: taskStats.find(t => t.status === 'pending')?.count || 0,
                blocked: taskStats.find(t => t.status === 'blocked')?.count || 0,
                total
              },
              currentState: active?.current_state || 'No active context',
              lastVerification: active?.last_verification || 'N/A',
              recentActivity: recentSessions.map(s => ({
                summary: s.summary,
                date: s.timestamp
              }))
            }, null, 2)
          }]
        };
      }

      case 'project_init': {
        const project = args.project as string;
        const techStack = args.techStack as Record<string, string> | undefined;
        const description = args.description as string | undefined;

        const projectPath = getProjectPath(project);

        // 기술 스택 자동 감지
        const detectedStack = await detectTechStack(projectPath);
        const finalStack = { ...detectedStack, ...techStack };

        db.prepare(`
          INSERT OR REPLACE INTO project_context (project, tech_stack, special_notes, updated_at)
          VALUES (?, ?, ?, datetime('now'))
        `).run(project, JSON.stringify(finalStack), description || null);

        db.prepare(`
          INSERT OR REPLACE INTO active_context (project, current_state, updated_at)
          VALUES (?, 'Project initialized', datetime('now'))
        `).run(project);

        return {
          content: [{
            type: 'text',
            text: `✅ Project "${project}" initialized\nTech Stack: ${JSON.stringify(finalStack)}`
          }]
        };
      }

      case 'project_analyze': {
        const project = args.project as string;
        const projectPath = getProjectPath(project);

        if (!await fileExists(projectPath)) {
          return { content: [{ type: 'text', text: `Project not found: ${project}` }] };
        }

        const platform = await detectPlatform(projectPath);
        const techStack = await detectTechStack(projectPath);

        // 파일 구조 분석
        const structure: string[] = [];
        try {
          const entries = await fs.readdir(projectPath, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            structure.push(entry.isDirectory() ? `📁 ${entry.name}/` : `📄 ${entry.name}`);
          }
        } catch {}

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              project,
              platform,
              techStack,
              structure: structure.slice(0, 20)
            }, null, 2)
          }]
        };
      }

      case 'list_projects': {
        try {
          let projects: string[] = [];

          // 단일 프로젝트 모드
          if (!IS_MONOREPO && DEFAULT_PROJECT) {
            projects = [DEFAULT_PROJECT];
          } else if (IS_MONOREPO) {
            // 모노레포 모드: apps/ 하위 디렉토리
            const entries = await fs.readdir(APPS_DIR, { withFileTypes: true });
            projects = entries
              .filter(e => e.isDirectory() && !e.name.startsWith('.'))
              .map(e => e.name);
          }

          // 각 프로젝트 상태 조회
          const projectsWithStatus = await Promise.all(projects.map(async (p) => {
            const active = db.prepare('SELECT current_state FROM active_context WHERE project = ?').get(p) as { current_state: string } | undefined;
            const taskCount = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE project = ? AND status != ?').get(p, 'done') as { count: number };

            return {
              name: p,
              status: active?.current_state || 'No context',
              pendingTasks: taskCount?.count || 0,
              mode: IS_MONOREPO ? 'monorepo' : 'single'
            };
          }));

          return { content: [{ type: 'text', text: JSON.stringify(projectsWithStatus, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: `Failed to list projects: ${error instanceof Error ? error.message : String(error)}` }] };
        }
      }

      // ===== 태스크/백로그 =====
      case 'task_add': {
        const project = args.project as string;
        const title = args.title as string;
        const description = args.description as string | undefined;
        const priority = (args.priority as number) || 5;
        const relatedFiles = args.relatedFiles as string[] | undefined;

        const result = db.prepare(`
          INSERT INTO tasks (project, title, description, priority, related_files)
          VALUES (?, ?, ?, ?, ?)
        `).run(project, title, description || null, priority, relatedFiles ? JSON.stringify(relatedFiles) : null);

        return {
          content: [{
            type: 'text',
            text: `✅ Task added (ID: ${result.lastInsertRowid})\n[P${priority}] ${title}`
          }]
        };
      }

      case 'task_update': {
        const taskId = args.taskId as number;
        const status = args.status as string;
        const note = args.note as string | undefined;

        const completedAt = status === 'done' ? "datetime('now')" : 'NULL';

        db.prepare(`
          UPDATE tasks SET status = ?, completed_at = ${status === 'done' ? "datetime('now')" : 'NULL'}
          WHERE id = ?
        `).run(status, taskId);

        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;

        return {
          content: [{
            type: 'text',
            text: `✅ Task #${taskId} → ${status}${note ? `\nNote: ${note}` : ''}\n${task?.title || ''}`
          }]
        };
      }

      case 'task_list': {
        const project = args.project as string;
        const status = (args.status as string) || 'pending';

        const sql = status === 'all'
          ? 'SELECT * FROM tasks WHERE project = ? ORDER BY priority DESC, created_at DESC'
          : 'SELECT * FROM tasks WHERE project = ? AND status = ? ORDER BY priority DESC, created_at DESC';

        const tasks = status === 'all'
          ? db.prepare(sql).all(project)
          : db.prepare(sql).all(project, status);

        return { content: [{ type: 'text', text: JSON.stringify({ project, status, count: tasks.length, tasks }, null, 2) }] };
      }

      case 'task_suggest': {
        const project = args.project as string;
        const searchPath = args.path as string | undefined;
        const projectPath = path.join(getProjectPath(project), searchPath || '');

        // TODO, FIXME 등 검색
        try {
          const result = runCommand(
            `grep -rn "TODO\\|FIXME\\|HACK\\|XXX" --include="*.ts" --include="*.tsx" --include="*.dart" --include="*.kt" . | head -20`,
            projectPath
          );

          if (!result.success || !result.output.trim()) {
            return { content: [{ type: 'text', text: 'No TODO/FIXME comments found' }] };
          }

          const lines = result.output.trim().split('\n');
          const suggestions = lines.map(line => {
            const match = line.match(/^(.+?):(\d+):(.+)$/);
            if (match) {
              return {
                file: match[1],
                line: parseInt(match[2]),
                comment: match[3].trim()
              };
            }
            return { comment: line };
          });

          return {
            content: [{
              type: 'text',
              text: `Found ${suggestions.length} potential tasks:\n\n${JSON.stringify(suggestions, null, 2)}`
            }]
          };
        } catch {
          return { content: [{ type: 'text', text: 'Failed to search for tasks' }] };
        }
      }

      // ===== 솔루션 아카이브 =====
      case 'solution_record': {
        const project = args.project as string | undefined;
        const errorSignature = args.errorSignature as string;
        const errorMessage = args.errorMessage as string | undefined;
        const solution = args.solution as string;
        const relatedFiles = args.relatedFiles as string[] | undefined;

        // 키워드 자동 추출
        const keywords = errorSignature.toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 2)
          .slice(0, 10)
          .join(',');

        const result = db.prepare(`
          INSERT INTO solutions (project, error_signature, error_message, solution, related_files, keywords)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          project || null,
          errorSignature,
          errorMessage || null,
          solution,
          relatedFiles ? JSON.stringify(relatedFiles) : null,
          keywords
        );

        // 임베딩 저장 (시맨틱 검색용, 재시도 포함)
        storeEmbeddingWithRetry(db, 'solution', result.lastInsertRowid, `${errorSignature} ${errorMessage || ''} ${solution}`);

        return {
          content: [{
            type: 'text',
            text: `✅ Solution recorded (ID: ${result.lastInsertRowid})\nSignature: ${errorSignature}`
          }]
        };
      }

      case 'solution_find': {
        const query = args.query as string;
        const project = args.project as string | undefined;
        const limit = (args.limit as number) || 3;
        const semantic = args.semantic === true;

        let solutionResults: Array<Record<string, unknown>> = [];

        if (semantic) {
          // 시맨틱 검색 (임베딩 기반)
          const queryEmb = await generateEmbedding(query);
          if (queryEmb) {
            const allSolutions = db.prepare(`
              SELECT s.*, e.embedding FROM solutions s
              LEFT JOIN embeddings_v4 e ON e.entity_type = 'solution' AND e.entity_id = s.id
              ${project ? 'WHERE s.project = ?' : ''}
              ORDER BY s.created_at DESC LIMIT 50
            `).all(
              ...(project ? [project] : [])
            ) as Array<Record<string, unknown>>;

            const scored = allSolutions.map(s => {
              if (!s.embedding) return { ...s, similarity: 0 };
              const emb = Array.from(new Float32Array((s.embedding as Buffer).buffer));
              return { ...s, similarity: cosineSimilarity(queryEmb, emb) };
            });

            scored.sort((a, b) => (b.similarity as number) - (a.similarity as number));
            solutionResults = scored.filter(s => (s.similarity as number) > 0.3).slice(0, limit);
          }
        } else {
          // 키워드 검색 (LIKE 기반, 단어별 OR)
          // 2026-07-09 audit-7 방안A: 공용 토큰화(stopword 제거)로 흔한 단어가 아무
          //   solution이나 잡는 오탐 감소. 의미 토큰이 없으면 raw split 폴백.
          const solTokens = tokenizeQuery(query);
          const words = solTokens.length > 0
            ? solTokens
            : query.split(/\s+/).filter(w => w.length > 0);
          const wordConditions = words.map(() =>
            '(error_signature LIKE ? OR error_message LIKE ? OR solution LIKE ? OR keywords LIKE ?)'
          ).join(' OR ');
          const wordParams: unknown[] = [];
          words.forEach(w => {
            wordParams.push(`%${w}%`, `%${w}%`, `%${w}%`, `%${w}%`);
          });

          let sql = `SELECT * FROM solutions WHERE (${wordConditions || 'error_signature LIKE ?'})`;
          const params: unknown[] = wordConditions ? wordParams : [`%${query}%`];

          if (project) {
            sql += ` AND project = ?`;
            params.push(project);
          }
          sql += ` ORDER BY created_at DESC LIMIT ?`;
          params.push(limit);

          solutionResults = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
        }

        const results = solutionResults.map(r => ({
          id: r.id,
          errorSignature: r.error_signature,
          errorMessage: r.error_message,
          solution: r.solution,
          project: r.project,
          relatedFiles: r.related_files,
          similarity: r.similarity ? Math.round((r.similarity as number) * 100) + '%' : undefined,
          created: r.created_at
        }));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              query,
              mode: semantic ? 'semantic' : 'keyword',
              found: results.length,
              results
            }, null, 2)
          }]
        };
      }

      case 'solution_suggest': {
        const errorMessage = args.errorMessage as string;
        const project = args.project as string | undefined;

        // solution_find 결과를 기반으로 제안
        const similar = db.prepare(`
          SELECT * FROM solutions
          WHERE error_signature LIKE ? OR error_message LIKE ?
          ${project ? 'AND project = ?' : ''}
          ORDER BY created_at DESC LIMIT 3
        `).all(
          `%${errorMessage.substring(0, 50)}%`,
          `%${errorMessage.substring(0, 50)}%`,
          ...(project ? [project] : [])
        ) as Array<Record<string, unknown>>;

        if (similar.length === 0) {
          return { content: [{ type: 'text', text: 'No similar solutions found. This might be a new error.' }] };
        }

        const suggestions = similar.map((s, i) => `
### Solution ${i + 1} (from: ${s.project || 'global'})
**Error**: ${s.error_signature}
**Solution**: ${s.solution}
        `).join('\n');

        return {
          content: [{
            type: 'text',
            text: `Found ${similar.length} similar solutions:\n${suggestions}`
          }]
        };
      }

      // ===== 검증/품질 =====
      case 'verify_build': {
        const project = args.project as string;
        const projectPath = getProjectPath(project);
        const platform = await detectPlatform(projectPath);

        let cmd: string;
        switch (platform) {
          case 'flutter':
            cmd = 'flutter build apk --debug';
            break;
          case 'android':
            cmd = './gradlew assembleDebug';
            break;
          case 'web':
            cmd = 'pnpm build';
            break;
          default:
            return { content: [{ type: 'text', text: `Unknown platform: ${platform}` }] };
        }

        const result = runCommand(cmd, projectPath);

        // 결과 저장
        db.prepare(`
          INSERT OR REPLACE INTO active_context (project, last_verification, updated_at)
          VALUES (?, ?, datetime('now'))
        `).run(project, result.success ? 'build:passed' : 'build:failed');

        return {
          content: [{
            type: 'text',
            text: `${result.success ? '✅' : '❌'} Build ${result.success ? 'passed' : 'failed'}\n\n${result.output.slice(-1000)}`
          }]
        };
      }

      case 'verify_test': {
        const project = args.project as string;
        const testPath = args.testPath as string | undefined;
        const projectPath = getProjectPath(project);
        const platform = await detectPlatform(projectPath);

        let cmd: string;
        switch (platform) {
          case 'flutter':
            cmd = testPath ? `flutter test ${testPath}` : 'flutter test';
            break;
          case 'web':
            cmd = testPath ? `pnpm test ${testPath}` : 'pnpm test';
            break;
          default:
            return { content: [{ type: 'text', text: `Tests not configured for platform: ${platform}` }] };
        }

        const result = runCommand(cmd, projectPath);

        return {
          content: [{
            type: 'text',
            text: `${result.success ? '✅' : '❌'} Tests ${result.success ? 'passed' : 'failed'}\n\n${result.output.slice(-1000)}`
          }]
        };
      }

      case 'verify_all': {
        const project = args.project as string;
        const stopOnFail = args.stopOnFail === true;
        const projectPath = getProjectPath(project);
        const platform = await detectPlatform(projectPath);

        const results: { step: string; success: boolean; output: string }[] = [];

        // Build
        let buildCmd: string;
        let testCmd: string;
        let lintCmd: string;

        switch (platform) {
          case 'flutter':
            buildCmd = 'flutter build apk --debug';
            testCmd = 'flutter test';
            lintCmd = 'flutter analyze';
            break;
          case 'web':
            buildCmd = 'pnpm build';
            testCmd = 'pnpm test';
            lintCmd = 'pnpm lint';
            break;
          default:
            return { content: [{ type: 'text', text: `Unknown platform: ${platform}` }] };
        }

        // Execute each step
        for (const [name, cmd] of [['build', buildCmd], ['test', testCmd], ['lint', lintCmd]]) {
          const result = runCommand(cmd, projectPath);
          results.push({ step: name, success: result.success, output: result.output.slice(-500) });

          if (!result.success && stopOnFail) break;
        }

        const allPassed = results.every(r => r.success);

        // 결과 저장
        db.prepare(`
          INSERT OR REPLACE INTO active_context (project, last_verification, updated_at)
          VALUES (?, ?, datetime('now'))
        `).run(project, allPassed ? 'all:passed' : 'all:failed');

        const summary = results.map(r =>
          `${r.success ? '✅' : '❌'} ${r.step}: ${r.success ? 'passed' : 'failed'}`
        ).join('\n');

        return {
          content: [{
            type: 'text',
            text: `## Verification Results\n\n${summary}\n\n### Details\n${results.map(r => `**${r.step}**:\n${r.output}`).join('\n\n')}`
          }]
        };
      }

      // ===== 6. 메모리 시스템 =====
      case 'memory_store': {
        const content = args.content as string;
        const memoryType = args.type as string;
        const project = args.project as string | undefined;
        const rawTags = args.tags;
        const tags: string[] | undefined = Array.isArray(rawTags) ? rawTags : (typeof rawTags === 'string' ? rawTags.split(',').map((t: string) => t.trim()).filter(Boolean) : undefined);
        const importance = (args.importance as number) || 5;
        const relatedTo = args.relatedTo as number | undefined;

        // 필수 파라미터 검증
        if (!content || content.trim().length === 0) {
          return { content: [{ type: 'text', text: 'Error: content is required and cannot be empty' }] };
        }
        if (!memoryType) {
          return { content: [{ type: 'text', text: 'Error: type is required' }] };
        }

        // 메모리 저장
        const result = db.prepare(`
          INSERT INTO memories (content, memory_type, tags, project, importance, metadata)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          content,
          memoryType,
          tags ? JSON.stringify(tags) : null,
          project || null,
          importance,
          null
        );

        const memoryId = result.lastInsertRowid as number;

        // 임베딩 생성 (재시도 포함)
        storeEmbeddingWithRetry(db, 'memory', memoryId, content);

        // 관계 자동 생성
        if (relatedTo) {
          db.prepare(`
            INSERT OR IGNORE INTO memory_relations (source_id, target_id, relation_type, strength)
            VALUES (?, ?, 'related_to', 1.0)
          `).run(memoryId, relatedTo);
        }

        return {
          content: [{
            type: 'text',
            text: `✅ Memory stored (ID: ${memoryId})\nType: ${memoryType}\nProject: ${project || 'global'}\nTags: ${tags?.join(', ') || 'none'}`
          }]
        };
      }

      case 'memory_search': {
        const query = args.query as string;
        const memoryType = args.type as string | undefined;
        const project = args.project as string | undefined;
        const tags = args.tags as string[] | undefined;
        const semantic = args.semantic === true;
        const minImportance = (args.minImportance as number) || 1;
        const limit = (args.limit as number) || 10;

        let results: Array<Record<string, unknown>> = [];

        if (semantic) {
          // 시맨틱 검색 (임베딩 기반)
          const queryEmb = await generateEmbedding(query);
          if (queryEmb) {
            const allMemories = db.prepare(`
              SELECT m.*, e.embedding FROM memories m
              LEFT JOIN embeddings_v4 e ON e.entity_type = 'memory' AND e.entity_id = m.id
              WHERE m.importance >= ?
              ${memoryType && memoryType !== 'all' ? 'AND m.memory_type = ?' : ''}
              ${project ? 'AND m.project = ?' : ''}
              ORDER BY m.importance DESC
              LIMIT 100
            `).all(
              minImportance,
              ...(memoryType && memoryType !== 'all' ? [memoryType] : []),
              ...(project ? [project] : [])
            ) as Array<Record<string, unknown>>;

            const scored = allMemories.map(m => {
              if (!m.embedding) return { ...m, similarity: 0 };
              const emb = Array.from(new Float32Array((m.embedding as Buffer).buffer));
              return { ...m, similarity: cosineSimilarity(queryEmb, emb) };
            });

            scored.sort((a, b) => (b.similarity as number) - (a.similarity as number));
            results = scored.filter(m => (m.similarity as number) > 0.3).slice(0, limit);
          }
        } else {
          // FTS5 + bm25() 랭킹 우선, 결과 없으면 LIKE 폴백
          // (P1-2, 2026-05-22: 7-agent 검증 후 적용)
          // 2026-07-09 audit-7 방안A: 공용 토큰화로 자동주입과 같은 한국어/다구 품질.
          //   의미 토큰이 없으면 raw split 폴백(recall 보존).
          const semanticTokens = tokenizeQuery(query);
          const words = semanticTokens.length > 0
            ? semanticTokens
            : query.split(/\s+/).filter(w => w.length > 0);

          // 1차: FTS5 MATCH + bm25() 점수
          let ftsResults: Array<Record<string, unknown>> = [];
          try {
            const ftsQuery = buildFtsQuery(words, true) ?? query;  // expandEnglish: 영어 복수/시제 recall
            let ftsSql = `
              SELECT m.*, bm25(memories_fts) AS bm25_score
              FROM memories_fts fts
              JOIN memories m ON m.id = fts.rowid
              WHERE memories_fts MATCH ?
              AND m.importance >= ?
            `;
            const ftsParams: unknown[] = [ftsQuery, minImportance];

            if (memoryType && memoryType !== 'all') {
              ftsSql += ` AND m.memory_type = ?`;
              ftsParams.push(memoryType);
            }
            if (project) {
              ftsSql += ` AND m.project = ?`;
              ftsParams.push(project);
            }
            if (tags && tags.length > 0) {
              ftsSql += ` AND (${tags.map(() => 'm.tags LIKE ?').join(' OR ')})`;
              ftsParams.push(...tags.map(t => `%"${t}"%`));
            }
            // bm25는 낮을수록 관련도 높음. importance 가중치 더해 종합 랭킹.
            ftsSql += ` ORDER BY bm25_score ASC, m.importance DESC LIMIT ?`;
            ftsParams.push(limit);

            ftsResults = db.prepare(ftsSql).all(...ftsParams) as Array<Record<string, unknown>>;
          } catch {
            // FTS5 구문 오류(MATCH 토큰 이슈) 시 폴백
            ftsResults = [];
          }

          if (ftsResults.length > 0) {
            results = ftsResults;
          } else {
            // 2차 폴백: LIKE (FTS5 0건 시 — 한국어 부분일치 등)
            const likeConditions = words.map(() => '(content LIKE ? OR tags LIKE ?)').join(' OR ');
            const likeParams: unknown[] = [];
            words.forEach(w => {
              likeParams.push(`%${w}%`, `%${w}%`);
            });

            let sql = `
              SELECT * FROM memories
              WHERE (${likeConditions || 'content LIKE ?'})
              AND importance >= ?
            `;
            const params: unknown[] = [...(likeConditions ? likeParams : [`%${query}%`]), minImportance];

            if (memoryType && memoryType !== 'all') {
              sql += ` AND memory_type = ?`;
              params.push(memoryType);
            }
            if (project) {
              sql += ` AND project = ?`;
              params.push(project);
            }
            if (tags && tags.length > 0) {
              sql += ` AND (${tags.map(() => 'tags LIKE ?').join(' OR ')})`;
              params.push(...tags.map(t => `%"${t}"%`));
            }

            sql += ` ORDER BY importance DESC, accessed_at DESC LIMIT ?`;
            params.push(limit);

            results = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
          }
        }

        // 접근 기록 업데이트
        const ids = results.map(r => r.id);
        if (ids.length > 0) {
          db.prepare(`
            UPDATE memories SET accessed_at = datetime('now'), access_count = access_count + 1
            WHERE id IN (${ids.join(',')})
          `).run();
        }

        const formatted = results.map(m => ({
          id: m.id,
          content: (m.content as string).substring(0, 300) + ((m.content as string).length > 300 ? '...' : ''),
          type: m.memory_type,
          project: m.project || 'global',
          tags: parseTags(m.tags as string),
          importance: m.importance,
          similarity: m.similarity ? Math.round((m.similarity as number) * 100) + '%' : undefined,
          created: m.created_at
        }));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              query,
              mode: semantic ? 'semantic' : 'keyword',
              found: formatted.length,
              results: formatted
            }, null, 2)
          }]
        };
      }

      case 'memory_get': {
        const ids = args.ids as number[];
        if (!ids || ids.length === 0) {
          return { content: [{ type: 'text', text: 'ids 배열이 필요합니다.' }] };
        }
        const placeholders = ids.map(() => '?').join(',');
        const memRows = db.prepare(`
          SELECT id, content, memory_type, tags, project, importance, created_at, access_count, metadata
          FROM memories WHERE id IN (${placeholders})
        `).all(...ids) as Array<Record<string, unknown>>;

        // access_count 업데이트
        if (memRows.length > 0) {
          db.prepare(`
            UPDATE memories SET accessed_at = datetime('now'), access_count = access_count + 1
            WHERE id IN (${memRows.map(r => r.id).join(',')})
          `).run();
        }

        const memResults = memRows.map(row => ({
          id: row.id,
          content: row.content,
          type: row.memory_type,
          project: row.project || 'global',
          tags: parseTags(row.tags as string),
          importance: row.importance,
          accessCount: (row.access_count as number) + 1,
          createdAt: row.created_at
        }));

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ found: memResults.length, memories: memResults }, null, 2)
          }]
        };
      }

      case 'memory_related': {
        const memoryId = args.memoryId as number;
        const includeGraph = args.includeGraph !== false;
        const includeSemantic = args.includeSemantic !== false;
        const limit = (args.limit as number) || 10;

        const related: Array<{
          id: number;
          content: string;
          type: string;
          source: 'graph' | 'semantic';
          relation?: string;
          similarity?: string;
        }> = [];

        // 기준 메모리 조회
        const baseMemory = db.prepare('SELECT * FROM memories WHERE id = ?').get(memoryId) as Record<string, unknown> | undefined;
        if (!baseMemory) {
          return { content: [{ type: 'text', text: `Memory not found: ${memoryId}` }] };
        }

        // 1. 지식 그래프 관계
        if (includeGraph) {
          const graphRelated = db.prepare(`
            SELECT m.id, m.content, m.memory_type, r.relation_type, r.strength, 'outgoing' as direction
            FROM memory_relations r
            JOIN memories m ON m.id = r.target_id
            WHERE r.source_id = ?
            UNION ALL
            SELECT m.id, m.content, m.memory_type, r.relation_type, r.strength, 'incoming' as direction
            FROM memory_relations r
            JOIN memories m ON m.id = r.source_id
            WHERE r.target_id = ?
            ORDER BY strength DESC
            LIMIT ?
          `).all(memoryId, memoryId, limit) as Array<Record<string, unknown>>;

          for (const r of graphRelated) {
            related.push({
              id: r.id as number,
              content: (r.content as string).substring(0, 200),
              type: r.memory_type as string,
              source: 'graph',
              relation: `${r.relation_type} (${r.direction})`
            });
          }
        }

        // 2. 시맨틱 유사 메모리
        if (includeSemantic) {
          const baseEmb = db.prepare(`
            SELECT embedding FROM embeddings_v4 WHERE entity_type = 'memory' AND entity_id = ?
          `).get(memoryId) as { embedding: Buffer } | undefined;

          if (baseEmb) {
            const baseVec = Array.from(new Float32Array(baseEmb.embedding.buffer));
            const allMemories = db.prepare(`
              SELECT m.id, m.content, m.memory_type, e.embedding
              FROM memories m
              JOIN embeddings_v4 e ON e.entity_type = 'memory' AND e.entity_id = m.id
              WHERE m.id != ?
              LIMIT 100
            `).all(memoryId) as Array<Record<string, unknown>>;

            const scored = allMemories.map(m => ({
              id: m.id as number,
              content: m.content as string,
              memory_type: m.memory_type as string,
              similarity: cosineSimilarity(baseVec, Array.from(new Float32Array((m.embedding as Buffer).buffer)))
            }));

            scored.sort((a, b) => b.similarity - a.similarity);
            const existingIds = new Set(related.map(r => r.id));

            for (const m of scored.slice(0, limit)) {
              if (m.similarity > 0.5 && !existingIds.has(m.id)) {
                related.push({
                  id: m.id,
                  content: m.content.substring(0, 200),
                  type: m.memory_type,
                  source: 'semantic',
                  similarity: Math.round(m.similarity * 100) + '%'
                });
              }
            }
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              baseMemory: {
                id: baseMemory.id,
                content: (baseMemory.content as string).substring(0, 200),
                type: baseMemory.memory_type
              },
              related: related.slice(0, limit)
            }, null, 2)
          }]
        };
      }

      case 'memory_stats': {
        const project = args.project as string | undefined;

        const totalMemories = (db.prepare(
          project
            ? 'SELECT COUNT(*) as count FROM memories WHERE project = ?'
            : 'SELECT COUNT(*) as count FROM memories'
        ).get(...(project ? [project] : [])) as { count: number }).count;

        const byType = db.prepare(
          project
            ? 'SELECT memory_type as type, COUNT(*) as count FROM memories WHERE project = ? GROUP BY memory_type'
            : 'SELECT memory_type as type, COUNT(*) as count FROM memories GROUP BY memory_type'
        ).all(...(project ? [project] : [])) as Array<{ type: string; count: number }>;

        const byProject = db.prepare(`
          SELECT COALESCE(project, 'global') as project, COUNT(*) as count
          FROM memories GROUP BY project ORDER BY count DESC LIMIT 10
        `).all() as Array<{ project: string; count: number }>;

        const totalRelations = (db.prepare('SELECT COUNT(*) as count FROM memory_relations').get() as { count: number }).count;

        const relationsByType = db.prepare(`
          SELECT relation_type as type, COUNT(*) as count
          FROM memory_relations GROUP BY relation_type
        `).all() as Array<{ type: string; count: number }>;

        const recentMemories = db.prepare(`
          SELECT id, memory_type, content, created_at
          FROM memories
          ${project ? 'WHERE project = ?' : ''}
          ORDER BY created_at DESC LIMIT 5
        `).all(...(project ? [project] : [])) as Array<Record<string, unknown>>;

        const topAccessedMemories = db.prepare(`
          SELECT id, memory_type, content, access_count
          FROM memories
          ${project ? 'WHERE project = ?' : ''}
          ORDER BY access_count DESC LIMIT 5
        `).all(...(project ? [project] : [])) as Array<Record<string, unknown>>;

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              summary: {
                totalMemories,
                totalRelations,
                embeddingsCount: (db.prepare('SELECT COUNT(*) as count FROM embeddings_v4 WHERE entity_type = ?').get('memory') as { count: number }).count
              },
              byType: Object.fromEntries(byType.map(r => [r.type, r.count])),
              byProject: Object.fromEntries(byProject.map(r => [r.project, r.count])),
              relationsByType: Object.fromEntries(relationsByType.map(r => [r.type, r.count])),
              recentMemories: recentMemories.map(m => ({
                id: m.id,
                type: m.memory_type,
                content: (m.content as string).substring(0, 100),
                created: m.created_at
              })),
              topAccessedMemories: topAccessedMemories.map(m => ({
                id: m.id,
                type: m.memory_type,
                content: (m.content as string).substring(0, 100),
                accessCount: m.access_count
              }))
            }, null, 2)
          }]
        };
      }

      // ===== 7. 지식 그래프 =====
      case 'graph_connect': {
        const sourceId = args.sourceId as number;
        const targetId = args.targetId as number;
        const relation = args.relation as string;
        const strength = (args.strength as number) || 1.0;

        // 메모리 존재 확인
        const sourceExists = db.prepare('SELECT id FROM memories WHERE id = ?').get(sourceId);
        const targetExists = db.prepare('SELECT id FROM memories WHERE id = ?').get(targetId);

        if (!sourceExists || !targetExists) {
          return { content: [{ type: 'text', text: `Memory not found: ${!sourceExists ? sourceId : targetId}` }] };
        }

        const result = db.prepare(`
          INSERT OR REPLACE INTO memory_relations (source_id, target_id, relation_type, strength)
          VALUES (?, ?, ?, ?)
        `).run(sourceId, targetId, relation, strength);

        return {
          content: [{
            type: 'text',
            text: `✅ Relation created\n${sourceId} --[${relation}]--> ${targetId}\nStrength: ${strength}`
          }]
        };
      }

      case 'graph_explore': {
        const memoryId = args.memoryId as number;
        const maxDepth = Math.min((args.depth as number) || 2, 4);
        const relationFilter = args.relation as string | undefined;
        const direction = (args.direction as string) || 'both';

        const visited = new Set<number>();
        const nodes: Array<{
          id: number;
          content: string;
          type: string;
          depth: number;
        }> = [];
        const edges: Array<{
          from: number;
          to: number;
          relation: string;
          strength: number;
        }> = [];

        function explore(currentId: number, currentDepth: number) {
          if (currentDepth > maxDepth || visited.has(currentId)) return;
          visited.add(currentId);

          const memory = db.prepare('SELECT id, content, memory_type FROM memories WHERE id = ?').get(currentId) as Record<string, unknown> | undefined;
          if (memory) {
            nodes.push({
              id: memory.id as number,
              content: (memory.content as string).substring(0, 100),
              type: memory.memory_type as string,
              depth: currentDepth
            });
          }

          // 나가는 관계
          if (direction === 'outgoing' || direction === 'both') {
            let sql = 'SELECT target_id, relation_type, strength FROM memory_relations WHERE source_id = ?';
            const params: unknown[] = [currentId];
            if (relationFilter && relationFilter !== 'all') {
              sql += ' AND relation_type = ?';
              params.push(relationFilter);
            }
            const outgoing = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
            for (const r of outgoing) {
              edges.push({
                from: currentId,
                to: r.target_id as number,
                relation: r.relation_type as string,
                strength: r.strength as number
              });
              explore(r.target_id as number, currentDepth + 1);
            }
          }

          // 들어오는 관계
          if (direction === 'incoming' || direction === 'both') {
            let sql = 'SELECT source_id, relation_type, strength FROM memory_relations WHERE target_id = ?';
            const params: unknown[] = [currentId];
            if (relationFilter && relationFilter !== 'all') {
              sql += ' AND relation_type = ?';
              params.push(relationFilter);
            }
            const incoming = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
            for (const r of incoming) {
              edges.push({
                from: r.source_id as number,
                to: currentId,
                relation: r.relation_type as string,
                strength: r.strength as number
              });
              explore(r.source_id as number, currentDepth + 1);
            }
          }
        }

        explore(memoryId, 0);

        // 중복 엣지 제거
        const uniqueEdges = edges.filter((edge, index, self) =>
          index === self.findIndex(e => e.from === edge.from && e.to === edge.to && e.relation === edge.relation)
        );

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              startNode: memoryId,
              depth: maxDepth,
              direction,
              relationFilter: relationFilter || 'all',
              graph: {
                nodes: nodes.length,
                edges: uniqueEdges.length,
                nodeList: nodes,
                edgeList: uniqueEdges
              }
            }, null, 2)
          }]
        };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

// ===== Prompts 정의 (자동 컨텍스트 주입) =====

interface Prompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

const prompts: Prompt[] = [
  {
    name: 'project-context',
    title: '프로젝트 컨텍스트 로드',
    description: '프로젝트의 전체 컨텍스트를 자동으로 로드합니다. 세션 시작 시 사용하세요.',
    arguments: [
      {
        name: 'project',
        description: '프로젝트 이름 (예: saju-mung, hero-maker)',
        required: true
      }
    ]
  },
  {
    name: 'recent-memories',
    title: '최근 메모리 조회',
    description: '최근에 저장된 중요한 메모리(학습, 결정, 에러 등)를 자동으로 로드합니다.',
    arguments: [
      {
        name: 'project',
        description: '프로젝트 이름 (선택, 없으면 전체)',
        required: false
      },
      {
        name: 'limit',
        description: '조회할 메모리 개수 (기본: 10)',
        required: false
      }
    ]
  },
  {
    name: 'work-context',
    title: '/work 작업 컨텍스트',
    description: '프로젝트 작업 시작 시 필요한 모든 컨텍스트를 한 번에 로드합니다.',
    arguments: [
      {
        name: 'project',
        description: '프로젝트 이름',
        required: true
      }
    ]
  }
];

// ===== Prompt 내용 생성 함수 =====

async function generateProjectContext(project: string): Promise<string> {
  const projectPath = getProjectPath(project);

  // 프로젝트 존재 확인
  if (!await fileExists(projectPath)) {
    return `⚠️ 프로젝트를 찾을 수 없습니다: ${project}\n\napps/ 디렉토리에서 사용 가능한 프로젝트를 확인하세요.`;
  }

  const lines: string[] = [`# 🚀 ${project} 프로젝트 컨텍스트\n`];

  // 1. 고정 컨텍스트 (기술 스택, 아키텍처)
  const fixedRow = db.prepare('SELECT * FROM project_context WHERE project = ?').get(project) as Record<string, unknown> | undefined;
  if (fixedRow?.tech_stack) {
    const stack = JSON.parse(fixedRow.tech_stack as string);
    lines.push(`## 기술 스택`);
    lines.push(Object.entries(stack).map(([k, v]) => `- **${k}**: ${v}`).join('\n'));
    lines.push('');
  }

  // 2. 활성 컨텍스트 (현재 상태)
  const activeRow = db.prepare('SELECT * FROM active_context WHERE project = ?').get(project) as Record<string, unknown> | undefined;
  if (activeRow) {
    lines.push(`## 현재 상태`);
    if (activeRow.current_state) lines.push(`**상태**: ${activeRow.current_state}`);
    if (activeRow.blockers) lines.push(`**🚧 블로커**: ${activeRow.blockers}`);
    if (activeRow.last_verification) lines.push(`**마지막 검증**: ${activeRow.last_verification}`);
    if (activeRow.recent_files) {
      const files = JSON.parse(activeRow.recent_files as string);
      if (files.length > 0) lines.push(`**최근 수정 파일**: ${files.join(', ')}`);
    }
    lines.push('');
  }

  // 3. 최근 세션
  const lastSession = db.prepare(`
    SELECT last_work, current_status, next_tasks, timestamp
    FROM sessions WHERE project = ? ORDER BY timestamp DESC LIMIT 1
  `).get(project) as Record<string, unknown> | undefined;

  if (lastSession) {
    lines.push(`## 마지막 세션 (${lastSession.timestamp})`);
    lines.push(`**작업**: ${lastSession.last_work}`);
    if (lastSession.current_status) lines.push(`**진행**: ${lastSession.current_status}`);
    if (lastSession.next_tasks) {
      const tasks = JSON.parse(lastSession.next_tasks as string);
      if (tasks.length > 0) lines.push(`**다음 할 일**: ${tasks.join(', ')}`);
    }
    lines.push('');
  }

  // 4. 미완료 태스크 (상위 5개)
  const pendingTasks = db.prepare(`
    SELECT id, title, priority, status FROM tasks
    WHERE project = ? AND status IN ('pending', 'in_progress')
    ORDER BY priority DESC, created_at DESC LIMIT 5
  `).all(project) as Array<{ id: number; title: string; priority: number; status: string }>;

  if (pendingTasks.length > 0) {
    lines.push(`## 📋 미완료 태스크`);
    for (const task of pendingTasks) {
      const statusIcon = task.status === 'in_progress' ? '🔄' : '⏳';
      lines.push(`- ${statusIcon} [P${task.priority}] ${task.title} (#${task.id})`);
    }
    lines.push('');
  }

  // 5. 중요 메모리 (노이즈 필터링 - v1.10.0)
  const recentMemories = db.prepare(`
    SELECT id, content, memory_type, importance FROM memories
    WHERE project = ?
      AND memory_type IN ('decision', 'learning', 'error', 'preference')
      AND importance >= 5
      AND (tags NOT LIKE '%auto-tracked%' OR tags IS NULL)
      AND (tags NOT LIKE '%auto-compact%' OR tags IS NULL)
    ORDER BY importance DESC, accessed_at DESC LIMIT 5
  `).all(project) as Array<{ id: number; content: string; memory_type: string; importance: number }>;

  if (recentMemories.length > 0) {
    lines.push(`## 🧠 Key Memories`);
    for (const mem of recentMemories) {
      const typeIcon: Record<string, string> = {
        decision: '🎯',
        learning: '📚',
        error: '⚠️',
        preference: '💡'
      };
      const icon = typeIcon[mem.memory_type] || '💭';
      lines.push(`- ${icon} ${mem.content.substring(0, 100)}${mem.content.length > 100 ? '...' : ''}`);
    }
    lines.push('');
  }

  // 6. 최근 해결한 에러 (3개)
  const recentSolutions = db.prepare(`
    SELECT error_signature, solution FROM solutions
    WHERE project = ?
    ORDER BY created_at DESC LIMIT 3
  `).all(project) as Array<{ error_signature: string; solution: string }>;

  if (recentSolutions.length > 0) {
    lines.push(`## 🔧 최근 해결한 에러`);
    for (const sol of recentSolutions) {
      lines.push(`- **${sol.error_signature}**: ${sol.solution.substring(0, 80)}...`);
    }
    lines.push('');
  }

  lines.push(`---\n_이 컨텍스트는 자동으로 주입되었습니다. 작업 종료 시 session_end를 호출하세요._`);

  return lines.join('\n');
}

async function generateRecentMemories(project?: string, limit: number = 10): Promise<string> {
  const lines: string[] = ['# 🧠 최근 메모리\n'];

  const noiseFilter = `AND memory_type IN ('decision','learning','error','preference') AND importance >= 5 AND (tags NOT LIKE '%auto-tracked%' OR tags IS NULL) AND (tags NOT LIKE '%auto-compact%' OR tags IS NULL)`;
  const sql = project
    ? `SELECT id, content, memory_type, project, importance, created_at FROM memories WHERE project = ? ${noiseFilter} ORDER BY importance DESC, created_at DESC LIMIT ?`
    : `SELECT id, content, memory_type, project, importance, created_at FROM memories WHERE 1=1 ${noiseFilter} ORDER BY importance DESC, created_at DESC LIMIT ?`;

  const memories = project
    ? db.prepare(sql).all(project, limit)
    : db.prepare(sql).all(limit);

  if ((memories as unknown[]).length === 0) {
    return '저장된 메모리가 없습니다.';
  }

  const typeIcons: Record<string, string> = {
    observation: '👀 관찰',
    decision: '🎯 결정',
    learning: '📚 학습',
    error: '⚠️ 에러',
    pattern: '🔄 패턴'
  };

  for (const mem of memories as Array<Record<string, unknown>>) {
    lines.push(`### ${typeIcons[mem.memory_type as string] || '💭'} (${mem.project || 'global'})`);
    lines.push(`> ${mem.content}`);
    lines.push(`_중요도: ${mem.importance} | ${mem.created_at}_\n`);
  }

  return lines.join('\n');
}

async function generateWorkContext(project: string): Promise<string> {
  const lines: string[] = [];

  // 프로젝트 컨텍스트
  const projectContext = await generateProjectContext(project);
  lines.push(projectContext);

  // 추가 지시사항
  lines.push('\n---\n');
  lines.push('## ⚡ 작업 지침\n');
  lines.push('1. **작업 시작 전**: 위 컨텍스트를 확인하고 이어서 작업하세요.');
  lines.push('2. **에러 발생 시**: `solution_find`로 기존 해결책을 먼저 검색하세요.');
  lines.push('3. **중요 결정 시**: `memory_store`로 결정 사항을 기록하세요.');
  lines.push('4. **작업 완료 시**: `session_end`로 상태를 저장하세요.');
  lines.push('5. **새 할일 발견 시**: `task_add`로 태스크에 추가하세요.');

  return lines.join('\n');
}

// ===== MCP 요청 핸들러 =====

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return handleTool(request.params.name, request.params.arguments || {});
});

// ===== Prompts 핸들러 (자동 주입) =====

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let content: string;

    switch (name) {
      case 'project-context': {
        const project = args?.project as string;
        if (!project) {
          return {
            description: '프로젝트 컨텍스트',
            messages: [{
              role: 'user',
              content: { type: 'text', text: '⚠️ project 인자가 필요합니다.' }
            }]
          };
        }
        content = await generateProjectContext(project);
        break;
      }

      case 'recent-memories': {
        const project = args?.project as string | undefined;
        const limit = parseInt(args?.limit as string) || 10;
        content = await generateRecentMemories(project, limit);
        break;
      }

      case 'work-context': {
        const project = args?.project as string;
        if (!project) {
          return {
            description: '작업 컨텍스트',
            messages: [{
              role: 'user',
              content: { type: 'text', text: '⚠️ project 인자가 필요합니다.' }
            }]
          };
        }
        content = await generateWorkContext(project);
        break;
      }

      default:
        return {
          description: 'Unknown prompt',
          messages: [{
            role: 'user',
            content: { type: 'text', text: `Unknown prompt: ${name}` }
          }]
        };
    }

    return {
      description: `${name} prompt`,
      messages: [{
        role: 'user',
        content: { type: 'text', text: content }
      }]
    };
  } catch (error) {
    return {
      description: 'Error',
      messages: [{
        role: 'user',
        content: { type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }
      }]
    };
  }
});

// ===== 서버 시작 =====

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Project Manager MCP v5 started (24 tools + 3 prompts for auto-injection)');
}

// CLI subcommands (install/uninstall/status/help) → delegate to the hooks installer.
// Without this, `npx passbaton install` runs the default bin
// (the MCP server), which ignores the arg and hangs on stdio — looks broken to users.
const CLI_COMMANDS = new Set(['install', 'uninstall', 'remove', 'status']);
const cliArg = process.argv[2];

if (cliArg === 'config') {
  // Feature-flag CLI: `passbaton config [set|preset|reset|path]`
  const { runConfigCli } = await import('./cli-config.js');
  process.exit(runConfigCli(process.argv.slice(3)));
} else if (cliArg && (CLI_COMMANDS.has(cliArg) || cliArg === 'help' || cliArg === '--help' || cliArg === '-h')) {
  if (cliArg === 'help' || cliArg === '--help' || cliArg === '-h') {
    console.log('Usage: npx passbaton [install|uninstall|status|config]');
    console.log('  install    Register lifecycle hooks for Claude Code / Codex CLI / Gemini CLI');
    console.log('  uninstall  Remove the hooks');
    console.log('  status     Show installed hooks');
    console.log('  config     View / toggle feature flags (on/off)');
    console.log('  (no arg)   Start the MCP server (stdio) — used by the hook runtime');
    process.exit(0);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const installerPath = path.join(here, 'hooks', 'install.js');
  const result = spawnSync(process.execPath, [installerPath, cliArg], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
} else {
  main().catch(console.error);
}
