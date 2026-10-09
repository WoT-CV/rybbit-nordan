# Bezpieczne wyrównanie master → feat/wotcv — 2026-10-09

## Zakres i punkty odniesienia

Użytkownik zaktualizował fork master z rybbit-io/master. Integrujemy jego
zmiany do feat/wotcv, nie publikujemy naszych zmian na masterze ani produkcji.
Zmiany pozostają do przeglądu: bez commit i push. Nie uruchamiamy migracji,
backfilli, aplikacji podłączonej do produkcyjnych baz ani skryptów deploy.

- Repo: `C:/PROJECTS/rybbit-wotcv`, zdalne `WoT-CV/rybbit-wotcv`.
- Początek feat/wotcv: `8efce864d77233f43b245fa635f1a8257ce0758a`.
- Pobierany i przypięty master: `847553b79d2b0dbea488236f9268668c675fe056`.
- Wspólny przodek: `221fbaa7227e1d8c3591a00d8bca7250e835d6d6`.
- 147 commitów wyłącznie feature, 60 wyłącznie upstream (łącznie z merge).
- Upstream: 961 zmienionych plików; feature: 619; wspólnych: 159.
- Lokalne master jest starsze. Nie używać go jako źródła integracji.
- Początkowe drzewo robocze czyste; istniejących backupów/worktree nie usuwać.

## Analiza zmian i reguły rozwiązywania

| Obszar              | Zmiany upstream                                                                                        | Wymagania WoT-CV i strategia                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uprawnienia         | editor/viewer, role per-site, transfer witryny, nowe guardy i permissions                              | Przyjąć model uprawnień i nowe trasy; zachować ograniczenia credential/scope, public/private links oraz admin management. Nowe mutation nie mogą korzystać z samego read guard. Sprawdzić grant, revoke i izolację organizacji.           |
| Rejestracja tras    | wydzielenie `api/routes.ts`, route snapshots, graceful drain kolejek                                   | Przenieść growth accounting, observability i eksport replay do nowego routera. Zachować gzip decoder, limity 10 MiB, health/provenance i skompresowane assets. Dictionary v2 nie może zostać zastąpione mutacjami backfill.               |
| ClickHouse/czas     | wszystkie kolumny UTC, jawne UTC przy zapisie, zmiany init i testy                                     | Zachować obie gałęzie zmian: UTC oraz dictionary v2, uptime/pozostałe tabele fork. Nie usuwać starych faktów/Replay ani zmieniać TTL. Inicjalizacja przy następnym deploy wymaga osobnego review.                                         |
| Analityka/tożsamość | nowe podsumowania sesji/użytkowników, pages, goals, journeys, GSC/MCP                                  | Zachować aliasy PostgreSQL, explicit identity first, scope sesji i precyzję ms, growth accounting. Nowe hooki korzystają z jednolitego request context. Zachować profile/traits i wykluczenia.                                            |
| UI/settings         | nowe ledger, stat bands, command palette, reduced motion, segmented control, clipboard/hold-to-confirm | Włączyć nowy UX bez utraty PL i ukrywania nieaktywnych funkcji self-hosted. Usuwane komponenty zastępować następcami, a ich forkowe zachowania przenieść zamiast pozostawiać martwe duplikaty.                                            |
| Replay              | porządki formatu, nowe listy/overview i UI                                                             | Zachować player adapter i safeguards iPhone, seek/inactivity/activity timeline, eksport i Network/Grafana. Usunięty upstream stary decoder storage nie jest naszym HTTP gzip upload decoderem. Nie usuwać historycznych body.             |
| Tracker             | URL fragments/hashbang, klasyfikacja urządzeń/kanałów, bezpieczne form change                          | Zachować network metadata privacy cap, body-state/coverage i korelację. Po merge wygenerować script.js/script-full.js z połączonych źródeł; nie rozwiązywać konfliktów wygenerowanego bundla tekstowo.                                    |
| Grafana/gzip        | funkcje własne bez upstream odpowiedników                                                              | Profile Grafany, correlation/trace, rozróżnienie empty/inline/redacted/omitted/unknown i negocjowany bezstratny gzip pozostają. Nie podnosić limitów/retry/retencji, nie dodawać R2/archiwum ani fragmentacji dużych body.                |
| Zależności/build    | matched framer-motion/motion-dom/motion-utils, UA parser                                               | Przyjąć nowe wersje upstream razem z aktualniejszymi zabezpieczeniami dependency fork. Regenerować lock z połączonych manifestów; frozen install. Sprawdzić izolowany build klienta bez server/src, który już powodował błąd produkcyjny. |
| PostgreSQL          | 0021_site_grant_roles, 0022_site_transfers, 0023_track_url_fragments, 0024_sites_id_index              | Zachować starsze migracje fork i poprawną linię journal/snapshot; żadnej renumeracji ani wykonywania migracji. Review SQL i testów lineage w izolacji.                                                                                    |
| Deploy/persistence  | brak zgody na zmianę środowiska                                                                        | Zachować compose ports/volumes, Redis isolation, backup/auth cutover, TTL-aware invariants, image SHA/provenance. Testować skrypty bez uruchamiania deploy.                                                                               |
| Tłumaczenia/docs    | nowe klucze i korekty wielu języków                                                                    | Łączyć JSON per-key względem wspólnego przodka; nie wybierać całego ours/theirs. Zachować nasze PL i replay/Grafana, upstream additions i corrections. Zbadać usunięte klucze i brakujące/niepuste tłumaczenia.                           |

## Etapy wykonania

1. **Analiza i baseline.** Odczytać instrukcje repo/obszarów, pobrać master oraz
   feature, przypiąć SHA, sprawdzić clean tree i merge-tree. Zidentyfikować
   konflikty tekstowe, modify/delete, migracje i pozornie czysty automerge.
   Uruchomić obecne testy, aby odróżnić istniejący dług od regresji integracji.
2. **Punkt powrotu i merge.** Utworzyć osobną gałąź backup wskazującą początkowe
   HEAD. `git merge --no-commit --no-ff <master SHA>` na feat/wotcv. Nie używać
   istniejącego helpera sync, ponieważ wykonuje commity automatycznie.
3. **Backend i kontrakty.** Najpierw router/permissions, schema/UTC, dictionary,
   identity/session queries, tracker i config; potem klient. Rozwiązać każdy
   konflikt semantycznie. Zachować nowe upstream testy i własne regresje;
   zaktualizować snapshots jawnie dopiero po porównaniu tras/guardów.
4. **Klient i lokalizacja.** Nowe ledger/podsumowania/filtry + self-hosted
   capabilities/identity/replay. Połączyć tłumaczenia według kluczy, skontrolować
   wszystkie obszary automerge oraz permission gated mutation.
5. **Artefakty i walidacja.** Po manifestach zbudować shared, server/tracker
   oraz klienta; frozen pnpm install, typecheck, pełne Vitest, testy Node i
   Python deploy, polish coverage, whitespace/conflict-marker check. Osobno
   sprawdzić client isolation. Nie udawać testów Docker/ClickHouse produkcji.
6. **Samodzielne review i poprawki.** Sprawdzić diff względem feature i master,
   trasy, privacy/history/gzip, mobile replay, auth/role i nowe migracje. Każdy
   wykryty błąd poprawić i pokryć testem; powtórzyć odpowiednie bramki. Opisać
   wynik, pozostałe ograniczenia i bezpieczną kolejność wdrożenia.

## Bramka gotowości do produkcji (osobny krok użytkownika)

Najpierw review i commit, potem docelowy Docker/Alpine oraz staging z backupem
PostgreSQL i weryfikacją nowej schema/UTC. Zachować deploy preflight i backup
restore checks. Po wdrożeniu sprawdzić logowanie istniejącym kontem, read/write
role, private links, alias identity, stare i nowe replay, gzip przez proxy,
Grafana oraz iPhone (seek/speed/rotation/background). Samo `health=ok` nie
potwierdza tych funkcji. Nie wyłączać decodera gzip przy rollbacku, gdy stare
otwarte karty nadal wysyłają gzip. Rollback po migracjach wymaga zgodności
schema, a nie prostego startu dowolnego starego obrazu.

## Wynik wykonania

### Stan repo i odzyskiwanie

Etapy 1–6 wykonane. Zintegrowany został przypięty `origin/master`
`847553b79d2b0dbea488236f9268668c675fe056` z `feat/wotcv`. Nie użyto starszego
lokalnego master ani zbiorczego rozstrzygnięcia `ours`/`theirs`.

Merge pozostaje celowo **bez commita**, z rozwiązaniami w indeksie. `HEAD`
wskazuje nadal `8efce864d77233f43b245fa635f1a8257ce0758a`, a `MERGE_HEAD`
wskazuje przypięty master. Nie wykonano push, deploy, migracji ani operacji
na produkcyjnych bazach. Przed publikacją trzeba przejrzeć indeks i zakończyć
merge osobnym, świadomym commitem.

Punkt powrotu przed integracją:
`backup/feat-wotcv-8efce864-before-master-847553b7-20261009`.
Gałąź backup zachowuje dotychczasowe commity; nie zawiera bieżących rozwiązań
merge. Przed ewentualnym porzuceniem merge zachować również jego diff.

### Najważniejsze rozstrzygnięcia i poprawki po review

1. **Uprawnienia i router.** Przyjęto upstreamowy model owner/admin/editor/
   member/viewer oraz granty per-site. Przeniesiono wszystkie własne endpointy
   do wydzielonego routera. Eksport replay ma osobne `replay:export`
   (co najmniej member i scope write); viewer może czytać, ale nie inicjować
   ani anulować eksportu. Observability nie udostępniono anonimowym linkom.
   Zachowano public/private-link guards, identity, health/build provenance,
   cache namespace oraz HTTP gzip decoder. Snapshot tras porównano również
   z masterem, a nie tylko zaktualizowano automatycznie.
2. **Tożsamość.** Zachowano dictionary PostgreSQL/ClickHouse v2, aliasy i zasadę
   explicit identity first. Nowe podsumowania, segmenty, goals, journeys,
   sessions oraz zapytania profilu stosują scope efektywnej tożsamości.
   Dodano regresję prawdziwego handlera sesji: świeżo powiązany alias działa
   przed odświeżeniem dictionary, a odpowiedź zachowuje replay i feature flags.
   Nie przywrócono usuniętego legacy identity backfill/mutacji.
3. **Replay v1/dual/v2.** Nowe upstreamowe odczyty nie mogą bezwarunkowo
   wybierać `session_replay_metadata_v2`: nasza produkcja może wciąż używać v1.
   Zapytania sesji, summary, journeys i funnel sessions korzystają ze wspólnego
   wyboru tabel. Dodano testy wszystkich trzech trybów. Poprawiono także brakujące
   kolumny autocapture w projekcji sesji lejka.
4. **PostgreSQL.** Dołączono SQL 0021–0024 bez zmiany dotychczasowych migracji.
   Snapshoty upstream pomijały siedem tabel fork. Odbudowano ich linię względem
   naszego 0020, zachowując pełne definicje tabel i dokładając jedynie role,
   `site_transfers`, `trackUrlFragments` i indeks sites. Test porównuje wszystkie
   stare definicje, kolumny, journal i `prevId`: 46 tabel w 0021, 47 od 0022.
   To jest walidacja plików, nie wykonanie SQL na bazie.
5. **UTC.** Włączono upstreamowe jawne UTC i zachowano własne time columns
   uptime/admin rollup. Przetestowano zakresy i fallback na zmianie DST.
   Automatyczne inicjalizacyjne ALTER przy starcie nowego backendu pozostają
   istotną bramką staging — sam lokalny typecheck nie potwierdza ich działania
   na istniejącym ClickHouse.
6. **Network/Grafana/gzip.** Zachowano lekki metadata capture, body states,
   correlation/trace links, profile Grafany, historyczne body i negocjowany
   gzip v1 z limitami encoded/decoded 10 MiB oraz fallback/retry. Nie zmieniono
   flagi rollout gzip, limitów ani retencji. Nie dodano prywatnego archiwum
   body, R2 ani fragmentacji logów. Correlation ID nadal nie udaje potwierdzenia
   trwałego, kompletnego zapisu treści w Grafanie.
7. **Odtwarzacz i UI.** Zachowano adapter i safeguards iPhone, seek, inactivity,
   activity timeline i eksport. Lista replay nie zeruje oglądanej sesji przy
   refetch. Nowe sidebar/command palette/settings/ledgery używają naszych
   self-hosted capabilities oraz upstreamowych uprawnień. Prywatne widoki nie
   dostały linków do uprzywilejowanych powierzchni. Zachowano canonical user ID,
   traits/avatar/map oraz brak placeholder danych innego profilu.
8. **Analityka.** Growth accounting zachowuje site-wide, 90-dniowy kontekst
   niezależny od dashboardowych filtrów; warianty kart nadal respektują czas
   dashboardu. Hook używa jednolitego request descriptor. Testy obejmują stare
   camelCase i nowe snake_case params oraz poprawność zakresu.
9. **Zależności i artefakty.** Połączono manifesty i odtworzono frozen lockfile,
   zachowując zabezpieczenia fork oraz zgodny zestaw motion upstream. Tracker
   wygenerowano ze źródeł. Izolowany client build nie ma dostępu do `server/src`,
   co weryfikuje warunek wcześniejszego błędu wdrożenia. W końcowym review
   wykryto CRLF w vendor assets Windows; dodano wąskie `.gitattributes` dla
   czterech publicznych JS i zweryfikowano bajtową zgodność źródeł z gzip/Brotli.
10. **Testy i dokumentacja.** Naprawiono Windowsowe rozwiązywanie ścieżki w
    checkerze bloga, niestabilny harness hold-to-confirm i zależne od locale
    asercje liczb (zmiana wyłącznie testowa, bez podmiany locale aplikacji).
    Tłumaczenia scalono per-key, następnie wykonano extraction i PL audit.
    Nie wyłączano reguł lint/testów, aby ukrywać wynik integracji.

### Wykonane bramki lokalne

Baseline sprzed merge: client 641 PASS w 60 plikach; server 2409 PASS i 16 SKIP
w 172 plikach. Po integracji i poprawkach końcowy pełny przebieg:

| Bramka                                        | Wynik                      | Uwagi                                                                                            |
| --------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`              | PASS                       | Połączony root workspace                                                                         |
| `pnpm typecheck`                              | PASS                       | Server i client                                                                                  |
| Pełny Vitest server                           | 2905 PASS, 0 FAIL, 41 SKIP | 201 plików; testy wymagające zewnętrznego ClickHouse nie potwierdzają produkcji                  |
| Pełny Vitest client                           | 1531 PASS, 0 FAIL, 0 SKIP  | 145 plików                                                                                       |
| `pnpm build:server`                           | PASS                       | Shared, TypeScript, tracker i compressed assets                                                  |
| `check:analytics`                             | PASS                       | Wygenerowane skrypty odpowiadają źródłom                                                         |
| `scripts/verify-isolated-client.ps1 -Offline` | PASS                       | Frozen install client/shared i produkcyjny Next build bez `server/src`                           |
| `client lint:wotcv`                           | PASS                       | 0 błędów, 2 ostrzeżenia TanStack Virtual                                                         |
| Pełny ESLint client                           | NIEZIELONY                 | 97 błędów i 149 ostrzeżeń, porównane z oboma rodzicami — odziedziczony dług                      |
| Testy Node audit/wire                         | 27 PASS                    | Lokalne fixture; round-trip, budgets, privacy, runtime evidence                                  |
| Testy Python deploy/preflight                 | 47 PASS                    | Git Bash z mockami Docker/DB; bez deploy i migracji                                              |
| PL extraction/audit                           | PASS                       | 3176 aktywnych kluczy; 0 missing/extra/empty/placeholder mismatch                                |
| `docs npm ci`                                 | PASS                       | Oddzielny npm workspace docs                                                                     |
| `docs npm run build`                          | PASS                       | Next production build, TypeScript i 5409 wygenerowanych stron                                    |
| Docs agent-readiness                          | 11 PASS                    | Content negotiation, OpenAPI, validation i SSRF guard                                            |
| Docs agent-http                               | PASS                       | Prawdziwy lokalny Next HTTP, HTML/Markdown/HEAD/404/redirect/OpenAPI/robots/sitemap              |
| Docs guides/blog                              | PASS                       | 93 guides; 26 posts, 0 błędów, 38 ostrzeżeń SEO                                                  |
| Network Replay Chromium/WebKit                | PASS / PASS                | Mobilny viewport; 2.42 MB body, 0 clone, 0 dodatkowych preflight, brak payload canaries w replay |
| Static JS/gzip/Brotli                         | PASS                       | Trzy serwowane assets po dekompresji bajtowo identyczne z plikami i Git index                    |

Pełny lint jest uczciwie niezielony: m.in. compiler rules dotyczące refs,
set-state-in-effect i manual memoization, oraz istniejące rules-of-hooks w
Uptime. Porównano raport z `HEAD` i przypiętym masterem przy tych samych
zależnościach ESLint; nie znaleziono nowego błędu specyficznego dla rozwiązania
merge. Nie wykonywano masowego refactoru niezwiązanych komponentów ani nie
osłabiano konfiguracji. Raport JSON znajduje się lokalnie w `.git/` i nie jest
częścią publikowanej aplikacji.

### Ograniczenia i procedura przed produkcją

Wynik lokalny nadaje się do review i zakończenia merge; **nie jest** deklaracją
bezwarunkowej gotowości produkcyjnej. Docker nie jest dostępny w tym środowisku.
Nie testowano docelowego Alpine, działającego produkcyjnego ClickHouse,
rzeczywistego Safari na iPhone ani istniejącego konta po aktualizacji. WebKit
z mobilnym viewportem sprawdza recorder/CORS, nie zastępuje fizycznego iPhone
i pełnego odtwarzania sesji.

Przed produkcją wykonać kolejno:

1. Review staged merge, świadomy commit i uzgodnioną publikację. Potwierdzić
   status odziedziczonego długu lint; nie przedstawiać pełnego lint jako PASS.
2. Build obu obrazów z frozen lockfile na docelowym Docker/Alpine. Zweryfikować
   runtime contents, shared package, GeoLite, ffmpeg/Chromium i precompressed
   statics. Nie rozwiązywać problemów przez zwiększanie limitów.
3. Staging na izolowanych bazach ze zweryfikowanym restore backup. Sprawdzić
   migracje 0021–0024, czas/UTC na istniejących tabelach ClickHouse oraz
   zachowanie TTL i chronionych replay; żadnego backfillu tożsamości w ciemno.
4. Smoke auth/roles: owner/admin/editor/member/viewer, granty i team grants,
   transfer witryny, read/write scopes API key/OAuth i prywatne linki. Viewer
   nie może wykonywać mutation ani eksportu replay.
5. Smoke analytics: aliasy świeże i historyczne, profile/traits, sessions,
   goals/funnels/journeys, growth accounting, GSC, uptime i admin rollup.
6. Smoke replay: historyczne v1 i nowe nagrania, tryby odczytu bez przełączania
   produkcji na v2 w ciemno, Network/Grafana, gzip i JSON przez publiczny proxy,
   encoded/decoded limits, fallback po 415 i zgodność nowych oraz starych kart.
7. iPhone: zmiana prędkości, seek, przewijanie listy network, fullscreen,
   obrót ekranu, tło/powrót i refetch listy — oglądana sesja ma pozostać wybrana.
8. Dopiero po tych bramkach deploy standardowym guarded skryptem, z backupem
   i zgodnym ze schema planem powrotu. Po deploy porównać health SHA i obraz
   backend/client, publiczny health, liczniki/persistence/TTL i zalogować się
   istniejącym kontem. Health `ok` sam nie wystarcza.
