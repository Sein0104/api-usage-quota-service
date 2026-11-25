# 벤치마크 보고서

## 방법

- 대상: Task 9 Docker Compose `app` image
- 동시성: 1, 10, 50, 100
- 반복: 동시성별 3회
- 각 반복: worker당 warmup 20회 후 측정 요청 50회
- 모든 HTTP 응답은 status `200`, decision `ACCEPTED`를 검증
- percentile: sample 오름차순 nearest-rank `ceil(p × N) - 1`
- audit: 격리 Project에 정확히 10,000행을 bulk insert하고 `ANALYZE` 후 첫 page와 5,000번째 keyset cursor page를 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`으로 측정
- 실행계획은 production의 `(project_id, created_at, id) < (...) ORDER BY created_at DESC, id DESC LIMIT`을 사용하고 `audit_logs_project_cursor_idx` 사용을 실행 중 검증

## 실측 환경

| 항목 | 값 |
| --- | --- |
| 기록 시각 | 2026-09-21T14:37:59.136Z |
| 기준 commit | `3bf2c92324f2430b1540faa89509e2b0da9b08ad` 기반 Task 9 working tree |
| app image digest | `sha256:9b1a71b6602f47c59073f9d39a24f364a035fca442d0a9822e32e8dc63f78b2e` |
| host | Windows 10.0.26200, AMD Ryzen 5 4500U, logical CPU 6 |
| Node.js / npm | 24.16.0 / 11.13.0 |
| PostgreSQL | 18.3 |
| 측정 timeout | 요청당 30,000 ms |

수치는 이 로컬 환경에서 얻은 재현 증거이며 서비스 수준 목표가 아닙니다. 하드웨어·Docker Desktop·호스트 부하에 따라 달라질 수 있습니다.

## Usage ingest 결과

| 동시성 | 반복 | 요청 수 | 처리량(req/s) | p50(ms) | p95(ms) | p99(ms) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 50 | 87.67 | 11.17 | 13.67 | 15.17 |
| 1 | 2 | 50 | 86.69 | 11.46 | 12.86 | 13.42 |
| 1 | 3 | 50 | 90.67 | 10.81 | 12.65 | 16.09 |
| 10 | 1 | 500 | 179.16 | 45.64 | 124.80 | 176.80 |
| 10 | 2 | 500 | 202.67 | 38.56 | 117.51 | 154.59 |
| 10 | 3 | 500 | 189.16 | 43.81 | 123.35 | 170.63 |
| 50 | 1 | 2,500 | 183.94 | 256.47 | 364.11 | 434.97 |
| 50 | 2 | 2,500 | 172.43 | 261.07 | 410.28 | 936.59 |
| 50 | 3 | 2,500 | 187.18 | 250.84 | 362.89 | 430.49 |
| 100 | 1 | 5,000 | 187.55 | 513.30 | 662.57 | 733.70 |
| 100 | 2 | 5,000 | 188.72 | 510.79 | 638.15 | 706.26 |
| 100 | 3 | 5,000 | 184.85 | 518.26 | 689.88 | 767.24 |

측정 요청은 총 24,150건이고, 매 반복의 warmup 요청은 결과 표에서 제외했습니다. 동시성 50의 두 번째 반복 p99 936.59 ms를 포함해 관측값을 제외하거나 보정하지 않았습니다.

## Audit keyset EXPLAIN 결과

환경: PostgreSQL `18.3 (Debian 18.3-1.pgdg13+1)`, Linux `6.18.33.2-microsoft-standard-WSL2`, Node.js 24.16.0. 기록 시각은 2026-09-21T14:38:16.750Z입니다.

| 조회 | 실제 행 | 실행 시간(ms) | buffer hit/read | 핵심 plan |
| --- | ---: | ---: | ---: | --- |
| 첫 50행 | 50 | 0.032 | 4 / 0 | `Limit → Index Scan(audit_logs_project_cursor_idx)` |
| 5,000번째 cursor 이후 50행 | 50 | 0.054 | 6 / 0 | `Limit → Index Scan(audit_logs_project_cursor_idx)` |

두 조회 모두 `project_id` 조건을 사용했습니다. 중간 page는 `ROW(created_at, id) < ROW(cursor_created_at, cursor_id)` 조건을 index condition에 포함했고, 큰 sequential scan은 없었습니다. 측정 fixture는 결과 생성 후 해당 Project 범위로 삭제하고 `ANALYZE audit_logs`를 다시 실행했습니다.
