/*! Modified WoT-CV fork of Rybbit | GNU AGPL-3.0 | Source: https://github.com/WoT-CV/rybbit-wotcv */
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // ../../../shared/src/botSignalContract.ts
  var CLIENT_BOT_SIGNAL_MASKS = {
    automationApi: 1 << 0,
    zeroOuterDimensions: 1 << 1,
    missingChrome: 1 << 2,
    swiftShader: 1 << 3,
    emptyPlugins: 1 << 4,
    defaultViewport800x600: 1 << 5,
    defaultViewport1024x768: 1 << 6,
    impossibleDimensions: 1 << 7,
    outerDimensionsWeird: 1 << 8,
    pluginApiAbsence: 1 << 9,
    defaultViewport1280x1200: 1 << 10,
    squareScreen: 1 << 11,
    missingScreenDimensions: 1 << 12
  };
  var CLIENT_BOT_SIGNAL_NAMES = Object.keys(CLIENT_BOT_SIGNAL_MASKS);
  var CLIENT_BOT_SIGNAL_WEIGHTS = {
    automationApi: 3,
    zeroOuterDimensions: 2,
    missingChrome: 1,
    swiftShader: 1,
    emptyPlugins: 1,
    defaultViewport800x600: 3,
    defaultViewport1024x768: 3,
    impossibleDimensions: 3,
    outerDimensionsWeird: 2,
    pluginApiAbsence: 0,
    defaultViewport1280x1200: 3,
    squareScreen: 3,
    missingScreenDimensions: 1
  };
  var ALL_CLIENT_BOT_SIGNAL_BITS = CLIENT_BOT_SIGNAL_NAMES.reduce(
    (mask, name) => mask | CLIENT_BOT_SIGNAL_MASKS[name],
    0
  );
  var STRONG_CLIENT_BOT_SIGNAL_BITS = CLIENT_BOT_SIGNAL_MASKS.automationApi | CLIENT_BOT_SIGNAL_MASKS.impossibleDimensions | CLIENT_BOT_SIGNAL_MASKS.defaultViewport800x600 | CLIENT_BOT_SIGNAL_MASKS.defaultViewport1024x768 | CLIENT_BOT_SIGNAL_MASKS.defaultViewport1280x1200 | CLIENT_BOT_SIGNAL_MASKS.squareScreen;
  var MAX_CLIENT_BOT_SCORE = 10;
  var MIN_PLAUSIBLE_SCREEN_DIMENSION = 200;
  var MAX_PLAUSIBLE_SCREEN_DIMENSION = 8192;
  var IMPLAUSIBLE_DESKTOP_VIEWPORTS = [
    { width: 800, height: 600, signal: "defaultViewport800x600" },
    { width: 1024, height: 768, signal: "defaultViewport1024x768" },
    { width: 1280, height: 1200, signal: "defaultViewport1280x1200" }
  ];
  function isPlausibleScreenDimensions(width, height) {
    return Number.isFinite(width) && Number.isFinite(height) && width >= MIN_PLAUSIBLE_SCREEN_DIMENSION && height >= MIN_PLAUSIBLE_SCREEN_DIMENSION && width <= MAX_PLAUSIBLE_SCREEN_DIMENSION && height <= MAX_PLAUSIBLE_SCREEN_DIMENSION;
  }
  function isDesktopUserAgent(userAgent) {
    return /Windows NT|Macintosh|X11|Linux x86_64/.test(userAgent) && !/Mobile|Android|iPhone|iPad/.test(userAgent);
  }
  function getScreenDimensionSignals(width, height, userAgent) {
    if (!isPlausibleScreenDimensions(width, height)) {
      return ["impossibleDimensions"];
    }
    const signals = [];
    if (width === height) {
      signals.push("squareScreen");
    }
    if (isDesktopUserAgent(userAgent)) {
      for (const viewport of IMPLAUSIBLE_DESKTOP_VIEWPORTS) {
        if (width === viewport.width && height === viewport.height) {
          signals.push(viewport.signal);
        }
      }
    }
    return signals;
  }

  // ../../../shared/src/networkReplay.ts
  var DEFAULT_NETWORK_REPLAY_CONFIG = {
    enabled: false,
    captureMode: "full",
    captureFetch: true,
    captureXhr: true,
    capturePerformanceResources: true,
    captureInitialPerformanceResources: true,
    captureRequestHeaders: true,
    captureResponseHeaders: true,
    captureRequestBody: true,
    captureResponseBody: true,
    maxBodySizeBytes: 1e6,
    bodyReadTimeoutMs: 1e3,
    maxNetworkEventSizeBytes: 25e5,
    maxReplayBatchSizeBytes: 7e6
  };
  function applyNetworkReplayCapturePolicy(config) {
    return config.captureMode === "metadata" ? {
      ...config,
      captureRequestHeaders: false,
      captureResponseHeaders: false,
      captureRequestBody: false,
      captureResponseBody: false
    } : config;
  }
  function resolveNetworkReplayPrivacyCap(config, scriptMode) {
    if (scriptMode === void 0 || scriptMode === null || scriptMode.trim().toLowerCase() === "full") {
      return applyNetworkReplayCapturePolicy(config);
    }
    return applyNetworkReplayCapturePolicy({ ...config, captureMode: "metadata" });
  }

  // ../../../shared/src/networkReplayMetadata.ts
  function sanitizeNetworkUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "[redacted]";
      const path = url.pathname.length <= 2048 ? url.pathname : "/[redacted]";
      return `${url.origin}${path}`;
    } catch {
      return "[redacted]";
    }
  }
  function toMetadataRequest(request) {
    return {
      schemaVersion: request.schemaVersion,
      captureMode: "metadata",
      requestId: request.requestId,
      url: sanitizeNetworkUrl(request.url),
      currentUrl: sanitizeNetworkUrl(request.currentUrl),
      method: request.method,
      initiatorType: request.initiatorType,
      startedAt: request.startedAt,
      completedAt: request.completedAt,
      durationMs: request.durationMs,
      status: request.status,
      outcome: request.outcome,
      requestHeaders: {},
      responseHeaders: {},
      correlationId: request.correlationId,
      traceId: request.traceId,
      timing: request.timing,
      sizes: request.sizes,
      performanceEntryFound: request.performanceEntryFound,
      // Exception messages/stack and statusText can contain URLs, credentials or body data.
      error: request.error ? {
        name: request.outcome === "aborted" ? "AbortError" : request.outcome === "timeout" ? "TimeoutError" : "NetworkError"
      } : void 0
    };
  }

  // ../../../shared/src/networkCorrelation.ts
  function normalizeCorrelationId(value) {
    if (typeof value !== "string") return void 0;
    const id = value.trim();
    return /^[a-zA-Z0-9._-]{1,128}$/.test(id) ? id : void 0;
  }
  function normalizeTraceId(value) {
    if (typeof value !== "string") return void 0;
    const id = value.trim().toLowerCase();
    return /^[0-9a-f]{32}$/.test(id) && !/^0+$/.test(id) ? id : void 0;
  }
  function readResponseCorrelation(getHeader) {
    const read2 = (name) => {
      try {
        return getHeader(name);
      } catch {
        return void 0;
      }
    };
    return {
      correlationId: normalizeCorrelationId(read2("x-correlation-id")),
      traceId: normalizeTraceId(read2("x-trace-id"))
    };
  }

  // ../../../shared/src/scopes.ts
  var SCOPE_MATRIX = {
    analytics: ["read"],
    sessions: ["read"],
    events: ["read"],
    users: ["read", "write"],
    goals: ["read", "write"],
    funnels: ["read", "write"],
    dashboards: ["read", "write"],
    annotations: ["read", "write"],
    segments: ["read", "write"],
    flags: ["read", "write"],
    experiments: ["read", "write"],
    sites: ["read", "write"],
    gsc: ["read", "write"],
    org: ["read", "write"],
    replay: ["read", "write"],
    sql: ["read"],
    ingest: ["write"]
  };
  var SCOPE_RESOURCES = Object.keys(SCOPE_MATRIX);
  var ALL_SCOPE_STRINGS = SCOPE_RESOURCES.flatMap(
    (resource) => SCOPE_MATRIX[resource].map((action) => `${resource}:${action}`)
  );

  // ../../../shared/src/replayExport.ts
  var MAX_REPLAY_EXPORT_DURATION_MS = 2 * 6e4;

  // ../../../shared/src/aiOperators.ts
  var AI_OPERATOR_REFERRER_DOMAINS = {
    OpenAI: ["chatgpt.com", "chat.openai.com"],
    Anthropic: ["claude.ai"],
    Google: ["gemini.google.com", "aistudio.google.com", "notebooklm.google.com"],
    // edgeservices.bing.com is Copilot in the Edge sidebar; the *.cloud.microsoft
    // hosts are the Microsoft 365 Copilot web app (m365 → copilot redirect, 2026).
    Microsoft: ["copilot.microsoft.com", "copilot.cloud.microsoft", "m365.cloud.microsoft", "edgeservices.bing.com"],
    Perplexity: ["perplexity.ai"],
    Meta: ["meta.ai"],
    Mistral: ["chat.mistral.ai", "mistral.ai"],
    xAI: ["grok.com"],
    "You.com": ["you.com"],
    // Only duck.ai, DuckDuckGo's chat: a referral from duckduckgo.com is organic
    // search, not an AI chat hand-off, and listing it here would reclassify
    // every DuckDuckGo visit as AI traffic.
    DuckDuckGo: ["duck.ai"],
    Cursor: ["cursor.com"],
    Cohere: ["coral.cohere.com"],
    Manus: ["manus.im"],
    ByteDance: ["doubao.com"]
  };
  var AI_REFERRER_DOMAIN_TO_OPERATOR = Object.fromEntries(
    Object.entries(AI_OPERATOR_REFERRER_DOMAINS).flatMap(
      ([operator, domains]) => domains.map((domain) => [domain, operator])
    )
  );
  var AI_CHAT_ONLY_DOMAINS = [
    "deepseek.com",
    "chat.deepseek.com",
    "poe.com",
    "pi.ai",
    "heypi.com",
    "character.ai",
    "qwen.ai",
    "jasper.ai",
    "writesonic.com",
    "chatsonic.com",
    "phind.com",
    "andi.com",
    "codeium.com",
    "kimi.com",
    "kimi.moonshot.cn",
    "chat.qwen.ai",
    "chat.z.ai",
    "chatglm.cn",
    "yuanbao.tencent.com",
    "genspark.ai",
    "t3.chat"
  ];
  var AI_CHAT_DOMAINS = [
    ...Object.keys(AI_REFERRER_DOMAIN_TO_OPERATOR),
    ...AI_CHAT_ONLY_DOMAINS
  ];

  // ../../../shared/src/permissions.ts
  var read = (resource) => ({ resource, action: "read" });
  var write = (resource) => ({ resource, action: "write" });
  var PERMISSIONS = {
    // Reading a site's analytics and the organization it belongs to.
    "analytics:read": { minRole: "viewer", scope: read("analytics") },
    "sessions:read": { minRole: "viewer", scope: read("sessions") },
    "events:read": { minRole: "viewer", scope: read("events") },
    "users:read": { minRole: "viewer", scope: read("users") },
    "funnels:read": { minRole: "viewer", scope: read("funnels") },
    "goals:read": { minRole: "viewer", scope: read("goals") },
    "annotations:read": { minRole: "viewer", scope: read("annotations") },
    "segments:read": { minRole: "viewer", scope: read("segments") },
    "dashboards:read": { minRole: "viewer", scope: read("dashboards") },
    "flags:read": { minRole: "viewer", scope: read("flags") },
    "experiments:read": { minRole: "viewer", scope: read("experiments") },
    "replay:read": { minRole: "viewer", scope: read("replay") },
    "gsc:read": { minRole: "viewer", scope: read("gsc") },
    "sites:read": { minRole: "viewer", scope: read("sites") },
    "sql:read": { minRole: "viewer", scope: read("sql") },
    "org:read": { minRole: "viewer", scope: read("org") },
    // Building reports: shared analysis objects, and a member's own segments and
    // annotations (rows another user created need the :manage permission).
    "users:write": { minRole: "member", scope: write("users") },
    "replay:export": { minRole: "member", scope: write("replay") },
    "funnels:write": { minRole: "member", scope: write("funnels") },
    "goals:write": { minRole: "member", scope: write("goals") },
    "dashboards:write": { minRole: "member", scope: write("dashboards") },
    "annotations:write": { minRole: "member", scope: write("annotations") },
    "segments:write": { minRole: "member", scope: write("segments") },
    // Configuring a site, and managing saved segments and annotations other people
    // created (org-wide ones are checked against the organization role).
    "annotations:manage": { minRole: "editor", scope: write("annotations") },
    "segments:manage": { minRole: "editor", scope: write("segments") },
    "users:delete": { minRole: "editor", scope: write("users") },
    "replay:delete": { minRole: "editor", scope: write("replay") },
    "flags:write": { minRole: "editor", scope: write("flags") },
    "experiments:write": { minRole: "editor", scope: write("experiments") },
    "gsc:write": { minRole: "editor", scope: write("gsc") },
    "sites:configure": { minRole: "editor", scope: write("sites") },
    "imports:read": { minRole: "editor", scope: read("sites") },
    "imports:write": { minRole: "editor", scope: write("sites") },
    // Administering the organization.
    "sites:create": { minRole: "admin", scope: write("sites") },
    "sites:delete": { minRole: "admin", scope: write("sites") },
    "sites:transfer": { minRole: "admin", scope: write("sites") },
    "members:manage": { minRole: "admin", scope: write("org") },
    "teams:manage": { minRole: "admin", scope: write("org") },
    "apikeys:manage": { minRole: "admin", scope: "deny-scoped" },
    // Enforced by better-auth's organization access control (orgRoles in the
    // server's auth.ts); listed here so the client can ask for it by name.
    "org:rename": { minRole: "admin", scope: "deny-scoped" },
    // Owning the organization.
    "billing:manage": { minRole: "owner", scope: "deny-scoped" },
    "org:delete": { minRole: "owner", scope: "deny-scoped" }
  };
  var ALL_PERMISSIONS = Object.keys(PERMISSIONS);

  // networkReplay/config.ts
  function normalizeNetworkReplayConfig(config) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return DEFAULT_NETWORK_REPLAY_CONFIG;
    }
    return applyNetworkReplayCapturePolicy({
      ...DEFAULT_NETWORK_REPLAY_CONFIG,
      ...config,
      enabled: config.enabled === true,
      captureMode: config.captureMode === void 0 || config.captureMode === "full" ? "full" : "metadata"
    });
  }

  // types.ts
  var SessionReplayTransportError = class extends Error {
    constructor(status, statusText) {
      super(`Session replay transport failed with HTTP ${status}${statusText ? ` ${statusText}` : ""}`);
      this.name = "SessionReplayTransportError";
      this.status = status;
    }
  };

  // replayUpload.ts
  function acceptsReplayGzip(value) {
    return typeof value === "object" && value !== null && "version" in value && value.version === 1 && "gzip" in value && value.gzip === true;
  }
  function createReplayUploader(url, capability) {
    let gzipEnabled = acceptsReplayGzip(capability);
    return async (batch) => {
      const json = JSON.stringify(batch);
      let body = json;
      let compressed = false;
      if (gzipEnabled && typeof CompressionStream !== "undefined" && (typeof document === "undefined" || document.visibilityState !== "hidden")) {
        try {
          const plain = new Blob([json], { type: "application/json" });
          if (plain.size >= 4096) {
            const bytes = await new Response(plain.stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
            if (bytes.byteLength <= plain.size * 0.9) {
              body = bytes;
              compressed = true;
            }
          }
        } catch {
          gzipEnabled = false;
        }
      }
      let response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: compressed ? { "Content-Type": "application/json", "Content-Encoding": "gzip" } : { "Content-Type": "application/json" },
          body,
          mode: "cors",
          keepalive: false
        });
      } catch (error) {
        if (compressed) gzipEnabled = false;
        throw error;
      }
      if (!response.ok) {
        if (response.status === 415 && compressed) gzipEnabled = false;
        throw new SessionReplayTransportError(response.status, response.statusText);
      }
    };
  }

  // utils.ts
  function patternToRegex(pattern) {
    const REGEX_PREFIX = "re:";
    if (pattern.startsWith(REGEX_PREFIX)) {
      const rawRegex = pattern.slice(REGEX_PREFIX.length);
      if (!rawRegex) {
        throw new Error("Empty regex pattern");
      }
      return new RegExp(rawRegex);
    }
    const DOUBLE_WILDCARD_TOKEN = "__DOUBLE_ASTERISK_TOKEN__";
    const SINGLE_WILDCARD_TOKEN = "__SINGLE_ASTERISK_TOKEN__";
    let tokenized = pattern.replace(/\*\*/g, DOUBLE_WILDCARD_TOKEN).replace(/\*/g, SINGLE_WILDCARD_TOKEN);
    let escaped = tokenized.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    escaped = escaped.replace(new RegExp(`/${DOUBLE_WILDCARD_TOKEN}/`, "g"), "/(?:.+/)?");
    escaped = escaped.replace(new RegExp(DOUBLE_WILDCARD_TOKEN, "g"), ".*");
    escaped = escaped.replace(/\//g, "\\/");
    let regexPattern = escaped.replace(new RegExp(SINGLE_WILDCARD_TOKEN, "g"), "[^/]+");
    return new RegExp("^" + regexPattern + "$");
  }
  function findMatchingPattern(path, patterns) {
    for (const pattern of patterns) {
      try {
        const regex = patternToRegex(pattern);
        if (regex.test(path)) {
          return pattern;
        }
      } catch (e2) {
        console.error(`Invalid pattern: ${pattern}`, e2);
      }
    }
    return null;
  }
  function debounce(func, wait) {
    let timeout = null;
    return (...args) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(() => func(...args), wait);
    };
  }
  function isOutboundLink(url) {
    try {
      const currentHost = window.location.hostname;
      const linkHost = new URL(url).hostname;
      return linkHost !== currentHost && linkHost !== "";
    } catch (e2) {
      return false;
    }
  }
  function parseJsonSafely(value, fallback) {
    if (!value) return fallback;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(fallback) && !Array.isArray(parsed) ? fallback : parsed;
    } catch (e2) {
      console.error("Error parsing JSON:", e2);
      return fallback;
    }
  }

  // url.ts
  function getTrackedPathname(url, trackUrlFragments = false) {
    if (url.hash.startsWith("#/")) {
      return url.hash.substring(1);
    }
    if (url.hash.startsWith("#!/")) {
      return url.hash.substring(2);
    }
    return url.pathname + (trackUrlFragments ? url.hash : "");
  }

  // config.ts
  var FEATURE_FLAG_REQUEST_TIMEOUT_MS = 2e3;
  function createVisitorId() {
    try {
      if (crypto?.randomUUID) {
        return crypto.randomUUID();
      }
    } catch (e2) {
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
  function getOrCreateVisitorId(namespace) {
    const key = `${namespace}-visitor-id`;
    try {
      const stored = localStorage.getItem(key);
      if (stored) return stored;
      const visitorId = createVisitorId();
      localStorage.setItem(key, visitorId);
      return visitorId;
    } catch (e2) {
      return createVisitorId();
    }
  }
  function rotateVisitorId(namespace) {
    const visitorId = createVisitorId();
    try {
      localStorage.setItem(`${namespace}-visitor-id`, visitorId);
    } catch (e2) {
    }
    return visitorId;
  }
  function getIdentifiedUserId(namespace) {
    try {
      return localStorage.getItem(`${namespace}-user-id`) || void 0;
    } catch (e2) {
      return void 0;
    }
  }
  async function fetchFeatureFlags(analyticsHost, siteId, namespace, visitorId, trackUrlFragments) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), FEATURE_FLAG_REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(window.location.href);
      const response = await fetch(`${analyticsHost}/site/${siteId}/feature-flags/evaluate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        credentials: "omit",
        signal: controller.signal,
        body: JSON.stringify({
          anonymousId: visitorId,
          identifiedUserId: getIdentifiedUserId(namespace),
          hostname: url.hostname,
          pathname: getTrackedPathname(url, trackUrlFragments),
          querystring: url.search,
          query: Object.fromEntries(url.searchParams.entries()),
          referrer: document.referrer,
          language: navigator.language,
          screenWidth: screen.width,
          screenHeight: screen.height
        })
      });
      if (!response.ok) {
        return { enabled: true, flags: {} };
      }
      const data = await response.json();
      return {
        enabled: data?.featureFlagsEnabled !== false,
        flags: data?.flags && typeof data.flags === "object" ? data.flags : {}
      };
    } catch (e2) {
      return { enabled: true, flags: {} };
    } finally {
      window.clearTimeout(timeout);
    }
  }
  function getSiteIdFromSrc(src) {
    try {
      const url = new URL(src, window.location.href);
      return url.searchParams.get("siteId") || url.searchParams.get("site-id") || url.searchParams.get("site_id");
    } catch (e2) {
      return null;
    }
  }
  async function parseScriptConfig(scriptTag) {
    const src = scriptTag.getAttribute("src");
    if (!src) {
      console.error("Script src attribute is missing");
      return null;
    }
    const analyticsHost = src.split("/script.js")[0];
    if (!analyticsHost) {
      console.error("Please provide a valid analytics host");
      return null;
    }
    const siteId = getSiteIdFromSrc(src) || scriptTag.getAttribute("data-site-id") || scriptTag.getAttribute("site-id");
    if (!siteId) {
      console.error("Please provide a valid site ID using the ?siteId= query parameter or the data-site-id attribute");
      return null;
    }
    const namespace = scriptTag.getAttribute("data-namespace") || "rybbit";
    const visitorId = createVisitorId();
    const skipPatterns = parseJsonSafely(scriptTag.getAttribute("data-skip-patterns"), []);
    const maskPatterns = parseJsonSafely(scriptTag.getAttribute("data-mask-patterns"), []);
    const sessionReplayMaskTextSelectors = parseJsonSafely(
      scriptTag.getAttribute("data-replay-mask-text-selectors"),
      []
    );
    const debounceDuration = scriptTag.getAttribute("data-debounce") ? Math.max(0, parseInt(scriptTag.getAttribute("data-debounce"))) : 500;
    const sessionReplayBatchSize = scriptTag.getAttribute("data-replay-batch-size") ? Math.max(1, parseInt(scriptTag.getAttribute("data-replay-batch-size"))) : 250;
    const sessionReplayBatchInterval = scriptTag.getAttribute("data-replay-batch-interval") ? Math.max(1e3, parseInt(scriptTag.getAttribute("data-replay-batch-interval"))) : 5e3;
    const sessionReplayBlockClass = scriptTag.getAttribute("data-replay-block-class") || void 0;
    const sessionReplayBlockSelector = scriptTag.getAttribute("data-replay-block-selector") || void 0;
    const sessionReplayIgnoreClass = scriptTag.getAttribute("data-replay-ignore-class") || void 0;
    const sessionReplayIgnoreSelector = scriptTag.getAttribute("data-replay-ignore-selector") || void 0;
    const sessionReplayMaskTextClass = scriptTag.getAttribute("data-replay-mask-text-class") || void 0;
    const maskAllInputsAttr = scriptTag.getAttribute("data-replay-mask-all-inputs");
    const sessionReplayMaskAllInputs = maskAllInputsAttr !== null ? maskAllInputsAttr !== "false" : void 0;
    const maskInputOptionsAttr = scriptTag.getAttribute("data-replay-mask-input-options");
    const sessionReplayMaskInputOptions = maskInputOptionsAttr ? parseJsonSafely(maskInputOptionsAttr, { password: true, email: true }) : void 0;
    const collectFontsAttr = scriptTag.getAttribute("data-replay-collect-fonts");
    const sessionReplayCollectFonts = collectFontsAttr !== null ? collectFontsAttr !== "false" : void 0;
    const samplingAttr = scriptTag.getAttribute("data-replay-sampling");
    const sessionReplaySampling = samplingAttr ? parseJsonSafely(samplingAttr, {}) : void 0;
    const slimDOMAttr = scriptTag.getAttribute("data-replay-slim-dom-options");
    const sessionReplaySlimDOMOptions = slimDOMAttr ? parseJsonSafely(slimDOMAttr, {}) : void 0;
    const sampleRateAttr = scriptTag.getAttribute("data-replay-sample-rate");
    const sessionReplaySampleRate = sampleRateAttr ? Math.min(100, Math.max(0, parseInt(sampleRateAttr, 10))) : void 0;
    const tag = scriptTag.getAttribute("data-tag") || "";
    const defaultConfig = {
      namespace,
      analyticsHost,
      siteId,
      visitorId,
      debounceDuration,
      sessionReplayBatchSize,
      sessionReplayBatchInterval,
      sessionReplayMaskTextSelectors,
      skipPatterns,
      maskPatterns,
      // Default all tracking to true initially (will be updated from API)
      autoTrackPageview: true,
      autoTrackSpa: true,
      trackQuerystring: true,
      trackUrlFragments: false,
      trackOutbound: true,
      enableWebVitals: false,
      trackErrors: false,
      enableSessionReplay: false,
      networkReplay: DEFAULT_NETWORK_REPLAY_CONFIG,
      trackButtonClicks: false,
      trackCopy: false,
      trackFormInteractions: false,
      tag,
      featureFlagsEnabled: false,
      featureFlags: {},
      // rrweb session replay options (undefined means use rrweb defaults)
      sessionReplayBlockClass,
      sessionReplayBlockSelector,
      sessionReplayIgnoreClass,
      sessionReplayIgnoreSelector,
      sessionReplayMaskTextClass,
      sessionReplayMaskAllInputs,
      sessionReplayMaskInputOptions,
      sessionReplayCollectFonts,
      sessionReplaySampling,
      sessionReplaySlimDOMOptions,
      sessionReplaySampleRate
    };
    let resolvedConfig = defaultConfig;
    try {
      const configUrl = `${analyticsHost}/site/tracking-config/${siteId}`;
      const response = await fetch(configUrl, {
        method: "GET",
        // Include credentials if needed for authentication
        credentials: "omit"
      });
      if (response.ok) {
        const apiConfig = await response.json();
        resolvedConfig = {
          ...defaultConfig,
          // Map API field names to script config field names
          autoTrackPageview: apiConfig.trackInitialPageView ?? defaultConfig.autoTrackPageview,
          autoTrackSpa: apiConfig.trackSpaNavigation ?? defaultConfig.autoTrackSpa,
          trackQuerystring: apiConfig.trackUrlParams ?? defaultConfig.trackQuerystring,
          trackUrlFragments: apiConfig.trackUrlFragments ?? defaultConfig.trackUrlFragments,
          trackOutbound: apiConfig.trackOutbound ?? defaultConfig.trackOutbound,
          enableWebVitals: apiConfig.webVitals ?? defaultConfig.enableWebVitals,
          trackErrors: apiConfig.trackErrors ?? defaultConfig.trackErrors,
          enableSessionReplay: apiConfig.sessionReplay ?? defaultConfig.enableSessionReplay,
          networkReplay: normalizeNetworkReplayConfig(apiConfig.networkReplay),
          replayTransport: { version: 1, gzip: acceptsReplayGzip(apiConfig.replayTransport) },
          trackButtonClicks: apiConfig.trackButtonClicks ?? defaultConfig.trackButtonClicks,
          trackCopy: apiConfig.trackCopy ?? defaultConfig.trackCopy,
          trackFormInteractions: apiConfig.trackFormInteractions ?? defaultConfig.trackFormInteractions,
          featureFlagsEnabled: apiConfig.featureFlagsEnabled === true
        };
      } else {
        console.warn("Failed to fetch tracking config from API, using defaults");
      }
    } catch (error) {
      console.warn("Error fetching tracking config:", error);
    }
    resolvedConfig.networkReplay = resolveNetworkReplayPrivacyCap(
      resolvedConfig.networkReplay ?? DEFAULT_NETWORK_REPLAY_CONFIG,
      scriptTag.getAttribute("data-replay-network-mode")
    );
    if (resolvedConfig.featureFlagsEnabled) {
      resolvedConfig.visitorId = getOrCreateVisitorId(namespace);
      const result = await fetchFeatureFlags(
        analyticsHost,
        siteId,
        namespace,
        resolvedConfig.visitorId,
        resolvedConfig.trackUrlFragments
      );
      resolvedConfig.featureFlagsEnabled = result.enabled;
      resolvedConfig.featureFlags = result.flags;
    }
    return resolvedConfig;
  }

  // networkReplay/utils.ts
  function createRequestId() {
    try {
      if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
      }
    } catch {
      return createFallbackRequestId();
    }
    return createFallbackRequestId();
  }
  function createFallbackRequestId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
  function getCurrentUrl() {
    try {
      return window.location.href;
    } catch {
      return "";
    }
  }
  function toAbsoluteUrl(url) {
    try {
      return new URL(url, getCurrentUrl() || void 0).href;
    } catch {
      return url;
    }
  }
  function getFetchInputUrl(input) {
    if (typeof input === "string") {
      return input;
    }
    if (typeof URL !== "undefined" && input instanceof URL) {
      return input.href;
    }
    return "url" in input ? input.url : input.href;
  }
  function getErrorDetails(error) {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack
      };
    }
    return {
      message: String(error)
    };
  }
  function isAbortError(error) {
    return error instanceof Error && error.name === "AbortError";
  }
  function getDurationMs(startedAt, completedAt) {
    return Math.max(0, completedAt - startedAt);
  }
  function getUtf8ByteSize(value) {
    if (typeof TextEncoder !== "undefined") {
      try {
        return new TextEncoder().encode(value).byteLength;
      } catch {
        return getUtf8ByteSizeWithoutEncoder(value);
      }
    }
    return getUtf8ByteSizeWithoutEncoder(value);
  }
  function getJsonByteSize(value) {
    try {
      const serialized = JSON.stringify(value);
      if (serialized === void 0) {
        return 0;
      }
      return getUtf8ByteSize(serialized);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }
  function getUtf8ByteSizeWithoutEncoder(value) {
    let sizeBytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit <= 127) {
        sizeBytes += 1;
      } else if (codeUnit <= 2047) {
        sizeBytes += 2;
      } else if (codeUnit >= 55296 && codeUnit <= 56319) {
        const nextCodeUnit = value.charCodeAt(index + 1);
        if (nextCodeUnit >= 56320 && nextCodeUnit <= 57343) {
          sizeBytes += 4;
          index += 1;
        } else {
          sizeBytes += 3;
        }
      } else {
        sizeBytes += 3;
      }
    }
    return sizeBytes;
  }

  // networkReplay/bodyCapture.ts
  function createUnavailableBody(kind, reason, contentType) {
    return {
      kind,
      contentType: contentType || void 0,
      reason
    };
  }
  function captureRequestBody(request, limits) {
    return captureFetchBody(request, limits);
  }
  function captureResponseBody(response, limits) {
    return captureFetchBody(response, limits);
  }
  async function captureFetchBody(source, limits) {
    const contentType = source.headers.get("content-type") || void 0;
    const contentLength = parseContentLength(source.headers.get("content-length"));
    if (contentLength !== void 0 && contentLength > limits.maxBodySizeBytes) {
      return {
        kind: "too-large",
        contentType,
        sizeBytes: contentLength,
        truncated: true,
        reason: "Body exceeds the configured size limit"
      };
    }
    if (!source.body) {
      return {
        kind: "empty",
        contentType,
        sizeBytes: 0
      };
    }
    if (!isTextContentType(contentType)) {
      return {
        kind: "binary-unavailable",
        contentType,
        sizeBytes: contentLength,
        reason: "Binary body capture is not supported"
      };
    }
    return readTextStream(source.body, contentType, limits);
  }
  async function captureBodyValue(body, contentType, limits) {
    try {
      if (body === void 0 || body === null) {
        return {
          kind: "empty",
          contentType,
          sizeBytes: 0
        };
      }
      if (typeof body === "string") {
        return captureTextValue(body, getTextBodyKind(contentType), contentType, limits);
      }
      if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
        return captureTextValue(body.toString(), "url-search-params", contentType, limits);
      }
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        return captureFormData(body, contentType, limits);
      }
      if (typeof Blob !== "undefined" && body instanceof Blob) {
        return captureBlob(body, contentType, limits);
      }
      if (body instanceof ArrayBuffer) {
        return captureArrayBufferSize(body.byteLength, contentType, limits);
      }
      if (ArrayBuffer.isView(body)) {
        return captureArrayBufferSize(body.byteLength, contentType, limits);
      }
      if (typeof Document !== "undefined" && body instanceof Document) {
        const serializedDocument = new XMLSerializer().serializeToString(body);
        return captureTextValue(serializedDocument, "text", contentType, limits);
      }
      if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
        return createUnavailableBody("stream-unavailable", "Direct stream body capture is not supported", contentType);
      }
      return createUnavailableBody("unreadable", "Unsupported body type", contentType);
    } catch (error) {
      return createUnavailableBody("unreadable", getErrorMessage(error), contentType);
    }
  }
  async function captureXhrResponseBody(xhr, contentType, limits) {
    try {
      switch (xhr.responseType) {
        case "":
        case "text":
          return captureTextValue(xhr.responseText || "", getTextBodyKind(contentType), contentType, limits);
        case "json": {
          if (xhr.response === null || xhr.response === void 0) {
            return { kind: "empty", contentType, sizeBytes: 0 };
          }
          const serializedJson = JSON.stringify(xhr.response);
          return captureTextValue(serializedJson, "json", contentType, limits);
        }
        case "blob":
          return captureBodyValue(xhr.response, contentType, limits);
        case "arraybuffer":
          return captureBodyValue(xhr.response, contentType, limits);
        case "document":
          return captureBodyValue(xhr.response, contentType, limits);
        default:
          return createUnavailableBody("binary-unavailable", "Unsupported XMLHttpRequest response type", contentType);
      }
    } catch (error) {
      return createUnavailableBody("unreadable", getErrorMessage(error), contentType);
    }
  }
  async function readTextStream(stream, contentType, limits) {
    const reader = stream.getReader();
    const readTask = consumeTextStream(reader, contentType, limits.maxBodySizeBytes);
    const timedResult = await resolveWithTimeout(readTask, limits.bodyReadTimeoutMs);
    if (timedResult.timedOut) {
      void reader.cancel().catch(() => void 0);
      return createUnavailableBody("timeout", "Body read timed out", contentType);
    }
    if (timedResult.error) {
      return createUnavailableBody("unreadable", getErrorMessage(timedResult.error), contentType);
    }
    return timedResult.value ?? createUnavailableBody("unreadable", "Body read failed", contentType);
  }
  async function consumeTextStream(reader, contentType, maxBodySizeBytes) {
    if (typeof TextDecoder === "undefined") {
      void reader.cancel().catch(() => void 0);
      return createUnavailableBody("unreadable", "Text decoding is not supported by this browser", contentType);
    }
    const decoder = new TextDecoder();
    let sizeBytes = 0;
    let value = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        value += decoder.decode();
        if (sizeBytes === 0) {
          return {
            kind: "empty",
            contentType,
            sizeBytes: 0
          };
        }
        return {
          kind: getTextBodyKind(contentType),
          value,
          contentType,
          sizeBytes
        };
      }
      sizeBytes += chunk.value.byteLength;
      if (sizeBytes > maxBodySizeBytes) {
        void reader.cancel().catch(() => void 0);
        return {
          kind: "too-large",
          contentType,
          sizeBytes,
          truncated: true,
          reason: "Body exceeds the configured size limit"
        };
      }
      value += decoder.decode(chunk.value, { stream: true });
    }
  }
  async function captureBlob(blob, contentType, limits) {
    const resolvedContentType = blob.type || contentType;
    if (blob.size > limits.maxBodySizeBytes) {
      return {
        kind: "too-large",
        contentType: resolvedContentType,
        sizeBytes: blob.size,
        truncated: true,
        reason: "Body exceeds the configured size limit"
      };
    }
    if (!isTextContentType(resolvedContentType)) {
      return {
        kind: "blob-metadata",
        contentType: resolvedContentType,
        sizeBytes: blob.size
      };
    }
    const timedResult = await resolveWithTimeout(readBlobText(blob), limits.bodyReadTimeoutMs);
    if (timedResult.timedOut) {
      return createUnavailableBody("timeout", "Blob read timed out", resolvedContentType);
    }
    if (timedResult.error || timedResult.value === void 0) {
      return createUnavailableBody("unreadable", getErrorMessage(timedResult.error), resolvedContentType);
    }
    return captureTextValue(timedResult.value, getTextBodyKind(resolvedContentType), resolvedContentType, limits);
  }
  async function captureFormData(formData, contentType, limits) {
    const entries = [];
    formData.forEach((value, name) => {
      if (typeof value === "string") {
        entries.push({ name, value });
        return;
      }
      entries.push({
        name,
        value: {
          name: "name" in value ? value.name : void 0,
          size: value.size,
          type: value.type
        }
      });
    });
    return captureTextValue(JSON.stringify(entries), "form-data", contentType, limits);
  }
  function captureArrayBufferSize(sizeBytes, contentType, limits) {
    if (sizeBytes > limits.maxBodySizeBytes) {
      return {
        kind: "too-large",
        contentType,
        sizeBytes,
        truncated: true,
        reason: "Body exceeds the configured size limit"
      };
    }
    return {
      kind: "array-buffer-metadata",
      contentType,
      sizeBytes
    };
  }
  function captureTextValue(value, kind, contentType, limits) {
    const sizeBytes = getUtf8ByteSize(value);
    if (sizeBytes === 0) {
      return {
        kind: "empty",
        contentType,
        sizeBytes: 0
      };
    }
    if (sizeBytes > limits.maxBodySizeBytes) {
      return {
        kind: "too-large",
        contentType,
        sizeBytes,
        truncated: true,
        reason: "Body exceeds the configured size limit"
      };
    }
    return {
      kind,
      value,
      contentType,
      sizeBytes
    };
  }
  function getTextBodyKind(contentType) {
    const normalizedContentType = contentType?.toLowerCase() || "";
    if (normalizedContentType.includes("json")) {
      return "json";
    }
    if (normalizedContentType.includes("application/x-www-form-urlencoded")) {
      return "url-search-params";
    }
    if (normalizedContentType.includes("multipart/form-data")) {
      return "form-data";
    }
    return "text";
  }
  function isTextContentType(contentType) {
    if (!contentType) {
      return true;
    }
    const normalizedContentType = contentType.toLowerCase();
    return normalizedContentType.startsWith("text/") || normalizedContentType.includes("json") || normalizedContentType.includes("xml") || normalizedContentType.includes("javascript") || normalizedContentType.includes("application/x-www-form-urlencoded") || normalizedContentType.includes("graphql");
  }
  function parseContentLength(contentLength) {
    if (!contentLength) {
      return void 0;
    }
    const parsedContentLength = Number(contentLength);
    return Number.isFinite(parsedContentLength) && parsedContentLength >= 0 ? parsedContentLength : void 0;
  }
  async function resolveWithTimeout(promise, timeoutMs) {
    let timeoutId;
    const settledPromise = promise.then((value) => ({ value, timedOut: false })).catch((error) => ({ error, timedOut: false }));
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = window.setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });
    const result = await Promise.race([settledPromise, timeoutPromise]);
    if (timeoutId !== void 0) {
      window.clearTimeout(timeoutId);
    }
    return result;
  }
  function readBlobText(blob) {
    if (typeof blob.text === "function") {
      return blob.text();
    }
    if (typeof FileReader === "undefined") {
      return Promise.reject(new Error("Blob text reading is not supported by this browser"));
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
          return;
        }
        reject(new Error("Blob text reading returned an unsupported result"));
      });
      reader.addEventListener("error", () => reject(reader.error || new Error("Blob text reading failed")));
      reader.addEventListener("abort", () => reject(new Error("Blob text reading was aborted")));
      reader.readAsText(blob);
    });
  }
  function getErrorMessage(error) {
    return error instanceof Error ? error.message : error ? String(error) : "Unknown body capture error";
  }

  // networkReplay/headerCapture.ts
  function captureHeaders(headers) {
    if (!headers) {
      return {};
    }
    try {
      const capturedHeaders = {};
      new Headers(headers).forEach((value, key) => {
        capturedHeaders[key] = value;
      });
      return capturedHeaders;
    } catch {
      return {};
    }
  }
  function appendCapturedHeader(headers, name, value) {
    const normalizedName = name.toLowerCase();
    headers[normalizedName] = headers[normalizedName] ? `${headers[normalizedName]}, ${value}` : value;
  }
  function getCapturedHeader(headers, name) {
    return headers[name.toLowerCase()];
  }
  function parseXhrResponseHeaders(rawHeaders) {
    const headers = {};
    for (const line of rawHeaders.trim().split(/[\r\n]+/)) {
      if (!line) {
        continue;
      }
      const separatorIndex = line.indexOf(":");
      if (separatorIndex <= 0) {
        continue;
      }
      appendCapturedHeader(headers, line.slice(0, separatorIndex).trim(), line.slice(separatorIndex + 1).trim());
    }
    return headers;
  }

  // networkReplay/ignoredTrackerRequests.ts
  var TRACKER_RESOURCE_PATHS = /* @__PURE__ */ new Set(["/script.js", "/replay.js", "/metrics.js"]);
  function isIgnoredTrackerRequest(requestUrl, analyticsHost) {
    try {
      const absoluteRequestUrl = new URL(toAbsoluteUrl(requestUrl));
      const absoluteAnalyticsHost = new URL(toAbsoluteUrl(analyticsHost));
      if (absoluteRequestUrl.origin !== absoluteAnalyticsHost.origin) {
        return false;
      }
      const analyticsBasePath = absoluteAnalyticsHost.pathname.replace(/\/$/, "");
      if (analyticsBasePath && !absoluteRequestUrl.pathname.startsWith(`${analyticsBasePath}/`)) {
        return false;
      }
      const relativePath = analyticsBasePath ? absoluteRequestUrl.pathname.slice(analyticsBasePath.length) || "/" : absoluteRequestUrl.pathname;
      return relativePath === "/track" || relativePath === "/identify" || relativePath.startsWith("/session-replay/record/") || relativePath.startsWith("/site/tracking-config/") || /^\/site\/[^/]+\/feature-flags\/evaluate$/.test(relativePath) || TRACKER_RESOURCE_PATHS.has(relativePath);
    } catch {
      return false;
    }
  }

  // networkReplay/fetchObserver.ts
  function observeFetch({
    analyticsHost,
    config,
    pendingRequests,
    performanceObserver
  }) {
    if (typeof window.fetch !== "function") {
      return () => void 0;
    }
    const originalFetch = window.fetch;
    const bodyCaptureLimits = config;
    const observedFetch = function(input, init) {
      let requestUrl;
      try {
        requestUrl = toAbsoluteUrl(getFetchInputUrl(input));
      } catch {
        return Reflect.apply(originalFetch, this, [input, init]);
      }
      if (isIgnoredTrackerRequest(requestUrl, analyticsHost)) {
        return Reflect.apply(originalFetch, this, [input, init]);
      }
      let captureContext;
      try {
        captureContext = registerFetchRequest(
          input,
          init,
          requestUrl,
          config,
          bodyCaptureLimits,
          pendingRequests,
          performanceObserver
        );
      } catch {
        captureContext = void 0;
      }
      let fetchPromise;
      try {
        fetchPromise = Reflect.apply(originalFetch, this, [input, init]);
      } catch (error) {
        if (captureContext) {
          completeFetchError(captureContext, error, pendingRequests, performanceObserver);
        }
        throw error;
      }
      if (!captureContext) {
        return fetchPromise;
      }
      return fetchPromise.then(
        (response) => {
          try {
            completeFetchResponse(
              captureContext,
              response,
              config,
              bodyCaptureLimits,
              pendingRequests,
              performanceObserver
            );
          } catch {
            completeFetchResponseWithoutBody(captureContext, response, config, pendingRequests, performanceObserver);
          }
          return response;
        },
        (error) => {
          completeFetchError(captureContext, error, pendingRequests, performanceObserver);
          throw error;
        }
      );
    };
    window.fetch = observedFetch;
    return () => {
      if (window.fetch === observedFetch) {
        window.fetch = originalFetch;
      }
    };
  }
  function registerFetchRequest(input, init, requestUrl, config, limits, pendingRequests, performanceObserver) {
    const requestId = createRequestId();
    const startedAt = Date.now();
    const capturedRequest = config.captureRequestBody ? createCapturedRequest(input, init) : void 0;
    const method = (capturedRequest?.method || init?.method || getInputRequestMethod(input) || "GET").toUpperCase();
    const effectiveHeaders = config.captureRequestHeaders || config.captureRequestBody ? capturedRequest?.headers || getInputRequestHeaders(input, init) : void 0;
    const capturedHeaders = config.captureRequestHeaders ? captureHeaders(effectiveHeaders) : {};
    const requestBody = config.captureRequestBody ? createFetchRequestBodyCapture(input, init, capturedRequest, effectiveHeaders, limits) : void 0;
    const request = {
      schemaVersion: 1,
      requestId,
      currentUrl: getCurrentUrl(),
      url: requestUrl,
      method,
      initiatorType: "fetch",
      startedAt,
      requestHeaders: capturedHeaders,
      responseHeaders: {},
      performanceEntryFound: false
    };
    pendingRequests.register(request, requestBody);
    performanceObserver?.registerRequest(requestId, requestUrl, "fetch", startedAt);
    return { requestId, startedAt };
  }
  function completeFetchResponse(context, response, config, limits, pendingRequests, performanceObserver) {
    const completedAt = Date.now();
    const responseBody = config.captureResponseBody ? captureResponseBody(response.clone(), limits) : void 0;
    const performanceTask = performanceObserver?.completeRequest(context.requestId, completedAt, response.url);
    pendingRequests.complete(
      context.requestId,
      {
        completedAt,
        durationMs: getDurationMs(context.startedAt, completedAt),
        outcome: getHttpOutcome(response.status),
        responseHeaders: config.captureResponseHeaders ? captureHeaders(response.headers) : {},
        ...readResponseCorrelation((name) => response.headers.get(name)),
        status: response.status,
        statusText: response.statusText
      },
      responseBody,
      performanceTask
    );
  }
  function completeFetchResponseWithoutBody(context, response, config, pendingRequests, performanceObserver) {
    const completedAt = Date.now();
    const responseBody = config.captureResponseBody ? Promise.resolve(createUnavailableBody("unreadable", "Response body could not be cloned")) : void 0;
    const performanceTask = performanceObserver?.completeRequest(context.requestId, completedAt, response.url);
    pendingRequests.complete(
      context.requestId,
      {
        completedAt,
        durationMs: getDurationMs(context.startedAt, completedAt),
        outcome: getHttpOutcome(response.status),
        responseHeaders: config.captureResponseHeaders ? captureHeaders(response.headers) : {},
        ...readResponseCorrelation((name) => response.headers.get(name)),
        status: response.status,
        statusText: response.statusText
      },
      responseBody,
      performanceTask
    );
  }
  function completeFetchError(context, error, pendingRequests, performanceObserver) {
    const completedAt = Date.now();
    const performanceTask = performanceObserver?.completeRequest(context.requestId, completedAt);
    pendingRequests.complete(
      context.requestId,
      {
        completedAt,
        durationMs: getDurationMs(context.startedAt, completedAt),
        error: getErrorDetails(error),
        outcome: isAbortError(error) ? "aborted" : "network_error",
        responseHeaders: {}
      },
      void 0,
      performanceTask
    );
  }
  function createCapturedRequest(input, init) {
    try {
      const captureInput = typeof Request !== "undefined" && input instanceof Request ? input.clone() : input;
      return new Request(captureInput, init);
    } catch {
      return void 0;
    }
  }
  function createFetchRequestBodyCapture(input, init, capturedRequest, headers, limits) {
    const contentType = captureHeaders(headers)["content-type"];
    if (init?.body !== void 0 && init.body !== null) {
      return captureBodyValue(init.body, contentType, limits);
    }
    if (capturedRequest) {
      try {
        return captureRequestBody(capturedRequest.clone(), limits);
      } catch {
        return Promise.resolve(createUnavailableBody("unreadable", "Request body could not be cloned", contentType));
      }
    }
    if (typeof Request !== "undefined" && input instanceof Request && input.body) {
      return Promise.resolve(createUnavailableBody("unreadable", "Request body could not be cloned", contentType));
    }
    return Promise.resolve({ kind: "empty", contentType, sizeBytes: 0 });
  }
  function getInputRequestMethod(input) {
    return typeof Request !== "undefined" && input instanceof Request ? input.method : void 0;
  }
  function getInputRequestHeaders(input, init) {
    if (init?.headers) {
      return init.headers;
    }
    return typeof Request !== "undefined" && input instanceof Request ? input.headers : void 0;
  }
  function getHttpOutcome(status) {
    return status >= 400 ? "http_error" : "success";
  }

  // networkReplay/pendingRequests.ts
  var PendingRequests = class {
    constructor(emit) {
      this.emit = emit;
      this.requests = /* @__PURE__ */ new Map();
    }
    register(request, requestBody) {
      const state = {
        request,
        networkCompleted: false,
        finishScheduled: false,
        emitted: false
      };
      if (requestBody) {
        state.requestBodyTask = this.attachBodyTask(state, "requestBody", requestBody);
      }
      this.requests.set(request.requestId, state);
    }
    complete(requestId, updates, responseBody, completionTask) {
      const state = this.requests.get(requestId);
      if (!state || state.emitted || state.networkCompleted) {
        return;
      }
      Object.assign(state.request, updates);
      state.networkCompleted = true;
      if (responseBody) {
        state.responseBodyTask = this.attachBodyTask(state, "responseBody", responseBody);
      }
      if (completionTask) {
        state.completionTask = completionTask.catch(() => void 0);
      }
      this.scheduleCompletedEmission(state);
    }
    addPerformance(requestId, timing, sizes) {
      const state = this.requests.get(requestId);
      if (!state || state.emitted) {
        return;
      }
      state.request.timing = timing;
      state.request.sizes = sizes;
      state.request.performanceEntryFound = true;
    }
    finalizePendingOnUnload() {
      const completedAt = Date.now();
      for (const state of this.requests.values()) {
        if (state.emitted) {
          continue;
        }
        if (!state.networkCompleted) {
          state.request.completedAt = completedAt;
          state.request.durationMs = getDurationMs(state.request.startedAt, completedAt);
          state.request.outcome = "pending_on_unload";
        }
        if (state.requestBodyTask && !state.request.requestBody) {
          state.request.requestBody = createUnavailableBody(
            "unreadable",
            "Recorder stopped before request body capture completed"
          );
        }
        if (state.responseBodyTask && !state.request.responseBody) {
          state.request.responseBody = createUnavailableBody(
            "unreadable",
            "Recorder stopped before response body capture completed"
          );
        }
        if (state.requestBodyTask || state.responseBodyTask) {
          state.request.bodyCaptureCompletedAt = completedAt;
        }
        this.emitState(state);
      }
    }
    attachBodyTask(state, field, bodyPromise) {
      return bodyPromise.then(
        (body) => {
          if (!state.emitted) {
            state.request[field] = body;
          }
        },
        (error) => {
          if (!state.emitted) {
            state.request[field] = createUnavailableBody(
              "unreadable",
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      );
    }
    scheduleCompletedEmission(state) {
      if (state.finishScheduled) {
        return;
      }
      state.finishScheduled = true;
      const completionTasks = [state.requestBodyTask, state.responseBodyTask, state.completionTask].filter(
        (task) => task !== void 0
      );
      void Promise.all(completionTasks).then(() => {
        if (!state.emitted) {
          if (state.requestBodyTask || state.responseBodyTask) {
            state.request.bodyCaptureCompletedAt = Date.now();
          }
          this.emitState(state);
        }
      });
    }
    emitState(state) {
      if (state.emitted || !state.request.outcome) {
        return;
      }
      state.emitted = true;
      this.requests.delete(state.request.requestId);
      try {
        this.emit(state.request);
      } catch {
        return;
      }
    }
  };

  // networkReplay/timing.ts
  function getPerformanceEntryStartedAt(entry) {
    return getTimeOrigin() + entry.startTime;
  }
  function getPerformanceEntryCompletedAt(entry) {
    const responseEnd = entry.responseEnd > 0 ? entry.responseEnd : entry.startTime + entry.duration;
    return getTimeOrigin() + responseEnd;
  }
  function getPerformanceEntryTiming(entry) {
    return {
      startTime: entry.startTime,
      fetchStart: entry.fetchStart,
      domainLookupStart: entry.domainLookupStart,
      domainLookupEnd: entry.domainLookupEnd,
      connectStart: entry.connectStart,
      secureConnectionStart: entry.secureConnectionStart,
      connectEnd: entry.connectEnd,
      requestStart: entry.requestStart,
      responseStart: entry.responseStart,
      responseEnd: entry.responseEnd,
      duration: entry.duration
    };
  }
  function getPerformanceEntrySizes(entry) {
    const resourceEntry = entry;
    if (resourceEntry.transferSize === void 0 && resourceEntry.encodedBodySize === void 0 && resourceEntry.decodedBodySize === void 0) {
      return void 0;
    }
    return {
      transferSize: resourceEntry.transferSize,
      encodedBodySize: resourceEntry.encodedBodySize,
      decodedBodySize: resourceEntry.decodedBodySize
    };
  }
  function getPerformanceEntryStatus(entry) {
    const responseStatus = entry.responseStatus;
    return typeof responseStatus === "number" && responseStatus > 0 ? responseStatus : void 0;
  }
  function getPerformanceEntryInitiatorType(entry) {
    return entry.entryType === "navigation" ? "navigation" : entry.initiatorType || "resource";
  }
  function isSupportedPerformanceEntry(entry) {
    return entry.entryType === "resource" || entry.entryType === "navigation";
  }
  function getTimeOrigin() {
    if (typeof performance.timeOrigin === "number" && performance.timeOrigin > 0) {
      return performance.timeOrigin;
    }
    return Date.now() - performance.now();
  }

  // networkReplay/performanceObserver.ts
  var MATCH_TOLERANCE_MS = 250;
  var MATCH_WAIT_MS = 250;
  var UNMATCHED_ENTRY_WAIT_MS = 250;
  function observePerformance({
    analyticsHost,
    config,
    emit,
    pendingRequests
  }) {
    const coordinator = new PerformanceObserverCoordinator(analyticsHost, emit, pendingRequests);
    coordinator.start(config.captureInitialPerformanceResources);
    return coordinator;
  }
  var PerformanceObserverCoordinator = class {
    constructor(analyticsHost, emit, pendingRequests) {
      this.analyticsHost = analyticsHost;
      this.emit = emit;
      this.pendingRequests = pendingRequests;
      this.candidates = /* @__PURE__ */ new Map();
      this.observedEntries = /* @__PURE__ */ new Map();
      this.seenEntryKeys = /* @__PURE__ */ new Set();
      this.observers = [];
      this.matchingEnabled = false;
      this.stopped = false;
    }
    start(captureInitialEntries) {
      if (typeof PerformanceObserver === "undefined" || typeof performance === "undefined") {
        return;
      }
      this.matchingEnabled = this.observeEntryType("resource", captureInitialEntries);
      this.observeEntryType("navigation", captureInitialEntries);
      if (captureInitialEntries) {
        this.handleEntries(performance.getEntriesByType("resource"));
        this.handleEntries(performance.getEntriesByType("navigation"));
      }
    }
    registerRequest(requestId, url, initiatorType, startedAt) {
      if (this.stopped || !this.matchingEnabled) {
        return;
      }
      const candidate = {
        requestId,
        urls: /* @__PURE__ */ new Set([toAbsoluteUrl(url)]),
        initiatorType,
        startedAt,
        matched: false
      };
      this.candidates.set(requestId, candidate);
      this.tryMatchCandidate(candidate);
    }
    completeRequest(requestId, completedAt, finalUrl) {
      const candidate = this.candidates.get(requestId);
      if (!candidate || this.stopped) {
        return Promise.resolve();
      }
      candidate.completedAt = completedAt;
      if (finalUrl) {
        candidate.urls.add(toAbsoluteUrl(finalUrl));
      }
      this.tryMatchCandidate(candidate);
      if (candidate.matched) {
        this.finishCandidate(candidate);
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        candidate.resolve = resolve;
        candidate.timeoutId = window.setTimeout(() => this.finishCandidate(candidate), MATCH_WAIT_MS);
      });
    }
    stop() {
      if (this.stopped) {
        return;
      }
      this.stopped = true;
      this.observers.forEach((observer) => observer.disconnect());
      for (const observedEntry of this.observedEntries.values()) {
        if (!observedEntry.claimed) {
          this.emitStandaloneEntry(observedEntry);
        }
      }
      for (const candidate of this.candidates.values()) {
        this.finishCandidate(candidate);
      }
      this.observedEntries.clear();
      this.candidates.clear();
    }
    observeEntryType(type, buffered) {
      if (PerformanceObserver.supportedEntryTypes && !PerformanceObserver.supportedEntryTypes.includes(type)) {
        return false;
      }
      const observer = new PerformanceObserver((list) => this.handleEntries(list.getEntries()));
      try {
        observer.observe({ type, buffered });
      } catch {
        try {
          observer.observe({ entryTypes: [type] });
        } catch {
          observer.disconnect();
          return false;
        }
      }
      this.observers.push(observer);
      return true;
    }
    handleEntries(entries) {
      if (this.stopped) {
        return;
      }
      for (const entry of entries) {
        if (!isSupportedPerformanceEntry(entry) || isIgnoredTrackerRequest(entry.name, this.analyticsHost)) {
          continue;
        }
        const key = createPerformanceEntryKey(entry);
        if (this.seenEntryKeys.has(key)) {
          continue;
        }
        this.seenEntryKeys.add(key);
        const observedEntry = {
          entry,
          key,
          claimed: false
        };
        this.observedEntries.set(key, observedEntry);
        const candidate = this.findMatchingCandidate(entry);
        if (candidate) {
          this.claimEntry(observedEntry, candidate);
        } else if (entry.entryType === "navigation") {
          this.emitStandaloneEntry(observedEntry);
        } else {
          observedEntry.timeoutId = window.setTimeout(
            () => this.emitStandaloneEntry(observedEntry),
            UNMATCHED_ENTRY_WAIT_MS
          );
        }
      }
    }
    tryMatchCandidate(candidate) {
      if (candidate.matched) {
        return;
      }
      let closestEntry;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const observedEntry of this.observedEntries.values()) {
        if (observedEntry.claimed || !this.isEntryMatch(observedEntry.entry, candidate)) {
          continue;
        }
        const distance = Math.abs(getPerformanceEntryStartedAt(observedEntry.entry) - candidate.startedAt);
        if (distance < closestDistance) {
          closestEntry = observedEntry;
          closestDistance = distance;
        }
      }
      if (closestEntry) {
        this.claimEntry(closestEntry, candidate);
      }
    }
    findMatchingCandidate(entry) {
      let closestCandidate;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const candidate of this.candidates.values()) {
        if (!this.isEntryMatch(entry, candidate)) {
          continue;
        }
        const distance = Math.abs(getPerformanceEntryStartedAt(entry) - candidate.startedAt);
        if (distance < closestDistance) {
          closestCandidate = candidate;
          closestDistance = distance;
        }
      }
      return closestCandidate;
    }
    isEntryMatch(entry, candidate) {
      if (candidate.matched || entry.entryType !== "resource") {
        return false;
      }
      const initiatorType = getPerformanceEntryInitiatorType(entry);
      if (initiatorType !== candidate.initiatorType || !candidate.urls.has(toAbsoluteUrl(entry.name))) {
        return false;
      }
      return Math.abs(getPerformanceEntryStartedAt(entry) - candidate.startedAt) <= MATCH_TOLERANCE_MS;
    }
    claimEntry(observedEntry, candidate) {
      observedEntry.claimed = true;
      candidate.matched = true;
      if (observedEntry.timeoutId !== void 0) {
        window.clearTimeout(observedEntry.timeoutId);
      }
      this.pendingRequests.addPerformance(
        candidate.requestId,
        getPerformanceEntryTiming(observedEntry.entry),
        getPerformanceEntrySizes(observedEntry.entry)
      );
      this.observedEntries.delete(observedEntry.key);
      if (candidate.completedAt !== void 0) {
        this.finishCandidate(candidate);
      }
    }
    finishCandidate(candidate) {
      if (candidate.timeoutId !== void 0) {
        window.clearTimeout(candidate.timeoutId);
        candidate.timeoutId = void 0;
      }
      this.candidates.delete(candidate.requestId);
      candidate.resolve?.();
      candidate.resolve = void 0;
    }
    emitStandaloneEntry(observedEntry) {
      if (observedEntry.claimed) {
        return;
      }
      observedEntry.claimed = true;
      if (observedEntry.timeoutId !== void 0) {
        window.clearTimeout(observedEntry.timeoutId);
      }
      this.observedEntries.delete(observedEntry.key);
      const entry = observedEntry.entry;
      const status = getPerformanceEntryStatus(entry);
      const request = {
        schemaVersion: 1,
        requestId: createRequestId(),
        currentUrl: getCurrentUrl(),
        url: toAbsoluteUrl(entry.name),
        method: "GET",
        initiatorType: getPerformanceEntryInitiatorType(entry),
        startedAt: getPerformanceEntryStartedAt(entry),
        completedAt: getPerformanceEntryCompletedAt(entry),
        durationMs: entry.duration,
        status,
        outcome: status !== void 0 && status >= 400 ? "http_error" : "success",
        requestHeaders: {},
        responseHeaders: {},
        timing: getPerformanceEntryTiming(entry),
        sizes: getPerformanceEntrySizes(entry),
        performanceEntryFound: true
      };
      try {
        this.emit(request);
      } catch {
        return;
      }
    }
  };
  function createPerformanceEntryKey(entry) {
    return [entry.entryType, entry.name, entry.startTime, entry.duration, getPerformanceEntryInitiatorType(entry)].join(
      "|"
    );
  }

  // networkReplay/recorderLifecycle.ts
  var RecorderLifecycle = class {
    constructor() {
      this.cleanups = [];
      this.stopped = false;
    }
    add(cleanup) {
      if (this.stopped) {
        runCleanup(cleanup);
        return;
      }
      this.cleanups.push(cleanup);
    }
    stop() {
      if (this.stopped) return;
      this.stopped = true;
      for (const cleanup of this.cleanups.reverse()) {
        runCleanup(cleanup);
      }
      this.cleanups = [];
    }
  };
  function runCleanup(cleanup) {
    try {
      cleanup();
    } catch {
    }
  }

  // networkReplay/xhrObserver.ts
  function observeXhr({
    analyticsHost,
    config,
    pendingRequests,
    performanceObserver
  }) {
    if (typeof XMLHttpRequest === "undefined") {
      return () => void 0;
    }
    const prototype = XMLHttpRequest.prototype;
    const originalOpen = prototype.open;
    const originalSend = prototype.send;
    const originalSetRequestHeader = prototype.setRequestHeader;
    const states = /* @__PURE__ */ new WeakMap();
    const activeStates = /* @__PURE__ */ new Set();
    const limits = config;
    const observedOpen = function(...args) {
      Reflect.apply(originalOpen, this, args);
      try {
        const previousState = states.get(this);
        if (previousState) {
          cleanupListeners(previousState, activeStates);
          finalizeReopenedRequest(previousState, pendingRequests, performanceObserver);
        }
        const method = String(args[0] || "GET").toUpperCase();
        const url = toAbsoluteUrl(String(args[1] || ""));
        states.set(this, {
          xhr: this,
          requestId: createRequestId(),
          method,
          url,
          requestHeaders: {},
          ignored: isIgnoredTrackerRequest(url, analyticsHost),
          registered: false,
          finalized: false
        });
      } catch {
        states.delete(this);
      }
    };
    const observedSetRequestHeader = function(name, value) {
      Reflect.apply(originalSetRequestHeader, this, [name, value]);
      const state = states.get(this);
      if (state && !state.ignored && (config.captureRequestHeaders || config.captureRequestBody && name.toLowerCase() === "content-type")) {
        appendCapturedHeader(state.requestHeaders, name, value);
      }
    };
    const observedSend = function(body) {
      const state = states.get(this);
      if (!state || state.ignored) {
        Reflect.apply(originalSend, this, [body]);
        return;
      }
      try {
        prepareXhrCapture(state, body, config, limits, pendingRequests, activeStates, performanceObserver);
      } catch {
        cleanupListeners(state, activeStates);
        Reflect.apply(originalSend, this, [body]);
        return;
      }
      try {
        Reflect.apply(originalSend, this, [body]);
      } catch (error) {
        state.outcome = "network_error";
        state.error = getErrorDetails(error);
        finalizeXhrRequest(state, config, limits, pendingRequests, activeStates, performanceObserver);
        throw error;
      }
    };
    try {
      prototype.open = observedOpen;
      prototype.setRequestHeader = observedSetRequestHeader;
      prototype.send = observedSend;
    } catch (error) {
      restoreXhrPrototype(prototype, observedOpen, observedSetRequestHeader, observedSend, {
        open: originalOpen,
        setRequestHeader: originalSetRequestHeader,
        send: originalSend
      });
      throw error;
    }
    return () => {
      for (const state of activeStates) {
        cleanupListeners(state, activeStates);
      }
      restoreXhrPrototype(prototype, observedOpen, observedSetRequestHeader, observedSend, {
        open: originalOpen,
        setRequestHeader: originalSetRequestHeader,
        send: originalSend
      });
    };
  }
  function restoreXhrPrototype(prototype, observedOpen, observedSetRequestHeader, observedSend, original) {
    try {
      if (prototype.open === observedOpen) {
        prototype.open = original.open;
      }
    } catch {
    }
    try {
      if (prototype.setRequestHeader === observedSetRequestHeader) {
        prototype.setRequestHeader = original.setRequestHeader;
      }
    } catch {
    }
    try {
      if (prototype.send === observedSend) {
        prototype.send = original.send;
      }
    } catch {
    }
  }
  function prepareXhrCapture(state, body, config, limits, pendingRequests, activeStates, performanceObserver) {
    state.startedAt = Date.now();
    const contentType = getCapturedHeader(state.requestHeaders, "content-type");
    const requestBody = config.captureRequestBody ? captureBodyValue(body, contentType, limits) : void 0;
    const request = {
      schemaVersion: 1,
      requestId: state.requestId,
      currentUrl: getCurrentUrl(),
      url: state.url,
      method: state.method,
      initiatorType: "xmlhttprequest",
      startedAt: state.startedAt,
      requestHeaders: config.captureRequestHeaders ? { ...state.requestHeaders } : {},
      responseHeaders: {},
      performanceEntryFound: false
    };
    const listeners = {
      abort: () => {
        state.outcome = "aborted";
        state.error = { name: "AbortError", message: "XMLHttpRequest was aborted" };
      },
      error: () => {
        state.outcome = "network_error";
        state.error = { name: "NetworkError", message: "XMLHttpRequest failed" };
      },
      loadend: () => finalizeXhrRequest(state, config, limits, pendingRequests, activeStates, performanceObserver),
      timeout: () => {
        state.outcome = "timeout";
        state.error = { name: "TimeoutError", message: "XMLHttpRequest timed out" };
      }
    };
    state.listeners = listeners;
    state.xhr.addEventListener("abort", listeners.abort);
    state.xhr.addEventListener("error", listeners.error);
    state.xhr.addEventListener("loadend", listeners.loadend);
    state.xhr.addEventListener("timeout", listeners.timeout);
    activeStates.add(state);
    pendingRequests.register(request, requestBody);
    performanceObserver?.registerRequest(state.requestId, state.url, "xmlhttprequest", state.startedAt);
    state.registered = true;
  }
  function finalizeXhrRequest(state, config, limits, pendingRequests, activeStates, performanceObserver) {
    if (state.finalized || !state.registered || state.startedAt === void 0) {
      return;
    }
    state.finalized = true;
    cleanupListeners(state, activeStates);
    const completedAt = Date.now();
    const status = getXhrStatus(state.xhr);
    const allResponseHeaders = config.captureResponseHeaders || config.captureResponseBody ? getXhrResponseHeaders(state.xhr) : {};
    const responseContentType = getCapturedHeader(allResponseHeaders, "content-type");
    const responseBody = config.captureResponseBody ? captureXhrResponseBody(state.xhr, responseContentType, limits) : void 0;
    const performanceTask = performanceObserver?.completeRequest(
      state.requestId,
      completedAt,
      getXhrResponseUrl(state.xhr)
    );
    pendingRequests.complete(
      state.requestId,
      {
        completedAt,
        durationMs: getDurationMs(state.startedAt, completedAt),
        error: state.error,
        outcome: state.outcome ?? getXhrOutcome(status),
        responseHeaders: config.captureResponseHeaders ? allResponseHeaders : {},
        ...readResponseCorrelation((name) => state.xhr.getResponseHeader(name)),
        status,
        statusText: getXhrStatusText(state.xhr)
      },
      responseBody,
      performanceTask
    );
  }
  function finalizeReopenedRequest(state, pendingRequests, performanceObserver) {
    if (!state.registered || state.finalized || state.startedAt === void 0) {
      return;
    }
    const completedAt = Date.now();
    state.finalized = true;
    const performanceTask = performanceObserver?.completeRequest(state.requestId, completedAt);
    pendingRequests.complete(
      state.requestId,
      {
        completedAt,
        durationMs: getDurationMs(state.startedAt, completedAt),
        error: { name: "AbortError", message: "XMLHttpRequest was reopened before completion" },
        outcome: "aborted",
        responseHeaders: {}
      },
      void 0,
      performanceTask
    );
  }
  function cleanupListeners(state, activeStates) {
    if (!state.listeners) {
      activeStates.delete(state);
      return;
    }
    state.xhr.removeEventListener("abort", state.listeners.abort);
    state.xhr.removeEventListener("error", state.listeners.error);
    state.xhr.removeEventListener("loadend", state.listeners.loadend);
    state.xhr.removeEventListener("timeout", state.listeners.timeout);
    state.listeners = void 0;
    activeStates.delete(state);
  }
  function getXhrResponseHeaders(xhr) {
    try {
      return parseXhrResponseHeaders(xhr.getAllResponseHeaders());
    } catch {
      return {};
    }
  }
  function getXhrStatus(xhr) {
    try {
      return xhr.status;
    } catch {
      return void 0;
    }
  }
  function getXhrStatusText(xhr) {
    try {
      return xhr.statusText || void 0;
    } catch {
      return void 0;
    }
  }
  function getXhrResponseUrl(xhr) {
    try {
      return xhr.responseURL || void 0;
    } catch {
      return void 0;
    }
  }
  function getXhrOutcome(status) {
    if (!status) {
      return "network_error";
    }
    return status >= 400 ? "http_error" : "success";
  }

  // networkReplay/index.ts
  var stopActiveRecorder;
  function startNetworkReplayRecorder({
    analyticsHost,
    config: inputConfig,
    emit: emitRequest
  }) {
    const config = normalizeNetworkReplayConfig(inputConfig);
    const emit = (request) => emitRequest(config.captureMode === "metadata" ? toMetadataRequest(request) : request);
    stopActiveRecorder?.();
    stopActiveRecorder = void 0;
    if (!config.enabled) {
      return () => void 0;
    }
    const pendingRequests = new PendingRequests(emit);
    const lifecycle = new RecorderLifecycle();
    let performanceObserver;
    if (config.capturePerformanceResources) {
      try {
        performanceObserver = observePerformance({ analyticsHost, config, emit, pendingRequests });
        lifecycle.add(() => performanceObserver?.stop());
      } catch {
        performanceObserver = void 0;
      }
    }
    if (config.captureFetch) {
      try {
        lifecycle.add(observeFetch({ analyticsHost, config, pendingRequests, performanceObserver }));
      } catch {
      }
    }
    if (config.captureXhr) {
      try {
        lifecycle.add(observeXhr({ analyticsHost, config, pendingRequests, performanceObserver }));
      } catch {
      }
    }
    let stopped = false;
    const stop = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      lifecycle.stop();
      pendingRequests.finalizePendingOnUnload();
      if (stopActiveRecorder === stop) stopActiveRecorder = void 0;
    };
    stopActiveRecorder = stop;
    return stop;
  }

  // networkReplay/networkPlugin.ts
  var NETWORK_PLUGIN_NAME = "rrweb/network@1";
  function getRecordNetworkPlugin(config, analyticsHost) {
    return {
      name: NETWORK_PLUGIN_NAME,
      observer: (callback, pluginWindow) => {
        if (pluginWindow !== window) {
          return () => void 0;
        }
        try {
          return startNetworkReplayRecorder({
            analyticsHost,
            config,
            emit: (request) => emitNetworkRequest(callback, request, config.maxNetworkEventSizeBytes)
          });
        } catch {
          return () => void 0;
        }
      }
    };
  }
  function emitNetworkRequest(callback, request, maxEventSizeBytes) {
    try {
      const payload = createPayload(request);
      if (getPluginEventSizeBytes(payload) <= maxEventSizeBytes) {
        callback(payload);
        return;
      }
      const reducedPayload = createPayload({
        ...request,
        requestBody: removeBodyValue(request.requestBody),
        responseBody: removeBodyValue(request.responseBody)
      });
      if (getPluginEventSizeBytes(reducedPayload) <= maxEventSizeBytes) {
        callback(reducedPayload);
        return;
      }
      console.warn(`[NetworkReplay] Dropped request ${request.requestId}: event exceeds configured size limit`);
    } catch {
      return;
    }
  }
  function createPayload(request) {
    return {
      version: 1,
      requests: [request]
    };
  }
  function getPluginEventSizeBytes(payload) {
    return getJsonByteSize({
      type: 6,
      timestamp: Date.now(),
      data: {
        plugin: NETWORK_PLUGIN_NAME,
        payload
      }
    });
  }
  function removeBodyValue(body) {
    if (!body || body.value === void 0) {
      return body;
    }
    return {
      kind: "too-large",
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      truncated: true,
      reason: "network_event_size_limit"
    };
  }

  // replayBatching.ts
  function getReplayBatchKey(events) {
    const first = events[0];
    return String(first?.sequenceNumber ?? first?.timestamp ?? "empty");
  }

  // sessionReplay.ts
  var SAMPLE_STORAGE_KEY = "rybbit-replay-sampled";
  var ACTIVITY_CAPTURE_VERSION = 2;
  var MAX_BATCH_SEND_ATTEMPTS = 3;
  var RETRY_BASE_DELAY_MS = 1e3;
  var RETRY_MAX_DELAY_MS = 3e4;
  function shouldSampleSession(sampleRate) {
    if (sampleRate >= 100) return true;
    if (sampleRate <= 0) return false;
    try {
      const existingDecision = sessionStorage.getItem(SAMPLE_STORAGE_KEY);
      if (existingDecision !== null) {
        return existingDecision === "1";
      }
      const sampled = Math.random() * 100 < sampleRate;
      sessionStorage.setItem(SAMPLE_STORAGE_KEY, sampled ? "1" : "0");
      return sampled;
    } catch {
      return Math.random() * 100 < sampleRate;
    }
  }
  var SessionReplayRecorder = class {
    constructor(config, userId, sendBatch) {
      this.isRecording = false;
      this.eventBuffer = [];
      this.eventBufferSizeBytes = 0;
      this.nextSequenceNumber = 0;
      this.pendingBatches = [];
      this.isSendingBatches = false;
      this.retryAttempts = /* @__PURE__ */ new Map();
      this.config = config;
      this.userId = userId;
      this.sendBatch = sendBatch;
    }
    async initialize() {
      if (!this.config.enableSessionReplay) {
        return;
      }
      const sampleRate = this.config.sessionReplaySampleRate;
      if (sampleRate !== void 0 && !shouldSampleSession(sampleRate)) {
        return;
      }
      if (!window.rrweb) {
        await this.loadRrweb();
      }
      if (window.rrweb) {
        this.startRecording();
      }
    }
    async loadRrweb() {
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `${this.config.analyticsHost}/replay.js`;
        script.async = false;
        script.onload = () => {
          resolve();
        };
        script.onerror = () => reject(new Error("Failed to load rrweb"));
        document.head.appendChild(script);
      });
    }
    startRecording() {
      if (this.isRecording || !window.rrweb || !this.config.enableSessionReplay) {
        return;
      }
      try {
        const defaultSlimDOMOptions = {
          script: false,
          comment: true,
          headFavicon: true,
          headWhitespace: true,
          headMetaDescKeywords: true,
          headMetaSocial: true,
          headMetaRobots: true,
          headMetaHttpEquiv: true,
          headMetaAuthorship: true,
          headMetaVerification: true
        };
        const recordingOptions = {
          emit: (event) => {
            this.addEvent({
              type: event.type,
              data: event.data,
              timestamp: event.timestamp || Date.now()
            });
          },
          recordCanvas: false,
          // Always disabled to save disk space
          checkoutEveryNms: 6e4,
          // Checkout every 60 seconds
          checkoutEveryNth: 500,
          // Checkout every 500 events
          // Use config values with fallbacks to defaults
          blockClass: this.config.sessionReplayBlockClass ?? "rr-block",
          blockSelector: this.config.sessionReplayBlockSelector ?? null,
          ignoreClass: this.config.sessionReplayIgnoreClass ?? "rr-ignore",
          ignoreSelector: this.config.sessionReplayIgnoreSelector ?? null,
          maskTextClass: this.config.sessionReplayMaskTextClass ?? "rr-mask",
          maskAllInputs: this.config.sessionReplayMaskAllInputs ?? true,
          maskInputOptions: this.config.sessionReplayMaskInputOptions ?? { password: true, email: true },
          collectFonts: this.config.sessionReplayCollectFonts ?? true,
          slimDOMOptions: this.config.sessionReplaySlimDOMOptions ?? defaultSlimDOMOptions,
          plugins: this.config.networkReplay?.enabled ? [getRecordNetworkPlugin(this.config.networkReplay, this.config.analyticsHost)] : []
        };
        if (this.config.sessionReplayMaskTextSelectors && this.config.sessionReplayMaskTextSelectors.length > 0) {
          recordingOptions.maskTextSelector = this.config.sessionReplayMaskTextSelectors.join(", ");
        }
        if (this.config.sessionReplaySampling !== void 0) {
          recordingOptions.sampling = this.config.sessionReplaySampling;
        }
        this.stopRecordingFn = window.rrweb.record(recordingOptions);
        this.addEvent({
          type: 5,
          data: {
            tag: "wotcv/replay-config",
            payload: {
              activityCaptureVersion: ACTIVITY_CAPTURE_VERSION,
              sampling: this.config.sessionReplaySampling ?? null
            }
          },
          timestamp: Date.now()
        });
        this.isRecording = true;
        this.setupBatchTimer();
      } catch (error) {
      }
    }
    stopRecording() {
      if (!this.isRecording) {
        return;
      }
      if (this.stopRecordingFn) {
        this.stopRecordingFn();
      }
      this.isRecording = false;
      this.clearBatchTimer();
      if (this.eventBuffer.length > 0) {
        this.flushEvents();
      }
    }
    isActive() {
      return this.isRecording;
    }
    addEvent(event) {
      const sequencedEvent = {
        ...event,
        sequenceNumber: event.sequenceNumber ?? this.nextSequenceNumber++
      };
      const eventSizeBytes = getJsonByteSize(sequencedEvent);
      const maxBatchSizeBytes = this.config.networkReplay?.maxReplayBatchSizeBytes ?? 7e6;
      if (this.eventBuffer.length > 0 && this.eventBufferSizeBytes + eventSizeBytes > maxBatchSizeBytes) {
        this.flushEvents();
      }
      this.eventBuffer.push(sequencedEvent);
      this.eventBufferSizeBytes += eventSizeBytes;
      if (eventSizeBytes >= maxBatchSizeBytes || this.eventBuffer.length >= this.config.sessionReplayBatchSize) {
        this.flushEvents();
      }
    }
    setupBatchTimer() {
      this.clearBatchTimer();
      this.batchTimer = window.setInterval(() => {
        if (this.eventBuffer.length > 0) {
          this.flushEvents();
        } else if (this.pendingBatches.length > 0 && this.retryTimer === void 0) {
          void this.processPendingBatches();
        }
      }, this.config.sessionReplayBatchInterval);
    }
    clearBatchTimer() {
      if (this.batchTimer !== void 0) {
        clearInterval(this.batchTimer);
        this.batchTimer = void 0;
      }
    }
    flushEvents() {
      if (this.eventBuffer.length === 0) {
        return;
      }
      const events = this.eventBuffer;
      this.eventBuffer = [];
      this.eventBufferSizeBytes = 0;
      this.pendingBatches.push(this.createBatch(events));
      void this.processPendingBatches();
    }
    async processPendingBatches() {
      if (this.isSendingBatches || this.retryTimer !== void 0) {
        return;
      }
      this.isSendingBatches = true;
      try {
        while (this.pendingBatches.length > 0) {
          const batch = this.pendingBatches.shift();
          if (!batch) {
            continue;
          }
          const unsentEvents = await this.sendEventsWithPayloadFallback(batch);
          if (unsentEvents) {
            const batchKey = getReplayBatchKey(unsentEvents);
            const attempts = (this.retryAttempts.get(batchKey) ?? 0) + 1;
            if (attempts >= MAX_BATCH_SEND_ATTEMPTS) {
              this.retryAttempts.delete(batchKey);
              console.warn(
                `[SessionReplay] Dropped ${unsentEvents.length} events after ${MAX_BATCH_SEND_ATTEMPTS} failed send attempts`
              );
              continue;
            }
            this.retryAttempts.set(batchKey, attempts);
            this.pendingBatches.unshift({ ...batch, events: unsentEvents });
            const queuedEventCount = this.pendingBatches.reduce(
              (total, queuedBatch) => total + queuedBatch.events.length,
              0
            );
            console.warn(`[SessionReplay] ${queuedEventCount} events queued for retry`);
            this.scheduleRetry(attempts);
            break;
          } else {
            this.retryAttempts.delete(getReplayBatchKey(batch.events));
          }
        }
      } finally {
        this.isSendingBatches = false;
      }
    }
    scheduleRetry(attempt) {
      if (this.retryTimer !== void 0) {
        return;
      }
      const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_DELAY_MS);
      this.retryTimer = window.setTimeout(() => {
        this.retryTimer = void 0;
        void this.processPendingBatches();
      }, delay);
    }
    async sendEventsWithPayloadFallback(batch) {
      const { events } = batch;
      try {
        await this.sendBatch(batch);
        return void 0;
      } catch (error) {
        if (!this.isPayloadTooLargeError(error)) {
          return events;
        }
        if (events.length === 1) {
          const event = events[0];
          console.warn(
            `[SessionReplay] Dropped event type ${String(event.type)} at ${event.timestamp} after HTTP 413 (${getJsonByteSize(event)} bytes)`
          );
          return void 0;
        }
        const splitIndex = Math.ceil(events.length / 2);
        const firstBatch = events.slice(0, splitIndex);
        const secondBatch = events.slice(splitIndex);
        const unsentFirstBatch = await this.sendEventsWithPayloadFallback({ ...batch, events: firstBatch });
        if (unsentFirstBatch) {
          return [...unsentFirstBatch, ...secondBatch];
        }
        return this.sendEventsWithPayloadFallback({ ...batch, events: secondBatch });
      }
    }
    createBatch(events) {
      return {
        anonymousId: this.config.visitorId,
        userId: this.userId,
        events,
        metadata: {
          pageUrl: window.location.href,
          viewportWidth: screen.width,
          viewportHeight: screen.height,
          language: navigator.language
        }
      };
    }
    isPayloadTooLargeError(error) {
      if (error instanceof SessionReplayTransportError) {
        return error.status === 413;
      }
      return typeof error === "object" && error !== null && "status" in error && error.status === 413;
    }
    // Update user ID when it changes
    updateUserId(userId) {
      if (userId === this.userId) {
        return;
      }
      if (this.eventBuffer.length > 0) {
        void this.flushEvents();
      }
      this.userId = userId;
    }
    // Handle page navigation for SPAs
    onPageChange() {
      if (this.isRecording) {
        this.flushEvents();
      }
    }
    // Cleanup on page unload
    cleanup() {
      this.stopRecording();
    }
  };

  // botSignals.ts
  var cachedBotSignals = null;
  function getBotScore() {
    return getBotSignals().score;
  }
  function getBotSignalMask() {
    return getBotSignals().mask;
  }
  function isPrerendering() {
    return document.prerendering === true;
  }
  function getBotSignals() {
    if (isPrerendering()) {
      return calculateBotSignals();
    }
    cachedBotSignals ?? (cachedBotSignals = calculateBotSignals());
    return cachedBotSignals;
  }
  function calculateBotSignals() {
    let score = 0;
    let mask = 0;
    function addSignal(name) {
      const signalMask = CLIENT_BOT_SIGNAL_MASKS[name];
      if ((mask & signalMask) !== 0) {
        return;
      }
      mask |= signalMask;
      score += CLIENT_BOT_SIGNAL_WEIGHTS[name];
    }
    try {
      const userAgent = navigator.userAgent;
      const isChromeLike = /Chrome\//.test(userAgent) && !/\bwv\b|; wv\)/.test(userAgent);
      const screenWidth = Number(window.screen?.width);
      const screenHeight = Number(window.screen?.height);
      const outerWidth = Number(window.outerWidth);
      const outerHeight = Number(window.outerHeight);
      const innerWidth = Number(window.innerWidth);
      const innerHeight = Number(window.innerHeight);
      const automationGlobalNames = [
        "__webdriver_evaluate",
        "__selenium_evaluate",
        "__webdriver_script_function",
        "__webdriver_script_func",
        "__webdriver_script_fn",
        "__fxdriver_evaluate",
        "__driver_unwrapped",
        "__webdriver_unwrapped",
        "__driver_evaluate",
        "__selenium_unwrapped",
        "__fxdriver_unwrapped",
        "_phantom",
        "callPhantom",
        "__nightmare",
        "domAutomation",
        "domAutomationController"
      ];
      const hasAutomationGlobal = automationGlobalNames.some((name) => name in window || name in document);
      if (navigator.webdriver === true || hasAutomationGlobal) {
        addSignal("automationApi");
      }
      if ((outerHeight === 0 || outerWidth === 0) && !isPrerendering()) {
        addSignal("zeroOuterDimensions");
      }
      for (const signal of getScreenDimensionSignals(screenWidth, screenHeight, userAgent)) {
        addSignal(signal);
      }
      if (Number.isFinite(outerWidth) && Number.isFinite(outerHeight) && Number.isFinite(innerWidth) && Number.isFinite(innerHeight) && outerWidth > 0 && outerHeight > 0 && innerWidth > 0 && innerHeight > 0 && (outerWidth + 8 < innerWidth || outerHeight + 8 < innerHeight)) {
        addSignal("outerDimensionsWeird");
      }
      let hasPluginOrApiAbsence = false;
      if (!window.chrome && isChromeLike) {
        addSignal("missingChrome");
        hasPluginOrApiAbsence = true;
      }
      try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (gl) {
          try {
            const rendererParts = [];
            const rendererRaw = gl.getParameter(gl.RENDERER);
            if (typeof rendererRaw === "string") {
              rendererParts.push(rendererRaw);
            }
            try {
              const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
              if (debugInfo) {
                const unmaskedRaw = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
                if (typeof unmaskedRaw === "string") {
                  rendererParts.push(unmaskedRaw);
                }
              }
            } catch {
            }
            if (rendererParts.join(" ").toLowerCase().includes("swiftshader")) {
              addSignal("swiftShader");
            }
          } finally {
            releaseWebGlContext(canvas, gl);
          }
        }
      } catch {
      }
      if ((!navigator.plugins || navigator.plugins.length === 0) && isChromeLike) {
        addSignal("emptyPlugins");
        hasPluginOrApiAbsence = true;
      }
      if (hasPluginOrApiAbsence) {
        addSignal("pluginApiAbsence");
      }
    } catch (e2) {
    }
    return {
      score: Math.min(score, MAX_CLIENT_BOT_SCORE),
      mask
    };
  }
  function releaseWebGlContext(canvas, gl) {
    try {
      const loseContextExt = gl.getExtension("WEBGL_lose_context");
      loseContextExt?.loseContext?.();
    } catch {
    }
    canvas.width = 0;
    canvas.height = 0;
  }

  // tracking.ts
  var IDENTIFY_MAX_ATTEMPTS = 3;
  var IDENTIFY_RETRY_BASE_DELAY_MS = 250;
  var IDENTIFY_RETRY_MAX_DELAY_MS = 2e3;
  var FEATURE_FLAG_REQUEST_TIMEOUT_MS2 = 2e3;
  var Tracker = class {
    constructor(config) {
      this.customUserId = null;
      this.errorDedupeCache = /* @__PURE__ */ new Map();
      this.errorDedupeLastCleanup = 0;
      this.exposedFeatureFlags = /* @__PURE__ */ new Set();
      this.config = config;
      this.sendReplay = createReplayUploader(
        `${config.analyticsHost}/session-replay/record/${config.siteId}`,
        config.replayTransport
      );
      this.lastPageviewUrl = this.getPageviewUrl();
      this.loadUserId();
      if (config.enableSessionReplay) {
        this.initializeSessionReplay();
      }
    }
    serializeFeatureFlagValue(value) {
      if (value === null || value === void 0) return "";
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      try {
        return JSON.stringify(value);
      } catch (e2) {
        return "";
      }
    }
    getFeatureFlagEventPayload() {
      const payload = {};
      for (const [key, assignment] of Object.entries(this.config.featureFlags || {})) {
        payload[key] = this.serializeFeatureFlagValue(assignment.value);
      }
      return payload;
    }
    getCurrentUrlContext() {
      const url = new URL(window.location.href);
      const pathname = getTrackedPathname(url, this.config.trackUrlFragments);
      return {
        hostname: url.hostname,
        pathname,
        querystring: url.search,
        query: Object.fromEntries(url.searchParams.entries()),
        referrer: document.referrer,
        language: navigator.language,
        screenWidth: screen.width,
        screenHeight: screen.height
      };
    }
    async refreshFeatureFlags() {
      if (!this.config.featureFlagsEnabled) return;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), FEATURE_FLAG_REQUEST_TIMEOUT_MS2);
      try {
        const response = await fetch(`${this.config.analyticsHost}/site/${this.config.siteId}/feature-flags/evaluate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            anonymousId: this.config.visitorId,
            identifiedUserId: this.customUserId || void 0,
            ...this.getCurrentUrlContext()
          }),
          mode: "cors",
          credentials: "omit",
          keepalive: true,
          signal: controller.signal
        });
        if (!response.ok) return;
        const data = await response.json();
        this.config.featureFlags = data?.flags && typeof data.flags === "object" ? data.flags : {};
        if (data?.featureFlagsEnabled === false) {
          this.config.featureFlagsEnabled = false;
        }
      } catch (e2) {
      } finally {
        window.clearTimeout(timeout);
      }
    }
    loadUserId() {
      try {
        const storedUserId = localStorage.getItem(`${this.config.namespace}-user-id`);
        if (storedUserId) {
          this.customUserId = storedUserId;
        }
      } catch (e2) {
      }
    }
    async initializeSessionReplay() {
      try {
        this.sessionReplayRecorder = new SessionReplayRecorder(
          this.config,
          this.customUserId || "",
          (batch) => this.sendSessionReplayBatch(batch)
        );
        await this.sessionReplayRecorder.initialize();
      } catch (error) {
        console.error("Failed to initialize session replay:", error);
      }
    }
    async sendSessionReplayBatch(batch) {
      await this.sendReplay(batch);
    }
    createBasePayload() {
      const url = new URL(window.location.href);
      let pathname = getTrackedPathname(url, this.config.trackUrlFragments);
      if (findMatchingPattern(pathname, this.config.skipPatterns)) {
        return null;
      }
      const maskMatch = findMatchingPattern(pathname, this.config.maskPatterns);
      if (maskMatch) {
        pathname = maskMatch;
      }
      const payload = {
        site_id: this.config.siteId,
        anonymous_id: this.config.visitorId,
        hostname: url.hostname,
        pathname,
        querystring: this.config.trackQuerystring ? url.search : "",
        screenWidth: screen.width,
        screenHeight: screen.height,
        language: navigator.language,
        page_title: document.title,
        referrer: document.referrer,
        _bs: getBotScore(),
        _bsm: getBotSignalMask()
      };
      if (this.customUserId) {
        payload.user_id = this.customUserId;
      }
      if (this.config.tag) {
        payload.tag = this.config.tag;
      }
      const featureFlagPayload = this.getFeatureFlagEventPayload();
      if (Object.keys(featureFlagPayload).length > 0) {
        payload.feature_flags = featureFlagPayload;
      }
      return payload;
    }
    async sendTrackingData(payload) {
      try {
        await fetch(`${this.config.analyticsHost}/track`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload),
          mode: "cors",
          keepalive: true
        });
      } catch (error) {
        console.error("Failed to send tracking data:", error);
      }
    }
    track(eventType, eventName = "", properties = {}) {
      if (eventType === "custom_event" && (!eventName || typeof eventName !== "string")) {
        console.error("Event name is required and must be a string for custom events");
        return;
      }
      const basePayload = this.createBasePayload();
      if (!basePayload) {
        return;
      }
      const typesWithProperties = [
        "custom_event",
        "outbound",
        "error",
        "button_click",
        "copy",
        "form_submit",
        "input_change"
      ];
      const payload = {
        ...basePayload,
        type: eventType,
        event_name: eventName,
        properties: typesWithProperties.includes(eventType) ? JSON.stringify(properties) : void 0
      };
      this.sendTrackingData(payload);
    }
    trackPageview() {
      this.lastPageviewUrl = this.getPageviewUrl();
      this.track("pageview");
    }
    trackPageviewIfUrlChanged() {
      if (this.getPageviewUrl() !== this.lastPageviewUrl) {
        this.trackPageview();
      }
    }
    getPageviewUrl() {
      const url = new URL(window.location.href);
      return JSON.stringify([
        url.hostname,
        getTrackedPathname(url, this.config.trackUrlFragments),
        this.config.trackQuerystring ? url.search : ""
      ]);
    }
    trackEvent(name, properties = {}) {
      this.track("custom_event", name, properties);
    }
    getFeatureFlag(key, fallback) {
      const assignment = this.config.featureFlags?.[key];
      if (!assignment) {
        return fallback;
      }
      const exposureKey = `${key}:${assignment.version}:${this.serializeFeatureFlagValue(assignment.value)}`;
      if (!this.exposedFeatureFlags.has(exposureKey)) {
        this.exposedFeatureFlags.add(exposureKey);
        this.trackEvent("feature_flag_exposure", {
          key,
          value: this.serializeFeatureFlagValue(assignment.value),
          version: assignment.version,
          reason: assignment.reason
        });
      }
      return assignment.value;
    }
    getFeatureFlags() {
      return Object.fromEntries(
        Object.entries(this.config.featureFlags || {}).map(([key, assignment]) => [key, assignment.value])
      );
    }
    getFeatureFlagPayload(key, fallback) {
      const assignment = this.config.featureFlags?.[key];
      if (!assignment || assignment.payload === void 0) {
        return fallback;
      }
      return assignment.payload;
    }
    getFeatureFlagPayloads() {
      return Object.fromEntries(
        Object.entries(this.config.featureFlags || {}).filter(([, assignment]) => assignment.payload !== void 0).map(([key, assignment]) => [key, assignment.payload])
      );
    }
    trackOutbound(url, text = "", target = "_self") {
      this.track("outbound", "", { url, text, target });
    }
    trackWebVitals(vitals) {
      const basePayload = this.createBasePayload();
      if (!basePayload) {
        return;
      }
      const payload = {
        ...basePayload,
        type: "performance",
        event_name: "web-vitals",
        ...vitals
      };
      this.sendTrackingData(payload);
    }
    trackError(error, additionalInfo = {}) {
      const message = error?.message || "";
      if (message.includes("ResizeObserver loop completed with undelivered notifications") || message.includes("ResizeObserver loop limit exceeded")) {
        return;
      }
      const currentOrigin = window.location.origin;
      const filename = additionalInfo.filename || "";
      const errorStack = error.stack || "";
      if (filename) {
        try {
          const fileUrl = new URL(filename);
          if (fileUrl.origin !== currentOrigin) {
            return;
          }
        } catch (e2) {
        }
      } else if (errorStack) {
        if (!errorStack.includes(currentOrigin)) {
          return;
        }
      }
      const dedupeKeyParts = [
        error.name || "Error",
        message,
        additionalInfo.filename || "",
        additionalInfo.lineno ?? "",
        additionalInfo.colno ?? ""
      ];
      const dedupeKey = dedupeKeyParts.join("|");
      const now = Date.now();
      const dedupeWindowMs = 6e4;
      const lastSeen = this.errorDedupeCache.get(dedupeKey);
      if (lastSeen && now - lastSeen < dedupeWindowMs) {
        return;
      }
      this.errorDedupeCache.set(dedupeKey, now);
      const pruneAfterMs = 10 * 6e4;
      if (now - this.errorDedupeLastCleanup > dedupeWindowMs) {
        for (const [key, ts] of this.errorDedupeCache.entries()) {
          if (now - ts > pruneAfterMs) {
            this.errorDedupeCache.delete(key);
          }
        }
        this.errorDedupeLastCleanup = now;
      }
      const errorProperties = {
        message: error.message?.substring(0, 500) || "Unknown error",
        // Truncate to 500 chars
        stack: errorStack.substring(0, 2e3) || ""
        // Truncate to 2000 chars
      };
      if (filename) {
        errorProperties.fileName = filename;
      }
      if (additionalInfo.lineno) {
        const lineNum = typeof additionalInfo.lineno === "string" ? parseInt(additionalInfo.lineno, 10) : additionalInfo.lineno;
        if (lineNum && lineNum !== 0) {
          errorProperties.lineNumber = lineNum;
        }
      }
      if (additionalInfo.colno) {
        const colNum = typeof additionalInfo.colno === "string" ? parseInt(additionalInfo.colno, 10) : additionalInfo.colno;
        if (colNum && colNum !== 0) {
          errorProperties.columnNumber = colNum;
        }
      }
      for (const key in additionalInfo) {
        if (!["lineno", "colno"].includes(key) && additionalInfo[key] !== void 0) {
          errorProperties[key] = additionalInfo[key];
        }
      }
      this.track("error", error.name || "Error", errorProperties);
    }
    trackButtonClick(properties) {
      this.track("button_click", "", properties);
    }
    trackCopy(properties) {
      this.track("copy", "", properties);
    }
    trackFormSubmit(properties) {
      this.track("form_submit", "", properties);
    }
    trackInputChange(properties) {
      this.track("input_change", "", properties);
    }
    identify(userId, traits) {
      if (typeof userId !== "string" || userId.trim() === "") {
        console.error("User ID must be a non-empty string");
        return;
      }
      const nextUserId = userId.trim();
      const isAccountSwitch = Boolean(this.customUserId && this.customUserId !== nextUserId);
      if (isAccountSwitch) {
        this.sessionReplayRecorder?.updateUserId(nextUserId);
        this.config.visitorId = rotateVisitorId(this.config.namespace);
      }
      this.customUserId = nextUserId;
      try {
        localStorage.setItem(`${this.config.namespace}-user-id`, this.customUserId);
      } catch (e2) {
        console.warn("Could not persist user ID to localStorage");
      }
      void this.sendIdentifyEvent(this.customUserId, traits, true).then(() => this.refreshFeatureFlags());
      if (this.sessionReplayRecorder) {
        this.sessionReplayRecorder.updateUserId(this.customUserId);
      }
    }
    setTraits(traits) {
      if (!traits || typeof traits !== "object") {
        console.error("Traits must be an object");
        return;
      }
      const userId = this.customUserId;
      if (!userId) {
        console.warn("Cannot set traits without identifying user first. Call identify() first.");
        return;
      }
      void this.sendIdentifyEvent(userId, traits, false).then(() => this.refreshFeatureFlags());
    }
    async sendIdentifyEvent(userId, traits, isNewIdentify = true) {
      let conflictRotationUsed = false;
      for (let attempt = 1; attempt <= IDENTIFY_MAX_ATTEMPTS; attempt += 1) {
        try {
          const response = await fetch(`${this.config.analyticsHost}/identify`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              site_id: this.config.siteId,
              anonymous_id: this.config.visitorId,
              user_id: userId,
              traits,
              is_new_identify: isNewIdentify
            }),
            mode: "cors",
            keepalive: true
          });
          if (response.ok) {
            return;
          }
          if (response.status === 409 && isNewIdentify && !conflictRotationUsed) {
            const body = await response.json().catch(() => null);
            if (body?.code === "ANONYMOUS_ID_ALREADY_LINKED" && body?.rotateAnonymousId === true) {
              conflictRotationUsed = true;
              this.config.visitorId = rotateVisitorId(this.config.namespace);
              continue;
            }
          }
          if (response.status !== 429 && response.status < 500) {
            console.error(`Failed to send identify event: HTTP ${response.status}`);
            return;
          }
        } catch (error) {
          if (attempt === IDENTIFY_MAX_ATTEMPTS) {
            console.error("Failed to send identify event:", error);
            return;
          }
        }
        if (attempt < IDENTIFY_MAX_ATTEMPTS) {
          const exponentialDelay = Math.min(
            IDENTIFY_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
            IDENTIFY_RETRY_MAX_DELAY_MS
          );
          const jitteredDelay = Math.round(exponentialDelay * (0.75 + Math.random() * 0.5));
          await new Promise((resolve) => window.setTimeout(resolve, jitteredDelay));
        }
      }
      console.error(`Failed to send identify event after ${IDENTIFY_MAX_ATTEMPTS} attempts`);
    }
    clearUserId() {
      this.customUserId = null;
      try {
        localStorage.removeItem(`${this.config.namespace}-user-id`);
      } catch (e2) {
      }
      if (this.sessionReplayRecorder) {
        this.sessionReplayRecorder.updateUserId("");
      }
      this.config.visitorId = rotateVisitorId(this.config.namespace);
      void this.refreshFeatureFlags();
    }
    getUserId() {
      return this.customUserId;
    }
    // Session Replay methods
    startSessionReplay() {
      if (this.sessionReplayRecorder) {
        this.sessionReplayRecorder.startRecording();
      } else {
        console.warn("Session replay not initialized");
      }
    }
    stopSessionReplay() {
      if (this.sessionReplayRecorder) {
        this.sessionReplayRecorder.stopRecording();
      }
    }
    isSessionReplayActive() {
      return this.sessionReplayRecorder?.isActive() ?? false;
    }
    // Handle page changes for SPA
    onPageChange() {
      void this.refreshFeatureFlags();
      if (this.sessionReplayRecorder) {
        this.sessionReplayRecorder.onPageChange();
      }
    }
    // Cleanup
    cleanup() {
      if (this.sessionReplayRecorder) {
        this.sessionReplayRecorder.cleanup();
      }
    }
  };

  // ../../../node_modules/.pnpm/web-vitals@5.1.0/node_modules/web-vitals/dist/web-vitals.js
  var e = -1;
  var t = (t2) => {
    addEventListener("pageshow", ((n2) => {
      n2.persisted && (e = n2.timeStamp, t2(n2));
    }), true);
  };
  var n = (e2, t2, n2, i2) => {
    let s2, o2;
    return (r2) => {
      t2.value >= 0 && (r2 || i2) && (o2 = t2.value - (s2 ?? 0), (o2 || void 0 === s2) && (s2 = t2.value, t2.delta = o2, t2.rating = ((e3, t3) => e3 > t3[1] ? "poor" : e3 > t3[0] ? "needs-improvement" : "good")(t2.value, n2), e2(t2)));
    };
  };
  var i = (e2) => {
    requestAnimationFrame((() => requestAnimationFrame((() => e2()))));
  };
  var s = () => {
    const e2 = performance.getEntriesByType("navigation")[0];
    if (e2 && e2.responseStart > 0 && e2.responseStart < performance.now()) return e2;
  };
  var o = () => {
    const e2 = s();
    return e2?.activationStart ?? 0;
  };
  var r = (t2, n2 = -1) => {
    const i2 = s();
    let r2 = "navigate";
    e >= 0 ? r2 = "back-forward-cache" : i2 && (document.prerendering || o() > 0 ? r2 = "prerender" : document.wasDiscarded ? r2 = "restore" : i2.type && (r2 = i2.type.replace(/_/g, "-")));
    return { name: t2, value: n2, rating: "good", delta: 0, entries: [], id: `v5-${Date.now()}-${Math.floor(8999999999999 * Math.random()) + 1e12}`, navigationType: r2 };
  };
  var c = /* @__PURE__ */ new WeakMap();
  function a(e2, t2) {
    return c.get(e2) || c.set(e2, new t2()), c.get(e2);
  }
  var d = class {
    constructor() {
      __publicField(this, "t");
      __publicField(this, "i", 0);
      __publicField(this, "o", []);
    }
    h(e2) {
      if (e2.hadRecentInput) return;
      const t2 = this.o[0], n2 = this.o.at(-1);
      this.i && t2 && n2 && e2.startTime - n2.startTime < 1e3 && e2.startTime - t2.startTime < 5e3 ? (this.i += e2.value, this.o.push(e2)) : (this.i = e2.value, this.o = [e2]), this.t?.(e2);
    }
  };
  var h = (e2, t2, n2 = {}) => {
    try {
      if (PerformanceObserver.supportedEntryTypes.includes(e2)) {
        const i2 = new PerformanceObserver(((e3) => {
          Promise.resolve().then((() => {
            t2(e3.getEntries());
          }));
        }));
        return i2.observe({ type: e2, buffered: true, ...n2 }), i2;
      }
    } catch {
    }
  };
  var f = (e2) => {
    let t2 = false;
    return () => {
      t2 || (e2(), t2 = true);
    };
  };
  var u = -1;
  var l = /* @__PURE__ */ new Set();
  var m = () => "hidden" !== document.visibilityState || document.prerendering ? 1 / 0 : 0;
  var p = (e2) => {
    if ("hidden" === document.visibilityState) {
      if ("visibilitychange" === e2.type) for (const e3 of l) e3();
      isFinite(u) || (u = "visibilitychange" === e2.type ? e2.timeStamp : 0, removeEventListener("prerenderingchange", p, true));
    }
  };
  var v = () => {
    if (u < 0) {
      const e2 = o(), n2 = document.prerendering ? void 0 : globalThis.performance.getEntriesByType("visibility-state").filter(((t2) => "hidden" === t2.name && t2.startTime > e2))[0]?.startTime;
      u = n2 ?? m(), addEventListener("visibilitychange", p, true), addEventListener("prerenderingchange", p, true), t((() => {
        setTimeout((() => {
          u = m();
        }));
      }));
    }
    return { get firstHiddenTime() {
      return u;
    }, onHidden(e2) {
      l.add(e2);
    } };
  };
  var g = (e2) => {
    document.prerendering ? addEventListener("prerenderingchange", (() => e2()), true) : e2();
  };
  var y = [1800, 3e3];
  var E = (e2, s2 = {}) => {
    g((() => {
      const c2 = v();
      let a2, d2 = r("FCP");
      const f2 = h("paint", ((e3) => {
        for (const t2 of e3) "first-contentful-paint" === t2.name && (f2.disconnect(), t2.startTime < c2.firstHiddenTime && (d2.value = Math.max(t2.startTime - o(), 0), d2.entries.push(t2), a2(true)));
      }));
      f2 && (a2 = n(e2, d2, y, s2.reportAllChanges), t(((t2) => {
        d2 = r("FCP"), a2 = n(e2, d2, y, s2.reportAllChanges), i((() => {
          d2.value = performance.now() - t2.timeStamp, a2(true);
        }));
      })));
    }));
  };
  var b = [0.1, 0.25];
  var L = (e2, s2 = {}) => {
    const o2 = v();
    E(f((() => {
      let c2, f2 = r("CLS", 0);
      const u2 = a(s2, d), l2 = (e3) => {
        for (const t2 of e3) u2.h(t2);
        u2.i > f2.value && (f2.value = u2.i, f2.entries = u2.o, c2());
      }, m2 = h("layout-shift", l2);
      m2 && (c2 = n(e2, f2, b, s2.reportAllChanges), o2.onHidden((() => {
        l2(m2.takeRecords()), c2(true);
      })), t((() => {
        u2.i = 0, f2 = r("CLS", 0), c2 = n(e2, f2, b, s2.reportAllChanges), i((() => c2()));
      })), setTimeout(c2));
    })));
  };
  var P = 0;
  var T = 1 / 0;
  var _ = 0;
  var M = (e2) => {
    for (const t2 of e2) t2.interactionId && (T = Math.min(T, t2.interactionId), _ = Math.max(_, t2.interactionId), P = _ ? (_ - T) / 7 + 1 : 0);
  };
  var w;
  var C = () => w ? P : performance.interactionCount ?? 0;
  var I = () => {
    "interactionCount" in performance || w || (w = h("event", M, { type: "event", buffered: true, durationThreshold: 0 }));
  };
  var F = 0;
  var k = class {
    constructor() {
      __publicField(this, "u", []);
      __publicField(this, "l", /* @__PURE__ */ new Map());
      __publicField(this, "m");
      __publicField(this, "p");
    }
    v() {
      F = C(), this.u.length = 0, this.l.clear();
    }
    L() {
      const e2 = Math.min(this.u.length - 1, Math.floor((C() - F) / 50));
      return this.u[e2];
    }
    h(e2) {
      if (this.m?.(e2), !e2.interactionId && "first-input" !== e2.entryType) return;
      const t2 = this.u.at(-1);
      let n2 = this.l.get(e2.interactionId);
      if (n2 || this.u.length < 10 || e2.duration > t2.P) {
        if (n2 ? e2.duration > n2.P ? (n2.entries = [e2], n2.P = e2.duration) : e2.duration === n2.P && e2.startTime === n2.entries[0].startTime && n2.entries.push(e2) : (n2 = { id: e2.interactionId, entries: [e2], P: e2.duration }, this.l.set(n2.id, n2), this.u.push(n2)), this.u.sort(((e3, t3) => t3.P - e3.P)), this.u.length > 10) {
          const e3 = this.u.splice(10);
          for (const t3 of e3) this.l.delete(t3.id);
        }
        this.p?.(n2);
      }
    }
  };
  var A = (e2) => {
    const t2 = globalThis.requestIdleCallback || setTimeout;
    "hidden" === document.visibilityState ? e2() : (e2 = f(e2), addEventListener("visibilitychange", e2, { once: true, capture: true }), t2((() => {
      e2(), removeEventListener("visibilitychange", e2, { capture: true });
    })));
  };
  var B = [200, 500];
  var S = (e2, i2 = {}) => {
    if (!globalThis.PerformanceEventTiming || !("interactionId" in PerformanceEventTiming.prototype)) return;
    const s2 = v();
    g((() => {
      I();
      let o2, c2 = r("INP");
      const d2 = a(i2, k), f2 = (e3) => {
        A((() => {
          for (const t3 of e3) d2.h(t3);
          const t2 = d2.L();
          t2 && t2.P !== c2.value && (c2.value = t2.P, c2.entries = t2.entries, o2());
        }));
      }, u2 = h("event", f2, { durationThreshold: i2.durationThreshold ?? 40 });
      o2 = n(e2, c2, B, i2.reportAllChanges), u2 && (u2.observe({ type: "first-input", buffered: true }), s2.onHidden((() => {
        f2(u2.takeRecords()), o2(true);
      })), t((() => {
        d2.v(), c2 = r("INP"), o2 = n(e2, c2, B, i2.reportAllChanges);
      })));
    }));
  };
  var N = class {
    constructor() {
      __publicField(this, "m");
    }
    h(e2) {
      this.m?.(e2);
    }
  };
  var q = [2500, 4e3];
  var x = (e2, s2 = {}) => {
    g((() => {
      const c2 = v();
      let d2, u2 = r("LCP");
      const l2 = a(s2, N), m2 = (e3) => {
        s2.reportAllChanges || (e3 = e3.slice(-1));
        for (const t2 of e3) l2.h(t2), t2.startTime < c2.firstHiddenTime && (u2.value = Math.max(t2.startTime - o(), 0), u2.entries = [t2], d2());
      }, p2 = h("largest-contentful-paint", m2);
      if (p2) {
        d2 = n(e2, u2, q, s2.reportAllChanges);
        const o2 = f((() => {
          m2(p2.takeRecords()), p2.disconnect(), d2(true);
        })), c3 = (e3) => {
          e3.isTrusted && (A(o2), removeEventListener(e3.type, c3, { capture: true }));
        };
        for (const e3 of ["keydown", "click", "visibilitychange"]) addEventListener(e3, c3, { capture: true });
        t(((t2) => {
          u2 = r("LCP"), d2 = n(e2, u2, q, s2.reportAllChanges), i((() => {
            u2.value = performance.now() - t2.timeStamp, d2(true);
          }));
        }));
      }
    }));
  };
  var H = [800, 1800];
  var O = (e2) => {
    document.prerendering ? g((() => O(e2))) : "complete" !== document.readyState ? addEventListener("load", (() => O(e2)), true) : setTimeout(e2);
  };
  var $ = (e2, i2 = {}) => {
    let c2 = r("TTFB"), a2 = n(e2, c2, H, i2.reportAllChanges);
    O((() => {
      const d2 = s();
      d2 && (c2.value = Math.max(d2.responseStart - o(), 0), c2.entries = [d2], a2(true), t((() => {
        c2 = r("TTFB", 0), a2 = n(e2, c2, H, i2.reportAllChanges), a2(true);
      })));
    }));
  };

  // webVitals.ts
  var WebVitalsCollector = class {
    constructor(onReady) {
      this.data = {
        lcp: null,
        cls: null,
        inp: null,
        fcp: null,
        ttfb: null
      };
      this.sent = false;
      this.timeout = null;
      this.onReadyCallback = null;
      this.onReadyCallback = onReady;
    }
    initialize() {
      try {
        x(this.collectMetric.bind(this));
        L(this.collectMetric.bind(this));
        S(this.collectMetric.bind(this));
        E(this.collectMetric.bind(this));
        $(this.collectMetric.bind(this));
        this.timeout = setTimeout(() => {
          if (!this.sent) {
            this.sendData();
          }
        }, 2e4);
        window.addEventListener("beforeunload", () => {
          if (!this.sent) {
            this.sendData();
          }
        });
      } catch (e2) {
        console.warn("Error initializing web vitals tracking:", e2);
      }
    }
    collectMetric(metric) {
      if (this.sent) return;
      const metricName = metric.name.toLowerCase();
      this.data[metricName] = metric.value;
      const allCollected = Object.values(this.data).every((value) => value !== null);
      if (allCollected) {
        this.sendData();
      }
    }
    sendData() {
      if (this.sent) return;
      this.sent = true;
      if (this.timeout) {
        clearTimeout(this.timeout);
        this.timeout = null;
      }
      if (this.onReadyCallback) {
        this.onReadyCallback(this.data);
      }
    }
    getData() {
      return { ...this.data };
    }
  };

  // clickTracking.ts
  var CLICK_THROTTLE_MS = 1e3;
  var ClickTrackingManager = class {
    constructor(tracker, config) {
      this.lastClickAt = /* @__PURE__ */ new WeakMap();
      this.tracker = tracker;
      this.config = config;
    }
    initialize() {
      document.addEventListener("click", this.handleClick.bind(this), true);
    }
    handleClick(event) {
      const target = event.target;
      if (this.config.trackButtonClicks && this.isButton(target)) {
        this.trackButtonClick(target);
      }
    }
    isButton(element) {
      if (element.tagName === "BUTTON") return true;
      if (element.getAttribute("role") === "button") return true;
      if (element.tagName === "INPUT") {
        const type = element.type?.toLowerCase();
        if (type === "submit" || type === "button") return true;
      }
      let parent = element.parentElement;
      let depth = 0;
      while (parent && depth < 3) {
        if (parent.tagName === "BUTTON") return true;
        if (parent.getAttribute("role") === "button") return true;
        parent = parent.parentElement;
        depth++;
      }
      return false;
    }
    trackButtonClick(element) {
      const buttonElement = this.findButton(element);
      if (!buttonElement) return;
      if (buttonElement.hasAttribute("data-rybbit-event")) return;
      const now = Date.now();
      const lastAt = this.lastClickAt.get(buttonElement);
      if (lastAt !== void 0 && now - lastAt < CLICK_THROTTLE_MS) return;
      this.lastClickAt.set(buttonElement, now);
      const properties = {
        text: this.getElementText(buttonElement),
        ...this.extractDataAttributes(buttonElement)
      };
      this.tracker.trackButtonClick(properties);
    }
    extractDataAttributes(element) {
      const attrs = {};
      for (const attr of element.attributes) {
        if (attr.name.startsWith("data-rybbit-prop-")) {
          const key = attr.name.replace("data-rybbit-prop-", "");
          attrs[key] = attr.value;
        }
      }
      return attrs;
    }
    findButton(element) {
      if (element.tagName === "BUTTON") return element;
      if (element.getAttribute("role") === "button") return element;
      if (element.tagName === "INPUT") {
        const type = element.type?.toLowerCase();
        if (type === "submit" || type === "button") return element;
      }
      let parent = element.parentElement;
      let depth = 0;
      while (parent && depth < 3) {
        if (parent.tagName === "BUTTON") return parent;
        if (parent.getAttribute("role") === "button") return parent;
        parent = parent.parentElement;
        depth++;
      }
      return null;
    }
    getElementText(element) {
      const text = element.textContent?.trim().substring(0, 100);
      if (text) return text;
      const ariaLabel = element.getAttribute("aria-label")?.trim().substring(0, 100);
      if (ariaLabel) return ariaLabel;
      if (element.tagName === "INPUT") {
        const value = element.value?.trim().substring(0, 100);
        if (value) return value;
      }
      const title = element.getAttribute("title")?.trim().substring(0, 100);
      if (title) return title;
      return void 0;
    }
    cleanup() {
      document.removeEventListener("click", this.handleClick.bind(this), true);
    }
  };

  // copyTracking.ts
  var CopyTrackingManager = class {
    constructor(tracker) {
      this.tracker = tracker;
    }
    initialize() {
      document.addEventListener("copy", this.handleCopy.bind(this));
    }
    handleCopy() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const text = selection.toString();
      const textLength = text.length;
      if (textLength === 0) return;
      const anchorNode = selection.anchorNode;
      const sourceElement = anchorNode instanceof HTMLElement ? anchorNode : anchorNode?.parentElement;
      if (!sourceElement) return;
      const properties = {
        text: text.substring(0, 500),
        ...textLength > 500 && { textLength },
        sourceElement: sourceElement.tagName.toLowerCase()
      };
      this.tracker.trackCopy(properties);
    }
    cleanup() {
      document.removeEventListener("copy", this.handleCopy.bind(this));
    }
  };

  // formTracking.ts
  var FormTrackingManager = class {
    constructor(tracker, config) {
      this.tracker = tracker;
      this.config = config;
      this.boundHandleSubmit = this.handleSubmit.bind(this);
      this.boundHandleChange = this.handleChange.bind(this);
    }
    initialize() {
      document.addEventListener("submit", this.boundHandleSubmit, true);
      document.addEventListener("change", this.boundHandleChange, true);
    }
    cleanup() {
      document.removeEventListener("submit", this.boundHandleSubmit, true);
      document.removeEventListener("change", this.boundHandleChange, true);
    }
    handleSubmit(event) {
      const form = event.target;
      if (form.tagName !== "FORM") return;
      const properties = {
        formId: form.id || "",
        formName: form.name || "",
        formAction: form.action || "",
        method: (form.method || "get").toUpperCase(),
        fieldCount: form.elements.length,
        ariaLabel: form.getAttribute("aria-label") || void 0,
        ...this.extractDataAttributes(form)
      };
      this.tracker.trackFormSubmit(properties);
    }
    handleChange(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const tagName = target.tagName.toUpperCase();
      if (!["INPUT", "SELECT", "TEXTAREA"].includes(tagName)) return;
      if (target.disabled) return;
      if (target.readOnly) return;
      if (tagName === "INPUT") {
        const inputType = target.type?.toLowerCase();
        if (inputType === "hidden" || inputType === "password") return;
      }
      const inputName = target.name || target.id || target.getAttribute("aria-label") || target.placeholder || "";
      const properties = {
        element: tagName.toLowerCase(),
        inputType: tagName === "INPUT" ? target.type?.toLowerCase() : void 0,
        inputName,
        formId: target.form?.id || void 0,
        formName: target.form?.name || void 0,
        ...this.extractDataAttributes(target)
      };
      this.tracker.trackInputChange(properties);
    }
    extractDataAttributes(element) {
      const attrs = {};
      for (const attr of element.attributes) {
        if (attr.name.startsWith("data-rybbit-prop-")) {
          const key = attr.name.replace("data-rybbit-prop-", "");
          attrs[key] = attr.value;
        }
      }
      return attrs;
    }
  };

  // index.ts
  (async function() {
    const scriptTag = document.currentScript || document.querySelector('script[src*="/script.js"]');
    if (!scriptTag) {
      console.error("Could not find current script tag");
      return;
    }
    const namespace = scriptTag.getAttribute("data-namespace") || "rybbit";
    const optOutKey = `disable-${namespace}`;
    if (window.__RYBBIT_OPTOUT__ || localStorage.getItem(optOutKey) !== null) {
      window[namespace] = {
        pageview: () => {
        },
        event: () => {
        },
        error: () => {
        },
        trackOutbound: () => {
        },
        identify: () => {
        },
        setTraits: () => {
        },
        clearUserId: () => {
        },
        getUserId: () => null,
        flag: (_key, fallback) => fallback,
        flagPayload: (_key, fallback) => fallback,
        flags: () => ({}),
        flagPayloads: () => ({}),
        onReady: () => {
        },
        startSessionReplay: () => {
        },
        stopSessionReplay: () => {
        },
        isSessionReplayActive: () => false
      };
      return;
    }
    const earlyQueue = [];
    const queueMethod = (method) => (...args) => {
      earlyQueue.push([method, args]);
    };
    window[namespace] = {
      pageview: queueMethod("pageview"),
      event: queueMethod("event"),
      error: queueMethod("error"),
      trackOutbound: queueMethod("trackOutbound"),
      identify: queueMethod("identify"),
      setTraits: queueMethod("setTraits"),
      clearUserId: queueMethod("clearUserId"),
      getUserId: () => null,
      flag: (_key, fallback) => fallback,
      flagPayload: (_key, fallback) => fallback,
      flags: () => ({}),
      flagPayloads: () => ({}),
      onReady: queueMethod("onReady"),
      startSessionReplay: queueMethod("startSessionReplay"),
      stopSessionReplay: queueMethod("stopSessionReplay"),
      isSessionReplayActive: () => false
    };
    const config = await parseScriptConfig(scriptTag);
    if (!config) {
      return;
    }
    const tracker = new Tracker(config);
    if (config.enableWebVitals) {
      const webVitalsCollector = new WebVitalsCollector((vitals) => {
        tracker.trackWebVitals(vitals);
      });
      webVitalsCollector.initialize();
    }
    let clickManager = null;
    let copyManager = null;
    let formManager = null;
    if (config.trackButtonClicks) {
      clickManager = new ClickTrackingManager(tracker, config);
      clickManager.initialize();
    }
    if (config.trackCopy) {
      copyManager = new CopyTrackingManager(tracker);
      copyManager.initialize();
    }
    if (config.trackFormInteractions) {
      formManager = new FormTrackingManager(tracker, config);
      formManager.initialize();
    }
    if (config.trackErrors) {
      window.addEventListener("error", (event) => {
        tracker.trackError(event.error || new Error(event.message), {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno
        });
      });
      window.addEventListener("unhandledrejection", (event) => {
        const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
        tracker.trackError(error, {
          type: "unhandledrejection"
        });
      });
    }
    const trackPageview = () => tracker.trackPageviewIfUrlChanged();
    const debouncedTrackPageview = config.debounceDuration > 0 ? debounce(trackPageview, config.debounceDuration) : trackPageview;
    function setupEventListeners() {
      document.addEventListener("click", function(e2) {
        let target = e2.target;
        while (target && target !== document.documentElement) {
          if (target.hasAttribute("data-rybbit-event")) {
            const eventName = target.getAttribute("data-rybbit-event");
            if (eventName) {
              const properties = {};
              for (const attr of target.attributes) {
                if (attr.name.startsWith("data-rybbit-prop-")) {
                  const propName = attr.name.replace("data-rybbit-prop-", "");
                  properties[propName] = attr.value;
                }
              }
              tracker.trackEvent(eventName, properties);
            }
            break;
          }
          target = target.parentElement;
        }
        if (config.trackOutbound) {
          const link = e2.target.closest("a");
          if (link?.href && isOutboundLink(link.href)) {
            tracker.trackOutbound(link.href, link.innerText || link.textContent || "", link.target || "_self");
          }
        }
      });
      if (config.autoTrackSpa) {
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;
        history.pushState = function(...args) {
          originalPushState.apply(this, args);
          debouncedTrackPageview();
          tracker.onPageChange();
        };
        history.replaceState = function(...args) {
          originalReplaceState.apply(this, args);
          debouncedTrackPageview();
          tracker.onPageChange();
        };
        window.addEventListener("popstate", () => {
          debouncedTrackPageview();
          tracker.onPageChange();
        });
        window.addEventListener("hashchange", () => {
          debouncedTrackPageview();
          tracker.onPageChange();
        });
      }
    }
    window[config.namespace] = {
      pageview: () => tracker.trackPageview(),
      event: (name, properties = {}) => tracker.trackEvent(name, properties),
      error: (error, properties = {}) => tracker.trackError(error, properties),
      trackOutbound: (url, text = "", target = "_self") => tracker.trackOutbound(url, text, target),
      identify: (userId, traits) => tracker.identify(userId, traits),
      setTraits: (traits) => tracker.setTraits(traits),
      clearUserId: () => tracker.clearUserId(),
      getUserId: () => tracker.getUserId(),
      flag: (key, fallback) => tracker.getFeatureFlag(key, fallback),
      flagPayload: (key, fallback) => tracker.getFeatureFlagPayload(key, fallback),
      flags: () => tracker.getFeatureFlags(),
      flagPayloads: () => tracker.getFeatureFlagPayloads(),
      onReady: (callback) => callback(window[config.namespace]),
      startSessionReplay: () => tracker.startSessionReplay(),
      stopSessionReplay: () => tracker.stopSessionReplay(),
      isSessionReplayActive: () => tracker.isSessionReplayActive()
    };
    const api = window[config.namespace];
    for (const [method, args] of earlyQueue) {
      api[method](...args);
    }
    setupEventListeners();
    window.addEventListener("beforeunload", () => {
      clickManager?.cleanup();
      copyManager?.cleanup();
      tracker.cleanup();
    });
    if (config.autoTrackPageview) {
      tracker.trackPageview();
    }
  })();
})();
