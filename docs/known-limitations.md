# 알려진 제한

- PostgreSQL RLS는 MVP에 적용하지 않았습니다. 애플리케이션 repository와 복합 FK가 tenant 경계를 강제하며, 다중 서비스/직접 SQL 주체가 생기면 역할 분리와 RLS를 추가합니다.
- API Key·audit·usage event 자동 retention과 archival이 없습니다. production에서는 보존 정책, partition, 삭제 감사와 복구 절차가 필요합니다.
- 단일 Project hot row에 대한 외부 rate limit이 없습니다. edge rate limit과 abuse protection은 quota 의미와 별개로 둬야 합니다.
- API Key/API pepper 자동 rotation과 vault 연동이 없습니다. 현재는 배포 환경의 secret manager를 전제로 합니다.
- cloud 배포·고가용성·다중 region 장애조치는 범위 밖입니다. managed PostgreSQL, backup/restore drill, connection pool sizing을 운영 단계에서 검증합니다.
- benchmark는 특정 로컬/Actions runner의 비교 자료이지 SLA가 아닙니다. 환경과 commit이 달라지면 다시 측정합니다.
- Docker 입력은 버전 tag와 현재 Debian 패키지 저장소를 사용하므로 bit 단위로 동일한 재빌드를 보장하지 않습니다. 배포 artifact를 고정할 때는 검증된 image digest를 보관하고, 더 엄격한 재현성이 필요하면 base manifest digest와 패키지 snapshot을 고정합니다.
- 2026-11-25 npm advisory 기준으로 개발·테스트 도구의 `glob`/`minimatch` 경로에 moderate 경고 24건(상위 의존성 포함)이 남아 있습니다. runtime의 `--omit=dev --omit=optional --omit=peer` 조건에서는 경고 0건이며 전체 의존성의 high/critical도 0건입니다. 개발 도구의 major 업그레이드는 별도로 검증하고, CI는 runtime의 moderate 이상 및 전체 의존성의 high 이상을 차단합니다.
- Prisma 7.10.1 config가 고정한 Effect 3.20.0의 [정규식 서비스 거부 취약점](https://github.com/advisories/GHSA-7589-6fvf-x4pw)을 피하기 위해 `@prisma/config` 경로에만 Effect 3.22.5 override를 적용했습니다. Prisma upstream의 고정 버전이 수정되면 override를 제거하고 migration·generate를 재검증합니다.
