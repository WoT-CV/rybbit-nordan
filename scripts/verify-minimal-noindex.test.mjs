import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_MISSING_PATH,
  formatNoindexReport,
  main,
  parseBaseOrigin,
  verifyMinimalNoindex,
} from "./verify-minimal-noindex.mjs";

async function fixture(run, change = () => {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    const manifest = ["/robots.txt", "/sitemap.xml"].includes(request.url);
    let body = "<!doctype html><html>candidate</html>";
    let status = 200;
    const headers = { "X-Robots-Tag": "noindex, nofollow, noarchive", "Content-Type": "text/html; charset=utf-8" };
    if (manifest) {
      status = 410;
      body = "";
      headers["Content-Type"] = "text/plain";
      headers["Cache-Control"] = "no-store";
    }
    if (request.url === "/api/health") {
      body = "OK";
      headers["Content-Type"] = "text/plain; charset=utf-8";
    }
    if (request.url === "/api/script.js") {
      body = "(()=>{window.rybbit={};})();";
      headers["Content-Type"] = "application/javascript";
    }
    if (request.url === DEFAULT_MISSING_PATH || request.url === "/custom-missing") {
      status = 404;
      body = '{"error":"not found"}';
      headers["Content-Type"] = "application/json";
    }
    const state = { status, body, headers, delay: 0 };
    change(state, request);
    if (state.skip) return;
    const respond = () => {
      if (response.destroyed) return;
      if (!state.omitLength && state.headers["Content-Length"] === undefined)
        state.headers["Content-Length"] = String(Buffer.byteLength(state.body));
      response.writeHead(state.status, state.headers);
      response.end(request.method === "HEAD" ? undefined : state.body);
    };
    if (state.delay) setTimeout(respond, state.delay).unref();
    else respond();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

const resultFor = (report, name, method = "GET") =>
  report.results.find(row => row.name === name && row.method === method);

test("valid native contract: 7 paths, both methods, no implicit redirect or body output", async () => {
  await fixture(async (base, requests) => {
    const report = await verifyMinimalNoindex(base, { target: "origin" });
    assert.equal(report.ok, true);
    assert.equal(report.results.length, 14);
    assert.equal(requests.length, 14);
    assert.deepEqual(new Set(requests.map(row => row.method)), new Set(["GET", "HEAD"]));
    assert.equal(resultFor(report, "health").bytes, 2);
    assert.equal(resultFor(report, "robots", "HEAD").bytes, 0);
    const output = formatNoindexReport(report);
    assert.match(output, /PASS origin 14 read-only probes/);
    assert.doesNotMatch(output, /candidate<|window\.rybbit|127\.0\.0\.1|not found/);
  });
});

test("origin parser permits HTTPS or loopback-only HTTP and rejects ambiguous input", () => {
  for (const [value, expected] of [
    ["https://EXAMPLE.com:443/", "https://example.com"],
    ["https://example.com:8443", "https://example.com:8443"],
    ["http://localhost:1234", "http://localhost:1234"],
    ["http://127.0.0.2", "http://127.0.0.2"],
    ["http://[::1]", "http://[::1]"],
  ])
    assert.equal(parseBaseOrigin(value), expected);
  for (const value of [
    undefined,
    "",
    "https://user:secret@example.com",
    "https://@example.com",
    "https://example.com?",
    "https://example.com/#",
    "https://example.com/path",
    "https://example.com/a/..",
    " https://example.com",
    "https://exam\nple.com",
    "https://example.com\\",
    "http://example.com",
    "ftp://localhost",
    "//example.com",
  ])
    assert.throws(() => parseBaseOrigin(value));
});

for (const [label, header, expected] of [
  ["missing", undefined, "noindex-header-count"],
  ["duplicates", ["noindex", "noindex"], "noindex-header-count"],
  ["index conflict", "noindex, index", "noindex-policy"],
  ["all conflict", "noindex, all", "noindex-policy"],
  ["scoped-only", "googlebot: noindex", "noindex-policy"],
])
  test(`noindex rejects ${label}`, async () => {
    await fixture(
      async base => {
        const report = await verifyMinimalNoindex(base);
        assert.equal(report.ok, false);
        assert.ok(resultFor(report, "home").issues.includes(expected));
      },
      state => {
        delete state.headers["X-Robots-Tag"];
        if (header !== undefined) state.headers["X-Robots-Tag"] = header;
      }
    );
  });

test("redirects are reported and never followed, including authentication redirects", async () => {
  await fixture(
    async (base, requests) => {
      const report = await verifyMinimalNoindex(base);
      for (const name of ["home", "missing", "robots"])
        assert.ok(resultFor(report, name).issues.includes("redirect-not-followed"));
      assert.equal(
        requests.some(row => row.path === "/private-target"),
        false
      );
    },
    (state, request) => {
      if (["/", DEFAULT_MISSING_PATH, "/robots.txt"].includes(request.url)) {
        state.status = 302;
        state.headers.Location = "/private-target";
      }
    }
  );
});

for (const [label, change, expected] of [
  [
    "built-in HTML body",
    state => {
      state.body = "<html>410 Gone: PRIVATE_SECRET</html>";
      state.headers["Content-Type"] = "text/html";
    },
    "manifest-body-not-empty",
  ],
  [
    "HEAD nonzero length",
    (state, request) => {
      if (request.method === "HEAD") state.headers["Content-Length"] = "17";
    },
    "manifest-content-length-not-zero",
  ],
  [
    "no cache policy",
    state => {
      delete state.headers["Cache-Control"];
    },
    "manifest-cache-policy",
  ],
  [
    "public cache",
    state => {
      state.headers["Cache-Control"] = "no-store, public";
    },
    "manifest-cache-policy",
  ],
  [
    "quoted positive age",
    state => {
      state.headers["Cache-Control"] = 'no-store, max-age="01"';
    },
    "manifest-cache-policy",
  ],
  [
    "shared cache age",
    state => {
      state.headers["Cache-Control"] = "no-store, s-maxage=600";
    },
    "manifest-cache-policy",
  ],
  [
    "duplicate cache",
    state => {
      state.headers["Cache-Control"] = ["no-store", "no-store"];
    },
    "manifest-cache-policy",
  ],
  [
    "duplicate length",
    state => {
      state.headers["Content-Length"] = ["0", "0"];
    },
    "transport-error",
  ],
])
  test(`manifest rejects ${label}`, async () => {
    await fixture(
      async base => {
        const report = await verifyMinimalNoindex(base);
        const row = resultFor(report, "robots", label === "HEAD nonzero length" ? "HEAD" : "GET");
        assert.equal(row.ok, false);
        assert.ok(row.issues.includes(expected), row.issues.join(","));
        assert.doesNotMatch(formatNoindexReport(report), /PRIVATE_SECRET/);
      },
      (state, request) => {
        if (request.url === "/robots.txt") change(state, request);
      }
    );
  });

for (const [label, path, change, expected] of [
  [
    "health JSON is not native OK",
    "/api/health",
    state => {
      state.body = '{"status":"ok"}';
      state.headers["Content-Type"] = "application/json";
    },
    "expected-native-health-ok",
  ],
  [
    "health error",
    "/api/health",
    state => {
      state.status = 500;
    },
    "unexpected-status",
  ],
  [
    "tracker HTML mislabeled JS",
    "/api/script.js",
    state => {
      state.body = "<!doctype html><html>login</html>";
    },
    "expected-javascript-body",
  ],
  [
    "tracker wrong MIME",
    "/api/script.js",
    state => {
      state.headers["Content-Type"] = "text/html";
    },
    "expected-javascript-type",
  ],
  [
    "tracker empty",
    "/api/script.js",
    state => {
      state.body = "";
    },
    "expected-javascript-body",
  ],
  [
    "missing route soft 200",
    DEFAULT_MISSING_PATH,
    state => {
      state.status = 200;
    },
    "unexpected-status",
  ],
])
  test(label, async () => {
    await fixture(
      async base => {
        const report = await verifyMinimalNoindex(base);
        assert.ok(report.results.find(row => row.method === "GET" && row.issues.includes(expected)));
      },
      (state, request) => {
        if (request.url === path) change(state);
      }
    );
  });

test("bounded body size and total timeout fail without disclosing transport errors", async () => {
  await fixture(
    async base => {
      const report = await verifyMinimalNoindex(base, { maxBodyBytes: 64, timeoutMs: 100 });
      assert.ok(resultFor(report, "script").issues.includes("body-limit"));
      assert.ok(resultFor(report, "health").issues.includes("timeout"));
      assert.doesNotMatch(formatNoindexReport(report), /PRIVATE_SECRET|127\.0\.0\.1/);
    },
    (state, request) => {
      if (request.url === "/api/script.js") state.body = "PRIVATE_SECRET".repeat(100);
      if (request.url === "/api/health") state.skip = true;
    }
  );
});

test("error status still requires noindex, not only successful responses", async () => {
  await fixture(
    async base => {
      const report = await verifyMinimalNoindex(base);
      for (const method of ["GET", "HEAD"]) {
        const row = resultFor(report, "health", method);
        assert.equal(row.status, 503);
        assert.ok(row.issues.includes("unexpected-status"));
        assert.ok(row.issues.includes("noindex-header-count"));
      }
    },
    (state, request) => {
      if (request.url === "/api/health") {
        state.status = 503;
        delete state.headers["X-Robots-Tag"];
      }
    }
  );
});

test("chunked empty manifest and duplicated MIME fail strict framing contract", async () => {
  await fixture(
    async base => {
      const report = await verifyMinimalNoindex(base);
      const row = resultFor(report, "robots");
      assert.ok(row.issues.includes("manifest-transfer-encoding"));
      assert.ok(row.issues.includes("manifest-content-length-not-zero"));
      assert.ok(resultFor(report, "script").issues.includes("content-type-header-count"));
    },
    (state, request) => {
      if (request.url === "/robots.txt") {
        state.omitLength = true;
        state.headers["Transfer-Encoding"] = "chunked";
      }
      if (request.url === "/api/script.js")
        state.headers["Content-Type"] = ["application/javascript", "application/javascript"];
    }
  );
});

test("oversized response headers are bounded and sanitized", async () => {
  await fixture(
    async base => {
      const report = await verifyMinimalNoindex(base);
      assert.ok(resultFor(report, "home").issues.includes("transport-error"));
      assert.doesNotMatch(formatNoindexReport(report), /PRIVATE_SECRET|Parse Error/);
    },
    (state, request) => {
      if (request.url === "/") state.headers["X-Private-Value"] = "PRIVATE_SECRET".repeat(3000);
    }
  );
});

test("custom missing path is explicit and invalid bounds are rejected before requests", async () => {
  await fixture(async (base, requests) => {
    assert.equal((await verifyMinimalNoindex(base, { missingPath: "/custom-missing" })).ok, true);
    assert.equal(
      requests.some(row => row.path === "/custom-missing"),
      true
    );
    for (const options of [
      { missingPath: "//other.example/path" },
      { missingPath: "/x?secret" },
      { missingPath: "/x#secret" },
      { timeoutMs: 0 },
      { timeoutMs: 10001 },
      { maxBodyBytes: 0 },
      { maxBodyBytes: 4194305 },
      { target: "prod" },
    ])
      await assert.rejects(verifyMinimalNoindex(base, options));
    assert.equal(requests.length, 14);
  });
});

test("CLI requires explicit target/base and returns only sanitized summaries", async () => {
  await fixture(async base => {
    const output = [];
    const write = value => output.push(value);
    assert.equal(await main(["--target", "public", "--base-url", base], write), 0);
    assert.match(output.join("\n"), /PASS public 14/);
    for (const args of [
      [],
      ["--base-url", base],
      ["--target", "origin"],
      ["--target", "origin", "--base-url", "https://user:PRIVATE_SECRET@example.com"],
      ["--target", "origin", "--base-url", base, "--unknown", "PRIVATE_SECRET"],
      ["--target", "origin", "--base-url", base, "--base-url", base],
    ])
      assert.equal(await main(args, write), 2);
    assert.equal(await main(["--help"], write), 0);
    assert.doesNotMatch(output.join("\n"), /PRIVATE_SECRET|window\.rybbit|127\.0\.0\.1/);
  });
  await fixture(
    async base => {
      assert.equal(await main(["--target", "origin", "--base-url", base], () => {}), 1);
    },
    state => {
      delete state.headers["X-Robots-Tag"];
    }
  );
});

test("dedicated snippets keep always policy and variable-valued empty 410 at both exact locations", async () => {
  const headers = await readFile(new URL("../ops/nginx/wotcv-minimal-noindex-headers.conf", import.meta.url), "utf8");
  const snippet = await readFile(new URL("../ops/nginx/wotcv-minimal-noindex.conf", import.meta.url), "utf8");
  assert.match(headers, /proxy_hide_header X-Robots-Tag;/);
  assert.match(headers, /add_header X-Robots-Tag "noindex, nofollow, noarchive" always;/);
  assert.equal(snippet.match(/include \/etc\/nginx\/snippets\/wotcv-minimal-noindex-headers\.conf;/g)?.length, 3);
  assert.equal(snippet.match(/return 410 \$wotcv_minimal_empty_manifest;/g)?.length, 2);
  assert.equal(snippet.match(/add_header Cache-Control "no-store" always;/g)?.length, 2);
  assert.equal(snippet.match(/types\s*\{\s*\}/g)?.length, 2);
  assert.match(snippet, /location = \/robots\.txt/);
  assert.match(snippet, /location = \/sitemap\.xml/);
  assert.doesNotMatch(snippet, /return 410 ""|proxy_pass|maintenance|add_header_inherit/);
});
