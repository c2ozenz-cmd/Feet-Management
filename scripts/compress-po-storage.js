// Originals stay on disk. Applying requires a verified report and an unchanged remote file.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const root = path.resolve(process.argv[3] || 'backups/pdf-compression-2026-11-05');
const bucket = db.storage.from('pdf-orders');

async function list() {
  const result = [];
  for (let offset = 0; ; offset += 500) {
    const response = await bucket.list('', { limit: 500, offset, sortBy: { column: 'name', order: 'asc' } });
    if (response.error) throw response.error;
    result.push(...response.data.filter(file => file.name.endsWith('.pdf') && path.basename(file.name) === file.name));
    if (response.data.length < 500) break;
  }
  return result;
}
async function download(name) {
  const response = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/authenticated/pdf-orders/${encodeURIComponent(name)}?verify=${crypto.randomUUID()}`, {
    headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, 'Cache-Control': 'no-cache' }, timeout: 30000
  });
  if (!response.ok) throw new Error(`Storage download ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
async function pool(rows, run, concurrency = 4) {
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < rows.length) await run(rows[next++]);
  }));
}
async function main() {
  fs.mkdirSync(path.join(root, 'originals'), { recursive: true });
  const manifestFile = path.join(root, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
  if (process.argv[2] === '--prepare') {
    let files = await list();
    if (process.argv.includes('--sample')) files = files.filter(file => ['PO_PO26110013.pdf', 'PO_PO26100112.pdf', 'PO_PO26070041.pdf'].includes(file.name));
    let finished = 0;
    await pool(files, async file => {
      const local = path.join(root, 'originals', file.name);
      if (manifest[file.name]) {
        if (!fs.existsSync(local) || hash(fs.readFileSync(local)) !== manifest[file.name].sha256) throw new Error('Backup mismatch: ' + file.name);
      } else {
        const buffer = await download(file.name);
        fs.writeFileSync(local, buffer, { flag: 'wx' });
        manifest[file.name] = { sha256: hash(buffer), bytes: buffer.length, updatedAt: file.updated_at, backedUpAt: new Date().toISOString() };
        fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
      }
      if (++finished % 50 === 0) console.log(JSON.stringify({ backedUp: finished, total: files.length }));
    });
    console.log(JSON.stringify({ root, backedUp: files.length, bytes: Object.values(manifest).reduce((sum, file) => sum + file.bytes, 0) }));
    return;
  }
  if (process.argv[2] !== '--apply') throw new Error('Use --prepare or --apply');
  const report = JSON.parse(fs.readFileSync(path.join(root, 'compression-report.json'), 'utf8'));
  const resultsFile = path.join(root, 'upload-results.json');
  const results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, 'utf8')) : {};
  const persist = () => fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  let finished = 0;
  await pool(Object.entries(report), async ([name, result]) => {
    if (results[name]?.success || result.status !== 'verified' || result.afterBytes >= result.beforeBytes * .9) return;
    try {
      const original = fs.readFileSync(path.join(root, 'originals', name));
      if (hash(original) !== manifest[name]?.sha256) throw new Error('Original backup checksum mismatch');
      const optimized = fs.readFileSync(path.join(root, 'optimized', name));
      if (hash(original) !== result.sourceSha256 || hash(optimized) !== result.optimizedSha256) throw new Error('Verified report checksum mismatch');
      const current = await download(name);
      if (hash(current) === hash(optimized)) {
        results[name] = { success: true, before: original.length, after: optimized.length, sha256: hash(optimized), completedAt: new Date().toISOString() };
        persist(); return;
      }
      if (hash(current) !== hash(original)) {
        results[name] = { success: false, skipped: true, reason: 'Remote changed since backup' }; persist(); return;
      }
      const upload = await bucket.upload(name, optimized, { upsert: true, contentType: 'application/pdf', cacheControl: '0' });
      if (upload.error) throw upload.error;
      const check = await download(name);
      if (hash(check) !== hash(optimized)) throw new Error('Uploaded checksum mismatch');
      results[name] = { success: true, before: original.length, after: optimized.length, sha256: hash(optimized), completedAt: new Date().toISOString() };
      persist();
    } catch (error) {
      results[name] = { success: false, error: error.message }; persist();
    }
    if (++finished % 50 === 0) console.log(JSON.stringify({ processed: finished }));
  }, 3);
  const successful = Object.values(results).filter(row => row.success);
  console.log(JSON.stringify({ uploaded: successful.length, failedOrSkipped: Object.values(results).filter(row => !row.success).length,
    beforeBytes: successful.reduce((sum, row) => sum + row.before, 0), afterBytes: successful.reduce((sum, row) => sum + row.after, 0), root }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
