# Odbudowa minimalnego forka WoT-CV Rybbit

## Zakres i niezmienne warunki

Punkt startowy: upstream `e69e843db903581a097500926147549f35d5306f`.
Gałąź: `feat/wotcv-minimal-20261101`, osobny worktree. Stary `feat/wotcv`,
lokalny closeout i ich dokumenty pozostają nienaruszone.

Wymagania: działające funkcje produktu self-hosted bez paywalli cloud,
natywny replay z małą korelacją Grafana, dotychczasowe traits i loga klanów,
noindex na dedykowanym Nginx. Nie przenosimy własnego playera, Network Replay
z body/headers, gzip, eksportu WebM/ZIP, Identity v2, Growth Accounting ani
prototypu Uptime. Zachowujemy natywne zabezpieczenia i limity upstream.

Każdy etap: ponowna analiza źródeł → zapisany plan → implementacja → testy →
self-review i niezależne review istotnych zmian → poprawki → osobny commit.
Nie wykonujemy push, deploymentu, migracji, backfill, restore, restartów ani
zmiany Nginx na produkcji. Skrypty aplikacji nie są uruchamiane z produkcyjną
konfiguracją. Testy korzystają z fixture/mock/local-only, nie z live danych.

## Kolejność i granice commitów

| Etap | Commit | Implementacja i bramka wyjścia |
| --- | --- | --- |
| 1 | `chore(minimal): etap 1 - establish pinned upstream baseline` | Czysty upstream, dokument zakresu/planu, bazowe testy i build/typecheck, jawne istniejące błędy; bez zmian dependency pins |
| 2 | `feat(self-hosted): etap 2 - enable native product capabilities` | Mała polityka UI/backend, Pages/Bots/Performance/Query/Dashboards/Admin/GSC, weekly email własny sender i jeden scheduler; bez cloud billing i bez osłabiania uprawnień |
| 3 | `feat(users): etap 3 - preserve clan profile presentation` | Resolver logo i avatar fallback, wszystkie powierzchnie, minimalne map payload enrichment; bez dictionary i zmian identity queries |
| 4 | `feat(replay): etap 4 - correlate native recordings with Grafana` | Wersjonowany custom rrweb event, ograniczony fetch/XHR observer, parser/lista i bezpieczne linki oraz site-scoped config; natywny player/transport/storage |
| 5 | `feat(ops): etap 5 - isolate deployment configuration and noindex` | Oddzielny snippet Nginx, instrukcja bezpiecznej instalacji i read-only HTTP verifier; parametry środowiska, źródła forka; bez zmian hosta |
| 6 | `test(minimal): etap 6 - validate integration and upstream boundaries` | Pełne testy/build/lint, browser desktop/mobile, HTTP recorder→ingest→read→UI→Grafana fixture, brak niechcianych subsystemów i review całego diffu |
| 7 | `docs(release): etap 7 - prepare guarded production transition` | Read-only inventory/preflight i runbook trzech strategii danych, prerequisites/rollback i explicit HOLD; żadnej automatycznej migracji ani samowolnego wyboru nowej bazy |

## Plan etapu 1

### Analiza przed implementacją

Dotychczasowy fork ma inne journal/schema PostgreSQL, aktywne ścieżki replay
metadata v1/dual/v2 i read-time Identity v2. Nowa baza kodu nie może udawać
bezpiecznego update-in-place. Startujemy od dokładnego U, a nie merge/revert
starego forka. Wymagania profili i korelacji dają się oprzeć na natywnych
traits i rrweb custom events, bez nowych tabel PostgreSQL.

Systemowy Node 26 i shim pnpm są nieodpowiednim baseline: pnpm wskazuje na
nieistniejący Corepack. Używamy prywatnego Node 24.22.1, sprawdzonego SHA256
z oficjalnego SHASUMS, i istniejącego pnpm 10.33.0. Nie naprawiamy globalnej
instalacji. Frozen lockfile instalujemy bez aktualizacji pakietów. Chromium,
Firefox i WebKit są dostępne lokalnie; lokalny Docker nie jest dostępny.
Test docelowego iPhone i realnych datasource Grafany nie jest zastępowany
viewportem ani poprawnym URL.

### Szczegółowy plan

1. Sprawdzić upstream SHA i czystość punktu startowego; utworzyć oddzielną
   gałąź/worktree bez naruszenia istniejących katalogów.
2. Odczytać instrukcje repo i umiejętności odpowiednie do zmienianych obszarów.
3. Zainstalować frozen workspace i zbudować shared; zachować pakiety/lockfile.
4. Uruchomić bazowe testy klienta i serwera z ograniczoną liczbą workerów,
   typecheck i build. Rozdzielić istniejące błędy od przyszłych regresji.
5. Sprawdzić wygenerowane locale/artefakty i nie commitować mechanicznego
   churn, raportów, nagrań, sekretów ani plików środowiska.
6. Zapisać wyniki i ograniczenia, sprawdzić staged diff i commit etapu 1.

## Warunki odbioru kolejnych etapów

### Etap 2

Wymagane działające dane i API, nie samo menu. Kontrola dotyczy Sidebar,
command palette, Web Vitals switches, GSC, admin dependencies i mail lifecycle.
Self-hosted nie inicjalizuje Stripe/AppSumo/usage enforcement. Własny sender
jest konfigurowany; brak transportu nie oznacza sukcesu. Agregacja hourly nie
jest backfill istniejących danych. Rozróżniamy unknown od zera. Sprawdzamy
single-process i cluster oraz shutdown schedulera. Kontrole permissions,
private links, SQL isolation i resource caps pozostają upstreamowe.

### Etap 3

Zachowujemy aktualny kontrakt producenta: identify(String(userId)), traits
username/name `[TAG] nick`, clanTag, customerId/customerName, avatarUrl,
language/browserLanguage/theme. Native profiles pozostają źródłem traits.
Testujemy URL validation, escaping, błędny obraz, zmianę obrazka, brak traits,
Users/Profile/Sessions/Replay/Events/Globe i single vs grouped locations.
Nie obiecujemy historycznej równoważności Identity v2.

### Etap 4

Obserwator działa wyłącznie podczas aktywnego sampled recording, tylko dla
allowlisted API origin i poza requestami własnego trackera. Zero body,
cookies, map headers, error text, outgoing injection i nowych preflightów.
Równoległe requesty mają osobne wiersze, backend ID nie jest lokalnym row ID.
Lifecycle owner/epoch i identity session chronią stare callbacki. Fetch/XHR
zachowują zachowanie, abort, timeout, HTTP errors i brak CORS ID. Link wymaga
poprawnego ID, site/origin config i ograniczonego okna czasu. UI nie subskrybuje
zegara playera w każdej klatce i nie tworzy drugiego playera. Testujemy native
storage passthrough, desktop/mobile, pusty/błędny payload i obce origin/site.

### Etap 5

Noindex w jednym dedykowanym vhoście, nie w aplikacyjnych metadanych i hooks.
GET/HEAD robots/sitemap: puste 410/no-store; wszystkie odpowiedzi odpowiedni
X-Robots-Tag. Przykład nie modyfikuje innych vhostów; verifier tylko czyta.
Żadne testy nie instalują/reloadują konfiguracji produkcyjnej.

### Etap 6

Powtórzyć pełne bramki na finalnym źródle; jawnie raportować baseline failures,
skips i ograniczenia środowiska. Browser plugin nie jest dostępny, więc użyć
istniejącego Playwright bez instalowania nowych zależności. Syntetyczny
Grafana endpoint sprawdza kodowanie i routing, nie dowodzi retencji live logu.
Fizyczny iPhone, realny SQL provisioning, e-mail delivery i live Grafana mają
odrębne acceptance przed wdrożeniem.

### Etap 7

Wykonać bezpieczny plan przejścia, a nie samo przejście. Zachować obecne dane,
backup i źródła rollback. Nie wykonywać Drizzle journal reset ani backfill
metadata v2 (nieidempotentny). Trzy strategie: nowa instancja z migracją danych,
kontrolowany most starego schematu, nowa baza z archiwum poprzedniej. Wybór
oraz operacje produkcyjne wymagają osobnej jawnej decyzji. Dopóki jej i realnych
prerequisites nie ma, status wdrożenia pozostaje HOLD.

## Wyniki

Wyniki dopisujemy po wykonaniu i review danego etapu; powyższe kryteria nie są
deklaracją zaliczenia testów ani ukończenia implementacji.

### Etap 1 wykonanie

- Utworzono oddzielną gałąź dokładnie od U. Frozen pnpm 10.33.0: 1384 pakiety,
  bez zmiany manifestów ani lockfile. Prywatny Node 24.22.1 sprawdzony przez
  oficjalny SHA256; brak zmian globalnego Node/pnpm i ustawień Windows.
- `build:server` i `build:client` PASS, oba budują shared i TypeScript.
  Client build używa wyłącznie syntetycznego `http://127.0.0.1:3001`.
- Bazowe testy serwera z `TZ=UTC`: 183 pliki PASS, 3000 testów PASS,
  41 SKIP w czterech plikach natywnych integracji. Bez UTC cztery testy czasu
  się nie zgadzały; ustawienie zgodne z upstream CI usuwa te błędy.
- Bazowe testy klienta z `TZ=UTC`: 123 pliki PASS, 10 FAIL; 1466 PASS,
  28 FAIL. Polski domyślny locale ICU Windows zwraca np. `2 godziny temu`
  zamiast oczekiwanego `2 hours ago` i inny separator tysięcy. LANG/LC_ALL
  nie zmienia tu natywnego locale. To znany problem bazowej przenośności
  testów, nie rezultat patchy aplikacji; nie uznajemy pełnego klienta za PASS.
  Etap 6 ma domknąć deterministyczny kontekst testów bez zmiany locale hosta.
- Build uruchomił upstream extraction: posortował 12 katalogów i usunął
  po dwa nieużywane klucze. Zweryfikowano brak nowych/zmienionych wartości,
  mechanicznie przywrócono kolejność i komplet kluczy bazy. Skrypty trackera
  i snapshot tras mają ten sam kanoniczny Git content. Brak churn w commicie.
- Raporty testów są poza repo w TEMP. Nie uruchamiano aplikacji z live env,
  migracji, serwerowego DDL, Docker ani operacji produkcyjnych.

Etap 1 utrwala czysty punkt startowy i ujawnione ograniczenia, nie deklaruje
gotowości do produkcji. Zależności runtime i finalne integracje pozostają
bramkami następnych etapów.

## Etap 2 — analiza i plan przed implementacją

### Ponowna analiza

Upstream ma gotowe endpointy Pages/Bots/Performance/Query/Dashboards, ale
Sidebar i command palette ukrywają je na podstawie IS_CLOUD/DEPLOYMENT.
Podobny warunek ukrywa przełączniki Web Vitals i wejście administratora.
Nie oznacza to potrzeby usunięcia wszystkich IS_CLOUD: billing, usage limits,
marketing i social sign-in to osobne polityki. Zachowujemy role, granty,
private-link constraints i zasobooszczędne limity SQL/replay upstream.

GSC wymaga prawdziwego OAuth ID/secret i redirect URI. Samo pokazanie karty
nie konfiguruje usługi. Weekly reports wymaga własnego Resend/sendera,
reply-to i poprawnego URL wypisania; upstream wiąże uruchomienie z cloud,
a sendEmail bez transportu potrafi zwrócić bez błędu. Harmonogram musi mieć
jednego właściciela w trybie single/cluster i zatrzymać się przy shutdown.
Włączenie transportu nie może uruchomić marketingowych kampanii SaaS.

Admin czyta hourly_event_counts, inicjalizowane obecnie wyłącznie dla cloud,
i może pytać o nieistniejące AppSumo/Stripe. Inkrementalny MV nie uzupełnia
historii. Błąd agregacji to brak danych, nie zero; aktualne sumy to obserwacja,
nie dowód pełnego pokrycia historycznego. Self-hosted nie ma fikcyjnego Pro,
renewal date ani limitu 3000. Nie dodajemy migracji/backfill ani nowej tabeli
produktu: używamy istniejącego natywnego inicjalizatora.

### Szczegółowa kolejność implementacji

1. Usunąć wyłącznie bramki widoczności istniejących funkcji produktu w
   Sidebar/palette/AppSidebar i Web Vitals (zachować mobile/private/role).
2. Dodać mały, testowalny resolver gotowości konfiguracji; /config zwraca
   wyłącznie gscEnabled/weeklyReportsEnabled, nigdy sekrety. Wpiąć gotowość
   w GSC dashboard/settings i preferencje weekly. Social login nie jest
   skutkiem skonfigurowania GSC.
3. Włączyć własny transport email wyłącznie po kompletnej konfiguracji;
   zachować cloud defaults. Brak transportu lub błąd providera nie oznacza
   dostarczenia. Marketing/lifecycle/audience pozostawić cloud-only.
4. Dostosować weekly service i oba entrypointy: jeden cron, idempotentny
   start/stop, stop na shutdown, bez cronów w cluster workers. Sprawdzić
   digest z dwoma aktywnymi sites, opt-out i ograniczone członkostwo.
5. Uruchamiać istniejącą inicjalizację hourly counts również self-hosted;
   nie uruchamiać jej podczas tej pracy przeciwko żadnej bazie. Naprawić
   projekcje admin bez AppSumo/Stripe i null/coverage w UI/API, nie zgadywać
   zera ani miesięcznego usage. Wyłączyć billing-only akcje self-hosted.
6. Dodać regresje konfiguracji, menu, permission denial, harmonogramu,
   mail failure/recipient scope, admin unknown/count coverage. Zmiany tekstu
   przepuścić przez istniejące i18n, ograniczyć wygenerowany churn.
7. Uruchomić testy zmienionych obszarów, server/client typecheck/build;
   dokonać self-review i niezależnego przeglądu całego diffu. Naprawić
   wykryte błędy, zapisać wyniki i dopiero wykonać commit etapu 2.

Właścicielem kodu etapu 2 jest jeden subagent; główny agent utrzymuje ten
plan, niezależnie sprawdza źródła/kontrakty i integruje wyniki. Brak zmian
na produkcji i brak zmian dependency pins.

### Review i walidacja etapu 2

- Sidebar/palette udostępniają natywne Pages, Bots, Performance, Query i
  Dashboards; zachowane są private-link/mobile constraints oraz role/granty.
  GSC, mail i raporty mają odrębne booleany gotowości, bez sekretów w /config.
  Skonfigurowany mail włącza też natywne zaproszenia i reset hasła; brak maila
  pozostawia natywne lokalne tworzenie kont, nie fikcyjne wysłanie zaproszenia.
- Dwa niezależne przeglądy doprowadziły do naprawienia niespójnych BASE_URL,
  SERVER_URL i callback redirectów, kodowania invitation params, linków transferu,
  zachowania jawnego trailing slash OAuth, inicjalizacji Stripe self-hosted
  i dostępności backendowych billing mutations. Nie wystarcza ukrycie UI.
- Obserwacje admin mają nullable counts i NOT_VERIFIED coverage; brak danych
  nie jest dodawany jako zero. Brak wiersza w działającej agregacji oznacza
  zero zaobserwowanych zdarzeń, nie dowód braku historycznych zdarzeń. Nie
  uruchomiono backfill. R2 pozostaje natywną opcjonalną infrastrukturą cloud;
  self-hosted replay używa natywnego storage ClickHouse, bez potrzeby R2.
- Podejrzenie błędu weekly digest zostało ODRZUCONE po sprawdzeniu semantyki:
  lastPageviewAt=null oznacza site aktywny w tym tygodniu; istniejący warunek
  rozróżnia go od quiet site. Zachowano go, zamiast naprawiać pozorny błąd.
- Pełny serwer: 188 plików PASS, 3032 testy PASS, 41 SKIP; po końcowych
  poprawkach URL dodatkowy zestaw konfiguracja/transfer 38/38 PASS.
  Zestaw zmienionego klienta: 10 plików / 52 testy PASS, dodatkowo reset hasła
  2/2 PASS. Oba typecheck PASS. Główny agent niezależnie uruchomił oba buildy
  po poprawkach URL/resetu: PASS. Pełny klient nadal ma jawny locale baseline
  etapu 1 do rozwiązania w etapie 6, nie jest deklarowany jako zielony.
- Realny ESLint Next (poza pustą konfiguracją upstream): w 29 zmienionych/
  nowych TS/TSX zero nowych errors względem U; siedem dawnych errors i pięć
  warnings pozostaje bazowych. Pełny audit 982 plików ma 56 error files.
  Zwykły pnpm lint nie jest wiarygodną bramką: pusty config skanuje .next
  i zgłasza brak reguł z wygenerowanych bundli. Etap 6 jawnie oddzieli debt
  upstream od nowych problemów, bez formatowania/refactoru 56 obcych plików.
- Weryfikacja uruchamiania schedulera: źródła single/cluster i testy lifecycle,
  nie rzeczywisty wieloprocesowy test procesu. Akceptacja maila przez SDK nie
  jest dowodem dostarczenia. Realne GSC, mail, SQL provisioning i browser QA
  pozostają bramkami integracji. Brak operacji produkcyjnych/migracji.
- Końcowy przegląd dodał wymóg zaakceptowanego message ID od providera;
  odpowiedź data=null/error=null nie jest sukcesem. Po tej poprawce email
  3 pliki / 37 testów PASS, server typecheck i ponowny build serwera PASS.
  Locale: dokładnie trzy nowe tłumaczenia w 12 językach; zachowano wszystkie
  wcześniejsze wartości i klucze. Usunięto wyłącznie własny format-only churn.

## Etap 3 — analiza i plan przed implementacją

### Ponowna analiza źródeł

Producent wot-cv-fe nadal identyfikuje String(userId) i przekazuje username/name
w formacie [TAG] nick, clanTag, customerId/customerName, avatarUrl, language,
browserLanguage i theme. AvatarUrl to logo klanu. Nie wywołuje identify bez
clanTag; nie zmieniamy teraz tej polityki i nie dopisujemy drugiego TAG.
Natywny getUserDisplayName już daje właściwą kolejność nazw. Profiles w PG są
aktualnym stanem traits, nie historycznym zdjęciem przynależności do klanu.

Users, UserHeader, Sessions, Replay i Events mają już traits z natywnego
enrichment. Dwa wyjątki wykryte w pełnym audycie: Goals deklaruje sessions type,
ale nie wybiera identified_user_id ani nie wzbogaca traits; Errors nie wybiera
ID/profilu w obu gałęziach paginacji. Koordynaty Globe są agregatami bez profilu.
Timeline Globe ma pełne sesje, lecz przejście przez GeoJSON może zamienić traits
w JSON-string; rzutowanie typu nie przywraca obiektu. Istniejące markery zmieniają
pozycję, ale wymagają też odświeżenia profilu/closure po zmianie nicku/logo.

People/Teams/AppSidebar to konta operatorów panelu, nie odwiedzający WoT-CV:
nie podmieniamy ich avatarów na loga klanów. Zachowujemy deterministyczną żabę
jako fallback. Nie zmieniamy identify, SQL alias resolution, usuwania profili,
schematu PG/CH ani public/private permissions.

### Szczegółowa kolejność implementacji

1. Wspólny getUserAvatarUrl(traits: unknown): avatarUrl → logoUrl → imageUrl →
   avatar_url → picture. Dopuszczalne wyłącznie absolutne HTTP(S), bez danych
   logowania, maks. 2048 znaków także po normalizacji. Zły priorytetowy wpis
   pozwala sprawdzić następny; null/array/niestring nie jest URL.
2. Rozszerzyć Avatar o optional traits. Logo object-contain, brak referrera,
   lazy load, błąd obrazu daje natywną żabę. Zmiana URL po błędzie znów pokazuje
   obraz. Bez useEffect do synchronizacji stanu; online dot zachowuje zachowanie.
3. Przekazać dostępne traits w UserRow/UserHeader, ledger/details/cards,
   SessionInfoTab, ReplayCard/breadcrumbs i EventRow. SessionInfoTab używa
   getUserDisplayName zamiast lokalnej, rozjeżdżającej się kopii resolvera.
4. Dodać natywny identified_user_id i jeden batch enrichWithTraits w Goals oraz
   Errors (flat i paginated). Zachować envelope, porządek, totalCount i site
   scope. Podłączyć Avatar/name/profile link w istniejących UI tych funkcji.
5. W locations zachować obecne grupowanie i count. Wybrać techniczne native ID,
   wzbogacić jednym batchem wyłącznie count=1 i zwrócić sample object lub null.
   Pola ID zachowują natywne nazwy, aby processResults nie zmienił "000123" w 123.
6. Mały bezpieczny adapter DOM Globe zamiast kopiowania map: używać wspólnego
   URL resolvera, escape tekstów/atrybutów, bez inline JS. GeoJSON odszukuje
   oryginalną sesję po ID lub niesie płaskie display fields. Uaktualniać istniejący
   marker po zmianie profilu. Grupie count>1 nie przypisywać jednej osoby/logo.
7. Testy: walidacja URL/priorytet, error→nowyURL, online/fallback, dotknięte widoki,
   oba Error envelopes, Goals i site isolation, count1/countN, GeoJSON round-trip,
   marker refresh i złośliwy HTML. Potem typecheck/build, review niezależne,
   poprawki, zapis wyników i osobny commit. Browser QA wspólna w etapie 6.

Własność plików: główny agent — userAvatar.ts, Avatar i zwykłe widoki (bez
Errors/Goals/Globe). Subagent — Globe/helper DOM, trzy endpointy enrichment,
typy odpowiedzi oraz Errors/Goals UI i testy. Dokument pozostaje u głównego
agenta; niezależny reviewer nie edytuje tych plików. Produkcja bez zmian.

### Review i wyniki etapu 3

- Traits i logo są przekazane przez wszystkie zaplanowane powierzchnie;
  Errors/Goals/lokalizacje używają istniejącego site-scoped PG enrichment.
  Bez nowych schematów, migracji i read-time alias modelu. Grupy na mapie nie
  są przedstawiane jako jedna osoba. Aktualne traits nie udają historii klanu.
- Review wyłapało i usunęło: stare image error po zmianie logo (osobny keyed
  image), błędne obiekty w nazwie (małe wzmocnienie natywnego resolvera),
  wyścig GeoJSON array-index po przestawieniu wyników (stabilny klucz lokacji),
  oraz async map callback po cleanup (disposed guard). Są regresje tych przypadków.
- Pierwszy client build wykrył granicę Server/Client po dodaniu useState do
  Avatar. Komponent ma teraz jawne use client; niezmieniony generateName został
  przeniesiony do czystego helpera, a Avatar zachowuje re-export. Utils importuje
  czystą funkcję zamiast komponentu. Ponowny build klienta PASS.
- Główny agent: 4 pliki / 37 testów core/avatar/name/SessionInfo PASS oraz jeden
  celowany test UserRow. Pozostałe 11 przypadków UserRow nie było wtedy odpalane
  z powodu znanego locale baseline; pełny plik wraca w etapie 6, bez nowych skip.
- Zakres subagenta: backend 4 pliki / 22 testy PASS, klient 5 plików / 13 testów
  PASS, oba typecheck PASS. Główny agent niezależnie wykonał oba buildy: PASS.
  Realny lint delta w 65 dotkniętych/new TS/TSX (etapy 2+3) nie dodał errors;
  odziedziczonych errors nie przedstawiamy jako zaliczonego pełnego lint.
- Dwa niezależne review nie zostawiły blokad w źródłach po poprawkach.
  Weryfikacja PG helpera obejmuje źródło site+ID i mockowany kontrakt handlera,
  nie rzeczywistą bazę. Prawdziwy Mapbox/OpenLayers, obrazy oraz fizyczny iPhone
  nie są zaliczone przez mocki. Pozostają acceptance etapu 6/wdrożenia.
- Usunięto wyłącznie własny extraction churn: odtworzono semantycznie identyczne
  locale i dwa usuwane baseline keys po weryfikacji wartości. Produkcja nietknięta.

## Etap 4 — ponowna analiza i plan przed implementacją

Natywny rrweb przenosi CustomEvent (type=5) bez nowej tabeli: ingest zapisuje
data jako JSON, odczyt odtwarza obiekt. Zatem korelacja nie wymaga starego
Network Replay, Identity v2, modyfikacji kompresji ani schematu. `rybbit.event`
nie jest właściwym kanałem (analytics, a nie rrweb). Rejestrator musi być
właścicielem obserwacji HTTP: poza aktywną, wylosowaną powtórką nie ma capture.
Native clock-skew poprawia zewnętrzny timestamp; nie zapisujemy drugiego
absolutnego czasu wewnątrz payloadu. Odtwarzacz pozostaje natywny.

Najważniejsze ryzyka: stare completion po stop/restart/identify, ponowne użycie
XHR, nadpisanie wrappera innego narzędzia, odczyt/klonowanie body, redirect na
obcy origin, publiczne udostępnienie konfiguracji Grafany, cache poprzedniej
witryny lub użytkownika, duplikaty retry i zamknięcie mobile drawer przez dialog.
Istnienie ID nie dowodzi retencji logów/body; trace może nie istnieć przy
sampling. Historyczne nagrania bez CustomEvent pozostają odtwarzalne.

Plan i kryteria odbioru:

1. Mały wspólny kontrakt `wotcv/request-correlation@1`: rowId, transport,
   method, origin, pathname, status, outcome, durationMs, opcjonalne correlationId
   i traceId. Zewnętrzny timestamp jest czasem zakończenia żądania. Parser
   kopiuje tylko whitelist, odrzuca nieprawidłowe wartości/ID i nie zgaduje braków.
   Brak query/hash/credentials, headers map, body, stack i resource timing.
2. Operator podaje `WOTCV_REPLAY_CORRELATION_JSON`; domyślnie wyłączone.
   Profile: siteIds, requestOrigin, grafanaUrl, orgId, lokiDatasourceUid,
   opcjonalny tempoDatasourceUid, serviceName, environment, timePaddingMs.
   Limity rozmiaru/liczby, ścisłe URL, brak wildcard i dwuznaczności site+origin;
   błędne JSON daje ogólny błąd, nigdy surowy input ani cause z parsera.
3. Public tracking config ujawnia wyłącznie allowlist origins, gdy replay jest
   włączony. Osobny no-store endpoint correlation-config wymaga natywnego
   `site(replay:read)` i nie dziedziczy publicReplayRead/private-key dostępu.
4. Fetch/XHR obserwuje tylko znane response headers x-correlation-id/x-trace-id.
   Bez outgoing injection, preflight i dotykania streamu. Zachować argumenty,
   this, identyczną Response/rejection, semantykę abort/timeout/500. Sprawdzić
   początkowy i końcowy origin. Ograniczyć pending do 64, rows do 2000 oraz
   istniejące natywne budżety. Ominąć własny transport analytics/replay.
5. Właściciel/epoch rejestratora unieważnia pending przy stop, size cap,
   cleanup, identity/session transition; stop podczas ładowania rrweb również
   blokuje późny start. Cleanup przywraca wrapper tylko jeżeli nadal jest własny.
6. UI: niewielki memoizowany dialog Requests w istniejącym player topbar,
   dostępny także mobile. Natywny seek; brak nowego zegara/player/store.
   Widoczne granice capture, empty/history/no-ID/unconfigured/error states.
   Dedupe rowId, nie correlationId (równoległe żądania nie mogą zniknąć).
7. Hook konfiguracji non-analytics endpoints+hooks, query key site+principal+
   uprawnienia; pobieranie dopiero po otwarciu, bez previous-site placeholder,
   public/private-key/wylogowany nie otrzymuje profili. Logi/Trace to osobne
   bezpieczne anchors HTTPS, noopener/noreferrer. Loki: dokładne service/env i
   structured metadata correlation filter; Tempo: traceId. Okno od poprawionego
   timestamp-duration do timestamp z ograniczonym padding, encoding JSON/URL.
8. Testy kontraktu, config/route auth, lifecycle/race/HTTP semantics i caps,
   parser/link injection oraz UI/cache/seek. Następnie niezależne review,
   poprawki, builds/typechecks i porządek locale/artifacts. Rendered synthetic
   cross-browser w etapie 6; prawdziwa retencja Grafany pozostaje live gate.

Własność: subagent implementuje shared + server/tracker i testy/artifacts;
główny agent client endpoint/hook/dialog/link builder i dokument. Reviewer
pracuje read-only na integracji. Bez nowych zależności, SQL, migracji i produkcji.

### Review i wyniki etapu 4

- Wykonano kontrakt, site-scoped konfigurację, chroniony endpoint, bounded
  fetch/XHR observer, lifecycle rejestratora i niewielki memoizowany dialog
  Requests z natywnym seek oraz linkami Loki/Tempo. Wszystkie 12 locale mają
  dokładnie 17 nowych tłumaczeń, bez zmiany/usunięcia istniejących wartości.
- Review poprawiło redirect A→B, tłumienie unhandledrejection, częściowo
  nieudany patch read-only globals, konkurencyjnych właścicieli, stop podczas
  ładowania rrweb, sampled-out manual start i stare batch controls po identify.
  rrweb bez stop function nie włącza obserwacji. JSON jest ograniczone także
  w bajtach UTF-8; znormalizowane URL mają te same granice co klient.
- Rozszerzony real-browser smoke znalazł utratę pierwszego zakończonego XHR,
  gdy aplikacja ponownie używa go w onload. Sam capture flag nie naprawił tego
  w Chromium (9 zamiast 10 rows). Ostatecznie wrappedOpen odczytuje już gotowy
  stary response przed natywnym resetem wyłącznie dla readyState4/status>=100.
  Nie zgaduje wyniku status0. Ponowny test: wszystkie 10 rows w trzech silnikach.
- Niezależne końcowe review nie zgłasza blokad źródłowych po poprawkach.
  Główny agent: server 7 plików / 70 testów PASS; shared cały pakiet 2 pliki /
  68 testów PASS (36 kontraktu); client 4 pliki / 23 testy PASS. Bez nowych skip.
  Prawdziwy browser observer smoke: Chromium/Firefox/WebKit PASS, również
  hidden CORS IDs, AbortController, synchroniczny/reused XHR i unhandledrejection.
- Oba niezależnie wykonane buildy PASS. Serwer buduje tracker z lokalnego
  source contract alias; natywne storage/query/schema i player/store nie są
  zmienione. Route snapshot jest rozszerzony tylko o deklarowany endpoint.
  Lint delta 76 plików: brak nowych errors, 14 odziedziczonych pozostaje.
- Zmierzony script.js: baza 37 351 B → 44 788 B (+7 437 B); porównawcze gzip
  11 823 B → 14 162 B (+2 339 B). To pomiar kosztu skryptu, nie upload replay,
  nie deklaracja produkcyjnego oszczędzania transferu ani zmiana limitów.
- Test roundtrip wykonuje prawdziwy ingest/query/clock correction z mockami
  infrastruktury, nie bazę. Pełny ekran Next+rrweb i mobile acceptance wracają
  w etapie 6; fizyczny iPhone oraz rzeczywiste datasource/retencja nadal live gate.
  Instrukcja operatora: WOTCV_REPLAY_CORRELATION.md. Produkcja bez zmian.

## Etap 5 — ponowna analiza i plan przed implementacją

Native docker-compose.yml ma stałe container_name oraz domyślne porty. Samo
inne -p nie izoluje od produkcyjnych kontenerów. Named volumes bez external
pozostają natomiast project-scoped. Nie przenosimy starego zestawu updaterów,
reconcile i automatycznych napraw baz. Native server/docker-entrypoint.sh
uruchamia Drizzle przed startem; backend inicjalizuje także struktury CH.
Żadnego `up`, entrypoint, SQL ani backup/restore nie używamy do preflight.
Nie zmieniamy upstreamowego compose i nie podpinamy produkcyjnych wolumenów.

Noindex wymaga osobnego vhosta. add_header w child location zastępuje dziedziczone
headers: include trzeba świadomie powtórzyć tam, gdzie są własne add_header.
Literalny pusty return 410 generuje HTML Nginx; puste manifests wymagają
zmiennej empty response. Nie dodajemy robots/meta/canonical do kodu aplikacji.
Noindex nie usuwa natychmiast wcześniej zindeksowanych wyników i nie jest auth.

Plan:

1. Osobny, jawnie wybrany overlay kandydata: usunąć stałe nazwy kontenerów,
   stały bezpieczny project name, loopback porty 13001/13002/18123/15432/16379,
   zachować native volumes/configs/health. Wyłączyć build w overlay, wymagać
   jawnych obrazów aplikacji przypiętych digestem. Wszystkie pięć usług ma
   json-file 50m/5. Brak external network/volumes i bindów do produkcji.
2. Nie dostarczać automatycznego deployera. Backend entrypoint w overlay
   pozostaje zablokowany domyślnie dedykowanym candidate startup guard;
   świadomy operator musi osobno zatwierdzić wyłącznie pustą izolowaną bazę.
   To nie jest zgoda na migrację starej bazy ani dowód, że jest ona pusta.
3. Env example zawiera wszystkie niezbędne public/private parametry etapów
   2/4; syntetyczne adresy, bez sekretów/UID z produkcji. CLOUD=false,
   telemetry off. Weryfikator czyta effective Compose JSON, sprawdza project,
   digests, ports, logging, storage, internal wiring i guard, nie drukuje
   credentials, nie korzysta z daemon/start/migrate/restart/prune.
   Testy fixture invalid/valid. Jeśli dostępny tylko standalone Compose,
   zweryfikować oficjalny pinned binarny checksum i użyć wyłącznie config.
4. Mały konfigurowany publiczny odnośnik SOURCE_CODE_URL do źródeł forka,
   walidacja HTTPS/no credentials/query/hash, zachowane upstream notices i
   license. Sidebar nie pokazuje błędnego URL. Wydanie wymaga opublikowania
   odpowiadającego źródła; samo ustawienie linku nie dowodzi publikacji.
5. Dedicated Nginx snippets: X-Robots-Tag always, hide upstream duplicate,
   robots.txt/sitemap.xml exact GET/HEAD empty410 i no-store, bez catch-all
   zmian innych usług. Instrukcja manualnej instalacji: kopia, wybrany vhost,
   konflikt locations/inheritance, nginx -t, kontrolowany reload i rollback.
   Nie instalować ani reloadować teraz; żadnego kopiowania globalnych snippets.
6. Read-only HTTP verifier dla osobnych explicit public/origin base URL:
   bez redirectów, timeout/body cap, natywne health200textOK, JS200nieHTML, noindex na
   normalnych/error/manifest odpowiedziach, GET/HEAD empty410/no-store.
   Nie logować body ani sekretów. Testy lokalnym HTTP fixture, brak live apply.
7. Podział: główny agent overlay/guard/Compose verifier i dokument centralny;
   subagent A source link i testy; subagent B Nginx/verifier/testy/instrukcja.
   Niezależne review, poprawki, walidacja dostępna lokalnie, osobny commit.
   Realny Nginx/Docker daemon i hostowe runtime checks pozostają release gate.

### Review i wyniki etapu 5

- Gotowy oddzielny candidate overlay, prywatny env example, domyślnie zamknięty
  startup guard, effective-model checker, dedicated Nginx snippets oraz bounded
  HTTP verifier. Upstream docker-compose.yml i Dockerfiles bez zmian. Nie
  przeniesiono updatera/reconcile/backfill/maintenance infrastruktury starego forka.
- Parametr SOURCE_CODE_URL jest walidowany po obu stronach, widoczny bez
  logowania i bez fallback sugerującego nieprawdziwe źródło. Native notices i
  license pozostają. Każdy z 12 katalogów ma jeden nowy przekład, bez usunięć.
- Realny Docker Compose 5.6.1 standalone (oficjalny SHA256
  91b1492f0a923427651e2b955739d732ac36b8191193bf4799e62f3e3525c4cd)
  zweryfikował merge/quiet config na syntetycznych parametrach: PASS, gate CLOSED.
  Wyłącznie parser config, bez daemon/start/DB/migracji. Fixture checker 29 PASS,
  fixture HTTP verifier 29 PASS, razem 58 PASS. Guard z pustym ACK realnie
  odmówił kodem 78; native entrypoint nie został wykonany. Shell syntax PASS.
- Niezależne review wykryło frozen NEXT_PUBLIC_* (runtime env nie zmienia obrazu)
  i CRLF native entrypoint w Windows. Instrukcja wymaga właściwych build args,
  provenance/digest i browser request proof. .gitattributes wymusza LF; plik
  entrypoint ma teraz 0CR/17LF, bez zmiany kanonicznego Git content ani logiki.
  Backend restart=no zapobiega restart-loop zamkniętego gate.
- Main review poprawiło odziedziczony MIME XML (`types { }` w obu manifests),
  Redis credential consistency i loopback callback URLs. Natywne health to
  text/plain OK, nie JSON starego forka; verifier nie wymusza zmiany aplikacji.
  Końcowe niezależne review nie pozostawia source blockers.
- Główny agent niezależnie: source backend 2 pliki/21 PASS, sidebar 19 PASS,
  oba buildy PASS. Lint delta 76 plików: brak nowych errors, 14 odziedziczonych.
  Nie uruchamiano Nginx, Docker images ani live HTTP/prod; realne inheritance,
  empty410, CDN, image provenance i opublikowanie źródeł pozostają release gate.
- Instrukcje: WOTCV_MINIMAL_DEPLOYMENT.md i WOTCV_MINIMAL_NOINDEX.md.

## Etap 6 — ponowna analiza i plan przed implementacją

Wszystkie poprzednie etapy są osobno commitowane, native schema/transport i
player zostały zachowane. Bazowe 28 błędów klienta pochodzi z locale Windows:
5 Luxon, 8 calendar day selectors i 15 default Number formatting. Node 24 ma
navigator.language=pl-PL; samo TZ/LANG lub ustawienie Luxon przed importem
nie wystarcza, bo aplikacja odczytuje navigator i nadpisuje locale. Nie zmieniamy
aplikacji ani globalnego ICU. Fixture dotyczy wyłącznie izolowanych workerów testu.

Native lint config jest pusty; jego zwykłe polecenie skanuje też .next i nie
jest poprawną bramką TS. Rzeczywisty preset Next raportuje odziedziczony dług.
Nie poprawiamy kilkudziesięciu nietkniętych komponentów tylko dla zielonego lint.
Potrzebna jest jawna bramka delta, nie ciche pomijanie nowych błędów. Dotychczas
sprawdzała 76 zmienionych TS/TSX, 14 starych errors i zero nowych.

Plan:

1. Test-only setup w OBU inline Vitest projects: navigator en-US, Luxon default
   reset beforeEach, natywne Number.toLocaleString/Date.toLocaleDateString z
   en-US tylko przy locales===undefined. Jawne locale/options/null/error/receiver
   zachowują native zachowanie. Fixture przetrwa restoreAllMocks/unstubGlobals.
   Dowody dom/node, explicit pl/de/ar i brak podmiany host Intl. Potem wszystkie
   10 bazowo czerwonych plików bez filtrów i cały client suite, żadnych nowych skip.
2. Rzeczywiste branch execution entrypointów cluster/index z mockami I/O:
   primary/single/worker/dev/db-failure, jeden weekly scheduler, brak marketing
   self-hosted, IPC readiness, shutdown stop przed close/kill. Bez OS fork,
   listen, sygnałów, process.exit, DB init/migrate lub prawdziwych cron callbacks.
   Test prawdziwego konstruktora Stripe: CLOUD=false/off → null; cloud+fakekey
   → realna instancja bez wywołania API. In-memory PGlite+real Drizzle i helper
   enrichment: izolacja site+opaque ID, history null i leading zeros. Wyłącznie
   mała syntetyczna tabela fixture, bez odpalania journal/migracji aplikacji.
3. Przenieść rzetelny lint-delta do repo: pin U, pełny preset Next, multiset
   rule+message first-line+source-line; bazę czytać przez git bez stderr noise.
   Nowe/zmienione errors blokują. Raport oddziela odziedziczone errors/warnings.
   Test samego porównania, deleted/untracked/path rules i exit status.
4. Mała adaptacja istniejącego CI, nie nowy system: push minimal branches,
   contents:read, checkout bez credentials, pełna historia tylko dla client
   delta. Uruchamiać istniejące Node fixture checks i lint delta w aktualnych
   jobach. Zachować pnpm/Node24/native runner/dependency layout. Nie kopiować
   Yarn/Maven/self-hosted/deploy jobs. Zweryfikować używane action SHA i
   trust boundary przed zmianą, bez tokenów/secrets, bez publikacji workflow.
5. Prawdziwy local Next frontend + rrweb z syntetycznym auth/API/native replay:
   lista→player/drawer→Requests→native seek→encoded Grafana URL, clan logo,
   przyspieszanie i zamykanie dialogu bez utraty sesji. Chromium desktop i
   mobile, Firefox desktop, WebKit mobile. Wszystkie zewnętrzne requesty
   blokować/stubować; app/API tylko loopback, bez produkcji i credentials.
   Profile/cookie/cache tests pozostają dodatkową bramką RTL/HTTP. Nie uznawać
   emulacji za test fizycznego iPhone ani fixture za realną retencję Grafany.
6. Native HTTP handler/ingest/read roundtrip i budgets/auth/cache wracają do
   pełnego suite. Przegląd całego diffu względem U i starego forka: zachowane
   capability gates/profiles/correlation, brak Identityv2/custom gzip/export/
   player/Growth/Uptime, brak limit increases, nowych secrets/migracji/deps.
   Build/typecheck obu pakietów i shared, native/generated artifacts/locale
   additive audit, Node ops tests, lint delta. Nie mylić skip integracji z PASS.
7. Własność: subagent A fixture locale/client config/tests; subagent B testy
   entrypoint/Stripe/PGlite; główny agent browser smoke/CI/lint gate/docs i pełna
   walidacja. Niezależny reviewer read-only. Naprawić wykryte regresje w swoim
   zakresie, ponowić bramki, dopiero osobny commit etapu 6. Live gates i pełny
   dług upstream raportować jawnie, nie maskować statusem zielonej delty.

### Etap 6 — analiza dodatkowych usterek wykrytych w realnym UI (przed poprawką)

Synthetic Next+rrweb smoke dotarł do Requests i linków, ale wykazał dwie
odziedziczone usterki. Native replay page używa useMediaQuery z @uidotdev/usehooks,
który jawnie rzuca w SSR; klient później odzyskuje widok po HTTP 500. Ten sam
pakiet ma już używany przez SiteLayout useWindowSize, bezpieczny dla SSR.
CheckoutModal wykonuje module-level loadStripe niezależnie od CLOUD, więc samo
zaimportowanie ukrytego billing UI próbuje pobrać zewnętrzny Stripe.js i powoduje
rejection, gdy transfer jest zablokowany. Nie jest to dowód awarii Grafany/rrweb.

Plan poprawki ograniczony do granicy środowiska, nie custom playera:

1. Replay page: zastąpić client-only media hook istniejącym useWindowSize;
   breakpoint nadal dokładnie <768. Brak nowych hooków/deps lub zmian odtwarzania.
2. CheckoutModal: module-level Stripe wyłącznie IS_CLOUD; self-hosted render
   zwraca null również przy podstawionym clientSecret. Cloud flow bez zmian.
   Testy rzeczywistego importu mockują wyłącznie zewnętrzny SDK/komponenty,
   sprawdzają brak load w self-hosted i zachowanie cloud.
3. Powtórzyć typecheck/lint delta/build, UI HTTP200 + brak zewnętrznego Stripe
   i nowych pageerrors, lokalne native seek/speed/drawer. Ponowić pełny client
   suite; native backend/storage/player nadal niezmienione.

Przegląd zainstalowanego @stripe/stripe-js 8.8.0 ujawnił, że root import sam
wstrzykuje skrypt w microtask nawet bez wywołania loadStripe. Sama bramka na
wywołaniu jest niewystarczająca. Używamy oficjalnego `/pure` entrypoint tego
samego SDK i bramki CLOUD, bez nowej zależności. Cloud nadal wywołuje loadStripe;
self-hosted nie importuje eager loadera i nie inicjalizuje SDK. Weryfikacja
obejmuje dependency source oraz rzeczywistą przeglądarkę z blokadą egress.

Końcowe review strony replay wykazało również pięć odziedziczonych conditional
hooks po demo early-return. Minimalna poprawka rozdziela pusty demo guard od
komponentu zawartości: hooki są unconditional, demo nadal nie uruchamia query
ani playera. Dodano osobny dowód renderu demo bez query. Nie zmienia to store,
rrweb ani algorytmu odtwarzania. Nowy build i pełny suite obejmują tę poprawkę.

### Etap 6 — wyniki i końcowe review

Główny agent obejrzał także finalne PNG Requests, nie tylko odtwarzanie.
Własna tabela na telefonie ściskała endpoint do kilku znaków i ucinała akcje.
Plan ostatniej poprawki: ten sam pojedynczy DOM danych, responsive grid row
na <640px z pełnej szerokości endpoint/IDs i wrap akcji; desktop pozostaje
tabelą. Zachować nagłówki dla accessibility, bez drugiego renderu/hooków,
nowych tekstów, playera lub zmian payload. Powtórzyć RTL/lint/build i cały
czteroprzeglądarkowy smoke z widocznymi linkami mieszczącymi się w mobile.

- Pełny client: 156 plików / 1631 PASS, bez failures i skips; Node24, UTC,
  maxWorkers=2. Bazowe 28 locale failures usunięto wyłącznie fixture testowym.
  Nowe testy potwierdzają native locale explicit/null/options/receivers oraz
  brak zmiany globalnego Intl/hosta; osobny proces nadal używa pl-PL.
- Pełny server: 199 plików PASS, 4 SKIP; 3147 PASS, 41 SKIP. Shared 68 PASS.
  Skips natywnych integracji nie są dowodem działania live DB/infrastruktury.
  Nowe entrypoint/SDK/PGlite: 27 PASS; prawdziwy helper+Drizzle izoluje site,
  leading zeros, duże opaque IDs i punctuation. Brak migracji aplikacji.
- Oba buildy PASS. Client build ma jawny loopback API origin 13001/CLOUD=false;
  build+typecheck obejmują finalną poprawkę SSR/demo oraz Stripe pure-loader.
  Wszystkie 12 katalogów sprawdzono semantycznie i przywrócono HEAD; żadnych
  nowych tłumaczeń, usunięć bazowych kluczy ani generated-artifact churn.
- Node fixtures 64 PASS. Repo-owned lint delta z pełnym presetem Next:
  84 pliki, 14 odziedziczonych errors, zero nowych errors. Porównanie multiset
  nie maskuje duplikatu starego błędu; brak Git/bazy daje sanitizowany exit2.
  Nie jest to deklaracja naprawienia całego długu lint upstream.
- CI zachowuje native jobs/pnpm/Node24. Dodano minimal branch push, read-only
  token, brak persisted checkout credentials, full-SHA actions i bramki fixture/
  lint delta. Oficjalne action refs sprawdzono przed pinningiem. Niezależne
  review: 0 critical/high/medium/low/info nowych findings. Remote CI nie uruchomiono.
- Recorder smoke Chromium/Firefox/WebKit: 10 request rows każdy, body unchanged,
  native rejection/abort/XHR reuse zachowane. Real Next+rrweb UI: Chromium
  desktop/mobile, Firefox desktop i WebKit mobile — HTTP200, brak pageerrors,
  exact Grafana origin/basepath/datasource/query/ID/time window, clan logo,
  native goto20s, wszystkie pięć prędkości, touch/pointer seek, realne 4x playback.
  Ten sam player i iframe pozostają; nested Requests Escape/goto nie zamyka
  mobile drawer. Główny agent obejrzał finalne desktop/mobile playback PNG.
- Smoke używa własnych loopback Next i syntetycznego API GET/OPTIONS. Ten drugi
  jest potrzebny również natywnemu SSR module-level auth getSession, nie tylko
  interceptowi przeglądarki. Nie startuje prawdziwy backend. Jedyny zadeklarowany
  zewnętrzny URL-fixture to native GET app.rybbit.io/api/version, obsłużony lokalnie
  bez wyjścia do sieci; pozostałe próby egress blokują test. Stripe nie jest ładowany.
  Brak unhandledRejection/ECONNREFUSED w Next log. Oba własne zasoby zatrzymano.
- Niezależny semantic review całego diffu: native SQL rate limits 60/20 per min,
  query budgets/isolation, auth/site permissions, cache, PG schema/journal,
  identity i replay storage/query oraz dependency pins zachowane. Nowa korelacja
  nie jest starym Network Replay ani drugim playerem. Nie ma nowej tabeli,
  Identityv2, custom gzip, eksportu WebM/ZIP, Growth Accounting czy Uptime.
- Fizyczny iPhone, live Grafana/retencja/CORS, real SQL query-user provisioning,
  mail delivery/GSC, Nginx/CDN, obrazy/provenance i przejście danych pozostają
  osobnymi release gates. Fixture/browser emulation nie zamyka tych bramek.
