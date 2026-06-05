const fs = require('fs');
const vm = require('vm');
const L = fs.readFileSync(__dirname + '/register-server.js', 'utf8').split('\n');

// Find dashboard <script> start/end
const startIdx = L.findIndex(l => l.includes('<script>') && L.indexOf(l) > 2400);
const endIdx = L.findIndex((l, i) => i > startIdx && l.includes('</script>'));

const js = L.slice(startIdx + 1, endIdx).join('\n');
console.log('Dashboard JS lines:', endIdx - startIdx - 1);

try {
    new vm.Script(js);
    console.log('DASHBOARD JS OK');
} catch (e) {
    console.error('SYNTAX ERROR:', e.message);
    process.exitCode = 1;
}

// ID cross-check
const allSrc = L.join('\n');
const dashStart = allSrc.indexOf('function buildDashboardPage');
const dashEnd = allSrc.indexOf('\nfunction ', dashStart + 50);
const dashSeg = dashEnd > 0 ? allSrc.slice(dashStart, dashEnd) : allSrc.slice(dashStart);

const used = new Set();
let m; const re = /getElementById\(['"]([^'"]+)['"]\)/g;
while ((m = re.exec(dashSeg))) used.add(m[1]);

const have = new Set();
const re2 = /id="([^"]+)"/g;
while ((m = re2.exec(dashSeg))) have.add(m[1]);

const missing = [...used].filter(x => !have.has(x));
console.log('JS引用:', used.size, 'HTML定义:', have.size);
console.log('缺失:', missing.length ? missing.join(', ') : '无 ✅');
