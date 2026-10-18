# 主畫面整理（Electron + Angular）

在 Mac 上透過 USB 自動分類、整理 iPhone 主畫面。

## 需求
- macOS、Node.js 22 以上
- iPhone 用 USB 線接上 Mac、已解鎖，並對這台 Mac 點過「信任」

## 使用
```bash
npm install
npm run probe   # 只測連線：讀取並列出主畫面，不改手機（加 -- --raw 可印出小工具原始資料）
npm start       # 開啟桌面版
```
流程：連接 iPhone → 在同一個工作區看目前排版、按「依類型分類」產生新排版並微調 → 套用到 iPhone。讀取時會自動備份，隨時能「還原原本排版」。

## 打包與發佈
```bash
npm run dist    # 本機打包，輸出 release/Homescreen-mac.dmg（universal，Apple 晶片和 Intel 都能跑）
```
發佈新版本由 GitHub Actions（`.github/workflows/release.yml`）自動完成：
1. 修改 `package.json` 的 `version`，例如 `0.1.1`
2. `git commit -am "v0.1.1" && git tag v0.1.1 && git push && git push --tags`
3. Actions 會在 macOS 機器上打包 DMG，並發佈到 GitHub Releases

推到 main 或發 PR 時只會打包、不發佈，可以在 Actions 頁面下載 DMG 測試。

目前用的是 ad-hoc 簽章（沒有 Apple Developer ID），使用者第一次打開時要到「系統設定 → 隱私權與安全性」按「強制打開」。

下載頁在 `docs/`，用 GitHub Pages 發佈（Settings → Pages → main 分支的 `/docs`）。

## 介面
- macOS 原生視窗：隱藏標題列、側邊欄使用系統毛玻璃（vibrancy），自動跟隨淺色／深色模式
- 側邊欄：裝置狀態、進度、重新讀取、還原
- 工作區預設顯示目前排版；工具列可切換「目前／新排版」，兩邊都用同樣的資料夾卡片呈現（真實 App 圖示）
- 「依類型分類」選單：選擇要整理的頁面；App 依 App Store 類型放進資料夾，太小的類型併進「其他」
- 分組在介面即時計算（`src/app/grouping.ts`），App Store 資料只在讀取後查詢一次
- 分類與微調：拖曳 App 換資料夾，或點一下 App 從選單搬移（鍵盤也能操作）；資料夾可改名、新增、刪除
- 套用與還原前以 macOS 風格的 sheet 確認
- 「目前」檢視依頁面列出 Dock、主畫面上的 App、每個資料夾和小工具，圖示直接從 iPhone 讀取
- 支援減少動態效果、減少透明度、增加對比的系統設定

## 結構
- `electron/device.js`：USB 連線層（usbmuxd → lockdownd TLS → SpringBoard）
- `electron/layout.js`：排版邏輯（攤平、依計畫重建、保留指定頁面，絕不遺漏 icon）
- `electron/classify.js`：用 Apple 公開的 iTunes Lookup API 查每個 App 的類型
- `electron/main.js`、`preload.js`：IPC，介面只透過 `window.hs` 呼叫
- `src/app/`：Angular 介面（`app.*` 主視窗、`grouping.ts` 依類型分組）

## 已知限制
- 用的是 iOS 非公開協定，iOS 改版可能失效
- 小工具（widget）不會移動；Dock 不會改動

## 贊助
這個工具免費使用，覺得有幫助的話歡迎請我喝杯咖啡：

<a href="https://www.buymeacoffee.com/jayden_lim" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" style="height: 60px !important;width: 217px !important;" ></a>
