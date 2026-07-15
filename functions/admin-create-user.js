const { createClient } = require('@supabase/supabase-js');

let supabase;
function initSupabase() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
}

exports.handler = async (event, context) => {
  initSupabase();
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { email, password, username, name, role } = JSON.parse(event.body);

    if (!email || !password || !username) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required parameters' }) };
    }

    // 1. Create user in Supabase Auth via Admin API
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
      user_metadata: {
        username: username,
        name: name || username,
        role: role || 'user'
      }
    });

    if (authErr) {
      throw authErr;
    }

    // Profiles trigger (on_auth_user_created) in schema will automatically create public.profiles row.
    // Let's return the created user ID
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, id: authData.user.id })
    };

  } catch (err) {
    console.error('Admin Create User Error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
