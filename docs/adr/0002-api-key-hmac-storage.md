# ADR 0002: API Key HMAC digest 저장

- 상태: Accepted
- 결정일: 2026-08-13

## 맥락

서버는 API Key를 검증해야 하지만 DB 유출 시 원문 credential을 복구할 수 없어야 합니다. 사용자 password와 달리 Key secret은 256-bit 난수이므로 느린 password KDF의 비용이 필요하지 않습니다.

## 결정

`mq_<uuid>.<base64url secret>`을 한 번만 발급하고, prefix와 `HMAC-SHA-256(API_KEY_PEPPER, credential)`만 저장합니다. pepper는 DB 밖에서 주입하며 digest는 constant-time 비교합니다.

## 결과

prefix로 후보를 찾고 고정 비용으로 검증할 수 있습니다. pepper 유출과 DB 유출이 결합되면 offline 검증이 가능하므로 secret rotation·접근 통제가 여전히 필요합니다.
