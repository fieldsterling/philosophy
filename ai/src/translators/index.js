// 内置转译器注册表
// 新增内置转译器：在 src/translators/ 下新建文件（导出 { id, name, prompt }），
// 并在下方 require 与 BUILTIN 中登记即可；自定义转译器由用户上传到 COS，运行时动态读取。

const general = require('./general');
const math = require('./math');

const BUILTIN = {
  [general.id]: general,
  [math.id]: math
};

module.exports = {
  // 取内置转译器提示词，未命中返回 null
  get(id) {
    const t = BUILTIN[id];
    return t ? t.prompt : null;
  },
  // 内置转译器列表（供 /api/translators 合并自定义转译器返回）
  list() {
    return Object.values(BUILTIN).map((t) => ({ id: t.id, name: t.name, builtin: true }));
  }
};
