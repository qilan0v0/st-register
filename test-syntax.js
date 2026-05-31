// 简单的语法检查
import('./register-server.js').then(() => {
    console.log('语法检查通过');
    process.exit(0);
}).catch(err => {
    console.error('语法错误:', err);
    process.exit(1);
});
