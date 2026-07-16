const { createClient } = require('@supabase/supabase-js');
const { createSessionToken } = require('./auth-utils');

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

exports.handler = async event => {
  if (event.httpMethod !== 'POST') {
    return json(405, { success: false, message: 'Method not allowed' });
  }

  initSupabase();

  try {
    const { username, password } = JSON.parse(event.body || '{}');
    if (!username || !password) {
      return json(400, { success: false, message: 'Missing username or password' });
    }

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('username', username)
      .eq('password', password)
      .single();

    if (error || !profile) {
      return json(401, { success: false, message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
    }
    if (profile.status !== 'active') {
      return json(403, { success: false, message: 'บัญชีนี้ถูกระงับการใช้งาน' });
    }

    const user = {
      id: profile.id,
      username: profile.username,
      name: profile.name,
      status: profile.status,
      role: profile.role,
      lineUserId: profile.line_user_id,
      signatureUrl: profile.signature_url
    };

    return json(200, {
      success: true,
      user,
      token: createSessionToken(user)
    });
  } catch (err) {
    return json(500, { success: false, message: err.message });
  }
};
