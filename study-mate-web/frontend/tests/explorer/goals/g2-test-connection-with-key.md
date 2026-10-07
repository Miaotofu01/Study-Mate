id: g2-test-connection-with-key
title: 已填 API Key 时测试连接的结果
start_url: /settings/providers
max_steps: 20
max_walls: 3
---
你是 StudyMate Web 的用户，刚拿到一个 API Key 想验证能不能用。进入提供商设置页，选择硅基流动（SiliconFlow），在 API Key 输入框里填入一个假 key（例如 sk-test-e2e-12345），Base URL 和模型名保持默认不要改，然后点击"测试连接"按钮。仔细观察结果区域显示了什么：是"连接成功"、具体的错误详情、还是"缺少 API Key"之类与已填 key 矛盾的提示。如果出现了"与已填 key 矛盾的提示"（比如明明填了 key 却还说缺少 key），这正是一个重要发现，请用 wall 如实报告你看到的确切文字。
