/**
 * Flowboard Bridge — Chrome Extension Background Service Worker
 *
 * Connects to local Python agent via WebSocket (agent runs WS server).
 * Captures Bearer token and proxies API calls through the browser context.
 */

const AGENT_WS_URL = 'ws://127.0.0.1:9223';
const CALLBACK_URL = 'http://127.0.0.1:8101/api/ext/callback';
const FLOW_API_BASE = 'https://aisandbox-pa.googleapis.com';
const FLOW_API_KEY = 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY';
const FLOW_TRPC_CREATE_PROJECT = 'https://labs.google/fx/api/trpc/project.createProject';
const FLOW_UPLOAD_IMAGE_URL = `${FLOW_API_BASE}/v1/flow/uploadImage`;
const FLOW_VIDEO_START_URL = `${FLOW_API_BASE}/v1/video:batchAsyncGenerateVideoStartImage`;
const FLOW_VIDEO_CHECK_URL = `${FLOW_API_BASE}/v1/video:batchCheckAsyncVideoGenerationStatus`;

let ws = null;
let flowKey = null;
let callbackSecret = null; // Auth secret received from agent on WS connect
let state = 'off'; // off | idle | running
let manualDisconnect = false;
let flowProjects = {};
let paygateTier = null;
let flowCredits = null;
let metrics = {
  tokenCapturedAt: null,
  requestCount: 0,
  successCount: 0,
  failedCount: 0,
  lastError: null,
};

const flowUrls = ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'];

function classifyUrl(url) {
  if (url.includes('batchGenerateImages')) return 'GEN_IMG';
  if (url.includes('batchAsyncGenerateVideo')) return 'GEN_VID';
  if (url.includes('batchCheckAsync')) return 'POLL';
  return 'API';
}

let requestLog = [];

function addRequestLog(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > 50) requestLog.pop();
  broadcastRequestLog();
}

function updateRequestLog(id, updates) {
  const entry = requestLog.find((e) => e.id === id);
  if (entry) Object.assign(entry, updates);
  broadcastRequestLog();
}

function broadcastRequestLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG_UPDATE', log: requestLog }).catch(() => { });
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'reconnect') connectToAgent();
  if (alarm.name === 'keepAlive') keepAlive();
});

async function init() {
  const data = await chrome.storage.local.get(['flowKey', 'metrics', 'callbackSecret', 'flowProjects']);
  if (data.flowKey) flowKey = data.flowKey;
  if (data.metrics) Object.assign(metrics, data.metrics);
  if (data.callbackSecret) callbackSecret = data.callbackSecret;
  if (data.flowProjects && typeof data.flowProjects === 'object') flowProjects = data.flowProjects;
  connectToAgent();
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details?.requestHeaders?.length) return;
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization',
    );
    const value = authHeader?.value || '';
    if (!/^Bearer\s+/i.test(value)) return;

    const token = value.replace(/^Bearer\s+/i, '').trim();
    // Flow normally sends ya29.* OAuth tokens; accept any non-trivial
    // bearer so we don't break when Google rotates the prefix.
    if (!token || token.length < 30) return;

    // Always update — even if same token string, refresh the timestamp
    const tokenChanged = flowKey !== token;
    flowKey = token;
    metrics.tokenCapturedAt = Date.now();
    chrome.storage.local.set({ flowKey, metrics });

    // Only emit on the WS when the token actually rotated. The listener
    // fires on EVERY outbound aisandbox-pa request — and the agent's
    // own poll loops generate dozens per minute. Re-sending the same
    // string each time pushed the agent into an effective infinite
    // /v1/credits refresh loop (one credits GET per poll). The agent
    // side has a defensive dedupe too, but quiet at the source first.
    if (tokenChanged) {
      resetFlowBillingState();
      console.log('[Flowboard] Bearer token captured');
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
      }
      // Resolve the user's identity (email/name/picture) once per token —
      // saves the popup + AccountPanel from showing "Connected via
      // extension" placeholders. The token already has the userinfo.email
      // + userinfo.profile scopes Flow needs anyway, so this is a free
      // call. Errors are non-fatal and silent.
      fetchAndPushUserInfo(token);
    }
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*'] },
  ['requestHeaders', 'extraHeaders'],
);

let cachedUserInfo = null;
let lastBillingFetchAt = 0;

function resetFlowBillingState() {
  flowCredits = null;
  paygateTier = null;
}

function sendFlowUserStatus(userInfo, loggedIn) {
  const payload = {
    type: 'flow_user_status',
    user: {
      loggedIn,
      email: userInfo?.email || undefined,
      name: userInfo?.name || undefined,
      avatar: userInfo?.picture || userInfo?.avatar || undefined,
      source: 'google-flow',
      accountId: userInfo?.id || userInfo?.sub || undefined,
      updatedAt: new Date().toISOString(),
    },
    credits: flowCredits,
    paygateTier,
    extensionPackage: {
      name: 'flowboard-bridge',
      version: '0.0.5',
    },
  };

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function fetchAndPushUserInfo(token) {
  try {
    const resp = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) {
      console.warn('[Flowboard] userinfo fetch returned', resp.status);
      return;
    }
    const info = await resp.json();
    // In-memory only — DO NOT persist to chrome.storage.local. PII
    // there is plaintext on disk and readable by other extensions
    // with the `storage` permission. Lifetime = service-worker
    // lifetime; rebuilt on next token rotation if the SW recycles.
    cachedUserInfo = info;
    console.log('[Flowboard] userinfo captured for', info?.email || '<no email>');
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'user_info', userInfo: info }));
    }
    sendFlowUserStatus(info, true);
    void fetchPaygateTier();
  } catch (e) {
    console.warn('[Flowboard] userinfo fetch failed:', e?.message || e);
  }
}

function connectToAgent() {
  if (manualDisconnect) return;
  if (ws?.readyState === WebSocket.CONNECTING) return;
  if (ws?.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(AGENT_WS_URL);
  } catch (e) {
    console.error('[Flowboard] WS connect error:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[Flowboard] Connected to agent');
    chrome.alarms.clear('reconnect');
    setState('idle');

    const tokenAge = flowKey && metrics.tokenCapturedAt
      ? Date.now() - metrics.tokenCapturedAt
      : null;

    ws.send(JSON.stringify({
      type: 'extension_ready',
      flowKeyPresent: !!flowKey,
      tokenAge,
    }));

    // Resend token immediately so agent can start without waiting for a capture
    if (flowKey) {
      ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
    }
    // Replay cached userinfo so the agent's AccountPanel populates on
    // reconnect without waiting for the next token rotation. If we
    // never resolved one yet but a token IS present, kick off a fetch.
    if (cachedUserInfo) {
      ws.send(JSON.stringify({ type: 'user_info', userInfo: cachedUserInfo }));
      sendFlowUserStatus(cachedUserInfo, true);
    } else if (flowKey) {
      fetchAndPushUserInfo(flowKey);
    } else {
      // No cached token — nudge the user by opening Flow so the
      // webRequest sniffer can capture the next Bearer header.
      captureTokenFromFlowTab();
    }

    if (flowKey) {
      void refreshPaygateTierIfStale(true);
    }
  };

  ws.onmessage = async ({ data }) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'callback_secret') {
        callbackSecret = msg.secret;
        chrome.storage.local.set({ callbackSecret: msg.secret });
        console.log('[Flowboard] Received callback secret');
      } else if (msg.type === 'pong') {
        // keepalive response — no-op
      } else if (msg.type === 'logout') {
        // Agent's /api/auth/logout invoked — drop in-memory identity
        // so the next reconnect picks up fresh credentials. Don't
        // touch chrome.storage (we don't persist identity there
        // anyway, but be explicit). The WS stays open; agent will
        // re-greet when the user logs back in.
        console.log('[Flowboard] logout requested by agent');
        cachedUserInfo = null;
        flowKey = null;
        resetFlowBillingState();
        sendFlowUserStatus(null, false);
      } else if (msg.type === 'please_resend_userinfo') {
        // Agent's /api/auth/scan asks us to re-fetch userinfo when
        // its own cache is empty (e.g. agent restarted, or user
        // clicked "Scan extension" before WS finished its first
        // round-trip). If we have a cached profile, replay it
        // immediately; otherwise refetch from Google's userinfo
        // endpoint with whatever Bearer token we currently hold.
        if (cachedUserInfo) {
          ws.send(JSON.stringify({ type: 'user_info', userInfo: cachedUserInfo }));
        } else if (flowKey) {
          fetchAndPushUserInfo(flowKey);
        } else {
          console.log('[Flowboard] please_resend_userinfo: no token captured yet');
        }
      } else if (msg.method === 'api_request') {
        await handleApiRequest(msg);
      } else if (msg.method === 'trpc_request') {
        await handleTrpcRequest(msg);
      } else if (msg.type === 'generate_job') {
        await handleGenerateJob(msg.job || msg);
      } else if (msg.method === 'get_status') {
        sendToAgent({
          id: msg.id,
          result: {
            state,
            flowKeyPresent: !!flowKey,
            manualDisconnect,
            tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
            metrics,
          },
        });
      }
    } catch (e) {
      console.error('[Flowboard] Message error:', e);
    }
  };

  ws.onclose = () => {
    setState('off');
    if (!manualDisconnect) scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error('[Flowboard] WS error:', e);
    metrics.lastError = 'WS_ERROR';
    chrome.storage.local.set({ metrics });
  };
}

function scheduleReconnect() {
  chrome.alarms.create('reconnect', { delayInMinutes: 0.083 }); // ~5 s
}

function keepAlive() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
    void refreshPaygateTierIfStale(false);
  } else {
    connectToAgent();
  }
}

/**
 * Route a message to the agent.
 * Responses (msg.id present) go via HTTP callback — immune to WS drops.
 * Falls back to WS on HTTP failure. Non-response messages use WS directly.
 */
function sendToAgent(msg) {
  if (msg.id) {
    fetch(CALLBACK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Callback-Secret': callbackSecret || '',
      },
      body: JSON.stringify(msg),
    }).catch(() => {
      // HTTP failed — fall back to WS
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });
    return;
  }
  // Non-response messages (ping, status, token_captured)
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

async function handleApiRequest(msg) {
  const { id, params } = msg;
  const { url, method, headers, body, captchaAction } = params || {};

  if (!url || !url.startsWith('https://aisandbox-pa.googleapis.com/')) {
    sendToAgent({ id, status: 400, error: 'INVALID_URL' });
    return;
  }

  setState('running');
  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;

  addRequestLog({
    id,
    type: classifyUrl(url),
    time: new Date().toISOString(),
    status: 'processing',
    url,
  });

  try {
    // Step 0: Fail fast if we have no bearer token. Avoids burning a reCAPTCHA
    // solve (rate-limited + single-use) only to discover later that we can't
    // send the request.
    if (!flowKey) {
      sendToAgent({ id, status: 503, error: 'NO_FLOW_KEY' });
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = 'NO_FLOW_KEY'; }
      chrome.storage.local.set({ metrics });
      updateRequestLog(id, { status: 'failed', error: 'NO_FLOW_KEY' });
      setState('idle');
      return;
    }

    // Step 1: Solve captcha if needed
    let captchaToken = null;
    if (captchaAction) {
      const captchaResult = await solveCaptcha(id, captchaAction);
      captchaToken = captchaResult?.token || null;
      if (!captchaToken) {
        const err = captchaResult?.error || 'CAPTCHA_FAILED';
        console.error(`[Flowboard] Captcha failed for ${captchaAction}: ${err}`);
        sendToAgent({ id, status: 403, error: `CAPTCHA_FAILED: ${err}` });
        if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `CAPTCHA_FAILED: ${err}`; }
        chrome.storage.local.set({ metrics });
        updateRequestLog(id, { status: 'failed', error: `CAPTCHA_FAILED: ${err}` });
        setState('idle');
        return;
      }
    }

    // Step 2: Inject captcha token into body clone if present
    let finalBody = body;
    if (captchaToken && finalBody) {
      finalBody = JSON.parse(JSON.stringify(finalBody)); // deep clone
      if (finalBody.clientContext?.recaptchaContext) {
        finalBody.clientContext.recaptchaContext.token = captchaToken;
      }
      if (finalBody.requests && Array.isArray(finalBody.requests)) {
        for (const req of finalBody.requests) {
          if (req.clientContext?.recaptchaContext) {
            req.clientContext.recaptchaContext.token = captchaToken;
          }
        }
      }
    }

    const fetchHeaders = { ...(headers || {}), authorization: `Bearer ${flowKey}` };

    const response = await fetch(url, {
      method: method || 'POST',
      headers: fetchHeaders,
      credentials: 'include',
      body: method === 'GET' ? undefined : JSON.stringify(finalBody),
    });

    const responseText = await response.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    sendToAgent({ id, status: response.status, data: responseData });

    if (response.ok) {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      updateRequestLog(id, { status: 'success', httpStatus: response.status });
    } else {
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `API_${response.status}`; }
      updateRequestLog(id, { status: 'failed', httpStatus: response.status, error: `API_${response.status}` });
    }
  } catch (e) {
    sendToAgent({ id, status: 500, error: e.message || 'API_REQUEST_FAILED' });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = e.message || 'API_REQUEST_FAILED'; }
    updateRequestLog(id, { status: 'failed', error: e.message || 'API_REQUEST_FAILED' });
  }

  chrome.storage.local.set({ metrics });
  setState('idle');
}

let _openingFlowTab = false;

const FLOW_URL = 'https://labs.google/fx/tools/flow';

/**
 * Open a Flow tab even when Chrome has zero windows. `chrome.tabs.create`
 * throws "No current window" in that state because it needs a window
 * context to attach to; `chrome.windows.create` spawns a fresh window
 * and tab in one call. Falls back through both paths so we recover from
 * "all-windows-closed but service-worker-still-alive" silently.
 */
async function openFlowTabResilient(active = false) {
  try {
    return await chrome.tabs.create({ url: FLOW_URL, active });
  } catch (e) {
    const msg = e?.message || '';
    if (!msg.includes('No current window')) throw e;
    console.log('[Flowboard] No Chrome window — spawning a fresh one for Flow');
    const win = await chrome.windows.create({
      url: FLOW_URL,
      focused: false,
      state: 'minimized',
    });
    return win.tabs?.[0] ?? null;
  }
}

async function captureTokenFromFlowTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
  });

  if (!tabs.length) {
    if (_openingFlowTab) return;
    _openingFlowTab = true;
    try {
      console.log('[Flowboard] No Flow tab — opening in background');
      await openFlowTabResilient(false);
    } catch (e) {
      console.error('[Flowboard] Failed to open Flow tab:', e);
    } finally {
      _openingFlowTab = false;
    }
    return;
  }

  try {
    // Trigger a credentialed request so the page re-issues an Authorization header
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => fetch('/fx/tools/flow', { credentials: 'include' }),
    });
    console.log('[Flowboard] Token refresh triggered on Flow tab');
  } catch (e) {
    console.error('[Flowboard] Token refresh failed:', e);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function readResponseBody(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function flowApiRequest(url, { method = 'POST', headers = {}, body = undefined, captchaAction = null } = {}) {
  if (!flowKey) return { error: 'NO_FLOW_KEY' };

  const fetchHeaders = {
    ...(headers || {}),
    authorization: `Bearer ${flowKey}`,
    origin: 'https://labs.google',
    referer: 'https://labs.google/',
  };

  if (captchaAction) {
    const captchaResult = await solveCaptcha(`flow-${Date.now()}`, captchaAction);
    if (!captchaResult?.token) {
      return { error: captchaResult?.error || 'CAPTCHA_FAILED' };
    }
    if (body && typeof body === 'object') {
      const cloned = JSON.parse(JSON.stringify(body));
      if (cloned.clientContext?.recaptchaContext) cloned.clientContext.recaptchaContext.token = captchaResult.token;
      if (Array.isArray(cloned.requests)) {
        for (const req of cloned.requests) {
          if (req?.clientContext?.recaptchaContext) req.clientContext.recaptchaContext.token = captchaResult.token;
        }
      }
      body = cloned;
    }
  }

  const response = await fetch(url, {
    method,
    headers: fetchHeaders,
    credentials: 'include',
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });

  return {
    status: response.status,
    data: await readResponseBody(response),
  };
}

async function flowTrpcRequest(url, { method = 'POST', headers = {}, body = undefined } = {}) {
  if (!flowKey) return { error: 'NO_FLOW_KEY' };

  const response = await fetch(url, {
    method,
    headers: {
      ...(headers || {}),
      authorization: `Bearer ${flowKey}`,
    },
    credentials: 'include',
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });

  return {
    status: response.status,
    data: await readResponseBody(response),
  };
}

function extractTrpcProjectId(resp) {
  return resp?.data?.result?.data?.json?.result?.projectId || null;
}

function extractOperationNames(resp) {
  const data = resp?.data;
  if (!data || typeof data !== 'object') return [];
  const out = [];
  const operations = Array.isArray(data.operations) ? data.operations : [];
  for (const op of operations) {
    const name = op?.operation?.name || op?.name;
    if (typeof name === 'string' && name) out.push(name);
  }
  if (out.length) return out;

  const workflows = Array.isArray(data.workflows) ? data.workflows : [];
  for (const wf of workflows) {
    if (typeof wf?.name === 'string' && wf.name) out.push(wf.name);
  }
  return out;
}

function extractVideoWorkflows(resp) {
  const data = resp?.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.workflows)) return [];
  return data.workflows
    .map((wf) => ({
      name: typeof wf?.name === 'string' ? wf.name : '',
      primary_media_id: wf?.metadata?.primaryMediaId,
    }))
    .filter((wf) => wf.name && typeof wf.primary_media_id === 'string' && wf.primary_media_id);
}

function extractVideoOperations(resp, requested) {
  const byName = {};
  const data = resp?.data;
  const ops = data && typeof data === 'object' && Array.isArray(data.operations) ? data.operations : [];
  for (const op of ops) {
    const inner = op?.operation && typeof op.operation === 'object' ? op.operation : op;
    const name = typeof inner?.name === 'string' ? inner.name : null;
    if (!name) continue;

    const meta = inner?.metadata && typeof inner.metadata === 'object' ? inner.metadata : {};
    const videoMeta = meta.video && typeof meta.video === 'object' ? meta.video : {};
    let mediaId = typeof videoMeta.mediaId === 'string' ? videoMeta.mediaId : null;
    const fifeUrl = typeof videoMeta.fifeUrl === 'string' ? videoMeta.fifeUrl : null;
    if (!mediaId && typeof fifeUrl === 'string') {
      const match = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(fifeUrl);
      if (match) mediaId = match[1];
    }

    const status = typeof op?.status === 'string' ? op.status : null;
    const innerErr = inner?.error && typeof inner.error === 'object' ? inner.error : null;
    const errMessage = innerErr ? (innerErr.message || innerErr.status || 'operation_failed') : null;
    const done = status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' || status === 'MEDIA_GENERATION_STATUS_FAILED' || Boolean(inner?.done) || Boolean(mediaId && fifeUrl);
    const mediaEntries = [];
    if (done && !errMessage && mediaId) {
      mediaEntries.push({ media_id: mediaId, url: fifeUrl, mediaType: 'video' });
    }

    byName[name] = {
      name,
      done,
      media_entries: mediaEntries,
      status,
      error: errMessage || (status === 'MEDIA_GENERATION_STATUS_FAILED' ? 'MEDIA_GENERATION_STATUS_FAILED' : null),
    };
  }

  return requested.map((name) => byName[name] || { name, done: false, media_entries: [] });
}

async function fetchPaygateTier() {
  if (!flowKey) return null;
  lastBillingFetchAt = Date.now();
  const resp = await fetch(`${FLOW_API_BASE}/v1/credits?key=${FLOW_API_KEY}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${flowKey}`,
      origin: 'https://labs.google',
      referer: 'https://labs.google/',
    },
    credentials: 'include',
  });
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  const tier = data?.userPaygateTier;
  const credits = typeof data?.credits === 'number' ? data.credits : null;
  flowCredits = credits;
  if (tier === 'PAYGATE_TIER_ONE' || tier === 'PAYGATE_TIER_TWO') {
    paygateTier = tier;
    if (cachedUserInfo || flowKey) {
      sendFlowUserStatus(cachedUserInfo, true);
    }
    return tier;
  }
  if (cachedUserInfo || flowKey) {
    sendFlowUserStatus(cachedUserInfo, Boolean(cachedUserInfo));
  }
  return null;
}

async function refreshPaygateTierIfStale(force = false) {
  if (!flowKey) return null;
  if (!force && Date.now() - lastBillingFetchAt < 5 * 60) return paygateTier;
  return fetchPaygateTier();
}

async function ensureFlowProject(localProjectId, localProjectName) {
  if (flowProjects[localProjectId]) return flowProjects[localProjectId];

  const title = (typeof localProjectName === 'string' && localProjectName.trim())
    ? localProjectName.trim()
    : `Flowboard ${localProjectId}`;
  const resp = await flowTrpcRequest(FLOW_TRPC_CREATE_PROJECT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: '*/*',
    },
    body: {
      json: {
        projectTitle: title,
        toolName: 'PINHOLE',
      },
    },
  });

  const projectId = extractTrpcProjectId(resp);
  if (!projectId) return null;

  flowProjects[localProjectId] = projectId;
  chrome.storage.local.set({ flowProjects });
  return projectId;
}

async function uploadLocalMediaToFlow(projectId, sourceUrl, fileName) {
  if (isLocalFileReference(sourceUrl)) {
    return { error: 'LOCAL_FILE_PATH_NOT_SUPPORTED', raw: { sourceUrl, fileName } };
  }

  const response = await fetch(sourceUrl, { credentials: 'include' });
  if (!response.ok) {
    return { error: `SOURCE_MEDIA_FETCH_${response.status}` };
  }

  const mime = response.headers.get('content-type') || 'application/octet-stream';
  const buffer = await response.arrayBuffer();
  const upload = await flowApiRequest(FLOW_UPLOAD_IMAGE_URL, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      accept: '*/*',
      origin: 'https://labs.google',
      referer: 'https://labs.google/',
    },
    body: {
      clientContext: {
        projectId: String(projectId),
        tool: 'PINHOLE',
      },
      fileName,
      imageBytes: arrayBufferToBase64(buffer),
      isHidden: false,
      isUserUploaded: true,
      mimeType: mime,
    },
  });

  const mediaId = upload?.data?.media?.name;
  if (typeof mediaId !== 'string' || !mediaId) {
    return { error: 'NO_MEDIA_ID_IN_UPLOAD_RESPONSE', raw: upload };
  }

  return { mediaId, raw: upload };
}

function pickVideoSource(job) {
  const upstream = Array.isArray(job?.upstream) ? job.upstream : [];
  const candidates = upstream.filter((item) => item && (item.kind === 'storyboard' || item.kind === 'image'));
  for (const item of candidates) {
    const mediaId = item?.output?.mediaId || item?.output?.posterMediaId || item?.output?.mediaIds?.[0] || item?.data?.mediaId;
    if (typeof mediaId !== 'string' || !mediaId) continue;
    const mediaUrl = pickSafeMediaUrl(item, mediaId);
    return { mediaId, mediaUrl, title: item?.title || item?.kind || 'source' };
  }
  return null;
}

function isLocalFileReference(value) {
  return typeof value === 'string' && (
    /^[a-zA-Z]:[\\/]/.test(value) ||
    /^file:\/\//i.test(value)
  );
}

function pickSafeMediaUrl(item, mediaId) {
  const candidates = [
    item?.output?.mediaUrl,
    item?.output?.videoUrl,
    item?.output?.posterUrl,
    item?.output?.reference,
    item?.data?.reference,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue;
    if (isLocalFileReference(candidate)) continue;
    if (candidate.startsWith('http://') || candidate.startsWith('https://') || candidate.startsWith('data:')) {
      return candidate;
    }
  }

  return mediaId ? `http://127.0.0.1:8101/media/${mediaId}` : '';
}

function resolveVideoModelKey(quality, tier) {
  const isFourK = quality === '4k';
  if (tier === 'PAYGATE_TIER_TWO') {
    return isFourK ? 'veo_3_1_i2v_s' : 'veo_3_1_i2v_s_fast_ultra';
  }
  return isFourK ? 'veo_3_1_i2v_s' : 'veo_3_1_i2v_s_fast';
}

function collectStoryboardRefs(job) {
  const upstream = Array.isArray(job?.upstream) ? job.upstream : [];
  const refs = [];
  for (const item of upstream) {
    if (!item || !['character', 'scene', 'image'].includes(item.kind)) continue;
    const mediaId = item?.output?.mediaId || item?.output?.posterMediaId || item?.output?.mediaIds?.[0] || item?.data?.mediaId;
    if (typeof mediaId !== 'string' || !mediaId) continue;
    const mediaUrl = pickSafeMediaUrl(item, mediaId);
    refs.push({ mediaId, mediaUrl, title: item?.title || item?.kind || 'source' });
  }
  return refs;
}

async function generateStoryboardWithGoogleFlow(job) {
  const refs = collectStoryboardRefs(job);
  if (refs.length < 2) {
    return { error: 'MISSING_REQUIRED_INPUTS' };
  }

  const remoteProjectId = await ensureFlowProject(job.projectId, job.projectName);
  if (!remoteProjectId) {
    return { error: 'FLOW_PROJECT_CREATE_FAILED' };
  }

  const uploadedRefs = [];
  for (const ref of refs.slice(0, 2)) {
    const uploaded = await uploadLocalMediaToFlow(remoteProjectId, ref.mediaUrl, `${job.id}-${ref.title}.png`);
    if (uploaded?.error) {
      return { error: uploaded.error, raw: uploaded.raw || null };
    }
    uploadedRefs.push(uploaded.mediaId);
  }

  const tier = paygateTier || (await fetchPaygateTier()) || 'PAYGATE_TIER_ONE';
  const prompt = job.prompt || '';
  const startResponse = await flowApiRequest(`${FLOW_API_BASE}/v1/projects/${remoteProjectId}/flowMedia:batchGenerateImages`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      accept: '*/*',
      origin: 'https://labs.google',
      referer: 'https://labs.google/',
    },
    captchaAction: 'IMAGE_GENERATION',
    body: {
      clientContext: {
        projectId: String(remoteProjectId),
        recaptchaContext: { applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB', token: '' },
        sessionId: `;${Date.now()}`,
        tool: 'PINHOLE',
        userPaygateTier: tier,
      },
      mediaGenerationContext: { batchId: crypto.randomUUID() },
      useNewMedia: true,
      requests: [
        {
          clientContext: {
            projectId: String(remoteProjectId),
            recaptchaContext: { applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB', token: '' },
            sessionId: `;${Date.now()}`,
            tool: 'PINHOLE',
            userPaygateTier: tier,
          },
          seed: Date.now() % 1000000,
          structuredPrompt: { parts: [{ text: `${prompt}\nStoryboard variant 1` }] },
          imageAspectRatio: 'IMAGE_ASPECT_RATIO_LANDSCAPE',
          imageModelName: 'GEM_PIX_2',
          imageInputs: uploadedRefs.map((mediaId) => ({ name: mediaId, imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE' })),
        },
        {
          clientContext: {
            projectId: String(remoteProjectId),
            recaptchaContext: { applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB', token: '' },
            sessionId: `;${Date.now() + 1}`,
            tool: 'PINHOLE',
            userPaygateTier: tier,
          },
          seed: (Date.now() + 1) % 1000000,
          structuredPrompt: { parts: [{ text: `${prompt}\nStoryboard variant 2` }] },
          imageAspectRatio: 'IMAGE_ASPECT_RATIO_LANDSCAPE',
          imageModelName: 'GEM_PIX_2',
          imageInputs: uploadedRefs.map((mediaId) => ({ name: mediaId, imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE' })),
        },
      ],
    },
  });

  if (startResponse?.error) {
    return { error: startResponse.error, raw: startResponse };
  }

  const mediaEntries = Array.isArray(startResponse?.data?.media) ? startResponse.data.media : [];
  const images = mediaEntries
    .map((entry) => {
      const mediaId = typeof entry?.name === 'string' ? entry.name : null;
      const imageUrl = entry?.image?.generatedImage?.fifeUrl || null;
      return mediaId ? { mediaId, imageUrl } : null;
    })
    .filter(Boolean);

  if (!images.length) {
    return { error: 'NO_MEDIA_RETURNED', raw: startResponse };
  }

  const mediaIds = images.map((item) => item.mediaId);
  const mediaUrls = images.map((item) => item.imageUrl).filter(Boolean);
  return {
    description: 'Storyboard đã được tạo bằng Google Flow.',
    prompt,
    mediaIds,
    mediaUrls,
    mediaId: mediaIds[0],
    mediaUrl: mediaUrls[0] || `http://127.0.0.1:8101/media/${mediaIds[0]}`,
    reference: mediaUrls[0] || `http://127.0.0.1:8101/media/${mediaIds[0]}`,
  };
}

async function generateVideoWithGoogleFlow(job) {
  const source = pickVideoSource(job);
  if (!source) {
    return { error: 'MISSING_STORYBOARD_SOURCE' };
  }

  const remoteProjectId = await ensureFlowProject(job.projectId, job.projectName);
  if (!remoteProjectId) {
    return { error: 'FLOW_PROJECT_CREATE_FAILED' };
  }

  const uploaded = await uploadLocalMediaToFlow(remoteProjectId, source.mediaUrl, `${job.id}-${job.nodeId}.svg`);
  if (uploaded?.error) {
    return { error: uploaded.error, raw: uploaded.raw || null };
  }

  const tier = paygateTier || (await fetchPaygateTier()) || 'PAYGATE_TIER_ONE';
  const aspectRatio = 'VIDEO_ASPECT_RATIO_LANDSCAPE';
  const modelKey = resolveVideoModelKey(job.videoQuality || '2k', tier);
  const prompt = job.prompt || '';
  const startResponse = await flowApiRequest(FLOW_VIDEO_START_URL, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      accept: '*/*',
      origin: 'https://labs.google',
      referer: 'https://labs.google/',
    },
    captchaAction: 'VIDEO_GENERATION',
    body: {
      clientContext: {
        projectId: String(remoteProjectId),
        recaptchaContext: { applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB', token: '' },
        sessionId: `;${Date.now()}`,
        tool: 'PINHOLE',
        userPaygateTier: tier,
      },
      mediaGenerationContext: { batchId: crypto.randomUUID() },
      requests: [
        {
          aspectRatio,
          seed: Date.now() % 1000000,
          textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
          videoModelKey: modelKey,
          startImage: { mediaId: uploaded.mediaId },
          metadata: { sceneId: crypto.randomUUID() },
        },
      ],
      useV2ModelConfig: true,
    },
  });

  if (startResponse?.error) {
    return { error: startResponse.error, raw: startResponse };
  }

  const operationNames = extractOperationNames(startResponse);
  const workflows = extractVideoWorkflows(startResponse);
  if (!operationNames.length) {
    return { error: 'NO_OPERATIONS_RETURNED', raw: startResponse };
  }

  const doneByName = Object.fromEntries(operationNames.map((name) => [name, false]));
  const entryByName = {};
  const opErrors = {};
  const maxCycles = 30;

  for (let i = 0; i < maxCycles && !Object.values(doneByName).every(Boolean); i++) {
    await sleep(10000);

    const pollOps = operationNames.filter((name) => !workflows.find((wf) => wf.name === name));
    const pollResult = pollOps.length
      ? await flowApiRequest(FLOW_VIDEO_CHECK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain;charset=UTF-8',
          accept: '*/*',
          origin: 'https://labs.google',
          referer: 'https://labs.google/',
        },
        body: {
          operations: pollOps.map((name) => ({ operation: { name } })),
        },
      })
      : { data: {} };

    if (pollResult?.error) continue;

    const polled = extractVideoOperations(pollResult, pollOps);
    for (const op of polled) {
      if (!op || typeof op.name !== 'string') continue;
      if (op.done) {
        doneByName[op.name] = true;
        if (Array.isArray(op.media_entries) && op.media_entries.length) {
          entryByName[op.name] = op.media_entries[0];
        }
        if (op.error) opErrors[op.name] = op.error;
      }
    }

    for (const wf of workflows) {
      if (!wf?.name || doneByName[wf.name]) continue;
      const mediaResp = await flowApiRequest(`${FLOW_API_BASE}/v1/media/${wf.primary_media_id}?clientContext.tool=PINHOLE`, {
        method: 'GET',
        headers: {
          accept: '*/*',
          origin: 'https://labs.google',
          referer: 'https://labs.google/',
        },
      });
      if (mediaResp?.error) continue;

      const videoBlock = mediaResp?.data?.video || {};
      const encoded = typeof videoBlock.encodedVideo === 'string' ? videoBlock.encodedVideo : null;
      const fifeUrl = typeof videoBlock.fifeUrl === 'string' ? videoBlock.fifeUrl : (typeof mediaResp?.data?.fifeUrl === 'string' ? mediaResp.data.fifeUrl : null);
      if (!encoded) continue;
      const bytes = Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0));
      const isMp4 = bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
      if (!isMp4) continue;
      doneByName[wf.name] = true;
      entryByName[wf.name] = {
        media_id: wf.primary_media_id,
        url: fifeUrl || `data:video/mp4;base64,${encoded}`,
        mediaType: 'video',
      };
    }
  }

  const firstName = operationNames[0];
  const entry = firstName ? entryByName[firstName] : null;
  if (!entry || !entry.url) {
    const err = Object.values(opErrors)[0] || 'timeout_waiting_video';
    return { error: err, raw: { startResponse, opErrors } };
  }

  return {
    description: 'Video đã được sinh bằng Google Flow.',
    prompt,
    videoUrl: entry.url,
    reference: entry.url,
  };
}

async function requestCaptchaFromTab(tabId, requestId, pageAction) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  } catch (error) {
    const msg = error?.message || '';
    const shouldInject =
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection');
    if (!shouldInject) throw error;

    // Inject content script and retry. Both the inject + re-send can
    // throw "No current window" / "No tab with id" if the tab dies in
    // between (Chrome aggressively discards background tabs). Surface
    // those verbatim so solveCaptcha's loop can move to the next
    // candidate instead of bubbling a confusing message to the user.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    await sleep(200);
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  }
}

/** Try to wake a discarded Flow tab so `sendMessage` can reach it.
 *  Chrome auto-discards backgrounded tabs to save memory; the tab still
 *  shows up in `chrome.tabs.query` but cross-context calls fail with
 *  "No current window" / "No tab with id". A reload re-hydrates it. */
async function reviveTabIfNeeded(tab) {
  if (!tab?.discarded) return tab;
  try {
    await chrome.tabs.reload(tab.id);
    await sleep(2500);
    const fresh = await chrome.tabs.get(tab.id);
    return fresh;
  } catch {
    return null;
  }
}

async function solveCaptcha(requestId, captchaAction) {
  const tabs = await chrome.tabs.query({ url: flowUrls });

  // No Flow tab at all — spawn one (handles "no Chrome window" via the
  // resilient helper).
  if (!tabs.length) {
    try {
      await openFlowTabResilient(false);
      await sleep(3000);
    } catch (e) {
      return { error: e.message || 'NO_FLOW_TAB' };
    }
  }

  // Try each Flow tab in turn — gracefully skip dead/discarded ones
  // instead of bubbling "No current window" up to the user. Re-query
  // because we might have just spawned a new one above.
  const candidates = await chrome.tabs.query({ url: flowUrls });
  const errors = [];
  for (const tab of candidates) {
    const live = await reviveTabIfNeeded(tab);
    if (!live) continue;
    try {
      const resp = await Promise.race([
        requestCaptchaFromTab(live.id, requestId, captchaAction),
        new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
      ]);
      return resp;
    } catch (e) {
      const msg = e?.message || '';
      errors.push(msg);
      // Tab evaporated mid-call (window closed, tab discarded again,
      // or page navigated away). Move on to the next candidate.
      if (
        msg.includes('No current window') ||
        msg.includes('No tab with id') ||
        msg.includes('Receiving end does not exist')
      ) {
        continue;
      }
      return { error: msg };
    }
  }

  // All candidates failed — last-ditch: spawn a fresh Flow tab and try
  // it once. This handles the case where every existing Flow tab was
  // in a closed window we couldn't recover from.
  try {
    await openFlowTabResilient(false);
    await sleep(3000);
    const fresh = await chrome.tabs.query({ url: flowUrls });
    const target = fresh.find((t) => !t.discarded) || fresh[0];
    if (!target) return { error: 'NO_FLOW_TAB' };
    const resp = await Promise.race([
      requestCaptchaFromTab(target.id, requestId, captchaAction),
      new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), 30000)),
    ]);
    return resp;
  } catch (e) {
    const msg = e?.message || (errors[0] ?? 'NO_FLOW_TAB');
    return { error: msg };
  }
}

async function handleTrpcRequest(msg) {
  const { id, params } = msg;
  const { url, method = 'POST', headers = {}, body } = params;

  // Tightly scoped to TRPC endpoints — prevents the agent from navigating to
  // arbitrary labs.google paths (e.g. /fx/api/trpc/account.deleteAccount would
  // also match /fx/api/trpc/ but account-level mutations should be gated server
  // side if they're ever needed).
  if (!url || !url.startsWith('https://labs.google/fx/api/trpc/')) {
    sendToAgent({ id, error: 'INVALID_TRPC_URL' });
    return;
  }

  setState('running');
  // TRPC calls are silent — don't add to request log, don't bump metrics

  const fetchHeaders = { 'Content-Type': 'application/json', ...headers };
  if (flowKey) {
    fetchHeaders['authorization'] = `Bearer ${flowKey}`;
  }

  try {
    const resp = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const data = await resp.json();
    sendToAgent({ id, status: resp.status, data });
  } catch (e) {
    console.error('[Flowboard] tRPC request failed:', e);
    sendToAgent({ id, error: e.message || 'TRPC_FETCH_FAILED' });
  } finally {
    setState('idle');
  }
}

function summarizeInput(job, kind) {
  const upstream = Array.isArray(job?.upstream) ? job.upstream : [];
  return upstream.find((item) => item.kind === kind) || null;
}

function promptOf(item) {
  return item?.data?.prompt || item?.output?.description || '';
}

function promptGuard() {
  return [
    'Ràng buộc mặc định: giữ đúng chủ thể gốc theo ảnh tham chiếu (khuôn mặt, hình dạng, màu sắc, chi tiết nhận diện, thiết kế chính).',
    'Chỉ thay đổi tư thế, góc máy, hành động, và bối cảnh nếu prompt yêu cầu.',
    'Nếu prompt không yêu cầu thay đổi, phải giữ nguyên chủ thể như ảnh gốc.',
    'Không trộn lẫn hay thay thế sang chủ thể khác.',
  ].join('\n');
}

function buildStoryboardOutput(job) {
  const character = summarizeInput(job, 'character');
  const scene = summarizeInput(job, 'scene');
  const clothes = summarizeInput(job, 'clothes');
  const accessory = summarizeInput(job, 'accessory');
  const action = summarizeInput(job, 'action');
  const style = summarizeInput(job, 'style');

  if (!character || !scene) {
    return { error: 'MISSING_REQUIRED_INPUTS', missing: ['character', 'scene'].filter((k) => !summarizeInput(job, k)) };
  }

  const inputs = {
    character: promptOf(character),
    scene: promptOf(scene),
    clothes: promptOf(clothes),
    accessory: promptOf(accessory),
    action: promptOf(action),
    style: promptOf(style),
  };

  const base = [
    `Tạo storyboard 4 khung.`,
    `Nhân vật: ${inputs.character}.`,
    `Cảnh: ${inputs.scene}.`,
    inputs.clothes ? `Quần áo: ${inputs.clothes}.` : null,
    inputs.accessory ? `Phụ kiện: ${inputs.accessory}.` : null,
    inputs.action ? `Hành động: ${inputs.action}.` : null,
    inputs.style ? `Phong cách: ${inputs.style}.` : null,
    promptGuard(),
    `Yêu cầu: Giữ nhân vật nhất quán, tạo 4 khung liên tiếp.`,
  ].filter(Boolean).join('\n');

  const frames = [
    { title: 'Frame 1', prompt: `${inputs.character} ở ${inputs.scene}.` },
    { title: 'Frame 2', prompt: `${inputs.character} bắt đầu ${inputs.action || 'di chuyển'}.` },
    { title: 'Frame 3', prompt: `${inputs.character} đang ${inputs.action || 'chuyển động'} trong ${inputs.scene}.` },
    { title: 'Frame 4', prompt: `${inputs.character} kết thúc cảnh.` },
  ].map((frame, index) => ({ ...frame, index: index + 1, prompt: `${base}\n${frame.prompt}` }));

  return {
    description: 'Storyboard 4 khung đã được tạo.',
    prompt: base,
    inputs,
    frames,
  };
}

function buildVideoOutput(job) {
  const storyboard = summarizeInput(job, 'storyboard');
  const storyboardOutput = storyboard?.output || job?.context?.storyboard?.output || {};
  const cast = Array.isArray(storyboardOutput.cast) && storyboardOutput.cast.length ? storyboardOutput.cast : [];
  const scenes = Array.isArray(storyboardOutput.scenes) && storyboardOutput.scenes.length ? storyboardOutput.scenes : [];
  const frames = (Array.isArray(storyboardOutput.frames) && storyboardOutput.frames.length)
    ? storyboardOutput.frames
    : Array.isArray(storyboardOutput.mediaUrls) && storyboardOutput.mediaUrls.length
      ? storyboardOutput.mediaUrls.slice(0, 4).map((src, index) => ({
        title: `Shot ${index + 1}`,
        prompt: src,
      }))
      : Array.isArray(storyboardOutput.mediaIds) && storyboardOutput.mediaIds.length
        ? storyboardOutput.mediaIds.slice(0, 4).map((id, index) => ({
          title: `Shot ${index + 1}`,
          prompt: id,
        }))
        : [];
  if (!frames.length) {
    return { error: 'MISSING_STORYBOARD_FRAMES' };
  }

  const duration = Number(job?.node?.data?.duration || job?.context?.node?.data?.duration || 8);
  return {
    description: 'Video đã được sinh từ storyboard.',
    frames,
    cast,
    scenes,
    duration,
    videoUrl: `/outputs/video/${job.id}.mp4`,
    downloadUrl: `/outputs/video/${job.id}.mp4`,
    prompt: `${promptGuard()}\n\n${job.prompt || ''}`.trim(),
  };
}

async function handleGenerateJob(job) {
  if (!job?.id) return;
  setState('running');

  try {
    let result;
    if (job.provider === 'google-flow' && job.kind === 'storyboard') {
      result = await generateStoryboardWithGoogleFlow(job);
    } else if (job.provider === 'google-flow' && job.kind === 'video') {
      result = await generateVideoWithGoogleFlow(job);
    } else if (job.kind === 'storyboard') {
      result = buildStoryboardOutput(job);
    } else if (job.kind === 'video') {
      result = buildVideoOutput(job);
    } else {
      const label = job.kind || 'node';
      result = {
        description: `${label} đã được tạo.`,
        prompt: job.prompt || '',
      };
    }

    if (result?.error) {
      sendToAgent({ id: job.id, status: 422, error: result.error, data: result });
    } else {
      sendToAgent({ id: job.id, status: 200, data: result });
    }
  } catch (e) {
    sendToAgent({ id: job.id, status: 500, error: e?.message || 'GENERATE_JOB_FAILED' });
  } finally {
    setState('idle');
  }
}

function setState(newState) {
  state = newState;
  const badges = { idle: '●', running: '▶', off: '○' };
  const colors = { idle: '#22c55e', running: '#f5b301', off: '#6b7280' };
  chrome.action.setBadgeText({ text: badges[newState] || '' });
  chrome.action.setBadgeBackgroundColor({ color: colors[newState] || '#000' });
  broadcastStatus();
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_PUSH' }).catch(() => { });
}

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'STATUS') {
    reply({
      connected: ws?.readyState === WebSocket.OPEN,
      flowKeyPresent: !!flowKey,
      manualDisconnect,
      tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
      metrics: {
        requestCount: metrics.requestCount,
        successCount: metrics.successCount,
        failedCount: metrics.failedCount,
        lastError: metrics.lastError,
      },
      state,
    });
    return true;
  }

  if (msg.type === 'DISCONNECT') {
    manualDisconnect = true;
    ws?.close();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'RECONNECT') {
    manualDisconnect = false;
    connectToAgent();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'REQUEST_LOG') {
    reply({ log: requestLog });
    return true;
  }

  if (msg.type === 'OPEN_FLOW_TAB') {
    chrome.tabs.query({
      url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
    }).then(async (tabs) => {
      try {
        if (tabs.length) {
          await chrome.tabs.update(tabs[0].id, { active: true });
          reply({ ok: true, tabId: tabs[0].id });
        } else {
          // User-initiated → focus the new window so they can see it.
          const tab = await openFlowTabResilient(true);
          reply({ ok: true, tabId: tab?.id });
        }
      } catch (e) {
        reply({ error: e.message });
      }
    }).catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'REFRESH_TOKEN') {
    captureTokenFromFlowTab()
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  return true;
});

console.log('[Flowboard] Extension loaded');
