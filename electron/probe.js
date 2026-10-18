// Feasibility check without any UI:  npm run probe   (add -- --raw to dump widget data)
// Connects over USB, reads the home screen, prints it. Writes nothing to the phone.
const { Device } = require('./device');
const { summary } = require('./layout');
(async () => {
  const d = await Device.open();
  console.log('已連線：', d.udid);
  const state = await d.getIconState();
  for (const p of summary(state)) console.log(`\n## ${p.title}（${p.items.length}）\n- ` + p.items.join('\n- '));
  if (process.argv.includes('--raw')) {
    const odd = state.flat().filter((x) => !x.displayName || x.gridSize || x.elementType || (x.iconLists && x.listType !== 'folder'));
    console.log('\n## 小工具原始資料\n' + JSON.stringify(odd, (k, v) => (v && v.type === 'Buffer' ? '<data>' : v), 2));
  }
  const icons = await d.iconImages(['com.apple.mobilesafari']);
  console.log('\n圖示讀取：', icons['com.apple.mobilesafari'] ? '成功' : '失敗');
  d.close();
  console.log('\nOK：讀取成功，連線層可行。');
})().catch((e) => { console.error('失敗：', e.message); process.exit(1); });
