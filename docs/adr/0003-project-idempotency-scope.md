# ADR 0003: Project 범위 idempotency key

- 상태: Accepted
- 결정일: 2026-08-13

## 맥락

같은 Project의 여러 API Key가 하나의 논리 요청을 재시도할 수 있습니다. Key별 unique 범위는 Key가 바뀔 때 이중 집계를 허용합니다.

## 결정

`(project_id, idempotency_key)`를 unique로 두고 versioned payload hash와 최초 terminal decision/quota snapshot을 저장합니다. 같은 payload는 저장 결과를 재사용하고 다른 payload는 `409`입니다.

## 결과

Key rotation 후에도 replay 의미가 유지됩니다. client는 논리 요청마다 canonical UUID v4를 만들고, quota reset 뒤 새 요청은 새 key를 써야 합니다.
