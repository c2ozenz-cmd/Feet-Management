const crypto = require('crypto');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

function getSecret() {
  return process.env.APP_SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
}

function base64UrlEncode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function base64UrlDecode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function sign(payload) {
  const secret = getSecret();
  if (!secret) throw new Error('Missing APP_SESSION_SECRET or SUPABASE_SERVICE_ROLE_KEY');
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function createSessionToken(user) {
  const payload = {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    exp: Date.now() + TOKEN_TTL_MS
  };
  const encoded = base64UrlEncode(payload);
  return `${encoded}.${sign(encoded)}`;
}

function verifySessionToken(token) {
  if (!token || !token.includes('.')) throw new Error('Missing session token');
  const [encoded, signature] = token.split('.');
  const expected = sign(encoded);
  const a = Buffer.from(signature || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid session token');
  }
  const payload = base64UrlDecode(encoded);
  if (!payload.exp || Date.now() > payload.exp) throw new Error('Session expired');
  return payload;
}

function getBearerToken(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

module.exports = {
  createSessionToken,
  verifySessionToken,
  getBearerToken
};
