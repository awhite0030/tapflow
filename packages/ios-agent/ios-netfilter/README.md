# ios-netfilter — iOS 오프라인 1층 (content filter System Extension)

`#607` 네트워크 on/off의 **1층**이다. macOS `NEFilterDataProvider`로 사용자가 오프라인으로 전환한
시뮬레이터의 flow를 drop하고, 나머지는 손대지 않고 통과시킨다. **시뮬 단위** 격리를 flow의 프로세스
계보로 해낸다 — RocketSim은 bundle id로만 필터해 같은 앱 두 시뮬을 구분하지 못한다.

**왜 content filter인가** — 처음 만든 건 `NETransparentProxyProvider`였고, 시뮬레이터 flow를 하나도
못 봤다(실측: handler에 217건이 도달했고 전부 호스트 프로세스). `NEFilterDataProvider`는 본다.

**왜 호스트만으로는 안 되는가** — `handleNewFlow`의 `.drop()`은 **새 flow에만** 걸린다. `URLSession`의
keep-alive 연결은 새 flow를 안 만들어서 계속 통신한다. `filterDataVerdict`로 데이터 계층을 붙잡아
보려 했으나 양쪽 설정 다 못 쓴다 — peek 8192는 데이터 콜백 0건, peek 1은 40초에 815,869건(1바이트씩)
이면서 앱의 재사용 연결에서는 outbound 콜백이 한 번도 안 왔다. Apple DTS도 명시적이다: 허용한 연결은
되돌릴 수 없다. 그래서 기존 연결 절단은 호스트가 아니라 주입된 dylib이 앱 프로세스 안에서 한다.

**왜 fishhook이 아니라 inline patch인가** — fishhook은 Mach-O의 indirect symbol pointer를 다시 쓰는데,
dyld shared cache **밖의** 이미지에만 닿는다. 실제 `.app`에서 측정: 시스템 프레임워크는 서로를 캐시
안에서 direct branch로 부르므로 socket 계층도 path 계층도 안 잡혔다. 잡힌 것처럼 보인 건 우리 dylib
자신의 import였고, 그게 첫 self-check가 false positive였던 이유다. 근거는 `src/inline-hook.h`에 있다.

> **transparent proxy가 아니다.** `NETransparentProxyProvider`로 먼저 만들었고, 실측 결과 시뮬레이터
> 앱의 flow를 **하나도 보지 못했다** — `handleNewFlow`에 잡힌 217건이 전부 호스트 macOS 프로세스였다.
> 같은 조건에서 content filter(socket flow 계층)는 시뮬 flow를 그대로 본다.

## 두 층을 반드시 함께 쓴다

| 층 | 무엇을 | 어디서 | 상태 |
|---|---|---|---|
| **1층** (여기) | 트래픽 차단 (새 연결) | 호스트 sysext | 실증 완료 |
| **2층** | 앱의 `NWPathMonitor`를 `unsatisfied`로, **그리고 기존 연결 절단** | 앱-내부 dylib (`../bin/libtapflow-nethook.dylib`) | 실증 완료 |

1층 단독(= RocketSim)은 `NWPathMonitor`를 못 바꾼다 — 트래픽은 죽는데 앱은 `satisfied`를 계속 믿는다.
2층 단독은 트래픽을 못 막는다 — `nw_path_get_status`를 속여도 URLSession은 커널의 진짜 경로를 보고
요청을 보낸다. **둘 다 실측이고, 그래서 결합이 이 설계의 핵심이다.**

**기존 연결은 1층이 끊을 수 없다.** Apple이 명시한다 — *"Once you've allowed a connection to proceed,
there's no way to go back on that decision. That's true for both content filter and transparent
proxy."* ([forums/710166](https://developer.apple.com/forums/thread/710166)). 그래서 2층이 offline
전환 시 앱 프로세스 안에서 자기 소켓을 `shutdown`한다.

## 구조

```text
ios-netfilter/
  project.yml                    # xcodegen (xctest-runner와 같은 모델)
  TapflowNetFilter.xcodeproj/    # committed (runtime에 xcodegen 안 돌린다)
  Host/                          # 컨테이너 앱: sysext 설치·활성화·룰 기록. ios-agent가 실행
  Extension/                     # NEFilterDataProvider (Provider.swift). 판별과 drop
  build.sh                       # Developer ID 서명 + notarize + staple
  build/                         # gitignored
```

- **컨테이너 앱이 필요한 이유**: `OSSystemExtensionRequest`는 앱 번들 안에서만 호출된다. ios-agent는
  node라 앱이 아니므로, agent가 이 작은 `Host.app`을 실행해 설치·중개한다.
- **Provider가 UDID를 스스로 알아낸다.** flow의 `sourceAppAuditToken` → pid →
  `sysctl(KERN_PROC)`로 부모를 타고 올라가 `launchd_sim`을 찾고 →
  `sysctl(KERN_PROCARGS2)`로 그 argv에서 `/Devices/<UDID>/`를 읽는다. UDID가 있는 곳은 argv뿐이다
  (실행 파일 경로도 cwd도 아니다). 호스트 flow는 조상이 `launchd_sim`이 아니라 자연히 걸러진다.
- **룰 주입은 `NEFilterProviderConfiguration.vendorConfiguration`**. 컨테이너 앱이 쓰고 프레임워크가
  provider에 전달한다 — **실행 중인 provider에 도달하며 재시작이 없다**(토글 3회 내내 pid 불변).
  XPC mach service는 system domain 등록에 실패했고, 이 경로는 애초에 그것이 필요 없다.
- **loopback은 예외 코드가 필요 없다**: content filter가 루프백 flow를 아예 받지 않는다(실측 —
  offline 지정된 시뮬의 `127.0.0.1` 요청 5회 전부 성공, 같은 구간 `handleNewFlow` 0건). Metro dev
  서버와 XCUITest tree runner가 이 경로다.

## 사용

```bash
B=/Applications/TapflowNetFilter.app/Contents/MacOS/TapflowNetFilter

$B --install                    # 확장 활성화 + 설정. 릴리스당 한 번, 사람이 한다
$B --offline <udid>[,<udid>…]   # 룰만 쓴다. 에이전트가 토글마다 부르는 경로
$B                              # 인자 없음 = 빈 집합 = 전부 온라인
$B --off                        # 필터 비활성화 (확장은 그대로 둔다)
```

**활성화는 설정과 분리돼 있다.** 예전에는 매 실행이 `OSSystemExtensionRequest`를 보냈고, 에이전트가
토글마다 이걸 부르므로 **설정 문자열 하나 바꾸려고 시스템 확장 설치·교체를 요청**하고 있었다. 불필요한
데다, 그 요청이 무응답으로 끝나는 실패(exit 6)에 매번 노출된다.

**exit 0은 "거부당하지 않았다"까지다.** 저장이 받아들여졌다는 뜻이고, 실행 중인 provider가 새 룰을
들고 있다는 뜻은 아니다 — 프레임워크가 `vendorConfiguration`을 provider에 넘기는 것은 그 뒤이고
돌아오는 확인은 없다(전체 실행 27ms, 측정). 실패는 각각 다른 코드로 나온다.

| exit | 뜻 |
|---|---|
| 0 | 저장까지 받아들여짐 |
| 1 | sysext 활성화 실패 |
| 2 | preferences 읽기 실패 |
| 3 | preferences 저장 실패 (시스템 설정에서 거절한 경우가 여기) |
| 4 | 승인 대기 30초 초과 — 시스템 설정에서 승인 후 다시 실행 |
| 5 | 재부팅해야 새 확장이 뜬다 |
| 6 | 45초 안에 시스템 확장 관리자가 아무 응답도 안 함 — 에러도 거절도 아니다 |

디바이스가 실제로 오프라인인지는 이 코드가 아니라 시뮬레이터 안에서 dylib이 남긴 verdict로 판단한다.

## provider가 남기는 상태 파일

`/Library/Application Support/tapflow/tapflow-netfilter-state.json` — root 소유, 644. 에이전트가
읽는다. 초당 한 번(룰이 바뀌면 즉시) 갱신된다.

```json
{"at":1787500575,"rule":[],
 "flows":{"simulator":116,"host":90,"unresolved":0,"dropped":24},
 "attribution":{"walks":206,"avgMicros":319.7}}
```

- `rule` — **실행 중인 provider가 실제로 들고 있는 offline 집합.** 저장된 설정이 아니라 집행 중인
  것이라, exit code가 못 하는 말을 한다. 이게 없으면 필터가 죽어도 컨트롤은 "조종 가능"이라고 한다.
- `unresolved` — 귀속이 **실패한** flow. 호스트 flow와 다르다. 여전히 allow하지만(아래) 셀 수 있다.
- `avgMicros` — flow당 부모 walk 비용. 캐시를 붙일지 판단하려면 이 숫자가 먼저다.

**해결 불가 flow는 allow한다.** `sysctl` 일시 오류에 fail-closed하면 사용자 브라우저를 끊는다 — 이
필터는 호스트 전역이고, 기능의 약속은 "토글한 시뮬만 영향받는다"이다. 구멍인 것은 맞고, 그래서
error 레벨로 로그하고 세는 것이다.

## 빌드

```bash
export DEVELOPMENT_TEAM=<10자리 Team ID>
./build.sh
```

**교체가 그냥 무응답으로 끝날 수 있다.** `submitRequest`가 반환하고 delegate가 한 번도 안 불린다 —
에러도 거절도 승인 프롬프트도 없다. 호스트가 45초에 끊고 exit 6을 내는 게 유일하게 이걸 보이게 하는
장치다.

**원인은 아직 모른다.** 처음엔 누적 14개 / 대기 13개 상태에서 나와서 누적이 원인처럼 보였다. 재부팅으로
1개가 됐는데 **다음 교체가 똑같이 멈췄고**, `lsregister -f`도 소용없었다. 둘 다 사실이므로 둘 다 적는다.

멈추면 볼 것 두 가지 (해결책은 아니다):

```bash
systemextensionsctl list | grep -c "waiting to uninstall on reboot"
# System Settings > General > Login Items & Extensions > Network Extensions
```

교체마다 이전 버전이 재부팅까지 대기 상태로 남는 건 사실이므로, 편집마다 빌드하지 말고 묶는 편이
낫다. 자가호스터는 릴리스당 한 번 설치하므로 이걸 만나지 않는다 — `ios-netfilter`를 건드리는 기여자가
만난다.

`build.sh` 헤더에 one-time 셋업(App ID + NE capability, notarytool 자격증명)이 있다.

**★설치할 때 두 가지를 반드시 지킨다** — 둘 다 어기면 증상이 같다(새 빌드인데 옛 코드가 조용히 돈다):

1. **`CFBundleVersion`을 올린다.** 버전이 같으면 activation이 `result 0`을 돌려주면서도 번들 교체를
   조용히 건너뛴다. `build.sh`가 매 빌드 유니크 버전을 주입한다(xcodegen이 버전을 리터럴로 박아
   build setting override가 안 먹으므로 generate 후 `plutil` 필수).
2. **컨테이너 앱을 먼저 죽인다.** 이미 실행 중인 앱에 `open`/exec을 하면 `main`을 다시 안 타므로
   `OSSystemExtensionRequest` 자체가 발생하지 않는다.
   ```bash
   pkill -f "TapflowNetFilter.app/Contents/MacOS/TapflowNetFilter"
   ```

확인 세 가지: `systemextensionsctl list`의 활성 버전이 방금 빌드한 값인가, provider pid가 바뀌었나,
`/tmp/tapflow-netfilter-host.log` 마지막 줄 시각이 방금인가.

앱은 `/Applications`에 있어야 activation `code=3`을 피한다. `ditto`로 복사한다(서명 보존).

**notarize가 `timestamps differ by N seconds - check your system clock`으로 실패하면 시계를 만지지
말 것.** 실측 시 시계 오차는 0.14초였고, Apple 타임스탬프 서버 응답이 615초 걸린 것이었다. 재시도로
통과한다.

## 배포 — ad-hoc 불가, 정식 서명 prebuilt

sysext는 다른 헬퍼(`bin/`의 ad-hoc prebuilt)와 달리 **ad-hoc으로 로드되지 않는다**(실측). 그래서:

- **소스는 committed** (xctest-runner처럼), 하지만 **사용자가 빌드하지 않는다** — 서명할 수 없기 때문.
- **프로젝트가 Developer ID로 서명 + notarize한 단일 바이너리**를 배포한다 (LuLu 모델). NE
  content-filter entitlement는 셀프서비스라 별도 Apple 승인 폼은 없다.

## 관측

```bash
log show --start "<시각>" --predicate 'subsystem == "dev.tapflow.netfilter"' --info --debug --style compact
```

**반드시 스크립트 파일에 넣어 실행한다** — zsh가 predicate의 중첩 따옴표를 깨뜨린다. `--info --debug`
없이는 `.default` 레벨도 안 보인다. `log stream`이 아니라 `log show`를 쓰면 **재부팅 전 기록까지**
나온다(unified log는 디스크에 남는다).

## Open Questions

- **배포 매체** — `bin/` committed prebuilt vs CI release asset.
- **에러 코드** — 1층이 주는 것은 `-1005`(연결이 끊김)이고 신호 없는 실기는 `-1009`(인터넷 없음)다.
  앱의 오프라인 분기가 후자로 쓰여 있으면 다른 가지를 탄다.
- **`NENetworkRule` init** — macOS 15에서 deprecated. 지금은 룰 없이 `defaultAction: .filterData`로
  전량을 `handleNewFlow`에 받으므로 쓰지 않는다. 룰 기반으로 좁힐 때 최신 API를 확인할 것.
