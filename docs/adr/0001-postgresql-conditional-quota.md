# ADR 0001: Redis 대신 PostgreSQL 조건부 갱신

- 상태: Accepted
- 결정일: 2026-08-13

## 맥락

사용량 event, idempotency terminal decision, 일별 quota는 하나의 원자적 결과여야 합니다. 별도 Redis counter는 PostgreSQL event와의 이중 쓰기, 복구·reconciliation 절차를 추가합니다.

## 결정

PostgreSQL unique constraint와 `used_units + units <= limit_units` 조건부 `UPDATE ... RETURNING`을 한 트랜잭션에서 사용합니다. 요청별 mutex나 `SERIALIZABLE`을 전제로 하지 않습니다.

## 결과

commit/rollback 경계가 단일 DB에 있고 동시 요청 초과 허용을 DB가 차단합니다. hot Project row 경합이 처리량 상한이 되며 수평 partition·외부 counter는 실측 후 확장 옵션입니다.
