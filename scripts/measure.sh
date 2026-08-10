#!/usr/bin/env bash
# passbaton 가치 측정 스크립트
# 사용: bash scripts/measure.sh
# 출력: 베이스라인 대비 sessions/memories/solutions/duration 변화 + 자동 추출 효과

set -euo pipefail

DB="${MCP_DB:-/Users/ibyeongchang/Documents/dev/ai-service-generator/.claude/sessions.db}"

if [ ! -f "$DB" ]; then
  echo "ERROR: DB not found at $DB" >&2
  exit 1
fi

echo "==================================================================="
echo "  passbaton 가치 측정 — $(date '+%Y-%m-%d %H:%M:%S')"
echo "  DB: $DB"
echo "==================================================================="

# === 핵심 카운트 ===
echo ""
echo "## 핵심 카운트"
sqlite3 -column -header "$DB" "
SELECT
  (SELECT COUNT(*) FROM sessions) AS sessions,
  (SELECT COUNT(*) FROM memories) AS memories,
  (SELECT COUNT(*) FROM solutions) AS solutions,
  ROUND(1.0 * (SELECT COUNT(*) FROM sessions) / NULLIF((SELECT COUNT(*) FROM memories), 0), 1) AS s_m_ratio;
"

# === next_tasks 충실도 (P1-2, 2026-08-10) ===
# duration_minutes 충실도 지표는 폐기됨 — 커밋 5bcfc314(2026-07-08)에서 해당 필드
# INSERT를 의도적으로 중단했으므로(신뢰 불가 + 소비처 없음) 이 지표는 0으로만 수렴한다.
# 대신 실제 연속성 가치를 좌우하는 next_tasks 저장률을 본다.
echo ""
echo "## next_tasks 저장률 (P1-2 효과, 최근 30일)"
sqlite3 -column -header "$DB" "
SELECT
  COUNT(*) AS total_30d,
  SUM(CASE WHEN next_tasks IS NOT NULL AND next_tasks != '' AND next_tasks != '[]' THEN 1 ELSE 0 END) AS with_tasks,
  ROUND(100.0 * SUM(CASE WHEN next_tasks IS NOT NULL AND next_tasks != '' AND next_tasks != '[]' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS pct
FROM sessions WHERE timestamp > datetime('now', '-30 days');
"

# === auto-extracted 메모리 (Phase 2 효과) ===
echo ""
echo "## auto-extracted 메모리 (Phase 2 효과)"
sqlite3 -column -header "$DB" "
SELECT memory_type, COUNT(*) cnt, ROUND(AVG(importance),1) avg_imp
FROM memories
WHERE tags LIKE '%auto-extracted%'
GROUP BY memory_type;
"

# === 최근 24h 활동 ===
echo ""
echo "## 최근 24h 활동"
sqlite3 -column -header "$DB" "
SELECT
  (SELECT COUNT(*) FROM sessions WHERE timestamp > datetime('now','-1 day')) AS sessions_24h,
  (SELECT COUNT(*) FROM memories WHERE created_at > datetime('now','-1 day')) AS memories_24h,
  (SELECT COUNT(*) FROM solutions WHERE created_at > datetime('now','-1 day')) AS solutions_24h;
"

# === memory_type 분포 ===
echo ""
echo "## memory_type 분포"
sqlite3 -column -header "$DB" "
SELECT memory_type, COUNT(*) cnt
FROM memories GROUP BY memory_type ORDER BY cnt DESC;
"

# === 베이스라인 비교 ===
# ⚠️ 2026-05-12 베이스라인(sessions=1291)은 DB 정리 이전 수치라 현재(1121)와 직접
#    비교하면 delta가 음수로 나와 무의미했다. cleanup으로 302건이 영구삭제된 이력이
#    있어 sessions 총량은 누적 지표로 못 쓴다. → 총량 delta 대신 현재 스냅샷만 낸다.
echo ""
echo "## 현재 스냅샷 (총량은 cleanup 이력 탓에 시계열 비교 불가)"
sqlite3 -column -header "$DB" "
SELECT
  (SELECT COUNT(*) FROM sessions) AS sessions,
  (SELECT COUNT(*) FROM memories) AS memories,
  (SELECT COUNT(*) FROM solutions) AS solutions,
  (SELECT COUNT(*) FROM sessions WHERE timestamp > datetime('now','-7 days')) AS sessions_7d;
"

# === 가치 점수 추정 ===
echo ""
echo "## 가치 점수 추정 (0-100)"
sqlite3 "$DB" "
WITH stats AS (
  SELECT
    (SELECT COUNT(*) FROM sessions) AS s,
    (SELECT COUNT(*) FROM memories) AS m,
    (SELECT COUNT(*) FROM solutions) AS sol,
    (SELECT 100.0 * SUM(CASE WHEN next_tasks IS NOT NULL AND next_tasks != '' AND next_tasks != '[]' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)
       FROM sessions WHERE timestamp > datetime('now','-30 days')) AS nt_pct,
    (SELECT COUNT(*) FROM memories WHERE tags LIKE '%auto-extracted%') AS auto_mem
)
SELECT
  CAST(
    CASE WHEN m > 0 AND s/m <= 5 THEN 20 ELSE CAST(20.0 * 5 / MAX(1.0*s/m, 5) AS INT) END +  -- memories 비율
    -- duration 충실도(10점)를 next_tasks 저장률로 교체 (2026-08-10):
    -- duration_minutes는 2026-07-08 의도적 폐기라 0으로만 수렴하는 死지표였다.
    CASE WHEN COALESCE(nt_pct,0) >= 50 THEN 10 ELSE CAST(COALESCE(nt_pct,0)/5 AS INT) END +
    CASE WHEN sol >= 70 THEN 15 ELSE CAST(15.0 * sol / 70 AS INT) END +                       -- solutions
    CASE WHEN auto_mem >= 20 THEN 25 ELSE CAST(25.0 * auto_mem / 20 AS INT) END +             -- 자동 추출
    30  -- SESSION.md 수동 연속성 (이미 잘 작동)
  AS INT) AS score
FROM stats;
"

echo ""
echo "==================================================================="
echo "  참고 (2026-08-10 audit-7 실측, passbaton v2.1.3):"
echo "    sessions=1121, memories/solutions는 위 스냅샷 참조"
echo "    next_tasks 저장률: 수정 전 1/376 (0.3%) → P1-2 수정 후 재측정 대상"
echo "    ⚠️ duration_minutes 지표는 폐기됨 (2026-07-08 커밋 5bcfc314)"
echo "==================================================================="
