# Minimalna korelacja replay → Grafana

To jest kontrakt nowej gałęzi minimalnej, nie instrukcja aktualizacji starej
produkcji. Nie kopiować jej bazy/journal bez osobnego planu przejścia.

## Konfiguracja operatora

Domyślnie capture i odnośniki są wyłączone. Backend przyjmuje
`WOTCV_REPLAY_CORRELATION_JSON` jako tablicę profili:

```json
[
  {
    "siteIds": [17],
    "requestOrigin": "https://api.example.invalid",
    "grafanaUrl": "https://grafana.example.invalid/observability",
    "orgId": 1,
    "lokiDatasourceUid": "example-loki",
    "tempoDatasourceUid": "example-tempo",
    "serviceName": "example-backend",
    "environment": "staging",
    "timePaddingMs": 120000
  }
]
```

Wartości są przykładami, nie konfiguracją WoT-CV. Użyć rzeczywistego site ID
nowej instancji, dokładnego originu API, adresu/base path Grafany oraz UID
provisionowanych datasource. Bez tokenów API, haseł i danych użytkowników.
Każdy site+origin ma dokładnie jeden profil. Brak wildcard, ścieżki, query lub
credentials w requestOrigin. Grafana wymaga HTTPS. Nie konfigurować więcej
originów niż rzeczywiście potrzebne. Po zmianie konfiguracji nowo pobrany
tracking config określa capture; dawne nagrania nie dostaną historycznych ID.

To nie jest uprawnienie do logowania body. Operator osobno sprawdza redakcję,
retencję i dostęp w Loki/Tempo. Wartości serviceName/environment muszą pasować
do etykiet `service_name` i `deployment_environment`, a correlation ID do
structured metadata `http_correlation_id`. Link do Tempo wymaga trace ID oraz
skonfigurowanego tempoDatasourceUid.

## Granica danych i dostępu

- Publiczny tracking config: wyłącznie dozwolone origins, i tylko dla witryny
  z aktywnym replay. Nie zawiera adresu Grafany ani UID datasource.
- `GET /api/sites/:siteId/session-replay/correlation-config`: sesja użytkownika
  i natywne `replay:read` dla tej witryny; odpowiedź private/no-store.
  Publiczna witryna ani prywatny link do replay nie daje dostępu do profili.
- Custom rrweb event `wotcv/request-correlation@1` zawiera lokalny rowId,
  fetch/XHR, metodę, origin, pathname bez query/hash, status/outcome,
  czas trwania i opcjonalne ID z response headers.
- Nigdy body, cookies, pełna mapa headers, stack ani outgoing trace injection.
  Pathname nadal może zawierać identyfikatory biznesowe: przed włączeniem
  trzeba zatwierdzić allowlist i obowiązującą politykę replay/retencji.
- Rejestracja dotyczy aktywnego sampled replay, ma ograniczoną liczbę
  pending/rows i nadal podlega natywnym ograniczeniom ingest/storage.
  Nie jest kompletnym HAR ani dowodem, że wszystkie żądania zostały zapisane.

Zwykłe string/URL/Request i plain-data RequestInit są obsługiwane bez dodatkowej
konwersji URL ani odczytu getterów metody. Nietypowe/przedefiniowane wejścia są
pomijane konserwatywnie. Dowolny dynamiczny Proxy RequestInit może sfałszować
deskryptory po zużyciu przez natywny fetch; metadane są best-effort, nie
autorytatywnym audytem HTTP. Refleksja init następuje dopiero po natywnym
wywołaniu, aby nie zmieniać wysyłanego żądania. Źródłem prawdy pozostaje backend.

## Co oznaczają brakujące odnośniki

Brak correlationId/traceId nie oznacza pustego body ani sukcesu logowania.
Header może nie być wystawiony przez CORS, połączenie może zakończyć się przed
odpowiedzią, trace może nie zostać wylosowany. Starsze nagranie może nie zawierać
tego custom eventu. UI nie dopisuje brakujących ID z innych żądań.

Loki otrzymuje dokładny selector service/env i correlation filter, a Tempo
trace ID. Zakres czasu wyliczany jest z poprawionego przez natywny replay
timestampu zakończenia minus durationMs, z ograniczonym padding. To obejście
skrajnego clock skew, nie gwarancja zgodności zegarów i retencji. Natywna
korekta nie usuwa mniejszych przesunięć: np. zegar przeglądarki +10 minut
pozostaje przesunięty i przy padding 120 sekund odnośnik Loki może nie znaleźć
istniejącego wpisu. Panel jawnie informuje o zegarze nagrania. W takim przypadku
trzeba skorygować zakres w Grafanie i użyć widocznego correlation/trace ID;
brak wyników NIE jest dowodem braku logu/body. Nie zwiększamy automatycznie
padding, nie zmieniamy natywnej osi czasu ani nie obiecujemy kompletności
historycznych nagrań. Odbiór obejmuje poprawne zegary i taki negatywny scenariusz.
Równoległe żądania z tym samym correlation ID pozostają osobnymi wierszami.

## Odbiór przed produkcją

1. Utworzyć kontrolowane żądanie z niesekretnymi danymi i znanym correlation ID.
2. Potwierdzić, że CORS ujawnia response header dla rzeczywistego FE originu.
3. Odtworzyć nowe nagranie natywnym playerem, otworzyć Requests i sprawdzić
   osobno seek, logi oraz trace (jeżeli został wylosowany).
4. Potwierdzić rzeczywisty wynik w Grafanie oraz uprawnienia datasource;
   sam poprawny URL/test fixture nie potwierdza zapisania danych.
5. Sprawdzić mobile, przyspieszanie i zamykanie dialogu bez zamknięcia replay.
6. Sprawdzić konto bez replay:read, prywatny link, logout i zmianę witryny:
   brak cudzej konfiguracji i odnośników ze starego cache.
7. Potwierdzić, że nie zmieniono body/streamu odpowiedzi aplikacji, nie dodano
   preflightów ani ruchu przy replay wyłączonym. Sprawdzić budżety/rozmiar
   na reprezentatywnych sesjach; nie zwiększać limitów w celu przejścia testu.

Syntetyczne testy lokalne i test na fizycznym iPhone to różne bramki.

## Lokalne testy kontraktu i transportu

Po frozen install i build shared, uruchomić testy shared requestCorrelation,
serwerowe requestCorrelation/replayCorrelation, SessionReplayRecorder i
requestCorrelationRoundtrip, a także klientowe replayCorrelation oraz dialog.
Wspólny roundtrip używa prawdziwego ingest/query i natywnego processResults,
ale mockuje ClickHouse, R2 i tożsamość sesji; nie wykonuje SQL ani migracji.

Izolowany test prawdziwego fetch/XHR w trzech silnikach:

```text
node scripts/replay-correlation-browser-smoke.mjs <pełna-ścieżka-do-playwright-index.mjs>
```

Wymaga dostępnych lokalnie Chromium, Firefox i WebKit oraz istniejącego
Playwright. Nie instaluje zależności do projektu. Sam otwiera dwa losowe porty
na 127.0.0.1 i zamyka je po teście; nie używa `.env`, danych sesji ani live API.
Sprawdza HTTP 500, niezmienione body, równoległe żądania, zwykły/synchroniczny
i ponownie użyty w onload XHR, AbortController, brak ID ukrytych przez CORS,
odrzucenie redirectu między originami, wykluczenie własnego trackera, cleanup
i natywne unhandledrejection. Nie sprawdza retencji logów ani całego UI.

SPA navigation sama nie zmienia właściciela żądania: rrweb zapisuje nawigację,
a pending request nadal opisuje API i jego faktyczny czas zakończenia, nie
stronę inicjującą. Zmiana użytkownika lub granicy sesji/full snapshot
unieważnia stare completion. Przy redirect do innego originu capture pomija
żądanie nawet wtedy, gdy oba origins są dozwolone — nie zgaduje usługi ID.

## Dopasowanie do istniejącej instalacji WoT-CV — audyt 2026-11-02

Read-only odczyt czystej funkcji konfiguracji działającego starego backendu
potwierdził poniższe niesekretne wartości. Nowa nazwa env to
`WOTCV_REPLAY_CORRELATION_JSON`; stary `WOTCV_REPLAY_OBSERVABILITY_PROFILES`
nie jest automatycznie interpretowany. Bez nowego env mostek pozostaje wyłączony.
Do przygotowania przyszłej, zatwierdzonej konfiguracji (NIE polecenie dla prod):

```json
[
  {
    "siteIds": [2],
    "requestOrigin": "https://api.wot-cv.com",
    "grafanaUrl": "https://dashboard.wot-cv.com",
    "orgId": 1,
    "lokiDatasourceUid": "bet3mn133whkwd",
    "tempoDatasourceUid": "df0rqhtz9e3uoa",
    "serviceName": "wot-cv-be-prod",
    "environment": "prod",
    "timePaddingMs": 120000
  }
]
```

Nie kopiować site2 do pustej bazy bez sprawdzenia jej rzeczywistego siteId.
Profile nie są danymi logowania ani przyznaniem dostępu do Grafany. Audyt
potwierdził publiczne health Grafany i rzeczywiste logi/trace dla kontrolnego
GET oraz CORS, ale datasource API bez zalogowania odmawia401. Końcowy odbiór
obejmuje zalogowane konto, jego org/datasource permissions, link z prawdziwego
nowego replay i retencję. Nie stosowano root bypass do odczytu provisioningu.
