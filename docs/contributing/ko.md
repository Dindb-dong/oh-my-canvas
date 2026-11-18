# 기여 안내

현재 앱은 Rust 네이티브입니다. Rust 1.92.0으로 네이티브 바이너리를 빌드하고, JavaScript 도구는 문서·MCP 테스트·벤치마크에만 사용합니다.

```sh
cd native
cargo build --locked -p omc-desktop -p omc-service -p omc-cli
./target/debug/omc-desktop
```

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:native
```

네이티브 서비스와 CLI를 먼저 빌드한 뒤 SDK 검사를 실행하세요. 실제 문서 대신 합성 데이터와 격리 프로필을 사용하고 데스크톱 QA는 `--automation-background`로 숨김·비활성 상태에서 실행하세요. 기본 사용자 프로필을 사용하지 마세요.

작은 범위로 수정하고 관련 테스트, 실제 결과와 남은 검증을 기록하세요. Git·PR 문구는 영어로 작성하고 PR은 초안으로 만드세요. 명시적 요청 없이 병합·배포하지 마세요. 라이선스·출처 고지를 보존하고 비밀·초대장·개인 문서를 첨부하지 마세요.

[English reference](../../CONTRIBUTING.md) · [Testing](../TESTING.md) · [Native guide](../../native/README.md) · [Security](../../SECURITY.md)
