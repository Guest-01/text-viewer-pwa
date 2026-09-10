// 의존성 없는 정적 개발 서버. 기본은 localhost(127.0.0.1)에만 바인딩한다.
// 사용: node server.js          로컬 전용 (기본)
//       node server.js --lan    LAN의 모든 인터페이스(0.0.0.0)에 공개
//       HOST=0.0.0.0 node server.js   환경변수로도 공개 가능
//       PORT 환경변수로 포트 변경 가능 (기본 8080)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;
const LAN = process.argv.includes('--lan') || process.env.LAN === '1';
const HOST = process.env.HOST || (LAN ? '0.0.0.0' : '127.0.0.1');
const EXPOSED = HOST === '0.0.0.0' || HOST === '::';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'Bad Request');
  }

  // Service Worker가 없는 환경(HTTP)에서 share_target POST가 오면 홈으로 돌려보낸다.
  if (req.method === 'POST' && pathname.endsWith('/share-target')) {
    return send(res, 303, '', { Location: '/' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed');
  }

  let filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) return send(res, 403, 'Forbidden');

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (err2, data) => {
      if (err2) return send(res, 404, 'Not Found: ' + pathname);
      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const headers = { 'Content-Type': type };
      // txt 파일은 브라우저에서 바로 열리지 않고 다운로드되도록 한다(모바일 테스트용).
      if (ext === '.txt' && url.searchParams.has('download')) {
        headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`;
      }
      send(res, 200, req.method === 'HEAD' ? '' : data, headers);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n텍스트 뷰어 개발 서버 실행 중 (${HOST}:${PORT})\n`);
  console.log(`  로컬:   http://localhost:${PORT}/`);
  if (EXPOSED) {
    const ifaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) {
          console.log(`  LAN:    http://${a.address}:${PORT}/   (${name})`);
        }
      }
    }
    console.log('\n같은 와이파이의 모바일 기기에서 LAN 주소로 접속하세요.');
    console.log('참고: HTTP(LAN IP)에서는 Service Worker와 홈 화면 설치가 동작하지 않습니다. README.md 참고.\n');
  } else {
    console.log('\n현재 localhost에서만 접근할 수 있습니다. LAN에 공개하려면 `npm run start:lan` 을 사용하세요.\n');
  }
});
