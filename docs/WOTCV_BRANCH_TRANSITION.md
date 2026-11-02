# Przepięcie gałęzi i porządki — 2026-11-02

## Status i granica wdrożenia

Nowy minimalny fork jest rozwijany na `feat/wotcv`. Poprzednia produkcja ma
niezmieniony punkt odzyskania `feat/wotcv-backup`:
`dade9a932e0c5854d2f9bcf5c11d91efece5036f`. Żaden push, deployment, restart,
migracja ani zmiana danych nie należą do wykonanych tutaj operacji.

**Publikacja gałęzi nie jest zgodą na otwarcie starych baz nową aplikacją.**
Zwykły retained updater ma zakończyć się HOLD/78 na granicy legacy → minimal,
dopóki nie zostanie wybrana strategia danych i zakończona izolowana próba.
Nie kopiować starego deployera, nie usuwać warunków ani nie przekazywać ACK
jako obejścia. Nowy bridge nie wykonuje żadnej operacji aplikacyjnej.

Plan i dowody niezgodności baz:
[kontrolowane przejście](WOTCV_MINIMAL_DEPLOYMENT.md),
[całościowy review](WOTCV_MINIMAL_REBUILD.md#całościowe-review-integracyjne-i-audyt-ssh--2026-11-02).
Nadal wymagane rozstrzygnięcie: zachowanie historii przez zweryfikowaną migrację
na kopii albo jawnie zatwierdzony start od pustych danych z zachowaniem archiwum.
Samo przemianowanie brancha nie wybiera żadnej z tych strategii.

## Analiza i plan przed zmianami

1. Potwierdzić źródła: stara produkcja i remote feat=dade9a932, nowy minimalny
   fork=25cc3187, stan worktrees oraz nieśledzone dokumenty. Zabezpieczyć unikalne
   tips; nie zakładać, że każda stara nazwa jest już zmergowana.
2. Przemianować starą lokalną gałąź na feat/wotcv-backup i usunąć jej stary
   upstream do origin/feat/wotcv. Minimalną gałąź przemianować na feat/wotcv.
   Zachować unique closeout jako archive/wotcv-closeout-20261030.
3. Stare i nowe historie są rozbieżne: 176 old-only / 25 minimal-only. Przygotować
   techniczny merge `ours`: pierwszy rodzic ma nowe drzewo, drugi dade9a932.
   Zweryfikować identyczność tree SHA przed/po. To zachowuje nowe pliki bez
   przywracania legacy, a zwykły push i serwerowe `merge --ff-only` stają się
   możliwe bez force-push. Nie używać cherry-pick/rebase na starym drzewie.
4. Zachować wymagane wejście scripts/wotcv-branch-build-deploy.sh jako
   bezwarunkową odmowę przed build/maintenance/start/migrate/state. Testować
   prawdziwym Bash i sentinel PATH; argumenty/env nie mogą uruchomić deploy.
5. Poprawić trigger istniejącego CI na nową nazwę feat/wotcv, zachowując
   minimalne permissions, SHA pins i brak publikacji/deploy w tym workflow.
6. Usunąć lokalne redundantne branch refs dopiero po ancestry checks oraz trzy
   stale registrations wyłącznie dla faktycznie brakujących worktrees.
7. Na serwerze zinwentaryzować konkretne tymczasowe katalogi i referencje
   aktywnych kontenerów/procesów. Wykonać odzyskiwalne przeniesienie, z hashami
   i kontrolą runtime przed/po. Nie usuwać storage, backupów ani /var/backups.
8. Ponowić tests/review, ancestry/tree/whitespace, źródłowy preflight HOLD oraz
   read-only live health. Użytkownik wykonuje push; bez ukrytej aktywacji.

## Zachowane refs i źródła

| Ref                                              | Zachowana zawartość                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| feat/wotcv                                       | nowy minimalny fork i poprawki review                                     |
| feat/wotcv-backup                                | dokładnie dade9a932, poprzednia produkcja                                 |
| archive/wotcv-closeout-20261030                  | 2bcbb3ae, osobna nieutracona praca closeout                               |
| archive/server-feat-wotcv-20260715T233950Z (tag) | 71566693aef83849b7375043632b7ee3ebb7e39f, cztery unikalne commity serwera |
| master                                           | zachowana dotychczasowa gałąź upstream, bez nadpisywania                  |

Nowy working directory pozostaje `C:/PROJECTS/rybbit-wotcv-minimal-20261101`.
`C:/PROJECTS/rybbit-wotcv` trzyma backup i wspólny `.git` dla linked worktrees:
nie usuwać tego katalogu. Trzy wcześniejsze untracked documents w jego docs/
zostały nietknięte. Worktree closeout pozostaje na nazwie archive, bo nie jest
śmieciem ani kopią zawartą w starym produkcyjnym tipie.

Usunięto pięć lokalnych zbędnych refs po potwierdzeniu, że ich tips są przodkami
feat/wotcv-backup (zero utraconej unikalnej historii):

- backup/feat-wotcv-5c40c99e-before-master-221fbaa7 →5c40c99e;
- backup/feat-wotcv-8efce864-before-master-847553b7-20261009 →8efce864;
- backup/feat-wotcv-d9a750a1-before-master-045dd677-20261024 →d9a750a1;
- integration/master-221fbaa7-into-wotcv-20260924 →5c40c99e;
- integration/master-85a77b45-into-wotcv-20260919 →a84d9c09.

Pruned są tylko trzy registrations brakujących katalogów: merge-85a77b45,
replay-fix i sync-20260924. Nie usunięto istniejącego checkouta przez force.
Każdą usuniętą nazwę można odtworzyć jako branch od zachowanego SHA powyżej.

## Serwer: wykonane porządki i odzyskanie

Archiwum prywatne (0700):
`/home/wotcv/archives/rybbit-ops-20261102T004640Z-k1evjk_9`.

Przeniesione dokładnie sześć tymczasowych katalogów z /home/wotcv:

- rybbit-backup-hotfix-20261024.4DLZVvTS;
- rybbit-compose-check-20261024.zLVNBo;
- rybbit-hardening-20261024-r2.b5YchCAc;
- rybbit-hardening-20261024.c7M93i;
- rybbit-runtime-diagnosis-20261024.KGFsqctS;
- rybbit-runtime-resume-20261024.CiqAgMlU.

444 pliki, 12 452 880 B; każdy hash SHA256, rozmiar i file mode zgodny po
przeniesieniu. Manifest (0600) zawiera oryginalne ścieżki i snapshot runtime.
To odzyskiwalne przeniesienie, **nie zwolnienie 12 MB i nie usunięcie plików**.
Przywrócenie polega na przeniesieniu danego podkatalogu pod jego oryginalny
adres po sprawdzeniu, że nic go nie zajmuje. Nie nadpisywać nowych plików.

Backupy `rybbit-compose-backups`, /var/backups, wolumeny i aktywne repo pozostają
bez zmian. PostgreSQL ma Compose provenance w
`/var/backups/wotcv-runtime-logging/20261024T181202Z-oyytv00j` — to konkretny
powód, aby nie traktować tego katalogu jako zbędnego starego folderu.

Usunięto trzy stare server backup branch names. Dwie były przodkami dade9a932.
Trzecia miała cztery unique commity, więc została najpierw zabezpieczona tagiem
archive/server-feat-wotcv-20260715T233950Z oraz zweryfikowanym Git bundle w
tym samym prywatnym archiwum (`legacy-server-unique.bundle`). Receipt
`git-ref-cleanup.json` (0600) zapisuje pełne SHAs. Tag i obiekty pobrano także
lokalnie; nie wykonano push. Odtworzenie nazwy branch od zachowanego tagu nie
wymaga odtwarzania aplikacji ani bazy. Bundle wymaga istniejącej bazowej historii
starego repo; `git bundle verify` sprawdził jej dostępność, nie jest to backup DB.

Po operacji HEAD serwera nadal dade9a932, checkout clean. Utworzono tam również
feat/wotcv-backup o tym samym SHA; aktywny branch pozostaje feat/wotcv. Kontenery,
ich IDs/start/restarts oraz health były niezmienione. Nie instalowano nowych
root-owned wrapperów, nie uruchamiano updatera, Nginx reload ani usług.

## Push użytkownika — atomowo, bez force

Po zweryfikowanym technicznym merge zwykły fast-forward z dade9a932 jest
możliwy. Poniższe publikuje razem nową gałąź i punkty archiwalne; nie wdraża:

```powershell
git -C C:/PROJECTS/rybbit-wotcv-minimal-20261101 push --atomic origin `
  refs/heads/feat/wotcv:refs/heads/feat/wotcv `
  refs/heads/feat/wotcv-backup:refs/heads/feat/wotcv-backup `
  refs/heads/archive/wotcv-closeout-20261030:refs/heads/archive/wotcv-closeout-20261030 `
  refs/tags/archive/server-feat-wotcv-20260715T233950Z:refs/tags/archive/server-feat-wotcv-20260715T233950Z
```

Jeśli remote został w międzyczasie zmieniony albo nie przyjmuje atomic push,
zatrzymać się i sprawdzić refs. Nie dodawać --force ani nie publikować tylko
nowego feat bez backupu. W czasie audytu na origin istniały tylko master i
feat/wotcv, więc nie było zdalnych starych branchy do usuwania. Żaden remote
branch ani tag nie został przez agenta zmieniony.

**Nie uruchamiać jeszcze produkcyjnego update.** Obecny bridge ma odmówić (78),
nie aktywować minimalnego forka. Po decyzji o danych potrzebny jest właściwy
cutover/updater natywny z testem na izolowanej kopii, provenance obrazów i
odbiorami funkcjonalnymi. Git fast-forward i sprawny health starej wersji nie
zastępują tej walidacji.

## CI i bezpieczeństwo zmiany

| Critical | High | Medium | Low |
| -------- | ---- | ------ | --- |
| 0        | 0    | 0      | 0   |

Zakres review: tylko istniejący test.yml i zmiana nazwy push branch.
Sprawdzone push/pull_request, brak privileged trigger, contents:read,
persist-credentials:false, GitHub-hosted runners, action SHA pins, brak
niezaufanych `${{ }}` w shell i brak sekretów/deploy w jobach. Zachowano pnpm
repozytorium, nie kopiowano konfiguracji Yarn/Maven z innych projektów.
