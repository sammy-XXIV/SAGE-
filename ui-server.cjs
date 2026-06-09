const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');

const PORT = 8080;
const HTML = path.join(__dirname, 'ui', 'index.html');

async function fetchYahoo(sym) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`;
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const meta = json?.chart?.result?.[0]?.meta;
          resolve({ price: meta?.regularMarketPrice, prev: meta?.chartPreviousClose });
        } catch { reject(new Error('parse error')); }
      });
    });
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/prices') {
    const syms = ['TSLA', 'AMZN', 'NFLX', 'PLTR', 'AMD'];
    const result = {};
    await Promise.all(syms.map(async s => {
      try { result[s] = await fetchYahoo(s); } catch { result[s] = null; }
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  fs.createReadStream(HTML).pipe(res);
}).listen(PORT, () => {
  console.log(`SAGE DEX UI → http://localhost:${PORT}`);
});
