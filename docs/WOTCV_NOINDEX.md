# Wyłączenie indeksowania tracking.wot-cv.com

Ta aplikacja analityczna nie jest publiczną stroną marketingową. Wszystkie jej
odpowiedzi mają zakaz indeksowania: `noindex, nofollow, nosnippet, noimageindex`.
Nie uzależniamy tego od user-agent, trybu cloud, zalogowania ani konfiguracji
witryny analizowanej w Rybbit. Nagłówek dotyczy wyłącznie hosta aplikacji i jego
API, nie strony klienta, która ładuje tracker, ani samego `wot-cv.com`.

## Ochrona w kodzie

- Next.js: globalny `X-Robots-Tag` dla wszystkich ścieżek, także assets i widgetów.
- Root layout: serwerowy meta robots, dziedziczony przez strony i linki prywatne.
- `/robots.txt` i `/sitemap.xml`: puste `410 Gone`, bez mapy, listy URL ani manifestu.
- Fastify: nagłówek ustawiany przed CORS/auth na surowej odpowiedzi. Dotyczy też
  auth/MCP, błędów, przekierowań, OPTIONS, statics oraz 304.
- Caddy: natychmiastowy nagłówek dla błędów proxy i odroczone nadpisanie nagłówka
  upstream dla pozostałych odpowiedzi vhosta.

Wbudowane przekierowania normalizujące Next.js (np. `/login/`) mogą ominąć
regułę headers. Obsługuje je nagłówek proxy; nie zmieniamy routingu aplikacji.
Nagłówek Caddy w HTTPS vhoście nie obejmuje jego osobnych, automatycznie
generowanych przekierowań HTTP→HTTPS. Odczytana instalacja produkcyjna używa
Nginx z tym samym snippetem w obu server blocks, więc ta ścieżka jest chroniona.

Nie dodajemy `Disallow: /`. Robot musi móc odczytać `noindex`, również dla
wcześniej zaindeksowanych adresów. `noindex` nie zastępuje uwierzytelniania ani
kontroli dostępu. Nagłówek nie jest obietnicą zachowania botów ignorujących go.

Źródło: [Google — blokowanie indeksowania przez noindex](https://developers.google.com/search/docs/crawling-indexing/block-indexing?hl=pl).

Osobny pakiet `docs/` publikuje dokumentację/marketing upstream dla rybbit.com,
nie jest częścią Compose/Dockerfile klienta pod tracking.wot-cv.com. Nie usuwamy
jego SEO ani funkcjonalności Google Search Console w analityce.

## Produkcja: stan odczytany 2026-10-12

Publiczne odpowiedzi root, robots, sitemap i health mają już powyższy nagłówek.
Przez SSH odczytano `/etc/nginx/sites-enabled/tracking.wot-cv.com`: oba server
blocks dołączają `/etc/nginx/snippets/wotcv-search-noindex.conf`.
Obecny snippet generuje `/robots.txt` jako `200` z `User-agent: * / Allow: /`.
`/sitemap.xml` zwraca obecnie `200 text/html`, nie mapę XML.

Zmiana aplikacji nie zastępuje lokacji robots w Nginx. W repo przygotowano
`ops/nginx/wotcv-search-noindex.conf`, który wyłącza oba manifesty i zachowuje
zakaz indeksowania na przekierowaniach/błędach. Snippet należy dołączać tylko
do vhosta tracking, nie do publicznego wot-cv.com. Lokacje manifestów powtarzają
`X-Robots-Tag`, ponieważ własny `add_header Cache-Control` wyłącza dziedziczenie
`add_header` z poziomu server w używanej wersji Nginx.
W odczytanym vhoście pozostałe lokacje nie definiują własnego `add_header`.
Przy późniejszym dodaniu nagłówków na poziomie location trzeba powtórzyć również
`X-Robots-Tag`, zwłaszcza że snippet ukrywa kopię otrzymaną od upstream.
Manifesty używają jawnie pustej zmiennej w `return`, żeby Nginx nie wygenerował
standardowej strony błędu HTML dla literalnego `return 410 ""`.

Konfiguracji produkcyjnej nie zmieniano. Bezinterakcyjne sudo wymagało hasła;
odczyt wykonano jako użytkownik wdrożeniowy. Kod pozostaje bez commita/pusha.

## Wdrożenie przez administratora

1. Przejrzeć zmiany i wdrożyć obrazy backend/client zwykłym guarded skryptem.
   Nie wykonywać żadnych migracji na potrzeby tej zmiany.
2. Zachować kopię aktualnego snippetu Nginx; sprawdzić brak innych lokacji
   `= /robots.txt` i `= /sitemap.xml` w docelowych server blocks.
3. Zastąpić zawartość `/etc/nginx/snippets/wotcv-search-noindex.conf` przygotowanym
   `ops/nginx/wotcv-search-noindex.conf` z tego checkoutu. Nie dopisywać nowej
   kopii obok starej, bo powstałaby zdublowana lokacja robots.
4. Wykonać `sudo nginx -t`. Dopiero po powodzeniu `sudo systemctl reload nginx`.
   Nie zmieniać hostów innych usług ani ich nagłówków.
5. W instalacji używającej Caddy sprawdzić `caddy validate` i odświeżyć jego
   konfigurację osobno; zwykły update backend/client nie przeładowuje proxy.
6. Sprawdzić publiczne GET i HEAD: root/login, shared/private URL, widget,
   statics, health, przekierowanie HTTP→HTTPS. Wszędzie `X-Robots-Tag: noindex…`.
   Robots i sitemap mają zwracać 410 oraz pustą treść, bez `Disallow: /`.

## Walidacja lokalna

```powershell
pnpm build:client
pnpm --filter client run test:indexing-http
pnpm --filter client exec vitest run src/app/layout.test.tsx src/lib/indexingProtection.test.ts src/proxy.test.ts
pnpm --filter rybbit-backend exec vitest run src/lib/indexingProtection.test.ts src/lib/cors.test.ts src/lib/sourceCode.test.ts
pnpm typecheck
```

Test HTTP uruchamia wyłącznie lokalny Next na tymczasowym porcie, bez przeglądarki
i wywoływania API backendu. Sprawdza gotowy build, metatag w HTML, brak canonical/
Open Graph/Twitter/JSON-LD, GET/HEAD manifestów, statics, raw widget, 400/404 i
przekierowania z zachowaniem query. Środowisko nie ma Docker/Caddy/Nginx do
lokalnej walidacji konfiguracji proxy — `nginx -t` pozostaje bramką administratora.

Wynik wykonania 2026-10-12: produkcyjne buildy client/server i root typecheck
PASS; 9 testów klienta, 26 testów backendu/CORS/routera oraz 19 odpowiedzi w
lokalnym teście HTTP PASS. Lint zmienionych plików klienta, Prettier i diff-check
PASS. Ponowne extraction potwierdziło brak zmian treści tłumaczeń, a build
trackera nie zmienił jego publicznych skryptów. Niezależne review zakończono
po poprawkach obsługi błędów Caddy i pustego body 410 w Nginx.

## Wcześniej zaindeksowane adresy

Wyłączenie publikacji manifestów nie usuwa natychmiast wyników wyszukiwania.
Google musi ponownie odwiedzić URL i odczytać `noindex`. Aby przyspieszyć usunięcie,
administrator Search Console może użyć narzędzia Usunięcia dla prefiksu
`https://tracking.wot-cv.com/` i poprosić o ponowne sprawdzenie adresów.
To nie zastępuje trwałego `noindex`; nie zgłaszać usunięcia całego `wot-cv.com`.

Źródła: [Google — debugowanie noindex](https://developers.google.com/search/docs/crawling-indexing/block-indexing?hl=pl),
[Search Console — narzędzie Usunięcia](https://support.google.com/webmasters/answer/9689846?hl=pl).
