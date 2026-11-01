# WoT-CV minimal — dedicated Nginx noindex policy

This is a **manual operator procedure**, not a deployer. The repository contains
snippets and a read-only HTTP verifier. Nothing here installs Nginx, changes a
host, reloads a service, modifies application SEO output, or authorizes a
production operation. Use a dedicated candidate hostname/vhost; do not add these
includes to a shared vhost, `http {}` block, or another application's configuration.

Noindex is not authentication and does not immediately remove already indexed
results. Keep native access controls, TLS, firewall rules and private-link rules.
Do not publish private data while waiting for search engines to process a policy.

## Files and intended behavior

- `ops/nginx/wotcv-minimal-noindex-headers.conf` hides an upstream
  `X-Robots-Tag` and sets exactly one `noindex, nofollow, noarchive` header,
  including error responses (`always`).
- `ops/nginx/wotcv-minimal-noindex.conf` includes that header policy in the
  dedicated `server {}` and defines only exact `/robots.txt` and `/sitemap.xml`
  locations. GET and HEAD return 410, `Content-Type: text/plain`,
  `Content-Length: 0`, `Cache-Control: no-store`, and no body. Other methods
  return 405; this is not a catch-all or an application proxy configuration.
- `scripts/verify-minimal-noindex.mjs` checks the effective HTTP responses, not
  configuration text. It does not follow redirects or write to the target.

The empty response is deliberately a variable-valued `return 410
$wotcv_minimal_empty_manifest`. Do not replace it with `return 410 ""`: a literal
empty error response can select Nginx's built-in HTML error page. The distinction
is visible in Nginx's [return-code implementation](https://github.com/nginx/nginx/blob/master/src/http/ngx_http_script.c)
and its [return directive documentation](https://nginx.org/en/docs/http/ngx_http_rewrite_module.html#return).
Do not copy a maintenance page into either manifest location.
Both locations clear inherited MIME mappings with `types { }` before setting
`default_type text/plain`; otherwise an inherited XML mapping can make
`/sitemap.xml` use `text/xml` despite the default type.

## Review the existing vhost before any change

The procedure assumes a separately authorized operator change on the actual host.
First identify its installed Nginx version, active config path, selected
`server_name`, listen/TLS settings, configuration owner and service manager.
The `always` parameter requires Nginx 1.7.5 or later. The snippets intentionally
do not require the newer `add_header_inherit` directive.

Inspect the effective include graph locally with the host's normal privileged
configuration-dump command, usually `sudo nginx -T`. That output can contain
credentials or private upstream names: do not paste or upload it. Confirm all of
the following before editing:

1. The chosen vhost serves only this minimal candidate. The same hostname must
   not select another TLS/default server or a different public proxy route.
2. There are no existing exact manifest locations or nested includes defining
   them. Merge only this dedicated vhost's conflicting definitions deliberately;
   do not include two definitions of the same exact location.
3. Inventory every inherited or local `add_header`, including security headers
   from `http {}`. Adding an `add_header` in a child context replaces the parent's
   entire inherited set under Nginx's default rules. Preserve/repeat the site's
   required security headers at the new context as needed, not just noindex.
4. Every existing child location with its own `add_header` must also include
   `wotcv-minimal-noindex-headers.conf`. Review regex/nested/named locations,
   authentication failures and error-page/internal redirects. If the final
   response uses another location, that location needs the effective policy too.
5. Review `error_page` and `recursive_error_pages`: a vhost-wide 410 handler must
   not turn the two empty manifest responses into branded HTML or a redirect.
   Resolve such a conflict only inside the dedicated vhost before acceptance.
6. CDN/WAF/cache layers must not strip, duplicate or contradict `X-Robots-Tag`,
   rewrite 410, cache manifests, or replace them with HTML. If a non-proxy upstream
   mechanism such as FastCGI is used, `proxy_hide_header` does not hide that
   mechanism's headers; adapt its dedicated-vhost policy and verify the result.

These inheritance rules and `always` behavior are documented in the official
[Nginx headers module](https://nginx.org/en/docs/http/ngx_http_headers_module.html).
The repeated header includes in both manifest locations are intentional because
their local `Cache-Control` declarations otherwise prevent header inheritance.

## Manual installation, validation and rollback

Do not run these steps as part of a build or CI test. Examples below describe
operator actions only; substitute reviewed, exact paths for this host.

1. Record a private backup location and copy the selected vhost and every
   pre-existing destination snippet there before replacing anything. Record
   which of the two snippet destinations did not previously exist. Keep original
   ownership/modes and a copy of the pre-change effective configuration locally.
   Do not back up or overwrite another application's vhost as part of this task.
2. Review the repository snippets and copy them to the two explicit paths:
   `/etc/nginx/snippets/wotcv-minimal-noindex-headers.conf` and
   `/etc/nginx/snippets/wotcv-minimal-noindex.conf`. These are Nginx-readable
   configuration files, not world-writable files or secret storage. If this host
   uses another snippets directory, update all three include paths together.
3. Add the following line **inside only the selected `server {}`**:

   ```nginx
   include /etc/nginx/snippets/wotcv-minimal-noindex.conf;
   ```

4. Preserve the selected vhost's existing routes, upstreams, TLS, authentication,
   headers, request limits and timeouts. In each existing location that declares
   an `add_header`, add the header include too. For example, an existing
   location with a cache declaration retains its existing handler and adds:

   ```nginx
   # Inside that EXISTING location; this is not a replacement proxy block.
   include /etc/nginx/snippets/wotcv-minimal-noindex-headers.conf;
   # Keep its reviewed Cache-Control and other required header declarations.
   ```

   Do not add a second local `X-Robots-Tag`; consolidate it to this one policy.
   Do not add global headers or application `robots.ts`, metadata, canonical,
   sitemap or marketing-page changes to implement this Nginx policy.

5. Inspect the resulting selected-vhost include graph again, then run the host's
   exact configuration test (normally `sudo nginx -t`). A failure means **stop**;
   do not reload. Syntax success alone does not prove routing/header behavior.
6. Only with explicit operational authorization, perform the host's controlled
   reload (for example `sudo systemctl reload nginx` on a systemd-managed host).
   This reload affects the Nginx service's workers, not exclusively one vhost;
   the prepared configuration changes must remain confined to the candidate.
   Check service health and the established smoke checks for other served apps.
7. Run the separate origin and public verification commands below. A failure is
   evidence to investigate or roll back, not permission to bypass authentication
   or relax the verifier. Keep the sanitized reports and observation time.

Rollback: restore only the exact backed-up vhost/snippet files and their recorded
ownership/modes. If a snippet was newly introduced, first remove its include from
the restored dedicated vhost; an operator may then remove only that exact new
file after confirming no other include references it. Do not recursively delete
directories. Run `nginx -t` again before the separately authorized controlled
reload, then recheck service and unrelated application health. No rollback is
automated by this repository.

## Read-only HTTP verification

Run the tool with Node 24+ from the repository root. There is no default host,
inferred deployment, cookie, private-link key, DNS override or certificate bypass.
It accepts an explicit HTTPS origin (not a path) or loopback HTTP for local
fixtures. Credentials, query strings, fragments and ambiguous base URLs are
rejected. Verify a deliberately configured, directly reachable origin hostname
and the public hostname separately; `--target` labels evidence and does not
change routing or bypass a CDN.

```powershell
node scripts/verify-minimal-noindex.mjs --target origin --base-url https://origin-candidate.example.invalid
node scripts/verify-minimal-noindex.mjs --target public --base-url https://candidate.example.invalid
```

The `.invalid` examples are placeholders, not deployment targets. A local fixture
may use `--base-url http://127.0.0.1:13002`. An inaccessible origin/TLS certificate
must be resolved through the approved operator setup, not `--insecure` or a
production hostname guessed by this script. Alternate hostnames and HTTP-to-HTTPS
redirect vhosts require separate operator checks; this tool expects the selected
final HTTPS origin, and **does not follow a redirect to conceal a wrong target**.

The tool makes fourteen sequential probes (GET and HEAD for each path):

| Path                                          | Required native/effective response                                        |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| `/`                                           | 200, HTML, noindex                                                        |
| `/login`                                      | 200, HTML, noindex                                                        |
| `/api/health`                                 | 200, `text/plain`; GET body exactly `OK`; noindex                         |
| `/api/script.js`                              | 200, JavaScript MIME, nonempty GET body that is not an HTML page; noindex |
| `/api/__wotcv_minimal_noindex_missing_3c72f1` | Real 404 or 410, noindex                                                  |
| `/robots.txt`                                 | 410, text/plain, explicit zero Content-Length, no body, no-store, noindex |
| `/sitemap.xml`                                | Same empty manifest contract                                              |

The health contract is the upstream application's plain `OK`, **not JSON**.
The tracker check distinguishes an obvious login/error HTML response from JS; it
does not parse/execute JavaScript, prove a deployment revision or verify a build
SHA. HEAD checks response status/headers and does not require a health/script body.
Every response needs exactly one unscoped `X-Robots-Tag` containing `noindex`
without contradictory `index`/`all`; duplicate headers fail. Manifest caching
directives that contradict the strict no-store policy (including any max-age)
also fail. The default missing path deliberately targets an unknown backend API
route rather than a Next dashboard route which can validly return a shell.

If an installation uses a different known error route, provide an explicitly
reviewed path with `--missing-path /api/known-missing-for-this-installation`.
Do not choose a live route or change a failed 200/authentication redirect into an
accepted response. A legitimate authentication redirect still fails this public
smoke contract and must be explained/reviewed; the tool does not send credentials.
This is not an authenticated dashboard or private-link acceptance test.

Each request has a total 5-second deadline and 1 MiB response-body cap by default.
Use `--timeout-ms` (1–10000) and `--max-body-bytes` (1–4194304) only explicitly.
Raw headers are capped at 32 KiB. Requests advertise identity encoding and use
normal certificate verification. Only fixed probe names, method, status, byte
count and sanitized issue codes are printed—not URLs, response bodies, header
values, redirect destinations, transport errors or secrets. Exit codes are 0 for
all probes passing, 1 for HTTP/transport acceptance failure, and 2 for invalid
configuration. `--help` performs no HTTP requests.

## Local validation and remaining release gates

```powershell
node --test scripts/verify-minimal-noindex.test.mjs
node --check scripts/verify-minimal-noindex.mjs
```

The built-in Node fixtures exercise valid GET/HEAD responses plus missing,
duplicate/contradictory headers, redirects, soft 200 errors, empty/mislabeled
tracker output, the native health contract, malformed/nonempty/cacheable
manifests, HEAD nonzero Content-Length, transport/header errors, deadlines,
body caps and sanitized output. They do not start Nginx, Docker or the application.

No Nginx executable was available in this local Windows environment; **actual
`nginx -t`, effective header inheritance, empty 410 runtime behavior, installed
error-page handling, origin/public/CDN behavior and reload/rollback are unexecuted
operator release gates**, not locally proven deployment claims. Likewise no
production host, database, service or application SEO file was changed.
