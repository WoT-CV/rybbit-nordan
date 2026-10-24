# Integracja master z feat/wotcv i stabilizacja powtórek mobilnych

## Cel i granice zmian

Włączamy aktualny `origin/master` do `feat/wotcv`, zachowując rozszerzenia WoT-CV.
Nie kopiujemy forka na `master`, nie zastępujemy jednej historii drugą i nie
wycofujemy funkcji tylko dlatego, że upstream ich nie ma. `master` pozostaje
gałęzią śledzącą główny projekt. Zakończeniem lokalnej pracy jest zweryfikowany
merge pozostawiony do przeglądu, bez automatycznego commita ani pusha.

Zmiany na produkcji ograniczają się do diagnostyki po SSH. Nie uruchamiamy
wdrożenia, migracji, DDL, odtwarzania bazy, restartów ani reloadu Nginx. Nie
zwiększamy limitów uploadu, dekompresji, body, zapytań ani zasobów. Nie dodajemy
archiwum dużych body ani fragmentowania ich w Loki. Zachowujemy historyczne
body oraz unikalne dane przeglądarkowe, których nie zastępuje Grafana.

## Stan początkowy i analiza historii

Referencje sprawdzone po `git fetch origin` 24 października 2026:

| Referencja                         | Rewizja                                    | Znaczenie                         |
| ---------------------------------- | ------------------------------------------ | --------------------------------- |
| `feat/wotcv` i `origin/feat/wotcv` | `d9a750a100fe67ff2ac94c21860f7d46541691fd` | Punkt wyjścia forka               |
| `origin/master`                    | `045dd67765a89dcecf618c4d13567bac9143342a` | Przypięty zakres integracji       |
| Wspólny przodek                    | `847553b79d2b0dbea488236f9268668c675fe056` | Podstawa trójstronnego porównania |

`master` ma 18 commitów nieobecnych w forku, a fork 151 commitów nieobecnych
w `master`. Przyrost upstream obejmuje 138 plików, 4018 dodanych i 830 usuniętych
wierszy oraz dwie aktualizacje binarnych baz GeoLite. Porównanie od wspólnego
przodka jest właściwe: zwykły diff końcówek przedstawiałby również usunięcie
naszych funkcji jako zmianę upstream. Próbne połączenie wykazuje 29 plików
konfliktowych. Czysto scalone pliki również wymagają kontroli semantycznej.

### Wszystkie nowe zmiany upstream

| Commit     | Zakres i decyzja integracyjna                                                            |
| ---------- | ---------------------------------------------------------------------------------------- |
| `24eee008` | OAuth MCP i przekierowania loopback; zachować walidację klienta i origin                 |
| `db965168` | Poprawka wildcard rewrite Caddy w dokumentacji; nie zmieniać prywatnego vhosta           |
| `4d15d59b` | Limit replay 50 MiB na sesję; połączyć z gzip, retry i kolejnością forka                 |
| `e6b9f41d` | Liczbowe `meta.total` celów MCP; przyjąć wraz z testami kontraktu                        |
| `b8b17832` | Zakres zaznaczenia kalendarza; zachować nasze przypadki dat i porównań                   |
| `e98b571b` | Nowy komunikat tłumaczeń; połączyć klucze bez utraty polskiego pokrycia                  |
| `1a8f1ff9` | Izolacja SQL per site, normalizacja identyfikatorów i bezpieczne usuwanie użytkownika    |
| `3fc6af8e` | Kompresja odpowiedzi ClickHouse; zachować osobny użytkownik zapytań i jego limity        |
| `8244ee8f` | Cache preflight trackerów i mniej logów hot path; nie rozszerzać CORS panelu             |
| `d61502e0` | Cache sesji na pojedyncze żądanie i usunięcie zbędnego JWT; zachować role i granty       |
| `7f3ce916` | Polling aktywnych sesji tylko przy otwartym drawerze; zachować pierwszy pageview         |
| `829b2dc7` | Jednorazowa serializacja replay i zapis R2; zachować sekwencje i tryby metadanych        |
| `d02f43fc` | Leniwe ładowanie geometrii map; sprawdzić wszystkich konsumentów geoStore                |
| `9cee0e90` | Bazy GeoLite ASN i City; przyjąć binaria upstream bez ręcznej regeneracji                |
| `5b8a8882` | Przypięcie Node 24.22.1 w Dockerfile i Dependabot Docker; zachować pnpm i build metadata |
| `d983b2a1` | LCP i CLS bez interakcji użytkownika; zachować cykl życia trackera i jego opcje          |
| `fe676c67` | Zbiorcze poprawki auth, webhooków, importu, replay, uprawnień, cache i usuwania          |
| `045dd677` | Merge aktualnego upstream do forka master; integrujemy tę dokładną końcówkę              |

Upstream nie zmienia pakietów npm/pnpm, lockfile, pakietu shared ani schematu
PostgreSQL i migracji Drizzle. Nowe operacje startowe ClickHouse dotyczą
użytkownika custom SQL, profilu, row policy i kontroli izolacji. Nie są
uruchamiane w czasie tej pracy na produkcji. Ich bezpieczeństwo wymaga testów
konfiguracji i SQL, mimo braku nowej migracji PostgreSQL.

### Funkcje forka wymagające zachowania

1. Identity Resolution v2: aliasy PostgreSQL, słownik ClickHouse, rozdzielenie
   anonimowego i kanonicznego ID, ochrona przed przejęciem aliasu i brak
   historycznych mutacji wiążących zdarzenia z niewłaściwym użytkownikiem.
2. Role organizacyjne i site grants, ograniczenia zaproszeń oraz atomowe
   przenoszenie site z czyszczeniem grantów, cache i limitów importu.
3. Tryby metadanych replay v1, dual i v2, historyczne odczyty, kolejność
   `sequenceNumber`, deduplikacja, korekta zegara oraz snapshot tożsamości batcha.
4. Network Replay metadata, weryfikowalne pokrycie HTTP, odnośniki Grafana
   Tempo/Loki i ich domyślne UID, historyczne body i bezstratny upload gzip.
5. Typowany adapter rrweb, jedna aktywna powierzchnia playera, selekcja sesji,
   autoplay, seek preview, inactivity skipping, eksport i jego zakres czasu.
6. Pętle zwrotne dla opublikowanych portów, Redis bez publicznego portu,
   trwałe zewnętrzne wolumeny, kontrola projektu Compose i walidacja danych
   przed oraz po wdrożeniu. Bez kasowania wolumenów i obchodzenia guardów.
7. Wersja i SHA obrazów, `/api/health`, informacje o źródłach i precompressed
   assets oraz izolacja budowy klienta od źródeł backendu.
8. Noindex panelu i API, puste robots/sitemap 410, niezależny prywatny snippet
   tracking oraz nienaruszona konfiguracja innych usług.
9. Polskie tłumaczenia, self-hosted capabilities, identyfikacja użytkowników,
   growth accounting, mapy i rozszerzona analityka.

## Diagnostyka produkcyjna

Odczyt SSH 24 października około 10:29 UTC potwierdził:

- Checkout serwera ma HEAD `d9a750a1`, ale backend i klient działają z obrazu
  `45a267d3`, zbudowanego 12 października. Lokalny i publiczny health są zgodne.
- Kontenery mają zero restartów, a flaga OOM jest false. Nie dowodzi to braku
  presji pamięci w Safari: pamięć procesu telefonu nie jest pamięcią serwera.
- Trzy pliki Compose mają lokalne modyfikacje użytkownika. Nie wolno ich
  resetować ani wciągać do lokalnego merge bez osobnego uzgodnienia.
- W ograniczonym wycinku logów odczyty replay zwracały 200. Błędy uploadu
  `aborted` i `Invalid replay gzip` dotyczą nagrywania i nie są dowodem
  przyczyny zamknięcia odtwarzacza.
- Log klienta zawiera siedem wyjątków `useMediaQuery is a client-only hook`.
  Jedyny taki import hooka bibliotecznego znajduje się na stronie replay.
  Renderowanie SSR odtwarza ten sam wyjątek. Istniejący lokalny hook jest
  zgodny z SSR, więc wystarczy zmienić import i dodać regresję renderowania.

Odpowiednie pliki replay są identyczne w `45a267d3` i `d9a750a1`. Aktualizacja
samego SHA do `d9a750a1` nie stanowi więc naprawy mobilnego odtwarzania.

### Potwierdzone i niepotwierdzone przyczyny mobilne

Błąd SSR jest potwierdzony. Nie utożsamiamy go jednak z zamykaniem już otwartej
szuflady podczas dotyku. W kodzie playera nie ma automatycznego przekierowania
do listy na błąd fetch; błędy wyświetlane są wewnątrz playera.

Vaul domyślnie pozwala zamknąć szufladę gestem i dotknięciem tła. Obecne
`data-vaul-no-drag` chroni tylko część DOM, nie wszystkie mechanizmy zamykania.
Menu prędkości jest portalem. Sam portal nie dowodzi błędu, ponieważ Radix
obsługuje zagnieżdżone warstwy. Trzeba przetestować realne prymitywy, nie tylko
mock Drawer używany w dotychczasowych testach.

Otwarcie powtórki jest stanem lokalnym komponentu; przeładowanie WebKit może
wrócić do listy. Nie przypisujemy jednak takiego przeładowania do pamięci bez
odtworzenia lub telemetrii. Najpierw naprawiamy dowiedzione błędy i chronimy
obsługę gestów, bez przechwytywania dowolnej nawigacji użytkownika.

## Szczegółowy plan wykonania

### Etap 0 Przygotowanie i odtwarzalna walidacja

1. Przypiąć obie rewizje i bazę porównania podane powyżej; nie aktualizować
   celu integracji w trakcie pracy bez ponownego diffu.
2. Potwierdzić czysty lokalny worktree i brak rozpoczętej operacji Git.
3. Zachować referencję backup do `d9a750a1`, bez przepisywania historii.
4. Zachować niniejszą analizę i plan w dokumentacji repozytorium.
5. Usunąć pojedynczy końcowy przecinek z `client/package.json`, który już
   w punkcie wyjścia uniemożliwia pnpm odczyt całego workspace. Nie zmieniać
   wersji zależności ani nie regenerować lockfile bez potrzeby.
6. Wykonać testy bazowe replay po naprawie parsera; zapisać odrębnie błędy
   istniejące wcześniej i wprowadzone przez integrację.
7. Przygotować merge `--no-ff --no-commit` z dokładnego SHA master.
   Nie używać reset hard, clean, rebase ani globalnego ours/theirs.

Warunek wyjścia: znane wejścia, kopia referencji, pnpm działa, plan istnieje.

### Etap 1 Integracja infrastruktury i zmian bez konfliktów

1. Przejrzeć wszystkie 138 plików upstream według subsystemów z tabeli, nie
   tylko konflikty tekstowe. Zweryfikować automatyczny merge konfiguracji.
2. Przyjąć Node 24.22.1 w etapach build i runtime, zachowując cache pnpm,
   workspace deploy, Chromium i nasze ARG/ENV związane z build metadata.
3. Połączyć Dependabot Docker z istniejącą osobną konfiguracją npm dla docs.
   Nie kopiować Yarn ani obcych workflow do repozytorium pnpm.
4. Zachować porty, healthchecki, external volumes, nazwy usług/projektu i
   Redis isolation. Rotacja logów nie może rozluźnić naszych ustawień.
5. Scalając locale, zachować całą zawartość forka i dodać wyłącznie nowe klucze
   upstream; skontrolować duplikaty, zgodność kluczy oraz polski komunikat.
6. GeoStore: zachować kontrakt naszych map i leniwe ładowanie geometrii;
   sprawdzić kraje/boty/rollup oraz fallback nieznanego subdivision.
7. LiveUserCount: przyjąć razem polling, stan drawer i pamięć pierwszej
   odsłony. Unikać martwych referencji do usuniętych mechanizmów.
8. Przejrzeć pozostałe automatyczne poprawki: import CSV, usuwanie importu,
   feature flags, GSC callback, limit importu i cache konfiguracji site.
9. Nie odtwarzać masowo wcześniej świadomie usuniętych dokumentów.

Warunek wyjścia: komplet funkcji upstream w kandydacie, zachowane konfiguracje
forka, brak nieprzejrzanych automatycznych rozstrzygnięć w krytycznej logice.

### Etap 2 Bezpieczeństwo identity i izolacja zapytań

1. Połączyć `queryUser.ts` z nowym rozdzieleniem setup/access i row policy.
   Zachować nasz zakaz używania konta main lub default jako konta query;
   walidacja musi nastąpić przed jakimkolwiek CREATE/ALTER/REVOKE.
2. Zachować READONLY ograniczeń profilu. Nie zmieniać limitów pamięci,
   czasu, liczby wierszy i współbieżności. Sprawdzić izolację site i zakaz
   alternatywnych baz, tabel systemowych oraz funkcji tabelowych.
3. Przenieść bramkę uprawnień `ingest:write` do faktycznych zmiennych
   `requestIp` i `requestUserAgent` w naszym identify. Żaden wcześniejszy
   fallback nie może nadal ufać nieautoryzowanym override z body.
4. Zachować claimTrackerAlias, obsługę konfliktu 409/rotacji anonymous ID,
   migracyjne aliasy oraz niezależne aktualizacje profilu.
5. Do naszego deleteUser przenieść ochronę pustego ID i nieprawidłowego site.
   Zachować kasowanie z metadanych v1/v2, eventów, aliasów, profili i R2 oraz
   izolację cudzych zdarzeń na współdzielonym urządzeniu.
6. Przyjąć cache sesji i admina na obiekcie request, z retry po błędzie,
   bez cache globalnego przenoszącego uprawnienia między żądaniami.
7. Sprawdzić hook udanego przyjęcia zaproszenia i fail-closed site grants,
   atomowe przenoszenie site, invalidację cache, pola billing input:false.
8. Dodać testy konfliktów semantycznych, nie tylko zaakceptować testy upstream.
   Nie uruchamiać zapytań provisioning ani usuwania danych na produkcji.

Warunek wyjścia: regresje auth/SQL/identity przechodzą; granty i usuwanie nie
rozszerzają uprawnień ani zakresu danych.

### Etap 3 Nagrywanie replay i limit sesji

1. Połączyć jednorazową serializację eventów z zapisem sequenceNumber,
   anonimową tożsamością sesji i v1/dual/v2 metadanymi.
2. Budżet 50 MiB mierzyć bajtami UTF-8, nie liczbą znaków JavaScript.
   Zliczanie i decyzja muszą być atomowe w Redis; zachować fallback upstream
   i jawnie wskazać jego ograniczenie do pojedynczego workera przy awarii.
3. Limit stosować przed R2 i zapisami ClickHouse, zachowując zachowanie
   batcha przekraczającego próg i odmowę kolejnych batchy.
4. Propagować wynik `stopRecording` przez endpoint, uploader gzip/plain,
   Tracker oraz SessionReplayRecorder. Sukces tekstowy starego serwera
   pozostaje zgodny; błędy HTTP nie mogą stać się sukcesem.
5. Zatrzymanie po cap musi odpiąć recorder, wyczyścić buffer i jego licznik,
   kolejkę pending, retryAttempts oraz oba timery. Nie wysyłać kolejnych
   połówek podzielonego batcha ani nie odtwarzać zatrzymanej kolejki po błędzie.
6. Zachować kolejność, retry budget, snapshot tożsamości, pojedyncze
   zamrożenie JSON, próg kompresji i downgrade po 415; bez dodatkowego
   równoległego uploadu i bez podnoszenia limitów 413/dekompresji.
7. Zachować minimalne metadata Network Replay i domyślne linki Grafana.
   Nie usuwać danych historycznych i nie dodawać archiwum body.
8. Po ustabilizowaniu źródeł zregenerować script-full.js/script.js wyłącznie
   istniejącym buildem i zweryfikować powtarzalność artefaktów.

Warunek wyjścia: testy gzip/plain/415/413/cap/retry/Unicode, trybów metadanych
i zgodności historycznej przechodzą, a żaden limit nie został zwiększony.

### Etap 4 Odtwarzacz iPhone i zachowanie stanu

1. Zachować nasz adapter rrweb oraz zasadę jednej aktywnej powierzchni przy
   fullscreen; nie wprowadzać drugiej konkurencyjnej implementacji store.
2. Przenieść cel poprawek upstream dotyczących właściciela playera i cleanup
   na obecny adapter. Stary cleanup nie może usunąć nowszego playera.
3. Przy scalaniu ReplayCard zachować poprawną selekcję kolejnej sesji po
   usunięciu i nie dopuścić do wiszącego ID usuniętej powtórki.
4. Zastąpić potwierdzony SSR-unsafe import useMediaQuery istniejącym lokalnym
   hookiem oraz dodać test SSR bez dostępu do window.
5. Odtworzyć ścieżkę: lista sesji -> otwarcie -> menu prędkości -> kilkukrotna
   zmiana prędkości -> seek -> orientacja -> dalsze odtwarzanie.
6. Testować prawdziwe Drawer/Select i portale. Ewentualne zabezpieczenie
   przypadkowego dismiss ma być lokalne dla replay, zachować jawne X i
   dostępne wyjście klawiaturą, bez zmiany wszystkich drawerów aplikacji.
7. Zachować preview podczas przeciągania i pojedynczy seek po zakończeniu
   gestu, brak ukrytego ciężkiego sidebaru mobilnego i stabilny resize.
8. Nie utożsamiać emulowanego WebKit z fizycznym iPhonem. Oddzielić dowody
   odtworzenia od hipotez memory eviction i wyników statycznego przeglądu.

Warunek wyjścia: testy lifecycle/SSR/gestów przechodzą; wykonane testy
przeglądarkowe albo precyzyjnie opisana blokada ich wykonania.

### Etap 5 Walidacja integracji i review

1. Sprawdzić brak markerów konfliktu i plików unmerged oraz `git diff --check`.
2. Zweryfikować odczyt manifestów, zgodność zamrożonego lockfile i build shared.
3. Uruchomić targeted testy wszystkich ręcznych rozstrzygnięć.
4. Uruchomić pełne testy server i client z ograniczoną liczbą workerów.
5. Uruchomić typecheck workspace, lint klienta oraz build backendu i klienta.
6. Uruchomić istniejące testy skryptów operacyjnych Python i Node, w tym
   persistence/common/auth-cutover oraz replay wire/runtime/evidence audits.
7. Sprawdzić format zmienianych ręcznie plików i generowanie analytics.
8. Sprawdzić realnie wyrenderowany replay w desktop i mobilnym viewport,
   tożsamość strony, brak overlay, konsolę i wynik interakcji. Plugin Browser
   jest niedostępny w tej sesji, więc używamy dostępnego Playwright.
9. Niezależny reviewer przegląda gotowy diff, nie tylko własne pliki.
   Każde istotne znalezisko wymaga poprawki, testu i ponownego review.
10. Porównać końcowy kandydat z oboma rodzicami: upstream nie może zniknąć,
    a oczekiwane różnice WoT-CV muszą być wyjaśnione.
11. Zaktualizować poniżej wyniki komend, ograniczenia i warunki dopuszczenia
    do produkcji. Nie deklarować testu, którego nie wykonano.

### Etap 6 Poprawki wykryte w niezależnym review

Review gotowego kandydata ujawniło dodatkowe przypadki, których nie wolno
przykryć zielonymi testami podstawowego merge. Każdy wymaga osobnego testu
regresyjnego, ponownego przeglądu i uruchomienia odpowiednich pełnych bramek.

1. **Budżet a retry po niepewnym zapisie.** Rezerwacja przed ClickHouse/R2
   może przekroczyć cap, a insert następnie zgłosić błąd. Retry tego samego
   batcha nie może dostać terminalnego cap, bo dane mogły nie zostać zapisane.
   Rezerwację trzeba identyfikować hashem surowych timestampów, typu,
   sequence, identity i jednokrotnie serializowanych danych. Redis rozpoznaje
   retry atomowo przed testem cap. Pamięć fingerprintów musi być ograniczona;
   brak pojemności nie może udawać potwierdzonego terminalnego cap. Nie
   refundujemy na sam wyjątek, bo timeout nie dowodzi braku zapisu. Budżet
   nie oznacza exactly-once storage ani twardego limitu fizycznych kopii.
2. **URL a konto ClickHouse.** SDK nadaje credentials i parametrom URL
   pierwszeństwo przed jawną konfiguracją. Query client musi używać osobnego
   URL bez auth/query overrides, zachowując endpoint, podczas gdy main
   zachowuje istniejącą konfigurację. Guard porównuje efektywne konto main,
   a test sprawdza prawdziwy parser SDK, nie tylko mock createClient.
3. **Fail-closed podczas przyjęcia restricted invitation.** Better Auth
   zapisuje członka przed afterAcceptInvitation. Błąd dodatkowego SELECT
   lub UPDATE nie może pozostawić unrestricted membership. Przed zmianą
   należy dowieść na zainstalowanym SDK ustawienia restrictive flag przed
   INSERT, bez migracji i zmiany adaptera. Następnie wykorzystać zaakceptowany
   payload bez ponownego SELECT, odblokowywać tylko jawne unrestricted
   zaproszenia i pokryć tworzenie ownera, normal add, role i awarie.
4. **Rollback w kontekście warunkowym Bash.** `rollback ... || true` wyłącza
   działanie samego errexit wewnątrz funkcji. Wszystkie kroki pull/up,
   walidacje storage, ClickHouse i PostgreSQL muszą jawnie propagować błąd.
   Testy uruchamiają wyłącznie wyekstrahowane funkcje z mockami, również
   wewnątrz if/OR. Root guard GHCR musi działać przed operacjami, a nie
   dopiero w końcowym preflight.
5. **Responsive layout i reset powtórki.** Test odtworzył utratę lokalnego
   stanu po przekroczeniu 768 px: layout zwracał dwa różne drzewa i odmontowywał
   całą stronę. Zachować tę samą pozycję route w drzewie i przenieść różnice
   układu do CSS. Test portrait/landscape ma potwierdzić jedną instancję
   route, niezmienione private-link context i embed redirect.
6. **Cache listy po usunięciu replay.** Poczekać na invalidację listy,
   nie wybierać usuniętego elementu z cache podczas refetch/error, nie
   resetować nowszego wyboru ani wyniku z innego site. Dodatkowo kontrolować
   własność playera przed destroy i nie montować ciężkiej ukrytej osi
   timeline na telefonach.
7. **Dotykowy seek i klawiatura.** Rzeczywisty WebKit odtworzył DOWN na
   wypełnieniu osi, UP na thumb i brak `onValueCommit` Radix. Lokalne
   hit-testing CSS kieruje gest do Slider Root, bez zastępowania jego
   obsługi końca gestu i czyszczenia geometrii. Rzeczywisty Radix wykonuje
   keyboard COMMIT przed CHANGE; preview może działać tylko podczas pointer
   gesture. Spóźniony ruch starego gestu nie może rozpocząć preview nowego
   playera. Testować również cancel, utratę capture i nową geometrię po resize.
8. **Focus-scroll po menu prędkości.** `overflow:hidden` pozwala na
   programatyczne przewijanie. WebKit po zmianie prędkości przewijał przycięty
   panel do kontrolki i usuwał player z widocznego obszaru. Tylko drawer
   replay otrzymuje `overflow:clip`; zachować jawne X/Escape i portale Select.
9. **SSR i zmiana viewportu.** Guard `useHydrated` utrzymuje zgodny pierwszy
   render CommandPalette przy szybkim cache auth. Lokalny `useMediaQuery`
   korzysta z `useSyncExternalStore`, stałego null SSR, zdarzeń media change
   i resize oraz świeżego odczytu matches. Testy muszą sprawdzać przekroczenie
   progu, cleanup i utrzymanie otwartej sesji po rzeczywistym handoff.
10. **Koszt StrictMode i timer biblioteki.** Odtworzono niezatrzymany poster
    timeout rrweb po natychmiastowym destroy. Anulowalna inicjalizacja w
    microtask usuwa próbny ciężki konstruktor StrictMode; nie tłumić warningów
    i nie patchować biblioteki. Pilnować session/selectionVersion także przed
    konstrukcją, autoplay oraz cleanup po częściowej awarii.
11. **Pełniejszy guard principal ClickHouse.** URL `http_header_*` może
    dostarczyć auth nagłówki obok Basic Auth SDK. Nie zgadywać precedencji
    serwera/proxy: token lub auth-header override daje principal null i
    fail-closed custom SQL przed provisioningiem i dodatnim cache izolacji.

## Warunki wdrożenia i wycofania

Lokalny merge nie aktualizuje produkcji. Przed wdrożeniem trzeba przejrzeć
i zachować trzy lokalne zmiany Compose na serwerze, doprowadzić checkout do
uzgodnionego czystego stanu i sprawdzić konkretny commit oraz obrazy.
Nie obchodzimy guardu clean-worktree i nie uruchamiamy updatera z niedokończonym
merge. Lokalny merge pozostaje bez commita do zatwierdzenia przez użytkownika.

Warunkiem release jest przejście testów, przegląd własnych rozszerzeń, znane
obrazy obu aplikacji, zweryfikowany backup bazy i istniejące kontrole wolumenów,
portów, danych oraz health. Po wdrożeniu potrzebne są login istniejącym kontem,
anonimowe/identified sesje, historyczne i nowe replay, linki Grafana oraz
test szybkości i seek na fizycznym iPhonie. Bieżący zakres upstream nie dodaje
migracji PostgreSQL; nie jest to zgoda na uruchomienie migratora w tej sesji.

Przy wycofaniu wybieramy konkretne wcześniejsze obrazy, a nie przypadkowe
latest. Nie usuwamy wolumenów, nie cofamy schematu SQL i nie restartujemy
starych writerów po niezgodnej zmianie auth. Nowe ograniczenie nagrywania nie
usuwa historycznych nagrań. Zachowany punkt wyjścia Git umożliwia porównanie
lokalnego kandydata bez ingerencji w dane produkcyjne.

## Wyniki wykonania

Implementacja została scalona lokalnie z przypiętego `045dd677` przez
`git merge --no-ff --no-commit`. Wszystkie 29 konfliktów rozwiązano, w indeksie
nie ma unmerged entries. `master` i zdalne branche nie zostały zmodyfikowane.
Merge pozostaje do przeglądu i zatwierdzenia, bez commita ani pusha.

Porównano także końcowe bloby wszystkich 138 ścieżek zmienionych upstream.
Tylko `ReplayPlayer.tsx` celowo pozostał identyczny z forkiem: jego typowany
adapter i pojedyncza aktywna powierzchnia są zachowane, a wymagany efekt
poprawek upstream przeniesiono do hooka lifecycle oraz store. Pozostałe
ścieżki uwzględniają zmianę upstream lub kontrolowaną adaptację.

Referencja odtworzeniowa:
`backup/feat-wotcv-d9a750a1-before-master-045dd677-20261024` wskazuje dokładnie
na pierwotne `d9a750a100fe67ff2ac94c21860f7d46541691fd`.

### Walidacja pierwszego scalania

Poniższa tabela dokumentuje pierwszy przebieg integracji. Aktualne wyniki po
dodatkowym review i poprawkach znajdują się na końcu dokumentu.

| Kontrola                                             | Wynik                                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile --ignore-scripts`    | PASS, lockfile bez zmian                                                               |
| `pnpm build:server` i `check:analytics`              | PASS, tracker zregenerowany i powtarzalny                                              |
| Pełny Vitest backendu, dwa workery                   | 3159 PASS, 41 SKIP wymagających zewnętrznego ClickHouse; 204 pliki PASS, 4 SKIP        |
| Pełny Vitest klienta, dwa workery                    | 1621 PASS w 159 plikach                                                                |
| Końcowy test NoData po poprawce ikony                | 12 PASS                                                                                |
| `tsc --noEmit --incremental false` klienta           | PASS                                                                                   |
| Izolowany `verify-isolated-client.ps1 -Offline`      | PASS, frozen install i produkcyjny build client/shared bez `server/src`                |
| ESLint wszystkich 56 zmienionych plików klienta      | PASS bez ostrzeżeń                                                                     |
| Pełny ESLint klienta                                 | 95 istniejących błędów, 145 ostrzeżeń; nie deklarujemy pełnego PASS                    |
| Testy operacyjne Python                              | 57 PASS, wyłącznie lokalne fakes/ekstrakcja funkcji                                    |
| Składnia czterech zmienionych skryptów Bash          | PASS                                                                                   |
| Testy audytów/evidence/wire Node                     | 27 PASS                                                                                |
| HTTP uploader gzip/plain/415/CORS, syntetyczne dane  | PASS: Chromium 156, Firefox 157, WebKit 27.2                                           |
| Rzeczywisty frontend i rrweb UI, syntetyczne API     | PASS: mobile WebKit, mobile Chromium, desktop Chromium, bez błędów i warningów konsoli |
| Powtórzony UI smoke na produkcyjnym `server.js` Next | PASS, oryginalny traced output Windows, z public/static jak w pakowaniu Docker         |
| `git diff --check`, rozwiązanie konfliktów           | PASS                                                                                   |

Wszystkie pozostałe pliki z błędami pełnego lint są bajtowo zgodne po
normalizacji LF/CRLF z początkowym HEAD forka. Nie wyciszano reguł i nie
przepisywano niezwiązanych komponentów tylko po to, aby ukryć dług lint.
Usunięto błędy/ostrzeżenia w dotykanym zakresie, w tym memo dependency,
martwe zmienne i wadliwy wzorzec state-in-effect lokalnego media hooka.

Kompletne testy przeglądarkowe zapisują raport i screenshoty w osobnym
katalogu tymczasowym. Reprodukowany scenariusz obejmuje otwarcie jednej
powtórki, 6 zmian prędkości, 4 wskazania pozycji, drag 40 ruchów, poza-panelowy
tap, portrait -> landscape -> portrait z handoff, zachowanie pozycji,
odtworzenie, X, ponowne otwarcie i Escape. Nie jest to test fizycznego iPhone.
Plugin Browser nie był dostępny; wykorzystano istniejącą instalację
Playwright bez dodawania zależności projektu.

Powtarzalny UI smoke (uruchomiony frontend musi być lokalny i korzystać
z podanego lokalnego API origin):

```powershell
node scripts/replay-ui-smoke.mjs <playwright-index.mjs> http://127.0.0.1:13002 http://127.0.0.1:13001
```

Skrypt odmawia publicznego celu, podstawia syntetyczne odpowiedzi wszystkich
API i nie dopuszcza mutacji API. Zewnętrzne zasoby są zastąpione pustą
odpowiedzią i wykazane w raporcie; nie jest to weryfikacja dostawców, Grafany
ani prawdziwych danych użytkownika. Raport przykładowego końcowego przebiegu:
`C:\Users\Daniel\AppData\Local\Temp\rybbit-replay-ui-zmwEs6\report.json`.
Ponowny przebieg na produkcyjnym serwerze Next zapisał evidence w
`C:\Users\Daniel\AppData\Local\Temp\rybbit-replay-ui-TjGfH6\report.json`.
Końcowy przegląd zachował również wysokość obszaru dotyku slider-root
obejmującą cały thumb (24 px zamiast samej szyny). Po tej zmianie powtórzono
produkcyjny build, 15 testów controls i pełny UI smoke trzech wariantów;
asercja geometrii sprawdza, że hit target nie jest mniejszy od thumb.

Próba przeniesienia Windows standalone przez `Copy-Item -Recurse` spłaszczyła
symlink pnpm do Next i zgłosiła brak `@swc/helpers`. Zweryfikowano różnicę
`SymbolicLink` w oryginale i zwykły katalog w kopii; oryginalny traced output
uruchamia się i przeszedł cały UI smoke. Windows trace ma absolutne symlinki
do izolowanego installu, dlatego nie traktujemy tego jako dowodu przenośności
obrazu ani zastępstwa budowy i startu standalone na Alpine.

### Ograniczenia budżetu nagrań i rollout

Limit logicznych danych pozostaje domyślnie 50 MiB; nie podniesiono limitów
uploadu ani dekompresji. Atomowy Redis rozpoznaje hash przed cap i dopuszcza
łącznie 3 próby storage tego samego batcha, zgodnie z retry recordera.
Nie refunduje niepewnego zapisu i nie gwarantuje exactly-once: przy zdrowym
współdzielonym Redis możliwe są dwie dodatkowe kopie zaakceptowanego payloadu.
Próby payloadów są ograniczone przez `3 * (cap + crossing batch bytes)`, co
nie jest limitem fizycznego dysku ani całego klastra podczas awarii Redis.

Pamięć jest ograniczona do 4096 hashy/sesję i 50 000 rezerwacji/worker
fallbacku, z TTL 2 h i bez eksmisji żywych rezerwacji. Brak pojemności,
niespójna połowa stanu lub wyczerpane retry oznaczają 503, nigdy fałszywe
`stopRecording`. Fallback nie daje klastrowego limitu podczas awarii.
Lua została przetestowana na ioredis-mock, nie na produkcyjnym Redis.
Jeżeli przed rolloutem działał już wcześniejszy wariant cap z samym licznikiem
bez hashy, jego żywy stan wymaga wygaśnięcia (do 2 h); bezpieczna odpowiedź
503 nie udaje w tym czasie kompletnego zapisu. Nie kasować kluczy produkcji
ani nie obchodzić guardu w celu przyspieszenia rollout.

### Odczyt produkcji i decyzja release po pierwszym scalaniu

Ponowna kontrola SSH o 11:29 UTC potwierdziła niezmienione obrazy `45a267d3`,
health lokalny i publiczny `ok`, brak restartów/OOM kontenerów oraz aktywny
noindex. Publiczne `/robots.txt` i `/sitemap.xml` zwracają 410, pustą treść
i `Cache-Control: no-store`. Trzy zmienione pliki Compose pozostawiono
nienaruszone. Nie wykonano wdrożenia, migracji, restartu ani reloadu.

Kandydat nadaje się do przeglądu i kontrolowanego stagingu, nie do
bezwarunkowego automatycznego wdrożenia. Pozostają bramki: zatwierdzenie
merge/commit i publikacji, przegląd lokalnych zmian Compose na serwerze,
rzeczywista budowa obrazów Alpine Node 24.22.1 (lokalne testy używały Node
24.20.0, Docker jest niedostępny), integracja row policy z rzeczywistym
ClickHouse i budżetu z Redis oraz test istniejącym kontem na fizycznym
iPhonie. Odczyt z SSH nie potwierdza przyczyny historycznego zamknięcia karty
przez WebKit; lokalnie odtworzone i naprawione zostały konkretne błędy
SSR, stanu strony, focus-scroll i kończenia gestów.

## Powtórne review zgodności własnych zmian z master

Drugi przegląd obejmuje 54 ścieżki zmienione równolegle od wspólnej podstawy
przez fork i upstream oraz ich bezpośrednich konsumentów. Referencje zdalne
ponownie potwierdzone przez `git ls-remote` nadal wskazują `d9a750a1` dla
`feat/wotcv` i `045dd677` dla `master`. Nie rozszerzamy merge o nieuzgodniony
nowy upstream ani nie traktujemy braku konfliktu tekstowego jako dowodu zgodności.

| Własny kontrakt | Dopasowanie do aktualnego Rybbit |
| --- | --- |
| Identity v2 i bezpieczne aliasy | Zachowane canonical/anonymous ID, brak przejmowania aliasów i historycznego backfill; dodatkowo zamknięte wyścigi retry identyfikacji w przeglądarce |
| Replay metadata i payload | Zachowane tryby v1/dual/v2, sekwencje, korekta zegara, historyczne body oraz gzip/415/413; jednorazowa serializacja upstream pozostaje na ścieżce ingest/R2 |
| Odczyt replay i R2 | Unikatowe klucze batchy oraz deduplikacja dokładnych zdarzeń niezależna od storage, z uwzględnieniem zapisanej tożsamości |
| Player i eksport | Zachowane adapter rrweb, pojedyncza aktywna instancja i preview seek; trwający eksport ma niezmienną tożsamość zadania, a renderer działa bez zewnętrznych zasobów |
| Private links i cache analityki | Niezmienny snapshot klucza żądania i niejawny identyfikator kontekstu cache; dostosowane wrappers, ręczne fan-outy, rollup, globe i first-pageview |
| SQL, role i grants | Atestacja musi dotyczyć faktycznej bazy SDK; zachowane ograniczone zaproszenia, role, site grants, atomowe przenoszenie site i czyszczenie dostępu |
| HTTP, auth i importy | Zachowane CORS trackera bez rozszerzenia CORS panelu, podpisy surowych bajtów webhooków, poprawki OAuth oraz mechanizmy limitów importu |
| Build i wdrożenia | Zachowane pnpm, dokładna wersja Node w obrazach, metadata SHA, kontrole danych/portów/wolumenów, rollback i noindex; przywrócone brakujące komendy jakości CI |

### Dodatkowe usterki usunięte w review

1. **Wyścig identyfikacji po logout lub zmianie konta.** Ponowienie żądania
   zachowywało stare `user_id`, ale odczytywało już nowe `anonymous_id` ze
   zmiennej konfiguracji. Spóźniona odpowiedź 409 mogła także obrócić ID nowego
   konta. Generacja tożsamości i snapshot anonimowego ID są sprawdzane przed
   retry oraz po każdym asynchronicznym odczycie odpowiedzi. Bieżący, poprawny
   409 najpierw opróżnia bufor replay pod dotychczasową tożsamością.
2. **Nadpisanie równoległych batchy R2.** Nazwa oparta wyłącznie na milisekundzie
   nie rozdzielała zapisów jednej sesji z kilku kart lub workerów. Do nazwy
   dodano UUID; dotychczasowy prefix sesji i odczyt historycznych kluczy pozostają.
3. **Deduplikacja zależna od fizycznego miejsca zapisu.** Retry w dwóch obiektach
   R2 lub po fallbacku do ClickHouse było odtwarzane wielokrotnie. Odczyt porównuje
   dokładną krotkę zapisanej tożsamości, czasu, typu, sekwencji i payloadu.
   Nie scala samych numerów sekwencji ani zdarzeń podobnych czasowo. Zdarzenia
   różniące się tożsamością są zachowane. Historyczne `null`, `false`, `0` i pusty
   string w R2 nie są już mylone z brakiem payloadu.
4. **Błędny status nieistniejącego replay.** Niepasujący tekst wyjątku dawał 500
   zamiast 404. Kontrakt jest teraz typowany; pozostałe błędy nadal zwracają 500.
5. **Inna baza podczas atestacji SQL niż podczas wykonania.** SDK daje bazie
   w ścieżce URL pierwszeństwo przed `CLICKHOUSE_DB`. Provisioning i kontrola
   row policy używają teraz tej samej rozstrzygniętej wartości. Przypadki URL,
   reverse proxy, pustej zmiennej i kodowanych ścieżek sprawdzono na rzeczywistym
   zainstalowanym SDK bez połączeń sieciowych.
6. **Eksport powiązany z nowo wybraną sesją.** Polling/download starego zadania
   używały bieżących propsów site/session. Zapis całej tożsamości zadania przy
   jego utworzeniu zachowuje pierwotne nagranie także przy spóźnionej odpowiedzi.
7. **Cache prywatnego dashboardu bez tożsamości klucza.** Ten sam site mógł
   wyświetlić dane z poprzedniego klucza. Ponadto `includes(scope)` uznawało
   dowolny pasujący element query key za site scope. Klucz cache ma teraz
   osobny niejawny kontekst, a scope jest porównywany we właściwej pozycji.
   HTTP korzysta ze snapshotu credentials, włącznie z jawnym `null`.
   Bearer key nie trafia do query keys/devtools. Mapa kontekstów ma LRU 128
   wpisów i nigdy nie ponawia dawnych identyfikatorów po eksmisji lub HMR.
   Dostosowano także cache metadanych site, has-data, profili Grafany i zapis
   po claim; dane z jednego klucza nie zasilają cache innego klucza. Polityki
   placeholderów profilu użytkownika podlegają obowiązkowej kontroli kontekstu,
   zachowując odświeżanie dat i filtrów w obrębie tego samego użytkownika.
8. **Żądania sieciowe z serwera podczas eksportu.** Odtwarzany DOM mógł
   wskazywać obrazy, CSS i iframe w sieci dostępnej serwerowi. Renderer zakłada
   offline mode, interception, bypass service worker i CSP przed snapshotem.
   Tylko lokalny bundle otrzymuje losowy nonce skryptu. Zewnętrzne HTTP(S),
   pliki i pozostałe protokoły są blokowane; connect/worker/object/form nie
   uzyskują dostępu do sieci. Film może pominąć zewnętrzne obrazy, style i fonty;
   metadane ZIP informują o tym ograniczeniu zamiast obiecywać pełną wierność.
9. **Niewykonalna ścieżka jakości CI.** Workflow obrazów wywoływał cztery
   komendy usunięte wcześniej z `package.json`. Przywrócono ich zakres z
   historii forka, bez osłabienia reguł. Odtworzony audyt PL sprawdza zmienne
   interpolacji bez mylenia ramion ICU plural/select z placeholderami.
   CI uruchamia również testy kontraktów Node i efektywnych portów Compose.

### Dowody i granice drugiego przeglądu

Test eksportu na rzeczywistym Chromium 156 użył wyłącznie syntetycznego DOM
i lokalnego serwera kontrolnego. Oryginalny renderer wykonał sześć żądań
HTTP po zasoby tego snapshotu; poprawiony nie wykonał żadnego. Snapshot,
późniejsza mutacja tekstu i osadzony obraz data URI nadal się wyrenderowały.
Próby `fetch`, Worker i WebSocket zostały zablokowane. Evidence:
`C:\Users\Daniel\AppData\Local\Temp\rybbit-export-qa-67b2f08f045146e9be569801f4ec82cf\report.json`
oraz `baseline-report.json` i screenshoty w tym samym katalogu.

To izolacja zasobów odtwarzanej strony, nie sandbox procesu systemowego.
Chromium nadal używa dotychczasowych opcji uruchomienia; nie deklarujemy
ochrony przed luką silnika przeglądarki. Lokalnie brak ffmpeg, więc test
rzeczywistego Chromium nie potwierdza pełnego kodowania WebM i budowy ZIP.
Zabezpieczenie cache dotyczy przejrzanej analityki i jej konsumentów, nie
stanowi deklaracji audytu każdego administracyjnego cache w aplikacji.

Audyt PL przeszedł dla 3174 komunikatów w zakresie struktury i placeholderów.
Dziesięć identycznych wartości EN/PL jest jawnie wypisywane do przeglądu;
nie jest to deklaracja przetłumaczenia wszystkich terminów na język polski.
Zbiory argumentów leksera porównano także z lokalnym parserem FormatJS na
6348 komunikatach EN/PL, bez różnic. Nie dodano zależności ani zmian lockfile.

### Końcowa walidacja po drugim review

| Kontrola | Aktualny wynik |
| --- | --- |
| Pełny Vitest backendu, dwa workery | 3216 PASS, 41 SKIP; 206 plików PASS i 4 SKIP wymagające zewnętrznego ClickHouse |
| Pełny Vitest klienta, dwa workery | 1648 PASS w 166 plikach |
| `pnpm build:server` i `check:analytics` | PASS; tracker ponownie zbudowany i wynik zgodny z indeksem Git |
| `tsc --noEmit --incremental false` klienta | PASS |
| Świeży izolowany build produkcyjny klienta | PASS; frozen offline install, client/shared bez `server/src` i bez lokalnych `.env` |
| ESLint wszystkich 84 zmienionych plików klienta | PASS, 0 błędów i 0 ostrzeżeń |
| Przywrócone `lint:wotcv`, `knip`, `format:check:wotcv`, `audit:polish` | PASS; lint zakresu historycznego ma 2 istniejące ostrzeżenia TanStack Virtual, audyt PL: 3174 komunikaty |
| Pełny ESLint klienta | 87 istniejących błędów i 138 ostrzeżeń; wszystkie 46 plików z błędami identyczne z wyjściowym HEAD po normalizacji LF/CRLF |
| Testy kontraktów Node i operacyjne Python | 36 PASS oraz 57 PASS; lokalne fixtures/fakes, bez zmian produkcji |
| Replay UI na produkcyjnym serwerze Next | PASS: mobile WebKit 27.2, mobile Chromium i desktop Chromium 156.0.8078.4 |
| Eksport rrweb w rzeczywistym Chromium | PASS: renderer przed poprawką wykonał 6 kontrolnych żądań HTTP, po poprawce 0; DOM i dane osadzone nadal odtwarzane |
| Whitespace, kompletność merge i referencje | `git diff --check` PASS, brak unmerged entries; zdalne SHA nadal zgodne z przypiętymi referencjami |

Build drugiego review zachowano w:
`C:\Users\Daniel\AppData\Local\Temp\rybbit-client-check-9c679a4661274919909894141c26889e`.
Na jego oryginalnym traced output uruchomiono lokalny serwer Next z
public/static skopiowanymi zgodnie z układem obrazu. Końcowy UI smoke użył
syntetycznego pięciominutowego replay, 303 zdarzeń i 750 wierszy DOM.
Sprawdził 6 zmian prędkości, 4 seeki, 40 ruchów drag, utrzymanie modala po
tap poza panelem, przejście portrait/landscape/portrait oraz zamknięcie,
ponowne otwarcie i Escape na urządzeniach mobilnych. Wszystkie trzy warianty
mają 0 błędów, 0 ostrzeżeń konsoli i 0 nieoczekiwanych wywołań API.
Zewnętrzne sprawdzenie wersji `app.rybbit.io` zostało jawnie zastąpione
odpowiedzią testową, a wszystkie API korzystały z danych syntetycznych.

Raport i screenshoty:
`C:\Users\Daniel\AppData\Local\Temp\rybbit-replay-ui-b4Rthb\report.json`.
Obraz mobilnego WebKit po przewinięciu sprawdzono również wizualnie.
Serwer testowy i przeglądarki zostały zakończone. Brak pluginu Browser
zastąpiono istniejącą instalacją Playwright, bez instalowania zależności.

W drugim review nie wykonywano ponownego SSH ani działań produkcyjnych;
wcześniejszy odczyt produkcji powyżej jest osobnym, datowanym dowodem.
Nie wykonano migracji, commita ani pusha. Kandydat zawiera 215 zmienionych
plików względem wyjściowego HEAD i pozostaje niezatwierdzonym merge.
Nie zmieniono lockfile, schematu PostgreSQL ani istniejących migracji.

W przejrzanym zakresie nie pozostał potwierdzony, niepoprawiony błąd
integracji. Nie oznacza to bezwarunkowej gotowości produkcyjnej: nadal
wymagane są budowa/start obrazów Alpine, integracja z rzeczywistym
ClickHouse i Redis, pełne kodowanie WebM/ZIP z ffmpeg oraz sprawdzenie
istniejącym kontem na fizycznym iPhonie. Te bramki nie są zastępowane przez
lokalne testy, historyczny health ani sam brak konfliktów Git.
