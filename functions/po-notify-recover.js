const { createClient } = require('@supabase/supabase-js');
const { createQueue } = require('./lib/po-notifications');

exports.config = { schedule: '*/5 * * * *' };
exports.handler = async () => {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const queue = createQueue(db);
  const jobs = (await queue.list()).filter(job => job.state !== 'done' && job.leaseUntil <= Date.now() && job.nextAt <= Date.now() && queue.retryable(job));
  for (let offset = 0; offset < Math.min(jobs.length, 12); offset += 4) {
    await Promise.all(jobs.slice(offset, offset + 4).map(job => queue.dispatch(job.id).catch(error => console.error('PO queue dispatch:', job.id, error.message))));
  }
  return { statusCode: 200, body: '{}' };
};
