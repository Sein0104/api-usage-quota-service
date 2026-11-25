# 개발 및 Git 운영 규칙

이 저장소는 개인 프로젝트지만, 구현 근거와 변경 이력을 명확히 남기기 위해 Issue·Branch·PR 단위로 작업한다.

## 1. 기본 흐름

```text
Issue → 작업 브랜치 → PR → dev → release PR → main
```

- `main`: 안정·공개 기준선이다. 직접 작업하거나 직접 푸시하지 않는다.
- `dev`: 다음 공개 버전을 통합하는 브랜치다.
- 작업 브랜치는 최신 `dev`에서 만들고 PR도 `dev`를 대상으로 한다.
- 공개할 준비가 끝나면 `dev`에서 `main`으로 release PR을 만든다.
- 병합된 작업 브랜치는 삭제한다.

## 2. Issue

하나의 Issue는 독립적으로 완료 여부를 판정할 수 있는 목표 하나만 가진다. 구현 작업은 다음 내용을 포함한다.

- 작업 목적과 범위
- 완료 기준
- commit 단위로 나눈 체크리스트
- API 계약·DB schema·운영 설정·다른 모듈 영향
- 자동화·수동 검증 계획과 미수행 사유

관련 작업을 묶어 추적할 때만 Epic을 사용하며 Epic 자체에는 작업 브랜치를 만들지 않는다.

## 3. Branch

브랜치 이름은 다음 형식을 사용한다.

```text
<type>/<이슈번호>-<짧은-설명>
```

예시:

```text
docs/2-project-baseline
feat/5-usage-ingestion
test/8-concurrency-scenarios
```

허용 type은 `feat`, `fix`, `build`, `chore`, `ci`, `docs`, `style`, `refactor`, `test`, `perf`다.

## 4. Commit

커밋 메시지는 다음 형식을 사용한다.

```text
<type>: <한국어 변경 요약> (#이슈번호)
```

예시:

```text
feat: 멱등한 사용량 수집 로직 추가 (#5)
test: 쿼터 동시성 시나리오 추가 (#5)
docs: API 오류 계약 보완 (#2)
```

- `type`과 API·라이브러리 이름처럼 원문 표기가 필요한 용어를 제외한 요약은 한국어로 작성한다.
- 하나의 커밋은 독립적으로 이해하고 검증할 수 있는 변경만 포함한다.
- Issue 체크리스트를 기준으로 나누되, 빌드가 깨지는 불완전한 커밋을 만들기 위해 억지로 분할하지 않는다.
- lockfile, 생성 migration처럼 함께 검토해야 하는 파일은 해당 기능 커밋에 포함한다.

## 5. Pull Request

작업 브랜치 하나는 PR 하나와 대응하며 한 가지 작업 목적만 포함한다.

PR 제목:

```text
<type>(<scope1>,<scope2>): <한국어 변경 요약>
```

API 계약, DB schema·migration, 환경 변수, 배포 설정, 공통 작업 규칙을 바꾸는 PR은 제목 앞에 `🚨`를 붙인다.

PR 본문에는 다음 항목을 기록한다.

- 작업 내용과 주요 변경 사항
- `Closes #이슈번호`
- 수행한 테스트의 명령과 결과
- 미수행 테스트와 사유
- 리뷰 포인트와 배포 영향

PR은 구현·검증·self-review가 끝난 뒤 ready 상태로 생성한다. Draft PR은 사용하지 않는다. Merge commit을 기본으로 하고 Rebase도 허용하지만 Squash는 사용하지 않는다.

PR 권장 크기는 사람이 직접 작성한 변경 약 400줄 또는 1~3일 분량이다. `package-lock.json`, 생성 migration, 생성 OpenAPI처럼 기계 생성된 변경은 줄 수 판단에서 제외하되 반드시 함께 검토한다.

## 6. 병합 기준

- format, lint, typecheck, 관련 단위·통합 테스트와 build가 모두 통과해야 한다.
- DB·인증·동시성 변경은 실제 PostgreSQL 통합 테스트가 통과해야 한다.
- 테스트를 실행하지 못했다면 생략하지 말고 PR에 원인과 위험을 기록한다.
- 개인 저장소에서는 별도 reviewer 승인을 강제하지 않지만 작성자가 diff와 테스트 결과를 self-review한다.
- `dev → main` release PR에서는 전체 CI, Docker image build, 문서 링크와 공개 가능한 secret 범위를 다시 검증한다.

## 7. 작업 디렉터리

동시에 둘 이상의 브랜치를 다룰 때는 저장소의 `.worktrees/` 아래 Git worktree를 만들며, 이 디렉터리는 commit하지 않는다.
