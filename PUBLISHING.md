# 发布到 dsh 插件市场

这份文件不进 npm 包，只是给你自己照着敲的。

---

## 0. 先改三处占位符

`package.json` 里有 3 个 `REPLACE_ME`，全部换成你的 **GitHub 用户名**：

```
repository.url   git+https://github.com/xcw520/dsh-dania-voice.git
bugs.url         https://github.com/xcw520/dsh-dania-voice/issues
homepage         https://github.com/xcw520/dsh-dania-voice#readme
```

一条命令搞定（把 `xcw520` 换掉）：

```powershell
cd F:\dsh-downloads\dania\dsh-dania-voice
(Get-Content package.json -Raw) -replace 'REPLACE_ME','xcw520' | Set-Content package.json -Encoding UTF8
```

顺便确认作者名：`package.json` 里 `"author": "夜游人"`，想改就改。

---

## 1. 在 GitHub 建仓库

浏览器打开 https://github.com/new

- Repository name：`dsh-dania-voice`
- 可见性：**Public**
- **不要**勾选 Add README / .gitignore / License（本地已有）

---

## 2. 推送代码

```powershell
cd F:\dsh-downloads\dania\dsh-dania-voice

git init
git add -A
git commit -m "feat: 达妮娅语音朗读插件 v1.0.0"
git branch -M main
git remote add origin https://github.com/xcw520/dsh-dania-voice.git
git push -u origin main
```

第一次 push 会要求登录。推荐用 [GitHub CLI](https://cli.github.com/) 省事：

```powershell
winget install GitHub.cli
gh auth login          # 选 GitHub.com → HTTPS → 浏览器授权
gh repo create dsh-dania-voice --public --source . --push
```

---

## 3. 加 topic（必须）

仓库页面右上 **About** 旁的齿轮 → **Topics** → 输入 `dsh-plugin` → Save。

CI 会检查这一项。

---

## 4. 发 npm

```powershell
cd F:\dsh-downloads\dania\dsh-dania-voice

npm login          # 没登录过才需要
npm whoami         # 确认登录成功
npm publish --access public
```

- 包名 `dsh-dania-voice` 已确认**未被占用**（2026-10-18 查过，404）。
- 发完去 https://www.npmjs.com/package/dsh-dania-voice 确认能打开。
- 以后更新版本：改 `version` → `npm publish`。

---

## 5. 提 PR 到 awesome-dsh-plugin

1. Fork：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/fork
2. 在你的 fork 里新建文件：

   **路径**：`data/plugins/xcw520__dsh-dania-voice.yml`

   **内容**：

   ```yaml
   url: https://github.com/xcw520/dsh-dania-voice
   name: xcw520/dsh-dania-voice
   category: voice
   description:
     en: Local GPT-SoVITS text-to-speech that reads DeepSeek Harness assistant replies aloud, with a draggable mascot toggle and a one-click installer.
     zh: 用本地 GPT-SoVITS 把 DeepSeek Harness 的助手回复读出来，带可拖动的挂件开关与一键部署。
   ```

   注意：`description.en` 里如果出现 `: `（冒号+空格）必须给整行加引号，这里没有，可以直接写。

3. 提 PR，标题：`Add dsh-dania-voice`

4. CI 会依次检查：条目数（≤3）→ `dsh.bundle` manifest → 仓库年龄（≥1 天）→ `awesome-lint`。
   失败会明确说改什么，**在同一分支 push 修复即可，不用重开 PR**。

5. 合并后网站和市场自动收录，通常一天内。

---

## 6. 通过市场安装（自测）

收录后，别人在 DSH 插件市场搜 `达妮娅` 就能装。你也可以先本地验证安装链路：

```powershell
# 卸载当前的 link 安装
dsh plugin --profile desktop remove dsh-dania-voice
# 从 npm 装
dsh plugin --profile desktop add dsh-dania-voice
```

装完重启 DSH，打开挂件面板，应该看到「一键部署」按钮。

---

## 提交前自查

- [ ] `package.json` 里没有 `REPLACE_ME`
- [ ] `dsh.bundle.patch` 指向 `./cordis.patch.yml`，文件存在
- [ ] `icon.png` ≤ 256 KiB（当前 234 KB）
- [ ] GitHub 仓库是 Public 且有 `dsh-plugin` topic
- [ ] README 里没有夸大描述（市场维护者会对着代码核）
- [ ] 仓库已存在满 1 天（当天建当天提会被 CI 拦）
