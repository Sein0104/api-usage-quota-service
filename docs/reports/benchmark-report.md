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
| 기록 시각 | 2026-11-25T11:34:04.647Z |
| 기준 commit | `16a9abffb9cf2be54af3e000c0cd039785ba3158` |
| app image digest | `sha256:699b48914c40eeccb870872971c322b5ef919dd683459ed8d9281ed7f8988a10` |
| host | Windows 10.0.26200, AMD Ryzen 5 4500U, logical CPU 6 |
| Node.js / npm | 24.16.0 / 11.13.0 |
| PostgreSQL | 18.3 (Debian 18.3-1.pgdg13+1) |
| 측정 timeout | 요청당 30,000 ms |
| transaction 획득 대기 | Prisma maxWait 5,000 ms, pg pool connection timeout 3,000 ms |

수치는 이 로컬 환경에서 얻은 재현 증거이며 서비스 수준 목표가 아닙니다. 하드웨어·Docker Desktop·호스트 부하에 따라 달라질 수 있습니다. 원시 결과는 [usage JSON](./benchmark-result.json)과 [EXPLAIN JSON](./explain-audit-result.json)에 보관합니다.

## Usage ingest 결과

| 동시성 | 반복 | 요청 수 | 처리량(req/s) | p50(ms) | p95(ms) | p99(ms) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1 | 50 | 51.02 | 17.12 | 36.22 | 68.26 |
| 1 | 2 | 50 | 52.10 | 16.78 | 34.03 | 36.75 |
| 1 | 3 | 50 | 67.50 | 14.65 | 16.91 | 17.58 |
| 10 | 1 | 500 | 122.15 | 68.66 | 173.61 | 226.71 |
| 10 | 2 | 500 | 133.50 | 63.45 | 158.71 | 208.11 |
| 10 | 3 | 500 | 131.26 | 62.78 | 166.64 | 222.58 |
| 50 | 1 | 2,500 | 122.86 | 388.74 | 539.16 | 624.04 |
| 50 | 2 | 2,500 | 134.09 | 356.79 | 495.41 | 575.12 |
| 50 | 3 | 2,500 | 124.17 | 345.96 | 597.19 | 1593.47 |
| 100 | 1 | 5,000 | 138.70 | 699.80 | 860.57 | 1005.95 |
| 100 | 2 | 5,000 | 141.09 | 692.15 | 819.46 | 910.81 |
| 100 | 3 | 5,000 | 136.00 | 704.81 | 896.90 | 1325.69 |

측정 요청 24,150건과 warmup 9,660건, 총 33,810건 모두 HTTP 200 및 `ACCEPTED`를 검증했습니다. warmup은 결과 표에서 제외했습니다. 동시성 50의 세 번째 반복 p99 1,593.47 ms를 포함해 관측값을 제외하거나 보정하지 않았습니다.

## 부하 회귀 검증

최종 검증 중 이전 commit `6d6b770`에서 `P2028: Unable to start a transaction in the given time.`이 발생해 benchmark가 중단되었습니다. 격리된 진단 실행에서도 같은 오류를 재현했습니다. Prisma의 기본 획득 대기 2초가 pool의 연결 대기 3초보다 짧았고, 이 오류가 generic 500으로 분류되었습니다.

commit `16a9abf`는 획득 대기를 5초로 명시하고 해당 획득 오류만 dependency 503으로 분류합니다. 실제 PostgreSQL pool을 2.2초 점유하는 회귀 테스트의 RED→GREEN과 전체 테스트를 확인한 뒤, 진단기 없이 위 전체 benchmark를 다시 실행했습니다. 잘못 닫히거나 만료된 transaction 사용 오류는 일반 오류로 유지합니다.

## Audit keyset EXPLAIN 결과

환경: PostgreSQL `18.3 (Debian 18.3-1.pgdg13+1)`, `linux 6.18.58.1-microsoft-standard-WSL2`, Node.js 24.16.0. 기록 시각은 2026-11-25T11:34:06.044Z입니다.

| 조회 | 실제 행 | 실행 시간(ms) | buffer hit/read | 핵심 plan |
| --- | ---: | ---: | ---: | --- |
| 첫 50행 | 50 | 0.038 | 4 / 0 | `Limit → Index Scan(audit_logs_project_cursor_idx)` |
| 5,000번째 cursor 이후 50행 | 50 | 0.053 | 5 / 0 | `Limit → Index Scan(audit_logs_project_cursor_idx)` |

두 조회 모두 `project_id` 조건을 사용했습니다. 중간 page는 `ROW(created_at, id) < ROW(cursor_created_at, cursor_id)` 조건을 index condition에 포함했고, 큰 sequential scan은 없었습니다. 측정 fixture는 결과 생성 후 해당 Project 범위로 삭제하고 `ANALYZE audit_logs`를 다시 실행했습니다. 검증용 Compose container/network/volume도 정리했습니다.
