# 테스트 보고서

## 검증 기준

- 기록일: 2026-11-25
- 기준 commit: `3bf2c92324f2430b1540faa89509e2b0da9b08ad` 기반 Task 9 working tree
- 로컬 도구: Node.js 24.16.0, npm 11.13.0
- 컨테이너 데이터베이스: PostgreSQL 18.3

## 깨끗한 설치와 정적 검증

| 명령 | 결과 |
| --- | --- |
| `npm ci` | 성공, 943 packages 설치 |
| `npm run audit:runtime` | 성공, 경고 0건 |
| `npm run audit:all` | 성공, high/critical 0건, 개발 도구 moderate 24건 |
| `npm run prisma:generate` | 성공, Prisma Client 7.10.1 생성 |
| `npm exec -- prisma validate` | 성공 |
| `npm run format:check` | 성공 |
| `npm run lint` | 성공 |
| `npm run typecheck` | 성공 |
| `npm run openapi:check` | 성공 |
| `npm run docs:check` | 성공 |
| `npm run build` | 성공 |

## 자동화 테스트

| 범위 | 명령 | 결과 |
| --- | --- | --- |
| 단위 | `npm run test:unit` | 39 suites, 275 tests, 실패 0 |
| 운영 스크립트 | `npm run test:scripts` | 9 tests, 실패 0 |
| 통합 | `npm run test:integration` | 6 suites, 35 tests, 실패 0 |
| E2E | `npm run test:e2e` | 9 suites, 61 tests, 실패 0 |
| 동시성 | `npm run test:concurrency` | 3 suites, 5 tests, 실패 0 |
| OpenAPI 계약 | `npm run test:contract` | 1 suite, 22 tests, 실패 0 |
| 보안 | `npm run test:security` | 1 suite, 10 tests, 실패 0 |
| Compose smoke | `npm run test:smoke` | 4 tests, 실패 0 |

통합 테스트 35개에는 usage terminal 저장이 실패할 때 ACCEPTED 결과, 신규 daily row를 만든 429 결과, 동일 idempotency key의 대기 owner를 각각 완전히 rollback하는 3개 시나리오가 포함됩니다.

## Docker 재현 검증

- runtime target image build 및 Compose app build 성공. 검증한 Compose image: `sha256:6861e38cfbb545c973cb9f66787e4b92547f200656bf9a9709c681fd692ea6d6`
- runtime container는 UID 1000으로 실행했고, production dependency tree에 `prisma` CLI와 `typescript`가 없음을 확인
- Compose에서 PostgreSQL healthcheck 통과 후 migration container가 exit 0, 이어서 app healthcheck가 통과
- `npm run demo`로 Project 생성, API Key 발급, usage 적재, 일별 usage와 감사 로그 조회까지 성공
- `/docs`, `/openapi.json`, `/health/live`, `/health/ready`와 익명 거부·인증된 `/metrics` 응답을 smoke에서 검증하고, demo stdout 및 container 로그에서 실제 실행 secret 노출이 없음을 검사
- 테스트용 고유 Compose project를 사용했으며 검증 후 해당 container/network/volume을 정리
- Docker Desktop이 사용하는 Windows 호스트에서 TCP 3000이 OS 제외 범위에 포함되어 로컬 검증은 Compose의 지원 환경 변수 `PORT=3100`으로 수행했습니다. 컨테이너 내부 포트는 문서와 동일하게 3000입니다.

## 성능·실행계획 증거

- Usage benchmark는 동시성 1/10/50/100, 각 3회로 실행했고 모든 측정 응답의 HTTP 200 및 `ACCEPTED` 결정을 검증
- Audit fixture 10,000행에서 첫 page와 중간 cursor page 모두 `audit_logs_project_cursor_idx`의 index scan 사용을 확인
- 원시 조건과 전체 수치는 [벤치마크 보고서](./benchmark-report.md)에 기록

이 결과는 위 로컬 환경과 해당 working tree의 재현 증거이며, 운영 SLO를 의미하지 않습니다.
