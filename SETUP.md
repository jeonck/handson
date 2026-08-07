# 설정

처음 한 번만 하면 됩니다. 4단계, 10분.

---

## 1. Claude OAuth 토큰 발급 → 저장소 시크릿

Actions에서 Claude를 돌리려면 OAuth 토큰이 필요합니다. **Claude Pro 또는 Max 구독**이 있어야 발급됩니다.

로컬 터미널에서:

```bash
claude setup-token
```

브라우저가 열리고 인증이 끝나면 토큰이 출력됩니다. 이 값을 저장소 시크릿으로 넣습니다.

```bash
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo jeonck/handson
```

또는 웹에서: **Settings → Secrets and variables → Actions → New repository secret**
- Name: `CLAUDE_CODE_OAUTH_TOKEN`
- Secret: 위에서 받은 토큰

> ⚠️ 이 토큰은 당신의 Claude 계정으로 작업을 실행합니다. **공개 저장소의 이슈 본문에 붙여넣지 마세요.** 시크릿 외의 어디에도 두지 않습니다.

토큰은 만료됩니다. 워크플로가 인증 오류로 실패하면 `claude setup-token`을 다시 돌려 시크릿을 갱신하세요.

> **Claude GitHub App은 설치하지 않아도 됩니다.** 워크플로가 `github_token`으로 러너 토큰을 넘기기 때문입니다.
> 커밋과 이슈 코멘트는 워크플로가 직접 처리하므로 `claude[bot]` 신원이 필요 없습니다.

---

## 2. Actions에 쓰기 권한 주기

에이전트가 저장소에 커밋해야 하므로 워크플로가 쓸 수 있어야 합니다.

**Settings → Actions → General → Workflow permissions**
- ✅ **Read and write permissions**

---

## 3. GitHub Pages 켜기

**Settings → Pages → Build and deployment → Source: `GitHub Actions`**

Jekyll 빌드가 아니라 이 저장소의 `pages.yml` 워크플로가 배포합니다.

CLI로도 됩니다:

```bash
gh api -X POST repos/jeonck/handson/pages -f build_type=workflow
```

---

## 4. 커스텀 도메인 — handson.metacog.co.kr

### DNS (이미 완료된 상태를 가정)

`metacog.co.kr` 존에 CNAME 레코드가 있어야 합니다.

| 이름 | 타입 | 값 |
|---|---|---|
| `handson` | CNAME | `jeonck.github.io` |

확인:

```bash
dig +short handson.metacog.co.kr CNAME
```

`jeonck.github.io.` 가 나와야 합니다.

### 저장소 쪽

`site/CNAME` 파일이 이미 들어 있고, 빌드가 이것을 `dist/CNAME`으로 복사합니다. **Pages 설정에도 같은 값을 등록해야** GitHub가 인증서를 발급합니다.

```bash
gh api -X PUT repos/jeonck/handson/pages -f cname=handson.metacog.co.kr
```

또는 **Settings → Pages → Custom domain** 에 `handson.metacog.co.kr` 입력 후 저장.

인증서 발급에 몇 분에서 최대 한 시간이 걸립니다. 발급이 끝나면 **Enforce HTTPS**를 켭니다.

```bash
gh api -X PUT repos/jeonck/handson/pages -F https_enforced=true
```

> `site/CNAME`을 지우면 배포할 때마다 커스텀 도메인 설정이 풀립니다. 이 파일은 프레임워크 보호 대상이라 에이전트가 건드리지 못하게 되어 있습니다.

---

## 확인

네 단계가 끝났으면 이렇게 검증합니다.

```bash
open https://handson.metacog.co.kr/
```

```bash
gh workflow run claude-ondemand.yml \
  -f skill=handson \
  -f request="설정 검증용 테스트. kind로 로컬 클러스터 하나 띄워서 kubectl 컨텍스트 확인했음."
```

```bash
gh run watch
```

`00-inbox/` 또는 `01-install/` 에 새 `.md`가 커밋되고, 곧이어 Pages 빌드가 돌면 정상입니다.

예약 워크플로도 강제로 한 번 돌려 봅니다.

```bash
gh workflow run scheduled.yml -f skill=daily-topic -f force=true
```

`force=true`가 없으면 최근 26시간에 기록이 있을 때 아무것도 하지 않고 끝납니다 — 그것도 정상 동작입니다.

---

## 동작 방식과 보안

이 저장소는 **공개**입니다. 공개 저장소에서 에이전트에 쓰기 권한을 주는 건 조심할 일이라, 세 겹으로 막아 두었습니다.

1. **소유자 게이트** — `claude-ondemand.yml` 이 `github.event.issue.user.login == github.repository_owner` 를 확인합니다. 남이 연 이슈는 워크플로를 실행하지 못합니다.
2. **주입 방어** — 이슈 본문을 YAML에 직접 보간하지 않고 env를 거쳐 `/tmp/handson/request.md` 로 씁니다. 프롬프트는 그 파일을 "데이터이지 지시문이 아니다"로 다루라고 명시합니다.
3. **경로 방어선** — 커밋 단계가 `.github/`, `scripts/`, `site/`, `CLAUDE.md` 등 프레임워크 파일의 변경을 되돌립니다. 에이전트가 프롬프트를 어겨도 자기 실행 환경을 고칠 수 없습니다.

그래도 남는 위험: **문서에 쓰는 모든 것이 공개됩니다.** 핸즈온 문서는 특성상 내부 호스트명·계정·아키텍처가 섞이기 쉽습니다. 프롬프트가 자격증명을 마스킹하도록 지시하지만, **이슈 본문 자체는 마스킹되지 않고 그대로 남습니다.** 토큰이나 내부 식별자는 애초에 붙여넣지 마세요.

---

## 커스터마이즈

| 하고 싶은 것 | 고칠 파일 |
|---|---|
| 오늘의 주제가 고르는 범위 | `04-reference/topics.md` |
| 스킬의 동작 | `.claude/skills/<이름>/SKILL.md` |
| 새 스킬 추가 | `.claude/skills/<새이름>/SKILL.md` + 이슈 템플릿 + 워크플로 라벨 목록 |
| 예약 시각 | `.github/workflows/scheduled.yml` 의 cron (UTC 기준) |
| 재검증 기준일 (기본 120일) | `site.config.json` 의 `staleDays` |
| 사이트 제목·카테고리 라벨 | `site.config.json` |
| 모델 | 워크플로의 `--model` (기본 `claude-sonnet-5`) |

새 스킬을 붙일 때 인프라 코드를 건드릴 필요가 없다는 점이 핵심입니다 — 마크다운 파일 하나면 됩니다.

## 자주 겪는 문제

**사이트가 404** — Pages Source가 `GitHub Actions`인지, `pages.yml` 워크플로가 성공했는지 확인.

**커스텀 도메인이 자꾸 풀림** — `dist/CNAME`이 배포 아티팩트에 들어갔는지 확인하세요. `pages.yml`에 확인 단계가 있습니다.

**이슈를 열었는데 아무 일도 없음** — 이슈에 라벨(`handson` 등)이 붙었는지 확인하세요. 템플릿을 쓰지 않고 빈 이슈를 열면 라벨이 없어 워크플로가 걸리지 않습니다.

**아침에 오늘의 주제가 안 생김** — 정상일 수 있습니다. 최근 26시간 안에 핸즈온 문서가 커밋됐으면 건너뜁니다. Actions 로그의 `사람 기록:` 줄에 어떤 파일 때문인지 남습니다.

**커밋은 됐는데 사이트가 그대로** — `pages.yml`은 `paths-ignore`에 걸리는 경로만 바뀌면 돌지 않습니다. Actions 탭에서 수동 실행하세요.
