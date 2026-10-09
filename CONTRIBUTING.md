# 贡献指南 / Contributing

欢迎报告播放问题、来源解析错误或提交改进。

1. Fork 仓库，从新分支开始；不要把维护者的 KV/R2 配置用作自己的服务。
2. 运行 `npm test` 和 `npm run build`。本地画面预览可先运行 `npm run seed`，详见 README。
3. 修复行为问题时补上可复现的回归测试。界面改动附桌面/手机截图。
4. 提交 PR，说明问题、改动和已运行的验证。不要提交密钥、`.dev.vars`、缓存或生成音频。

报告问题请提供浏览器/系统、复现步骤、预期与实际行为；日志先去除凭据和个人信息。

Fork the repository, work on a branch, and run `npm test` and `npm run build`. Include regression coverage for behavioral fixes and screenshots for UI changes. Explain the problem and verification in your PR. Never commit credentials, local runtime data or generated audio.
