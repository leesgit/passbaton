import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // ★ 워커 스레드가 아니라 자식 프로세스로 돈다. better-sqlite3 은 네이티브
    // 애드온이고, 기본 'threads' 풀에서 여러 워커가 같은 애드온을 올렸다 내리면
    // **종료 시점에 세그폴트가 난다.** 실측(2026-09-08): 전체 스위트가 종료코드
    // 139 로 5회 중 5회 죽었고(변경 전에도 5회 중 3회), `--pool=forks` 로는 3회 중
    // 0회다. 테스트는 전부 통과한 뒤 죽는 형태라 결과만 보면 초록으로 보이지만
    // 종료코드가 139 이므로 CI 는 실패한다.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/dashboard.ts']
    }
  }
});
