# 项目约定

- 本项目是 vimls-go 的 coc.nvim 客户端。`src/index.ts` 负责扩展与语言客户端接入，`src/server.ts` 负责服务端二进制管理；语言解析与语义分析应在 vimls-go 中实现。
- 客户端命令及配置使用 `vimls.*`，传给服务端的配置使用 `vim.*`；保留 `configurationSection: 'vim'` 的同步约定。
- runtimepath 从 `workspace.env.runtimepath` 初始化，变更通过 `vimls/didChangeRuntimepath` 同步。
- 配置了 `vimls.command` 时使用自定义服务端。托管下载必须校验 SHA-256，失败时保留可用安装。
- `src/execute.ts` 中的 Vim9 执行需区分编辑器：Neovim 使用系统 Vim，路径由 `vimls.vimCommand` 指定。
- 集成测试通过 coc-test 加载 TypeScript 源码，需要真实 vimls 服务端：放在 `.test-bin/vimls`，或用 `VIMLS_TEST_BIN` 指定所在目录。提供 `npm run test:nvim` 和 `npm run test:vim`；下载测试使用本地 HTTP 夹具，不访问 GitHub。
- 每次修改完成后必须执行 `npm run build`，包括仅修改文档或配置的情况；构建失败应修复或明确报告。
