# Academic PDF Translator

面向学术阅读的 macOS PDF 翻译工具，主打“边读边译”。  
打开 PDF 后，将鼠标悬停在英文词语上即可看到中文翻译，尽量不打断阅读流程。

## 功能亮点
- 本地打开 PDF 阅读
- 英文词语悬停翻译（本地模型 + 词典兜底）
- 触控板左右滑动翻页
- 鼠标侧键翻页（常见 3/4 键）
- 翻页按钮悬浮显示，支持位置切换（右下/左下/右上）
- `+ / -` 缩放并显示当前缩放百分比
- 中文默认界面

## 下载与安装（普通用户）
已发布版本：  
[v0.1.0 Release](https://github.com/GSYH/academic-pdf-translator/releases/tag/v0.1.0)

下载文件：
- `Academic-PDF-Translator-mac-arm64-v0.1.0.zip`
- `Academic-PDF-Translator-mac-arm64-v0.1.0.sha256`
- `INSTALL-macOS-zh.md`

安装步骤：
1. 下载并解压 zip，得到 `Academic PDF Translator.app`
2. 拖到 `Applications` 文件夹
3. 首次打开若被系统拦截：
   - 右键 App -> `打开` -> 再次确认 `打开`
   - 或前往 `系统设置 -> 隐私与安全性` 点击“仍要打开”

## 使用方式
1. 打开 App，点击“打开 PDF”
2. 鼠标悬停在英文词语上查看翻译
3. 使用触控板左右滑动或翻页按钮切换页面
4. 通过顶部“翻页键位置”调整悬浮翻页控件位置

## 开发运行（开发者）
要求：
- Node.js 18+
- macOS（当前发布包为 Apple Silicon）

本地运行：
```bash
npm install
npm start
```

本地打包：
```bash
npx electron-packager . "Academic PDF Translator" --platform=darwin --arch=arm64 --out=release --overwrite
```

## 项目结构
```text
academic-pdf-translator/
├── main.js
├── preload.js
├── renderer/
│   ├── index.html
│   ├── styles.css
│   └── renderer.js
├── RELEASE_NOTES_zh.md
└── package.json
```

## 已知限制
- 当前未进行 Apple Developer 签名与公证，首次打开可能出现系统安全提示
- 扫描件/纯图片型 PDF 文本层不完整时，悬停翻译效果会受限
- 当前发布包仅支持 Apple Silicon（M1/M2/M3）

## Roadmap
- OCR 模式（提升扫描版论文支持）
- 更精准的词语定位与复杂版面适配
- 签名与公证发布流程

## License
MIT
