const assert = require('node:assert/strict');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const { PDFDocument: PDFReader, PDFRawStream, PDFName } = require('pdf-lib');
const fs = require('fs');
const vm = require('vm');
const { createRequire } = require('module');
const path = require('path');
const { optimizePDFImage } = require('../functions/lib/pdf-image-optimizer');
(async () => {
  const source = await sharp({ create: { width: 1564, height: 1600, channels: 4, background: { r: 50, g: 100, b: 160, alpha: .8 } } }).png().toBuffer();
  const optimized = await optimizePDFImage(source, 'logo');
  const meta = await sharp(optimized).metadata();
  assert.ok(Math.max(meta.width, meta.height) <= 512);
  assert.ok(meta.hasAlpha, 'retain transparency');
  const small = await sharp({ create: { width: 144, height: 91, channels: 4, background: '#ffffff' } }).png().toBuffer();
  const smallMeta = await sharp(await optimizePDFImage(small, 'stamp')).metadata();
  assert.equal(smallMeta.width, 144, 'never enlarge signatures or stamps');
  const invalid = Buffer.from('invalid');
  assert.equal(await optimizePDFImage(invalid, 'logo'), invalid, 'failed optimization keeps the original');
  const file = path.resolve('functions/generate-pdf.js');
  const sandbox = { exports: {}, require: createRequire(file), process, console, Buffer, __dirname: path.dirname(file) };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nexports.testFitImage = fitImage;', sandbox);
  const doc = new PDFDocument();
  const chunks = [];
  const done = new Promise(resolve => { doc.on('data', data => chunks.push(data)); doc.on('end', () => resolve(Buffer.concat(chunks))); });
  sandbox.exports.testFitImage(doc, optimized, 20, 20, 80, 80);
  doc.addPage();
  sandbox.exports.testFitImage(doc, optimized, 20, 20, 80, 80);
  doc.end();
  const pdf = await PDFReader.load(await done);
  const images = pdf.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFRawStream
    && object.dict.get(PDFName.of('Subtype'))?.toString() === '/Image'
    && object.dict.get(PDFName.of('Width'))?.toString() === String(meta.width));
  assert.equal(images.length, 2, 'one shared colour image + alpha mask, rather than duplicates per page');
  console.log('PASS: bounded dimensions, transparent logos, no upscaling, fallback on invalid image and image reuse across pages');
})().catch(error => { console.error(error); process.exitCode = 1; });
