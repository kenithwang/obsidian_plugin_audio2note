# Obsidian AI Transcriber 部署地址

## rclone 目标路径

```
Obsidian Vault:应用/remotely-save/Obsidian Vault/AI Transcribe/
```

## 需要复制的文件

- main.js
- manifest.json
- styles.css

## 部署命令

```bash
rclone copy /home/ken-wang/obsidian-ai-transcriber/obsidian-ai-transcriber/main.js "Obsidian Vault:应用/remotely-save/Obsidian Vault/AI Transcribe/"
rclone copy /home/ken-wang/obsidian-ai-transcriber/obsidian-ai-transcriber/manifest.json "Obsidian Vault:应用/remotely-save/Obsidian Vault/AI Transcribe/"
rclone copy /home/ken-wang/obsidian-ai-transcriber/obsidian-ai-transcriber/styles.css "Obsidian Vault:应用/remotely-save/Obsidian Vault/AI Transcribe/"
```
