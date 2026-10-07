# OpenTalk — 로스트아크 정보 봇

Discord 명령과 선택형 카카오 연동, 캐릭터 조회 웹 화면을 포함한 Node.js 프로젝트입니다. 이 폴더는 공개 배포를 준비한 소스 사본입니다. 운영 계정, 운영 데이터, 원본 Git 이력은 포함하지 않습니다.

## 포함한 기능

- 캐릭터·장비·치명타 적중률 조회, 시장·경매장 정보, 레이드·강화 참고 정보
- 캐릭터 등록, 알림, 출석과 원정대 조회 명령
- 선택형 카카오 스킬 서버와 MessengerBot R 연결 스크립트
- `docs/` 웹 화면과 `web/`의 OAuth 로그인, 길드·일정·캐릭터 정보 API

외부 API 키, 본인의 Discord 애플리케이션, 필요한 서비스 설정은 별도로 준비해야 합니다. 코드가 포함됐다는 것만으로 모든 외부 연동이 설정되는 것은 아닙니다.

## Discord 봇 설정

Node.js 24를 사용합니다. 웹 API를 함께 사용할 때는 `24.19.0 이상, 25 미만`이 필요합니다. 루트 패키지의 의존성은 `discord.js`와 `@anthropic-ai/sdk`이며 버전은 `package-lock.json`에 기록되어 있습니다.

```sh
npm ci
```

`.env.example`을 `.env`로 복사하고 본인이 발급한 `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `LOSTARK_API_KEY`를 입력합니다. 시험할 서버에만 명령을 등록하려면 `DISCORD_GUILD_ID`도 설정합니다.

```sh
npm run register
npm start
```

`register`는 설정한 Discord 애플리케이션에 명령을 등록합니다. 초대 링크의 애플리케이션 ID도 본인의 것으로 설정하세요. 웹 화면에 있는 `YOUR_DISCORD_APPLICATION_ID`와 `https://opentalk.example.invalid`는 설정 예시입니다.

선택 설정은 `.env.example`을 참고하세요. AI 키가 없으면 해당 기능은 코드에 정의된 대체 응답을 사용합니다. 웹 API 설정은 [web/README.md](web/README.md), 카카오 수신기의 구성 요소는 [services/kakao-welcome-loco/README.md](services/kakao-welcome-loco/README.md)에 설명되어 있습니다.

## 공개 사본의 데이터와 자산

`test/fixtures/crit-armory.json`은 이름·수치·tooltip을 직접 만든 작은 합성 데이터입니다. 실제 전투정보실 응답이나 실사용자의 캐릭터 정보를 포함하지 않으며, fixture의 노드 수치는 게임 밸런스 안내가 아닙니다.

웹 배경·로고·티어 이미지는 직접 만든 기하 도형 예시입니다. 원본 이미지는 재배포 권한을 확인하지 못해 포함하지 않았습니다. 예시 목록과 라이선스는 [ASSETS.md](ASSETS.md), [ASSETS.json](ASSETS.json)을 참고하세요. `/체방`은 차트 원본 없이 숫자 표로 응답합니다. 이모티콘 이미지는 포함하지 않으므로 관련 이미지 기능을 쓰려면 권리를 확인한 파일을 직접 추가해야 합니다.

개인·운영 정보가 있는 문서, 서버 연결 설정, 실제 API 캡처, 사용하지 않는 외부 수집 파일은 공개 사본에서 제외했습니다. 외부 URL에서 실행 중 내려받는 데이터·계산 코드와 제삼자의 서비스에는 각각의 이용 조건이 적용됩니다. 이 저장소의 MIT 라이선스가 그 자료의 재배포 권한까지 부여하지는 않습니다. 현재 로펙 연동 코드도 포함되어 있으므로 해당 연동을 사용하기 전 제공자의 조건을 확인하세요.

## 검증

의존성을 준비한 뒤 소스 구문과 로컬 테스트를 실행할 수 있습니다.

```sh
npm run check
npm test
npm --prefix web test
```

테스트는 합성 데이터와 임시 저장소를 사용합니다. 일부 테스트는 Java 컴파일러 또는 Python이 필요하고, 운영 업그레이드 도구의 POSIX 권한 검증은 Linux 환경에서만 실행됩니다. 검증 결과와 실행하지 못한 항목은 사본과 별도로 제공되는 준비 보고서에 기록합니다.

## 라이선스

프로젝트 소스는 [MIT](LICENSE)입니다. 원저작자의 저작권 표기를 유지했습니다. `docs/assets/fonts/`의 IBM Plex Sans KR·Gowun Dodum 폰트는 [SIL Open Font License 1.1](docs/assets/fonts/OFL.txt)을 따릅니다. 의존성의 라이선스는 각 패키지의 고지를 확인하세요.
