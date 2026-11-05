const sharp = require('sharp');
const crypto = require('crypto');
const cache = new Map();

async function optimizePDFImage(buffer, label) {
  const key = `${label}:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const image = sharp(buffer, { limitInputPixels: 40000000 });
    const meta = await image.metadata();
    const limit = label === 'logo' ? 512 : 800;
    const output = await image.rotate().resize({ width: limit, height: limit, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    const result = output.length < buffer.length || Math.max(meta.width || 0, meta.height || 0) > limit ? output : buffer;
    if (cache.size >= 20) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return result;
  } catch (error) {
    console.warn('Image optimization failed; using original:', label, error.message);
    return buffer;
  }
}
module.exports = { optimizePDFImage };
