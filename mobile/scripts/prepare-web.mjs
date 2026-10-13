import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = resolve(mobile, '../web');
const output = join(mobile, 'app/build/generated/assets/mobile/web');
const source = join(web, 'dist-mobile/browser');

if (!process.argv.includes('--skip-build')) {
  const cli = join(web, 'node_modules/@angular/cli/bin/ng.js');
  if (!existsSync(cli)) {
    throw new Error('Instale as dependências em web: npm ci --ignore-scripts');
  }
  const result = spawnSync(process.execPath, [cli, 'run', 'simplevlogeditor:build-mobile:production'], {
    cwd: web, stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const indexPath = join(source, 'index.html');
if (!existsSync(indexPath)) throw new Error('Build mobile ausente. Execute npm run build:mobile em web.');
const html = readFileSync(indexPath, 'utf8');
if (!html.includes('</head>')) throw new Error('index.html não contém </head>.');

// Never remove a directory outside this project's generated assets.
const generated = resolve(mobile, 'app/build/generated/assets/mobile');
if (!resolve(output).startsWith(generated + sep)) throw new Error('Destino de assets inválido.');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(source, output, { recursive: true });
cpSync(join(mobile, 'scripts/mobile-bridge.js'), join(output, 'mobile-bridge.js'));
const mobileHtml = html.replace(/<link\b[^>]*href="https:\/\/fonts\.googleapis\.com[^>]*>/g,
  tag => tag.includes('crossorigin') ? tag : tag.replace('<link', '<link crossorigin="anonymous"'));
writeFileSync(join(output, 'index.html'), mobileHtml.replace('</head>',
  '<style>.download-menu{display:none!important}</style><script src="/mobile-bridge.js"></script></head>'));
console.log(`Aplicação web incorporada em ${output}`);
