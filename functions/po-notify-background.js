const { createClient } = require('@supabase/supabase-js');
const { verifySessionToken, getBearerToken } = require('./auth-utils');
const { createQueue } = require('./lib/po-notifications');

exports.handler = async event => {
  const actor = verifySessionToken(getBearerToken(event));
  const { id } = JSON.parse(event.body || '{}');
  if (event.httpMethod !== 'POST' || typeof id !== 'string' || actor.role !== 'po-notify-worker' || actor.id !== id) throw new Error('Unauthorized worker');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  await createQueue(db).processJob(id);
  return { statusCode: 200, body: '{}' };
};
