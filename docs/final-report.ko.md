# SpecBridge 최종 보고서

작성일: 2026-11-15 · 대상 저장소: `/home/arthur/Code/architools` (기존 내용: 한 줄짜리 README뿐이었음)
실행 환경: Linux x86_64, Node 24.21.0, OpenJDK 17.0.20. Git commit/push는 하지 않았다(권한 없음).

## 1. 결론

다섯 도구(OpenSpec 2.0.0, LikeC4 1.61.0, TypeSpec 1.18.0, oasdiff 1.38.0, Alloy 6.2.0)의 공식
구조화 인터페이스에서 사실을 추출해 재생성 가능한 파일 기반 Semantic IR로 정규화하고, 둘 이상의
도구에 걸친 모순·누락·변경 영향을 근거와 함께 보고하는 SpecBridge를 구현하고 실제로 실행했다.
성공 시나리오 A–E, 15개 벤치마크 사례, 29개 자동화 테스트가 통과했다. 다만 벤치마크 정답은
구현자(에이전트)가 직접 작성했고 **사람이 검토하지 않았다**. 따라서 결과는 "명세한 동작이
작동한다"는 근거이지 독립 데이터에서의 정확도 근거가 아니다. AI 보조 매핑(구성 D)은 AI 제공자가
없어 **측정하지 못했고**, 실제 AI 호출은 0회였다.

## 2. 구현 완료 기능

| 영역 | 내용 | 위치 |
|---|---|---|
| 추출 | OpenSpec `list/show/validate --json`(위치는 자체 locator로 보완, 표시함), LikeC4 Model API + language services 위치, TypeSpec 컴파일러 타입 그래프 + `@typespec/http` + `@extension`, Alloy Java API(파서·실행·반례, `java/SpecBridgeAlloy.java`) | `src/adapters/` |
| oasdiff | TypeSpec→OpenAPI(공식 openapi3 emitter) 후 `oasdiff breaking/changelog -f json`, 변경을 TypeSpec Operation·소비 컴포넌트·요구사항에 연결, OpenAPI 변환 손실 보고 | `src/verify/apicompat.ts` |
| Semantic IR | 엔터티 10종 + 확장 6종, 관계 12종 + 확장 6종, 제약 12종, 출처(파일·줄·도구 보고 여부), 도구 버전·파일 해시·Git revision, 추출 방식, 검증 상태, 근거, Explicit/Derived/Proposed/Rejected | `src/ir/`, `schemas/ir.schema.json` |
| 연결 | 명시적 ID → 승인 매핑(지문 기반 재검증: VALID/STALE/INVALIDATED, 이름변경 제안은 자동 적용 안 함) → 유일 접미사 참조 → 결정적 규칙(D-*) → 제안(휴리스틱/외부 AI 명령, IR 밖 저장). 승인·거부는 `--by` 필수 CLI | `src/link/`, `specbridge mapping` |
| 정합성 | Architecture–API, Requirement–Contract, Requirement–Architecture, Architecture–Invariant(LikeC4→Alloy 결정적 투영), Requirement–Invariant, Cross-spec 구조화 제약 비교(방향·상태·단위 정렬 후 판정) | `src/analysis/consistency.ts`, `src/constraints/` |
| 영향 분석 | OpenSpec change(복사본에 공식 `openspec archive` 적용), Git 기준(`git archive`, 작업 트리 비변경), baseline 디렉터리, oasdiff 변경, 명시 엔터티; 관계 유형·방향별 전파 규칙, 직접/간접, 경로, 순환·깊이·노드 상한과 불완전 경고, 무효화 매핑, 재검증 대상 | `src/analysis/impact.ts` |
| 형식 검증 | 명시 모델의 check/run 실행, scope·solver·모델 해시·재현 명령 기록, 반례 원자→IR 엔터티·요구사항 매핑, run SAT ≠ 위반, "범위 내 반례 없음"만 보고, 초안 생성(SPECBRIDGE-DRAFT 표시, 증거에서 제외, 검토 경로 기록) | `src/verify/formal.ts`, `draft.ts` |
| CLI/보고 | build, link, mapping, analyze consistency/impact/coverage, verify formal, verify --change/--base-ref, formal draft, report; 실행 상태(PASS/FAIL/SKIP/ERROR)와 의미 판정(CONSISTENT/CONFLICT/UNKNOWN/NOT_APPLICABLE) 분리, Coverage 5종(분모 0이면 null), 종료 코드 0/1/2/3 | `src/cli.ts`, `src/report/report.ts` |
| CI·문서 | GitHub Actions 워크플로, 에이전트 가이드, 설치·사용, 지원 범위·한계, 백로그, 추적표 | `.github/`, `docs/` |

## 3. 구현하지 못했거나 제한된 기능과 원인

- **구성 D(AI 보조 매핑) 측정 불가**: AI 제공자·자격 증명이 없음. `SPECBRIDGE_AI_COMMAND` 경계만 구현했고, 사례 10의 스텁은 셸 스크립트 픽스처다.
- **사람 검토 정답 없음**: 사람 검토가 실제로 없었으므로 모든 case.yaml에 "NOT reviewed by a human"으로 표기했다.
- **CI의 GitHub 실행 미확인**: push 권한이 없어 워크플로 자체는 GitHub에서 돌리지 않았다. 동일 단계를 로컬에서 실행했고, 저장소 밖 깨끗한 복사본에서 `npm ci → setup-tools → typecheck → test → PoC`를 재현했다(29/29 통과).
- **자연어**: SCN 패턴에 맞는 문장만 구조화한다. 나머지 규범 문장은 UNKNOWN(`REQ-AMBIGUOUS-NL`).
- **Alloy 수식 해석 없음**: 단언이 언급하는 sig/field와 필드 다중성만 사용한다. 요구사항 모델링의 적절성은 구조적 겹침만 확인하고 판정하지 않는다.
- **투영 범위**: LikeC4 직접 관계만 Alloy로 투영한다(동적 뷰·배포 미포함).
- 기타 상세: `docs/limitations.md`, 후속 과제: `docs/backlog.md`.

## 4. 확인된 의미적 모순 사례 (실행 결과)

| 사례 | 판정 근거 | 기여 도구 |
|---|---|---|
| Phase 0 / 시나리오 E: `ClaimRequest.workerId`가 요구사항에서는 요청 필수(spec.md:10, SCN-REQUIRED), 계약에서는 선택(main.tsp:15) | `RC-REQUIRED-OPTIONAL` CONFLICT | OpenSpec + TypeSpec |
| 시나리오 E: `leaseSeconds` 30–3600 s 요구 vs 계약 1–86400(이름 접미사 단위) | `RC-RANGE-RANGE` CONTRACT_PERMITS_VIOLATION | OpenSpec + TypeSpec |
| 시나리오 B: 409 응답 제거(oasdiff는 INFO 수준) → 요구사항의 409 요구 위반; `priority` 필수화 → oasdiff breaking, 소비자 `jobs.webApp`·요구사항으로 추적 | `RC-ERROR-RESPONSE`, `API-BREAKING-CHANGE` | OpenSpec + TypeSpec + oasdiff + LikeC4 |
| 시나리오 C: `webApp -> jobQueue` 관계 추가 | `XS-FORBIDDEN-DEPENDENCY`(OpenSpec+LikeC4), 투영 반례 `QueueIsolation`·`NoCycles`(LikeC4+Alloy), 제공자 중복 `AA-PROVIDER-CONFLICT`·`XS-OWNERSHIP` | OpenSpec, LikeC4, TypeSpec, Alloy |
| 시나리오 D: claim 술어 변경 | `RI-COUNTEREXAMPLE` ×2, 반례 원자 `Job$0`→`typespec:type:JobApi.Job`(승인 CORRESPONDS_TO), 요구사항 `exclusive-job-claim`에 연결, scope `3 but 6 steps` | Alloy + OpenSpec (+TypeSpec) |
| 시나리오 A: change `add-job-lease` | 변경이 새로 만든 모순 `RC-REQUIRED-OPTIONAL`(leaseSeconds), `RC-FIELD-MISSING`(leaseExpiresAt); 수정된 요구사항의 VERIFIES 매핑 2건 STALE → 검증 범위 무효화 보고 | OpenSpec + TypeSpec + Alloy |

## 5. 검증 근거와 실행 결과

| 검사 | 명령 | 결과 |
|---|---|---|
| 타입 검사 | `npm run typecheck` | 오류 0 |
| 자동화 테스트 | `npm test` | 29/29 통과(단위·CLI·스키마·시나리오 A–E·초안) |
| 깨끗한 설치 재현 | 저장소 밖 복사본에서 `npm ci && scripts/setup-tools.sh && npm run typecheck && npm test && npm run poc` | 29/29 통과, PoC traceComplete=true |
| Phase 0 PoC | `npm run poc` | 요구사항→컴포넌트→Operation→Assertion 추적 완료, Alloy `check … for 3 but 5 steps` 반례 없음(범위 한정), 모순 1건 |
| 시나리오 | `npm run scenarios` | A–E 모두 exit 1 / FAIL·CONFLICT(의도된 결함), 보고서 `evidence/scenarios/` |
| 벤치마크 | `npm run bench` | 아래 표, 회귀 게이트 통과 |
| 도구 무결성 | `scripts/setup-tools.sh` | oasdiff sha256, Alloy sha1이 배포처 체크섬과 일치 |

## 6. Benchmark 측정 결과 (15개 사례, `bench/results/summary.md`)

| 지표 | A 개별 도구 | B 명시 참조 통합 | C IR+결정적 규칙 | D AI 매핑 | D′ 휴리스틱 자동 수락 |
|---|---|---|---|---|---|
| TP / FP / FN | 3 / 0 / 11 | 9 / 0 / 5 | 14 / 0 / 0 | 미측정 | 14 / 0 / 0 |
| Precision / Recall | 1.0 / 0.214 | 1.0 / 0.643 | 1.0 / 1.0 | 미측정 | 1.0 / 1.0 |
| FP rate / FN rate | 0 / 0.786 | 0 / 0.357 | 0 / 0 | 미측정 | 0 / 0 |
| 전체 판정 정확도 | 0.333 | 0.6 | 1.0 | 미측정 | 0.933 |
| **False PASS** | **10** | **6** | **0** | 미측정 | 0 |
| UNKNOWN 재현율 | 0 | 0 | 1.0 | 미측정 | 1.0 |
| 매핑 정확도 | 0.444 | 0.778 | 1.0 | 미측정 | 0.778 |
| 탐지 결함의 요구사항 추적 | 0 | 0 | 1.0 | 미측정 | 1.0 |
| 평균/최대 지연(ms) | 1206/1801 | 2515/3144 | 4560/5088 | 미측정 | 4567/5036 |
| 토큰 | 0 | 0 | 0 | 미측정 | 0 |

재현성: C를 두 번 실행해 정규화한 보고서 해시가 15/15 사례에서 동일했다.

## 7. False Positive / False Negative 분석

- **C**: FP 0, FN 0. 사례를 작성한 주체와 규칙 작성자가 같으므로 과적합 가능성이 높다. 독립 정확도로 해석하면 안 된다.
- **A**: 교차 명세 모순(02, 03, 04, 05, 09, 14)을 전혀 못 잡고(FN 11), 정보 부족·미실행 사례(08, 12, 13, 15)를 CONSISTENT로 보고해 False PASS 10건. 특히 15번(단언에 check 명령 없음)은 개별 도구가 실행할 대상이 없어 "통과"로 보인다.
- **B**: 끊어진 참조·매핑(04, 09, 14)은 잡지만 제약 모순·소유권·금지 의존·반례의 요구사항 추적은 못 한다(FN 5, False PASS 6).
- **D′**: 사례 11에서 이름만 같은 Alloy `Hold`(스레드 락)와 TypeSpec `Hold`(좌석 보류)를 잘못 연결(매핑 오류 2건)했고 판정이 CONSISTENT에서 UNKNOWN으로 바뀌었다. 제안을 검토 없이 신뢰하면 안 된다는 설계 근거다.
- C에서 의도적으로 UNKNOWN으로 남긴 범주: 범위 차이(stored vs response), 상태 차이, 단위 불명, 계약에 경계 없음, 해석 불가 자연어, 미실행 단언.

## 8. 성능 및 실행 비용

- `verify`(jobs-platform, Alloy 명령 3개 + 투영 단언 2개): 약 3.2–3.4 s. 추출 시간 OpenSpec CLI ≈ 0.7–1.1 s, LikeC4 ≈ 0.4 s, TypeSpec ≈ 0.3 s, Alloy 파싱 ≈ 0.15–0.3 s, Alloy 실행 ≈ 1.1 s, 분석 자체 < 10 ms.
- `verify --change` ≈ 6.7 s(복사본 생성·archive·재추출 포함), 벤치마크 전체 ≈ 4.5분(사례당 A/B/C×2/D′ 실행).
- 유료 서비스·AI 호출 없음. 비용은 로컬 CPU 시간뿐이다.

## 9. 알려진 한계

`docs/limitations.md` 14개 항목 요약: SCN 외 자연어 미해석, 제목 기반 요구사항 ID, Alloy 수식 비해석, 범위 한정 검증, 직접 관계만 투영, 헤더·쿼리 파라미터 미비교, 단위는 SCN 단어·이름 접미사·@encode에 한정, 정책(단일 제공자)은 설정값, 영향 전파 규칙은 대규모 실모델 미검증, 정답 미검토, D 미측정, 소규모에서만 성능 측정, oasdiff 체크섬 고정은 linux/amd64, 오류 있는 LikeC4/TypeSpec은 추출하지 않음.

## 10. 후속 연구개발

사람이 검토한 독립 벤치마크(B1), 실제 AI 제공자로 D 측정(B2), OpenSpec 안정 ID(B3), SCN 확장과 AI 기반 SCN 문장 제안(B4), 동적 뷰의 Alloy trace 투영(B5), Alloy AST 기반 대응 검사(B6), 추출 캐시·상주 JVM(B7), 파라미터·visibility 비교(B8), 대규모 모델에서 영향 규칙 보정(B9), SARIF 출력(B10), 다중 프로젝트·서비스(B11). 상세: `docs/backlog.md`.

## 11. 분할·독립 검증

작업을 하위 작업자로 분할하지 않았다. IR 스키마·연결 규칙·보고 계약이 모든 부분에 공유되는 결합된 작업이어서 병렬 분할 기준에 맞지 않았고, 사용자가 독립 검증을 요청하지 않았다. 검증은 위 자동화 검사와 깨끗한 복사본 재현으로 수행했다.
