// Node 原生类型擦除拒绝 node_modules 中的 .ts；仅为本包的 Host 源码接入显式擦除。
// 必须先加载本模块，再用动态 import 加载 TS，静态模块图会在钩子注册之前解析。
import { registerHooks, stripTypeScriptTypes } from 'node:module';

const plugin = new URL('./dsh-plugin.ts', import.meta.url).href;
const library = new URL('../lib/', import.meta.url).href;

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:')) return nextLoad(url, context);
    const file = new URL(url);
    file.search = '';
    file.hash = '';
    const ownLibrary = file.href.startsWith(library)
      && !file.href.slice(library.length).split('/').includes('node_modules');
    if (!file.pathname.endsWith('.ts') || (file.href !== plugin && !ownLibrary)) {
      return nextLoad(url, context);
    }
    // 保留默认加载器的文件读取与模块 URL，只把本包 TS 作为擦除后的 ESM 交给 Node。
    const loaded = nextLoad(url, { ...context, format: 'module' });
    return {
      ...loaded,
      format: 'module',
      source: stripTypeScriptTypes(Buffer.from(loaded.source).toString('utf8'), { sourceUrl: url }),
    };
  },
});
