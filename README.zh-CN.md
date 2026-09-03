# Rubato

[English](README.md) | 绠€浣撲腑鏂?

Rubato 璁?AI 鐨勫伐浣滅姸鎬佸湪妗岄潰瀹炰綋璁惧涓婂彲瑙併€傛湰浠撳簱涓烘瘡涓彈鏀寔鐨勭紪鐮?
鏅鸿兘浣撳悇鎻愪緵涓€涓?Rubato 鎻掍欢锛屼竴涓彃浠朵竴涓洰褰曘€傝澶囧浐浠跺湪
[lovaxi/Rubato_Device](https://github.com/lovaxi/Rubato_Device)銆?
璁惧鏁存満宸插湪
[Tindie](https://www.tindie.com/products/beartificialintelligence/rubato-retro-mac-ai-desk-companion/) 姝ｅ紡鍙戝敭銆?

![Rubato 璁惧](assets/product.jpg)

![Rubato 璁惧鏁堟灉](assets/product.gif)

```
妯″瀷璋冪敤 鈹€鈹€> Rubato 鎻掍欢 鈹€鈹€> EMQX 鏈嶅姟鍣?鈹€鈹€> Rubato 璁惧锛圱FT 灞忓箷锛?
```

| 鐩綍 | 鏅鸿兘浣?| 鐘舵€?|
|---|---|---|
| [dsh/](dsh/) | DeepSeek Harness | 鍙敤 |
| [openclaw/](openclaw/) | OpenClaw | 鍙敤 |
| codex/ | Codex | 璁″垝涓?|
| claude-code/ | Claude Code | 璁″垝涓?|
| [cursor/](cursor/) | Cursor | 鍙敤 |
| [opencode/](opencode/) | OpenCode | 鍙敤 |

## MQTT 濂戠害

鎵€鏈夋彃浠跺彂甯冪浉鍚岀殑娑堟伅鍒?`rubato/<deviceId>/state`鈥斺€旀瘡鍙拌澶囦竴涓富棰樸€?
璁よ瘉涓庤澶囧浐浠朵竴鑷达細username = deviceId锛坄RUBATO-xxxxxx`锛夛紝password = 瀵瑰簲
token銆侻QTT 3.1.1 over TLS锛?883锛夛紝鍗曟潯鎸佷箙杩炴帴銆?

| 娑堟伅 | 杞借嵎 | 璇存槑 |
|---|---|---|
| `Estimate` | `{ model, state, ts, estSec? }` | 棰勪及鏃堕暱锛堢锛夆€斺€斾粎 dsh 鎻掍欢鎼哄甫锛堢敤鎴风鎻掍欢涓嶅甫璇ュ瓧娈碉級 |
| `Thinking` | `{ model, state, ts }` | 棣栦釜鎬濊€冪墖娈?|
| `Generating` | `{ model, state, ts }` | 棣栦釜鍥炵瓟/宸ュ叿鐗囨 |
| `Done` | `{ model, state, ts }` | 涓棿宸ュ叿璋冪敤姝ラ涓嶅彂閫?Done |

璁惧灞忓箷鏄剧ず妯″瀷鍚嶅拰闅忛樁娈靛彉鑹茬殑鍛煎惛鍏夌幆鈥斺€旀€濊€冩椂濂舵补鑹叉參鍛煎惛锛岀敓鎴愭椂
鍐拌摑鑹插揩鍛煎惛锛岀粨鏉熸椂缁胯壊鏀跺熬銆傚綋棰勪及鏃堕暱 鈮?30 绉掞紝璁惧浼氬湪浠诲姟杩愯涓叏灞?
鏄剧ず鍋ュ悍鎻愰啋锛堝枬姘?/ 浼戞伅鏃堕棿鍒颁簡锛夛紝涓ゆ鍏ㄥ睆鎻愰啋鍏ㄥ眬闂撮殧 鈮?30 鍒嗛挓銆?

## 瀹夎

### DeepSeek Harness

鍦?DSH 瀵硅瘽閲岀矘璐达細

```text
Install the Rubato plugin for DSH from https://github.com/lovaxi/Rubato_Plugins/dsh
```

杩欏氨鏄叏閮ㄥ畨瑁呮楠ゃ€傚姪鎵嬩細鎶婃彃浠跺寘澶嶅埗鍒颁綅骞舵敞鍐岋紝鐒跺悗鎻愰啋浣犻噸鍚€傞噸鍚悗锛?

1. 鎺у埗鍙颁細鎵撳嵃 `SETUP REQUIRED` 鎸囧崡锛屽苟鑷姩鐢熸垚閰嶇疆妯℃澘銆?
2. 鎶婅澶囪创绾镐笂鐨勪袱涓€煎～杩涘幓鈥斺€攗sername = deviceId锛坄RUBATO-xxxxxx`锛夛紝
   password = 瀵瑰簲 token鈥斺€斿彲浠ヨ嚜宸辩紪杈戞枃浠讹紝鎴栫洿鎺ュ憡璇夊姪鎵嬨€?

淇濆瓨鍗冲畬鎴愨€斺€旀彃浠跺湪涓嬩竴鏉℃秷鎭嚜鍔ㄥ惎鐢紝鏃犻渶閲嶅惎銆?

### OpenCode

鍦?opencode 瀵硅瘽閲岀矘璐达細

```text
Install the Rubato plugin for OpenCode from https://github.com/lovaxi/Rubato_Plugins/opencode
```

杩欏氨鏄叏閮ㄥ畨瑁呮楠ゃ€傚姪鎵嬩細鎶婃彃浠跺寘澶嶅埗鍒颁綅锛堥」鐩?`.opencode/plugins/` 鎴?
鍏ㄥ眬 `~/.config/opencode/plugins/`锛夛紝鐒跺悗鎻愰啋浣犻噸鍚€傞噸鍚悗锛?

1. 鎺у埗鍙颁細鎵撳嵃 `SETUP REQUIRED` 鎸囧崡锛屽苟鑷姩鐢熸垚閰嶇疆妯℃澘銆?
2. 鎶婅澶囪创绾镐笂鐨勪袱涓€煎～杩涘幓鈥斺€攗sername = deviceId锛坄RUBATO-xxxxxx`锛夛紝
   password = 瀵瑰簲 token鈥斺€斿彲浠ヨ嚜宸辩紪杈戞枃浠讹紝鎴栫洿鎺ュ憡璇夊姪鎵嬨€?

淇濆瓨鍗冲畬鎴愨€斺€旀彃浠跺湪涓嬩竴鏉℃秷鎭嚜鍔ㄥ惎鐢紝鏃犻渶閲嶅惎銆?

### Cursor

Cursor 鏄?VS Code 鐨勫垎鏀紝鎻掍欢浠?VSIX 褰㈠紡瀹夎鈥斺€旀棤闇€浠讳綍鏋勫缓宸ュ叿銆?

**鏈€绠€瀹夎 鈥斺€?涓ゆ锛?*

1. 涓嬭浇鎵╁睍锛歔`cursor/rubato-cursor-1.1.0.vsix`](https://github.com/lovaxi/Rubato_Plugins/raw/main/cursor/rubato-cursor-1.1.0.vsix)
2. 鍦?Cursor 涓細鎵╁睍闈㈡澘 鈫?`鈰痐 鑿滃崟 鈫?**浠?VSIX 瀹夎鈥?* 鈫?閫夋嫨涓嬭浇鐨勬枃浠?鈫?
   閲嶈浇绐楀彛銆傦紙鎶?`.vsix` 鐩存帴鎷栬繘鎵╁睍闈㈡澘涔熷彲浠ャ€傦級

鍠滄缁堢锛熶竴琛屾悶瀹氾紙`cursor` 鍛戒护闅?Cursor 鑷甫锛夛細

```powershell
# Windows (PowerShell)
curl.exe -L -o rubato-cursor.vsix https://github.com/lovaxi/Rubato_Plugins/raw/main/cursor/rubato-cursor-1.1.0.vsix; cursor --install-extension rubato-cursor.vsix
```

```bash
# macOS / Linux
curl -L -o rubato-cursor.vsix https://github.com/lovaxi/Rubato_Plugins/raw/main/cursor/rubato-cursor-1.1.0.vsix && cursor --install-extension rubato-cursor.vsix
```

鐒跺悗閰嶇疆涓€娆★細

1. 鎺у埗鍙颁細鎵撳嵃 `SETUP REQUIRED` 鎸囧崡锛屽苟鑷姩鍦ㄦ彃浠舵梺鐢熸垚閰嶇疆妯℃澘
   锛坄cursor/rubato-mqtt-config.json` 鈥斺€?涓庢湰鏈哄叾浠?Rubato 瀹夸富鎻掍欢璇荤殑鏄?
   鍚屼竴涓枃浠讹紱鏃у悕 `dsh-mqtt-config.json` 浼氬湪棣栨鏌ユ壘鏃惰嚜鍔ㄦ敼鍚嶈縼绉伙級銆?
   鍛戒护闈㈡澘 鈫?**Rubato: Open Config File** 鍙洿鎺ユ墦寮€銆?
2. 鎶婅澶囪创绾镐笂鐨勪袱涓€煎～杩涘幓鈥斺€攗sername = deviceId锛坄Cursor-RUBATO-xxxxxx`锛夛紝
   password = 瀵瑰簲 token鈥斺€斿彲浠ヨ嚜宸辩紪杈戞枃浠讹紝鎴栫洿鎺ュ憡璇夊姪鎵嬨€?

淇濆瓨鍗冲畬鎴愨€斺€旀彃浠跺湪涓嬩竴娆＄紪杈戠獊鍙戞椂鑷姩鍚敤锛屾棤闇€閲嶅惎銆傚懡浠ら潰鏉块噷鐨?
**Rubato: Send Test Cycle to Device** 鍙仛璁惧閾捐矾妫€鏌ャ€?

**宸ヤ綔鍘熺悊** 鈥斺€?Cursor 娌℃湁鍏紑鍏?AI 瀵硅瘽鐨?API锛屾彃浠惰瀵?AI 瀵瑰伐浣滃尯纭疄
浜х敓鐨勬敼鍔細蹇€熴€侀潪閫愰敭鐨勬枃妗ｇ紪杈戯紙Tab 琛ュ叏銆丆md/Ctrl+K銆佸璇?Apply銆?
agent 澶氭枃浠?diff锛夌粍鎴愪竴娆?缂栬緫绐佸彂*锛屾槧灏勪负涓婇潰鐨勬秷鎭簭鍒楋紱鐒︾偣缂栬緫鍣ㄩ噷
閫愰敭绾у埆鐨勫皬鏀瑰姩瑙嗕负浜虹被杈撳叆锛屽拷鐣ャ€?

鍛戒护锛堝懡浠ら潰鏉匡級锛?*Rubato: Show Status** 路 **Rubato: Send Test Cycle to
Device** 路 **Rubato: Open Config File**銆?

璁剧疆锛歚rubato.modelLabel`锛坄cursor-agent`锛岃礋杞芥ā鍨嬪悕锛夈€?
`rubato.settleMs`锛坄6000`锛岀獊鍙戜互 Done 鏀跺熬鐨勯潤榛樻绉掓暟锛夈€?
`rubato.minBurstChars`锛坄12`锛岀劍鐐圭紪杈戝櫒鍐呭崟娆＄紪杈戣鍏?AI 宸ヤ綔鐨勫瓧绗﹂槇鍊硷級銆?
`rubato.maxBurstMs`锛坄600000`锛屽畨鍏ㄤ笂闄愶級銆?

<details>
<summary>浠庢簮鐮佹瀯寤猴紙寮€鍙戣€咃級</summary>

```bash
git clone https://github.com/lovaxi/Rubato_Plugins.git
cd Rubato_Plugins/cursor
npx @vscode/vsce package        # 鐢熸垚 rubato-cursor-<version>.vsix
```

</details>

### OpenClaw

鍦?OpenClaw 瀵硅瘽閲岀矘璐达細

```text
Install the Rubato plugin for OpenClaw from https://github.com/lovaxi/Rubato_Plugins/openclaw
```

杩欏氨鏄叏閮ㄥ畨瑁呮楠ゃ€傚姪鎵嬩細閾炬帴鎻掍欢鍖呫€佸惎鐢ㄣ€佹巿浜堟墍闇€鐨勪細璇濋挬瀛愭潈闄愶紝骞?
鎻愰啋浣犻噸鍚€傞噸鍚悗锛?

1. 鎺у埗鍙颁細鎵撳嵃 `SETUP REQUIRED` 鎸囧崡锛屽苟鑷姩鐢熸垚閰嶇疆妯℃澘銆?
2. 鎶婅澶囪创绾镐笂鐨勪袱涓€煎～杩涘幓鈥斺€攗sername = deviceId锛坄RUBATO-xxxxxx`锛夛紝
   password = 瀵瑰簲 token鈥斺€斿彲浠ヨ嚜宸辩紪杈戞枃浠讹紝鎴栫洿鎺ュ憡璇夊姪鎵嬨€?

淇濆瓨鍗冲畬鎴愨€斺€旀彃浠跺湪涓嬩竴鏉℃秷鎭嚜鍔ㄥ惎鐢紝鏃犻渶閲嶅惎銆侽penClaw 绫诲瀷鍖栭挬瀛愭病鏈?
棣栦釜澧為噺浜嬩欢锛屽洜姝や笉鍙戦€?`Generating`锛涜澶囦繚鎸佹€濊€冨懠鍚告€佺洿鍒?`Done`銆?

### Codex / Claude Code

璁″垝涓€?

## 璁稿彲璇?

[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html)
