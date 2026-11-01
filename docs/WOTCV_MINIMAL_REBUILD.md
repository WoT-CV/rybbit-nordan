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
