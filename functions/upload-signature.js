const { createClient } = require('@supabase/supabase-js');
const { getBearerToken, verifySessionToken } = require('./auth-utils');

let supabase;

function initSupabase() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

function sanitizePart(value, fallback) {
  return String(value || fallback || 'user')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback || 'user';
}

exports.handler = async event => {
  if (!['POST', 'DELETE'].includes(event.httpMethod)) {
    return json(405, { success: false, error: 'Method not allowed' });
  }

  initSupabase();

  try {
    const actor = verifySessionToken(getBearerToken(event));
    const body = JSON.parse(event.body || '{}');

    if (event.httpMethod === 'DELETE') {
      const path = String(body.path || '');
      if (!path.startsWith('sig-')) {
        return json(400, { success: false, error: 'Invalid signature path' });
      }
      const actorPrefix = `sig-${sanitizePart(actor.username, 'user')}-`;
      if (actor.role !== 'admin' && !path.startsWith(actorPrefix)) {
        return json(403, { success: false, error: 'Permission denied' });
      }
      const { error } = await supabase.storage.from('signatures').remove([path]);
      if (error) return json(500, { success: false, error: error.message });
      return json(200, { success: true });
    }

    const username = sanitizePart(body.username, 'user');
    const originalName = String(body.fileName || 'signature.png');
    const contentType = String(body.contentType || 'image/png');
    const base64 = String(body.base64 || '');

    const canUpload = actor.role === 'admin' || actor.username === body.username;
    if (!canUpload) {
      return json(403, { success: false, error: 'Permission denied' });
    }
    if (!base64) {
      return json(400, { success: false, error: 'Missing file data' });
    }
    if (!contentType.startsWith('image/')) {
      return json(400, { success: false, error: 'Signature must be an image file' });
    }

    const extFromName = (originalName.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const extFromType = contentType.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png';
    const ext = extFromName || extFromType || 'png';
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 2 * 1024 * 1024) {
      return json(400, { success: false, error: 'Signature file is too large' });
    }
    const version = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const filePath = `sig-${username}-${version}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('signatures')
      .upload(filePath, buffer, {
        contentType,
        cacheControl: '31536000',
        upsert: false
      });

    if (uploadError) {
      return json(500, { success: false, error: uploadError.message });
    }

    const { data: { publicUrl } } = supabase.storage
      .from('signatures')
      .getPublicUrl(filePath);

    return json(200, { success: true, publicUrl, path: filePath });
  } catch (err) {
    return json(500, { success: false, error: err.message });
  }
};
