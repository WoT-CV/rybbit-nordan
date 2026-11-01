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
