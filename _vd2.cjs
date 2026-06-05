const fs = require('fs');
const vm = require('vm');
const L = fs.readFileSync(__dirname + '/register-server.js', 'utf8').split('\n');
const js = L.slice(2625, 3178).join('\n');
console.log('Lines:', 3178 - 2625);

// Try to validate
try {
    new vm.Script(js);
    console.log('DASHBOARD JS OK');
} catch (e) {
    console.error('SYNTAX ERROR:', e.message);
    const m = e.stack.match(/<anonymous>:(\d+)/);
    if (m) {
        const el = parseInt(m[1]);
        const lines = js.split('\n');
        for (let j = Math.max(0, el - 5); j < Math.min(lines.length, el + 4); j++) {
            console.log((j === el - 1 ? '>>> ' : '    ') + (j + 1) + ': ' + (lines[j] || ''));
        }
    }
    process.exitCode = 1;
}

// Also scan for problematic patterns: raw newlines inside string literals
// (caused by \n in template literal producing real newlines in output JS)
for (let i = 0; i < L.length; i++) {
    const line = L[i];
    // look for \n inside single-quoted strings within the dashboard region (2625-3178)
    if (i >= 2625 && i <= 3178 && /'[^']*\n[^']*'/.test(line)) {
        console.log('WARNING: literal newline in single-quoted string at register-server.js line ' + (i + 1));
    }
}
