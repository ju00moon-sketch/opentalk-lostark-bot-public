# 웹 API

`docs/`의 웹 화면과 함께 사용하는 Node.js API입니다. Discord·카카오 OAuth 로그인, 세션, 길드·일정·캐릭터 조회를 처리하며 SQLite를 사용합니다. Node.js `>=24.19.0 <25`가 필요합니다.

## 설정

`web/.env.example`을 참고해 필요한 환경변수를 본인의 환경에 설정합니다. 저장소에는 실제 값과 데이터베이스를 넣지 않습니다.

- `WEB_ORIGIN`: 사용자에게 제공할 정규 HTTPS origin. 예시 도메인을 실제 주소로 바꿉니다.
- `WEB_HOST`: `127.0.0.1`을 사용합니다.
- `WEB_PORT`: 로컬 리스너 포트. 기본값은 `8090`입니다.
- `WEB_DB_PATH`: 별도 SQLite 데이터베이스의 절대 경로. 저장할 폴더를 미리 준비합니다.
- `DISCORD_OAUTH_CLIENT_ID`, `DISCORD_OAUTH_CLIENT_SECRET`: 본인 Discord OAuth 애플리케이션 설정.
- `KAKAO_OAUTH_CLIENT_ID`, `KAKAO_OAUTH_CLIENT_SECRET`, `KAKAO_ADMIN_KEY`, `KAKAO_APP_ID`: 카카오 연동을 사용할 때의 본인 애플리케이션 설정.
- `GUILD_AUTO_APPROVAL_ENABLED`와 관련 길드·역할 ID: 본인이 관리하는 서버에 자동 승인을 설정할 때만 입력합니다.
- `BOT_INTERNAL_TOKEN`: 봇과 웹의 루프백 연결을 사용할 때 양쪽에 동일한 별도 값을 설정합니다.

OAuth 공급자에 redirect URI를 본인의 origin으로 등록하고, HTTPS reverse proxy에서 필요한 `/auth/`, `/api/` 경로를 이 리스너로 전달합니다. 정적 화면의 예시 origin도 본인의 것으로 바꿉니다. 기존 서버나 길드의 ID, 운영 인증 정보는 이 사본에 포함하지 않았습니다.

환경변수를 설정한 후 이 디렉터리에서 다음 명령으로 시작할 수 있습니다.

```sh
node --env-file=.env src/start.js
```

기존 운영 데이터베이스에 연결하기 전에 새 임시 데이터베이스로 검증하세요. `ops/web-upgrade/`는 별도 Linux 배포의 업그레이드 도구 소스이며 실제 운영용 서비스 파일이나 배포 승인을 포함하지 않습니다. 이 사본을 준비하면서 앱 기동이나 실제 데이터베이스 변경을 하지 않았습니다.

## 테스트

```sh
npm test
```

테스트의 HTTP 리스너와 SQLite 파일은 로컬 임시 테스트 자원입니다. OAuth·게임 API 응답은 테스트에서 주입한 데이터로 검증합니다. 실제 계정의 로그인과 외부 서비스 연동은 별도 설정이 필요합니다.
