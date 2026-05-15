# clipshot

Screenshot monitor CLI. Watches clipboard for screenshots and uploads to remote server via SSH, or saves locally.

![Demo](demo.gif) 

## Why?

When using AI CLI tools like Claude Code, Codex, or others, you often need to share screenshots with them. But when you SSH into a remote server to use these tools, you can't paste images at all.

clipshot solves this - take a screenshot locally, and it automatically uploads to your remote server and copies the path to your clipboard. So you just take screenshot like usual and then paste the path and the AI can read the image.

## Install

```bash
echo "@m0rtzz:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT" >> ~/.npmrc
npm install -g @m0rtzz/clipshot
```

## Commands

```
clipshot              Setup config and start monitoring
clipshot start        Start monitoring (select target)
clipshot stop         Stop monitoring
clipshot status       Show running status and target
clipshot config       Modify remotes and save directories
clipshot uninstall    Remove config files
```

## Features

- Auto-detects SSH remotes from `~/.ssh/config` and shell history
- **Local mode**: Saves to a configurable local directory, copies path to clipboard
- **Remote mode**: Uploads via SSH to a configurable remote directory, copies remote path to clipboard
- Fast SSH with ControlMaster connection reuse
- WSL support (reads Windows clipboard)

## How it works

1. Polls clipboard for new images (200ms interval)
2. Detects changes via MD5 hash comparison
3. Uploads via SSH or saves locally
4. Copies absolute path to clipboard for easy pasting

## Configuration

`clipshot config` lets you:

- manage SSH remotes
- change the local screenshot directory (default: `~/clipshot-screenshots`)
- change the remote screenshot directory for SSH uploads (default: `~/clipshot-screenshots`)

## Publish

Push a `v*` tag to trigger the GitHub Actions workflow and publish to GitHub Packages:

```bash
git tag v1.0.19
git push origin v1.0.19
```
