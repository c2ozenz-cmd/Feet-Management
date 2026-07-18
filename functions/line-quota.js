const fetch = require('node-fetch');

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_TIMEOUT_MS = parseInt(process.env.LINE_QUOTA_TIMEOUT_MS || '3500', 10);
const CACHE_TTL_MS = parseInt(process.env.LINE_QUOTA_CACHE_TTL_MS || '300000', 10);

let quotaCache = null;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  };
}

function isTimeoutError(err) {
  return /timed?out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(String(err?.message || err || ''));
}

function cacheAgeMs() {
  return quotaCache?.cachedAt ? Date.now() - quotaCache.cachedAt : null;
}

function cachedBody(stale = false, warning = '') {
  if (!quotaCache?.body) return null;
  return {
    ...quotaCache.body,
    cached: true,
    stale,
    cacheAgeSeconds: Math.round((cacheAgeMs() || 0) / 1000),
    warning
  };
}

async function lineGet(path) {
  const res = await fetch(`https://api.line.me${path}`, {
    method: 'GET',
    timeout: LINE_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message || `LINE API failed: ${res.status}`);
  }
  return body;
}

exports.handler = async event => {
  if (event.httpMethod !== 'GET') {
    return json(405, { success: false, message: 'Method not allowed' });
  }

  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    return json(500, { success: false, message: 'LINE_CHANNEL_ACCESS_TOKEN is not configured' });
  }

  const freshCache = cachedBody(false);
  if (freshCache && (cacheAgeMs() || 0) < CACHE_TTL_MS) {
    return json(200, freshCache);
  }

  try {
    const [quotaResult, consumptionResult] = await Promise.allSettled([
      lineGet('/v2/bot/message/quota'),
      lineGet('/v2/bot/message/quota/consumption')
    ]);

    const quota = quotaResult.status === 'fulfilled' ? quotaResult.value : null;
    const consumption = consumptionResult.status === 'fulfilled' ? consumptionResult.value : null;
    if (!quota && !consumption) {
      const firstError = quotaResult.reason || consumptionResult.reason;
      throw firstError;
    }

    const used = consumption ? Number(consumption.totalUsage || 0) : null;
    const hasQuotaLimit = !!quota;
    const isLimited = quota?.type === 'limited';
    const limit = isLimited ? Number(quota.value || 0) : null;
    const remaining = isLimited && used !== null ? Math.max(0, limit - used) : null;
    const warnings = [];
    if (!quota) warnings.push('LINE quota limit API is temporarily unavailable');
    if (!consumption) warnings.push('LINE quota consumption API is temporarily unavailable');

    const body = {
      success: true,
      type: hasQuotaLimit ? (isLimited ? 'limited' : 'unlimited') : 'unknown',
      used,
      limit,
      remaining,
      cached: false,
      partial: !quota || !consumption,
      warning: warnings.join('; '),
      raw: { quota, consumption }
    };
    if (!body.partial) {
      quotaCache = { cachedAt: Date.now(), body };
    }

    return json(200, body);
  } catch (err) {
    const staleCache = cachedBody(true, 'LINE quota API is temporarily unavailable');
    if (staleCache) return json(200, staleCache);

    const temporary = isTimeoutError(err);
    return json(200, {
      success: false,
      temporary,
      message: temporary
        ? 'เช็กโควต้า LINE ไม่สำเร็จชั่วคราว: LINE API ตอบช้า/timeout'
        : `เช็กโควต้า LINE ไม่สำเร็จ: ${err.message}`
    });
  }
};
