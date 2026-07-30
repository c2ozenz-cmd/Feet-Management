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
  return String(value || fallback || 'asset')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback || 'asset';
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') {
    return json(405, { success: false, error: 'Method not allowed' });
  }

  initSupabase();

  try {
    const actor = verifySessionToken(getBearerToken(event));
    if (actor.role !== 'admin') {
      return json(403, { success: false, error: 'Permission denied' });
    }

    const body = JSON.parse(event.body || '{}');
    const assetType = sanitizePart(body.assetType, 'asset');
    if (!['logo', 'stamp'].includes(assetType)) {
      return json(400, { success: false, error: 'Invalid asset type' });
    }

    const originalName = String(body.fileName || `${assetType}.png`);
    const contentType = String(body.contentType || 'image/png');
    const base64 = String(body.base64 || '');

    if (!base64) {
      return json(400, { success: false, error: 'Missing file data' });
    }
    if (!contentType.startsWith('image/')) {
      return json(400, { success: false, error: 'File must be an image' });
    }

    const extFromName = (originalName.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const extFromType = contentType.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png';
    const ext = extFromName || extFromType || 'png';
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > 3 * 1024 * 1024) {
      return json(400, { success: false, error: 'Image file is too large' });
    }

    const version = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const filePath = `company/${assetType}-${version}.${ext}`;

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
