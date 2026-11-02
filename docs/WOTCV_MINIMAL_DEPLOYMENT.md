# Izolowana konfiguracja kandydata — nie update starej produkcji

Status wydania: HOLD. Ten dokument przygotowuje konfigurację, nie zatwierdza
startu, migracji, przełączenia ruchu ani użycia istniejących baz. Nie używać
starego updatera z tą gałęzią. Strategię zachowania danych opisuje osobny plan
przejścia. Nie wykonywać down -v, prune, reset journal lub backfill.

## Model i granice

Wybieramy jawnie `docker-compose.yml` oraz `docker-compose.wotcv-minimal.yml`,
project `rybbit-minimal-candidate`. Upstreamowy compose pozostaje bez zmian.
Overlay usuwa stałe container_name, a nie tylko zmienia project name. Pięć
usług ma osobne loopback porty i log rotation json-file 50m/5. Trzy magazyny
zachowują natywne named volumes, ale nazwy są project-scoped, bez external,
bindów produkcyjnych ani wspólnej sieci. To nie jest dowód, że wcześniejszy
operator nie utworzył już danych pod nazwami kandydata — runtime inventory
i zgoda na wykorzystanie storage są nadal wymagane.

| Usługa | Host loopback | Kontener |
| --- | --- | --- |
| backend | 13001 | 3001 |
| client | 13002 | 3002 |
| PostgreSQL | 15432 | 5432 |
| Redis | 16379 | 6379 |
| ClickHouse | 18123 | 8123 |

Caddy ma nieużywany profil. Nie włączać go ani innych profili dla tej
konfiguracji. Dedykowany Nginx przygotowuje się oddzielnie; instrukcja
[noindex](WOTCV_MINIMAL_NOINDEX.md) nie modyfikuje wspólnych vhostów.

## Przypięcie obrazów i pułapka Next.js

Backend/client muszą być lokalnie zbudowane z przeglądniętego commit SHA,
przetestowane, opublikowane i przypięte digestem. Nie używać latest, natywnych
obrazów upstream bez patchy ani starych obrazów dużego forka. Wymagamy zapisu
źródłowego SHA, build args, zależności frozen, wyników testów i digestów.
Nie wykonujemy tutaj build/push obrazów ani publikacji źródeł.

Client/Dockerfile wbudowuje NEXT_PUBLIC_* w JavaScript. W tej konfiguracji
przed zatwierdzeniem obrazu wymagane są argumenty build:

```text
NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:13001
NEXT_PUBLIC_CLOUD=false
NEXT_PUBLIC_DEPLOYMENT=
NEXT_PUBLIC_LITE_DASHBOARD=false
NEXT_PUBLIC_DISABLE_SIGNUP=true
```

Adres API to origin BE BEZ `/api`: natywne client/src/lib/const.ts dopisuje
`/api`. BASE_URL=http://127.0.0.1:13002 jest natomiast originem FRONTEND dla
auth. Nie budować klienta domyślnym compose build z BASE_URL zamiast powyższego
argumentu. Overlay celowo usuwa build i NIE naprawi wcześniej wbudowanego URL.
Runtime NEXT_PUBLIC_BACKEND_URL/CLOUD nie jest dowodem zgodności obrazu.
Po zbudowaniu sprawdzić rzeczywiste requesty przeglądarki i blokować wszelki
nieoczekiwany external origin podczas syntetycznego smoke. Fizyczny dostęp
do portów loopback z innego komputera wymaga świadomego tunelu; nie otwierać
portów na 0.0.0.0 jako obejścia błędnego builda.

Natywny server entrypoint i nowy guard mają eol=lf, również w checkout Windows.
Sprawdzić plik i shebang w gotowym obrazie. Nie testować tego przez uruchomienie
normalnego entrypointa na produkcyjnych połączeniach.

## Przygotowanie prywatnego env i read-only check

Skopiować `ops/minimal/candidate.env.example` do chronionego pliku poza Git
(na Linux uprawnienia 0600). Uzupełnić NOWE sekrety, zatwierdzone digests i
SOURCE_CODE_URL wskazujący dokładny opublikowany commit forka. Nie kopiować
sekretów produkcyjnych do testu. Parametry mail/GSC/Grafana zostają puste/off
dopóki nie ma osobnego planu funkcjonalnego i odbiorców testowych.

```text
node scripts/check-minimal-compose.mjs /absolute/private/candidate.env
```

Wymaga Docker Compose >=2.24.4 (!override). Narzędzie wybiera dokładnie oba
pliki i project, wyłącza COMPOSE_PROFILES i wykonuje tylko config --quiet oraz
config --format json. Nie łączy się z daemonem. Resolved secrets są parsowane
w pamięci, nie drukowane; błędy Compose są celowo uogólnione. Nie uruchamiać
osobno config bez --quiet w publicznym logu. Standalone Compose można wskazać
`--compose-binary /absolute/path/docker-compose`; zweryfikować pochodzenie,
wersję i oficjalny checksum przed wykonaniem pliku binarnego.

PASS obejmuje model konfiguracji, nie istniejące kontenery, wolumeny, zajęcie
portów, zawartość obrazów, wbudowany klient, publikację źródła czy stan danych.
Wynik jawnie zawiera runtimeVerified=false, compiledClientVerified=false oraz
sourcePublicationVerified=false. Nie przedstawiać go jako zgody na deploy.

## Domyślnie zamknięty startup

`WOTCV_CANDIDATE_START_ACK` musi być puste przy preflight. Backend ma restart=no,
aby odmowa guard nie tworzyła pętli restartów. Guard odmawia uruchomienia
natywnego entrypointa, dopóki operator nie zatwierdzi wyłącznie pustej izolowanej
bazy poprzez wartość `empty-isolated-candidate-approved` w osobnej operacji.
Nie jest to sprawdzenie pustki storage ani autoryzacja do otwarcia starej bazy.
Guard nie zapobiega utworzeniu/uruchomieniu pozostałych usług przy ręcznym up.
Dlatego ten etap NIE zawiera polecenia up i nie należy go próbować przed
przejściem wszystkich bramek planu przejścia. Samo `config` niczego nie startuje.

Po zatwierdzonym starcie native entrypoint uruchamia migracje PostgreSQL,
a aplikacja inicjalizuje ClickHouse. Nie wolno użyć tego do read-only diagnosis.
Polityka restartu docelowej produkcji musi zostać osobno zatwierdzona po
zakończeniu testów kandydata; ta konfiguracja nie zastępuje starego deployera.

## Publiczne źródła

SOURCE_CODE_URL jest niewrażliwym publicznym HTTPS URL bez credentials/query/hash.
Backend publikuje go w /api/config, a sidebar pokazuje odnośnik również bez
logowania. Natywne license/notices i link dokumentacji nie są usuwane. Ustawiony
URL nie dowodzi, że odpowiada obrazowi ani że repo/commit jest publicznie
dostępny. Publikacja i sprawdzenie dostępu do odpowiednich źródeł pozostają
osobną bramką wydania. Ten etap nie wykonuje git push.

## Kontrolowane przejście — status HOLD, nie aktualizacja in-place

Nowa gałąź jest odbudowana od upstream U, nie jest następnym obrazem starego
`feat/wotcv`. **Nie używać starego update_rybbit_wotcv.sh do tego przejścia.**
Nie zmieniać jego brancha/env na nowy fork i nie podłączać starych wolumenów.
Ten dokument przygotowuje przyszłą, oddzielnie zatwierdzoną operację. Nie
uruchomiono produkcji, migracji, backfill ani restore.

### Co zostało potwierdzone w źródłach

Porównanie: old `dade9a932e0c5854d2f9bcf5c11d91efece5036f`, native U
`e69e843db903581a097500926147549f35d5306f`. Nie są to dowody aktualnego runtime.

| Obszar | Ustalenie | Skutek dla przejścia |
| --- | --- | --- |
| Drizzle | Oba journals 25 entries; różnice idx10–14 obejmują tag/time i raw SQL SHA256 | Nie resetować journal, nie ufać liczbie wpisów/ostatniemu 0024 |
| Uptime | Old snapshot47 tabel, native40; native0014 usuwa siedem tabel | Zabezpieczyć stare dane; nie odpalać tego na old DB |
| Browser identity | Old NUL-separated hash32hex, native colon-separated12hex | Brak automatycznej ciągłości anonimowych użytkowników; sam hash nie wystarcza do przeliczenia |
| Aliases | Old source/updated_at/admin/no-steal/409-rotate/dictionary vs native reassignment/backfill queue | Te same nazwy tabel nie oznaczają tego samego kontraktu |
| Replay metadata | Old v1/dual/v2, source defaultv1; native czyta/piszev2 | Samo istnienie tabeliv2 lub identyczne source DDL nie potwierdza historycznej coverage |
| Object storage | Old capability-based R2, native CLOUD gate | Historyczne object keys mogą wymagać zachowania starego czytnika; nie deklarować odtwarzalności |
| Start | Entry point migruje PG, initPostgres może promować najstarsze konto, CH init zmienia struktury | Granica mutacji jest przed startupem, nie przed health/listen |

Native `0014_huge_dagger.sql` usuwa: agent_regions, notification_channels,
uptime_alert_history, uptime_alerts, uptime_incidents, uptime_monitor_status,
uptime_monitors. Nie wykonywać tych instrukcji w celu sprawdzenia kompatybilności.
Nie usuwać starych historycznych body ani nagrań jako sposobu upraszczania migracji.

### Read-only inventory zapisanych źródeł

```text
node scripts/minimal-transition-preflight.mjs --legacy-repo C:/PROJECTS/rybbit-wotcv --candidate-repo C:/PROJECTS/rybbit-wotcv-minimal-20261101
```

Narzędzie czyta wyłącznie committed HEAD przez lokalny Git i pin U. Wymaga
pełnych lokalnych obiektów; nie wykonuje fetch, status, poleceń shell, SQL,
Docker, entrypointa, importu kodu aplikacji ani odczytu plików env usług. Lazy-fetch jest
wyłączony (`--no-lazy-fetch` + env; wymaga Git >=2.46, starszy Git odmawia
zamiast ignorować ochronę). SHA256 liczone jest z raw Git blob, bez konwersji CRLF checkoutu.
Nie bada niezacommitowanych plików i nie stwierdza, co działa na serwerze.
Znaczenie tej blokady potwierdza [oficjalna dokumentacja Git](https://git-scm.com/docs/git/2.46.0).
Wyłączone są również replacement objects (`--no-replace-objects`), aby lokalne
refs/replace nie podmieniły treści przypiętego SHA. Dziedziczone GIT_DIR,
GIT_WORK_TREE i pozostałe GIT_* są usuwane ze środowiska procesu potomnego;
narzędzie nie może nieświadomie czytać innego repo wskazanego przez shell.

Raport zawiera SHA, czas obserwacji, różnice journal po idx/tag/time/hash i
hashy stałych native boundaries. Nie drukuje SQL, env, danych DB ani logów.
`sourceBoundaryMatchesNative=true` oznacza tylko zgodność wskazanych plików
z U, nie całego forka ani zgodność starej bazy. Główne custom zmiany nie są
objęte tym wskaźnikiem; mają oddzielny diff/review i testy.

**Prawidłowy raport zawsze ma deploymentStatus=HOLD i exit2**, nawet dla
identycznych źródeł. Brak wymaganych źródeł/nieprawidłowe argumenty: exit1,
sanitizowany błąd, bez częściowego JSON. Nie ma flagi apply/approve ani pliku,
który zmieni ten wynik na zgodę. Nie łączyć go z automatycznym deploy fallback.

### Wybór strategii danych — wymagana osobna decyzja

| Wariant | Zysk | Koszt i warunki |
| --- | --- | --- |
| A. Nowe izolowane bazy + celowy import zatwierdzonego zakresu | Docelowy native model, wybrane historyczne dane w nowym UI | Wymaga osobnego projektu migracji/ID mapping, restore-fixture testu, walidacji semantycznej i rozliczenia braków |
| B. Kontrolowany most ze starego schematu | Potencjalnie szersza ciągłość danych | Największy koszt, ponowne custom schema/identity patch; osłabia cel minimalnego forka; osobny projekt, nie ten overlay |
| C. Nowe native bazy + izolowane stare archiwum/czytnik | Najmniej różnic i najmniejsze ryzyko ingerencji w historię | Dwa widoki historii, nowe anonymous IDs/sesje; wymagany realny brak zapisów/schedulerów w archiwum i kontrola dostępu |

Dla celu utrzymaniowego C jest najprostszym kandydatem do rozważenia, ale
**nie został wybrany**. Żaden wariant nie uprawnia do usunięcia starych danych
ani do założenia bezstratności. Nie dostarczono automatycznego convertera,
ponieważ nie ustalono runtime schematów, coverage, zakresu i dopuszczalnych strat.
Brak decyzji jest zamkniętą bramką wydania, nie ukrytą domyślną nową bazą.

### Kolejność przyszłej operacji i konkretne bramki

1. **Zamrozić zakres/źródła.** Zapisać zaakceptowany SHA forka i U, diff,
   wyniki testów, producenta FE/trackera oraz własność usług. Wskazać wariant
   A/B/C, okresy historii, identyfikatory, archiwum i zaakceptowane braki.
   Nie dodawać kolejnych upstream commitów w trakcie okna bez ponownego review.
2. **Read-only runtime inventory — osobno autoryzowane.** Ustalić realne
   kontenery/image IDs/digests, uruchomione rewizje i start times, effective
   PG journal+schema, CH SHOW CREATE/engines/TTL/metadata modes, alias semantics,
   storage inline/object/coverage, Redis queues, schedulery i wszystkich writers.
   Checkout SHA oraz native health `OK` nie potwierdzają obrazu. Raportować
   nieznane jako NOT_VERIFIED/null, nie zero; nie drukować secret/env values.
3. **Backup + prawdziwy restore drill.** Spójny punkt danych obejmuje PG
   role/auth/profile/grants/aliases, CH events/replay/full snapshots/metadata,
   wykorzystywane object payloads i potrzebny Redis state. Zachować stare
   obrazy, effective konfigurację i secure secrets osobno od raportu. Hash pliku
   i odczyt archive TOC nie zastępują odtworzenia na izolowanym storage i
   sprawdzenia odtwarzania nagrań. Zanotować zmierzone RPO/RTO i wpływ TTL;
   nie zwiększać limitów ani TTL jako obejścia. Brak restore dowodu: STOP.
4. **Obrazy i źródła PRZED startupem.** Zbudować Docker backend/client frozen
   dependencies, poprawny baked NEXT_PUBLIC API origin/CLOUD i LF entrypoint.
   Przetestować i przypiąć digests z zaakceptowanego source SHA; sprawdzić
   publiczny Source code URL do dokładnie tych źródeł. Nie zmieniać/rebuildować
   kandydata w trakcie późniejszego odbioru bez ponownej walidacji. Utrzymać
   notices/license. Local Next build nie dowodzi zawartości kontenera.
   Natywne dependency pins mają własny cykl aktualizacji; zielona delta lint
   nie zastępuje security review.
5. **Izolowany candidate po zgodzie.** Rzeczywiście nowe project volumes,
   sieć, auth secrets, porty i konta testowe. Najpierw config check z zamkniętym
   gate, potem osobna zgoda na startup tylko tej pustej instancji. Nie otwierać
   guard dla starego storage. Zapisać każdy startup/DDL i porównać runtime
   z przypiętymi obrazami. Jeśli import ma być testowany, wyłącznie przez
   oddzielny przeglądnięty plan na odtworzonym fixture, nigdy przez podpięcie prod.
   Dopiero teraz potwierdzić uruchomiony digest i rzeczywiste browser request
   origins; wcześniej zapisane build args nie zastępują tego dowodu.
6. **Odbiór produktu, dwie organizacje i dwa konta.** Pages/Bots/Performance,
   Query/Dashboards, replay i Web Vitals mają realne dane i poprawne role.
   Negatywne cross-site/private-key testy obowiązkowe. SQL musi mieć natywnie
   provisioned restricted query user/row policies i zachowane budgets/60/20
   rate limits. AI tylko gdy skonfigurowano OPENROUTER; klucz nie trafia do klienta.
   GSC wymaga prawdziwego OAuth registration/callback i gsc:write. Maile:
   testowe zaproszenie/reset/weekly/opt-out, własny sender, jeden scheduler,
   bez wysyłki do realnej listy przed zgodą. Reports stub i nieistniejący native
   Uptime nie są ogłaszane jako odblokowane funkcje. Nie zwiększać limitów.
7. **Profile i telemetry producer.** Realne identify(String(userId)), traits
   `[TAG] nick`, clan/customer/username i avatarUrl; business opaque IDs bez
   Number coercion. Brak historycznej alias continuity musi być jawny. Sprawdzić
   FE i cached tracker contract, upload retry/gzip/stare custom events/409 rotation
   w fixture. Nie wysyłać starych producers do nowego ingest bez testu.
8. **Grafana i replay.** Operator weryfikuje aktualne org/datasource UID/service/
   environment/basepath i konfiguruje WOTCV_REPLAY_CORRELATION_JSON per site/origin.
   Realna odpowiedź backendu musi udostępniać browserowi x-correlation-id lub
   x-trace-id przez istniejące CORS expose headers. Link testować na konkretnym
   żądaniu/logu/trace w oknie retencji. Correlation ID nie dowodzi trwałego body;
   sampling może wyciąć trace, Loki retention może wygasnąć. Nie zwiększać limitów
   i nie wdrażać pominiętego archiwum dużych body. Starsze replay bez eventu
   pozostają poprawne, lecz bez nowych linków. Fizyczny iPhone/Safari: kilka
   realnych sesji, 0:20, seek, speed, Requests/Escape/goto, obrót i native drawer;
   ewentualna różnica względem upstream ma zostać rozstrzygnięta przed ruchem.
9. **Dedykowany Nginx/CDN.** Według osobnego noindex runbooku: backup/include
   graph/headers/CSP/access, nginx -t, kontrolowany reload, origin+public
   GET/HEAD/empty410/no-store i niezmienione pozostałe vhosty. Nie blokować
   zdrowego trackera ani autoryzacji. Nie traktować noindex jako ochrony danych.
10. **Okno, writers i przełączenie.** Jawny właściciel okna, akceptacja RPO,
    plan HTTP maintenance/rollback i pomiary baseline. Zatrzymać/odprowadzić
    wszystkie stare writers/schedulers/queues zgodnie z wybranym wariantem.
    Oddzielić archive, prod i candidate credentials/storage. Ustalić zachowanie
    otwartych kart/starych assetów/CDN/service workers. Nie kierować obu wersji
    na wspólną bazę ani nie uznawać chwilowego HTTP200 za gotowość do ruchu.
11. **Po przełączeniu.** Niezależny digest/revision/health, permissions,
    identify/clan logo, realne ingest→read→playback→Grafana, mail i SQL probes,
    noindex oraz baseline danych. Zaakceptować różnicę TTL od utraty danych
    wyłącznie na dowodach z tego samego okna; row counts nie dowodzą spójności
    session IDs/full snapshot/replay payloadów. Monitoring i czas obserwacji
    uzgodnić z właścicielem, nie z automatycznym timeoutem skryptu.

### Rollback i granica pierwszego zapisu

Przed pierwszym startupem na **nowym izolowanym storage** można zrezygnować
z kandydata, zachowując nietknięty stary stack. Zachować bramkę ruchu do
chwili udowodnionej gotowości starego stacka; nie robić blind toggle.

Po migracji/importach albo pierwszych nowych zapisach sam powrót obrazu
nie cofa schematu, alias ownership, CH mutations, maili ani sesji. Najpierw
zatrzymać nowych writers, zachować snapshot/logbook i uzgodnić accepted RPO
oraz procedurę reconciliation/restore. Odtwarzanie danych jest osobną
autoryzowaną operacją. Nie resetować journal, nie cofać DDL ad hoc i nie
scalać divergent stores po identyfikatorze, który zmienił znaczenie.

### Aktualny werdykt

Implementacja lokalnego forka i narzędzi może być zakończona, ale wydanie
produkcyjne pozostaje **HOLD**. Nie wybrano strategii A/B/C, nie wykonano
runtime inventory/restore drill/obrazy+provenance/live Grafana/Nginx i fizycznego
iPhone. Wyniki syntetyczne z etapu6 nie zamieniają tych pól w VERIFIED.
