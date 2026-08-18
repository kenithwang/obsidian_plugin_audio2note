# Obsidian AI Transcriber 构建产物传输地址

## rclone 目标路径

```
Obsidian Vault:应用/remotely-save/Obsidian Vault/AI Transcribe/Transcript/
```

本地同步配置会忽略 `.obsidian/plugins/`，不要把构建产物直接上传到远端插件目录。

## 需要复制的文件

- main.js
- manifest.json
- styles.css

## 部署命令

```bash
rclone copy /home/ken-wang/obsidian-ai-transcriber/obsidian-ai-transcriber/main.js "Obsidian Vault:应用/remotely-save/Obsidian Vault/AI Transcribe/Transcript/"
rclone copy /home/ken-wang/obsidian-ai-transcriber/obsidian-ai-transcriber/manifest.json "Obsidian Vault:应用/remotely-save/Obsidian Vault/AI Transcribe/Transcript/"
rclone copy /home/ken-wang/obsidian-ai-transcriber/obsidian-ai-transcriber/styles.css "Obsidian Vault:应用/remotely-save/Obsidian Vault/AI Transcribe/Transcript/"
```
