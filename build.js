const fs = require('fs');
const path = require('path');
require('dotenv').config();

const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR);
}

const PDFKIT_DATA_SRC = path.join(__dirname, 'node_modules', 'pdfkit', 'js', 'data');
const PDFKIT_DATA_DEST = path.join(__dirname, 'functions', 'data');

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`Warning: Directory "${src}" not found.`);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

copyDir(PDFKIT_DATA_SRC, PDFKIT_DATA_DEST);

// 1. Read entrypoint Index.html
let indexContent = fs.readFileSync('Index.html', 'utf8');

// 2. Compile includes using single-pass replace callback
const includeRegex = /<\?!=\s*include\('([^']+)'\);\s*\?>/g;

indexContent = indexContent.replace(includeRegex, (match, fileKey) => {
  let filename = `${fileKey}.html`;
  if (!fs.existsSync(filename)) {
    // case-insensitive fallback search
    const files = fs.readdirSync(__dirname);
    const found = files.find(f => f.toLowerCase() === filename.toLowerCase());
    if (found) filename = found;
  }

  if (fs.existsSync(filename)) {
    console.log(`Compining: ${filename}`);
    let fileContent = fs.readFileSync(filename, 'utf8');
    
    // If it's Js.html, prepend our compatibility bridge
    if (fileKey.toLowerCase() === 'js') {
      fileContent = `<script src="supabase-bridge.js"></script>\n` + fileContent;
    }
    return fileContent;
  } else {
    console.warn(`Warning: Include file "${filename}" not found.`);
    return `<!-- File ${filename} not found -->`;
  }
});

// 3. Inject Supabase JS SDK CDN and Client Credentials into Head
const supabaseSdkTag = `
  <!-- Supabase JS Client SDK -->
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script>
    window.SUPABASE_URL = "${process.env.SUPABASE_URL || ''}";
    window.SUPABASE_ANON_KEY = "${process.env.SUPABASE_ANON_KEY || ''}";
  </script>
`;

indexContent = indexContent.replace('</head>', `${supabaseSdkTag}\n</head>`);

// 4. Save compiled static index.html to public/
fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), indexContent, 'utf8');
console.log('Build completed: Compiled public/index.html successfully');
