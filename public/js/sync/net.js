/* 鎷剧闆?鈥斺€?鏄惁鍙戣捣鍚屾璇锋眰 / 杞闂撮殧
 * WebView 鐨?navigator.onLine 甯镐笉鍙潬锛氬師鐢熷凡閰嶅鏃朵竴寰嬪皾璇曪紝澶辫触鍐嶆爣绂荤嚎銆?
 * 缃戦〉浠嶅皧閲?online锛岄伩鍏嶆柇缃戞椂鍒蜂竴涓插け璐ャ€?
 */

const SYNC_INTERVAL_BUSY_MS = 8 * 1000;
// 鎺ㄩ€佽繛鐫€鐨勬椂鍊欏畬鍏ㄤ笉杞锛?锛夛紱鎺ㄩ€佹柇浜嗘墠鐢ㄨ繖涓參閫熷厹搴?
const SYNC_INTERVAL_FALLBACK_MS = 3 * 60 * 1000;

// ---------- 鍚庡彴鍚屾鐨勯噸璇曡妭濂忥紙鐢佃剳绔帹閫佽Е鍙戠殑閭ｄ竴杞級----------
// 闇€姹傚師鏂囷細鍚屾澶辫触灏辩瓑 5 鍒嗛挓鍐嶈瘯锛涜嫢鍐嶆澶辫触锛屽啀杩?5 鍒嗛挓鍐嶈瘯锛涘鏋滆繕澶辫触锛?
// 鎵嶇敤銆屾秷鎭?+ 閫氱煡銆嶅憡鐭ョ敤鎴枫€傚嵆 1 娆￠鍙?+ 2 娆￠噸璇?= 绗?3 娆″け璐ユ墠鎾姤銆?
// 鎾姤杩囦箣鍚庝粛鐒舵瘡 5 鍒嗛挓缁х画灏濊瘯锛堝彧鎾姤涓€娆℃晠闅滐紝涓嶅弽澶嶅埛灞忥級锛屾垚鍔熷嵆绠楁仮澶嶃€?
const SYNC_RETRY_DELAY_MS = 5 * 60 * 1000;
const SYNC_QUIET_RETRIES = 2;

// App 澹冲唴缃増鏈紙P10 / M5锛夛細涓?health.minClient 姣斿锛岃繃鏃ф彁绀洪噸瑁?APK銆?
// 姣忔鏀瑰埌銆屾棫澹充細闈欓粯鍑洪敊銆嶇殑鍓嶇/鍗忚琛屼负鏃堕€掑銆?
// v2锛氬悗鍙板悓姝ユ敼涓轰簨浠堕┍鍔ㄣ€傛湇鍔＄鎺ㄧ殑鑱氬悎浜嬩欢浠?changed 鏀瑰悕 sync锛堟棫澹冲彧璁?changed锛?
//     閰嶆柊鏈嶅姟绔細涓€鏉℃帹閫侀兘鏀朵笉鍒般€佸彧鍓?15 鍒嗛挓鍏滃簳闂归挓锛屾鏄€岄潤榛樺嚭閿欍€嶏級锛?
//     hello 甯т篃澶氫簡 pendingSince 瀛楁銆傚崌鍒?2 璁╂棫澹充富鍔ㄦ彁绀洪噸瑁咃紝鑰屼笉鏄粯榛樹笉鍚屾銆?
const CLIENT_VERSION = 2;

/** health.minClient 澶т簬鍐呯疆鐗堟湰鍗充负杩囨棫锛涘瓧娈电己澶憋紙鑰佹湇鍔★級瑙嗕负涓嶈繃鏃?*/
function isClientOutdated(minClient) {
  const min = Number(minClient);
  if (!Number.isFinite(min)) return false;
  return CLIENT_VERSION < min;
}

/**
 * @param {{ native?: boolean, paired?: boolean, online?: boolean }} input
 * @returns {boolean} 鏄惁搴斿彂璧?push/pull
 */
function shouldAttemptSync({ native = false, paired = false, online } = {}) {
  if (native) return !!paired;
  return online !== false;
}

/**
 * 鍘熺敓鍚庡彴鍚屾鏈嶅姟璇ヤ笉璇ヨ窇銆?
 * 鏈厤瀵规椂 shouldAttemptSync 鎭?false锛屾湇鍔″彧浼氱櫧鑰楃數 + 鐧芥寕甯搁┗閫氱煡锛屾墍浠ヤ竴骞舵尅浣忋€?
 * @param {{ pluginAvailable?: boolean, wanted?: boolean, paired?: boolean }} input
 * @returns {boolean}
 */
function shouldRunBackgroundService({ pluginAvailable = false, wanted = true, paired = false } = {}) {
  return !!(pluginAvailable && wanted && paired);
}

/**
 * 鍚庡彴韪㈠悓姝ョ殑鍥炴姤鍙ｅ緞锛氬彧鏈夋槑纭け璐ユ墠绠楀け璐ャ€?
 * skipped锛坮unning / disabled / offline / need_token锛夌畻涓€р€斺€旂數鑴戠涓存椂涓嶅彲杈?
 * 涓嶄唬琛ㄥ悓姝ラ€氶亾鏈夐棶棰橈紱鐪熷け璐ユ椂 syncNow 杩斿洖 { ok: false }銆?
 * 鍘熺敓渚ч棿闅斿凡鍥哄畾涓?15 鍒嗛挓鍏滃簳锛堜富閫氶亾鏄?SSE 鎺ㄩ€侊級锛屽洖鎶ュ彧浣滄棩蹇楄瀵熴€?
 * @param {{ ok?: boolean, skipped?: boolean }} result syncNow 鐨勮繑鍥炲€?
 * @returns {boolean} true = 鍚屾閫氶亾姝ｅ父
 */
function isBackgroundSyncOk(result) {
  return !result || result.ok !== false;
}

/**
 * syncNow 杩斿洖鍊?鈫?鏈疆鍚屾鐨勭粨璁恒€傝皟鐢ㄦ柟鎹鍐冲畾銆屽彂鎴愬姛娑堟伅 / 璁颁竴娆″け璐ラ噸璇?/ 鍘熸牱鎸傜潃绛変笅娆°€嶃€?
 * - 'success'  鐪熷悓姝ユ垚鍔燂紙ok:true锛?
 * - 'fail'     鐪熷け璐ワ紙ok:false锛夛紝瑕佽鍏ラ噸璇曞苟鏈€缁堥€氱煡
 * - 'defer'    娌℃垚浣嗕篃涓嶇畻澶辫触锛歰ffline / need_token / disabled / 涓婁竴杞繕鍦ㄨ窇銆?
 *               鎸傝捣杩欐鍚屾锛? 鍒嗛挓鍚庨噸璇曪紝浣嗕笉璁″叆杩炵画澶辫触娆℃暟鈥斺€?
 *               鍚﹀垯銆岀數鑴戝叧鏈轰簡銆嶄細琚鎶ユ垚銆屽悗鍙板悓姝ュけ璐ャ€嶃€?
 * @param {{ ok?: boolean, skipped?: boolean, reason?: string }} result
 * @returns {'success'|'fail'|'defer'}
 */
function classifySyncResult(result) {
  if (!result) return 'defer';
  if (result.ok === true) return 'success';
  if (result.ok === false) return 'fail';
  return 'defer';
}

/**
 * 杩炵画澶辫触 attempts 娆′箣鍚庯紝涓嬩竴姝ユ€庝箞璧般€?
 * attempts 璁扮殑鏄€屽凡缁忓け璐ヤ簡鍑犳銆嶏細棣栧彂閭ｆ澶辫触鏄?1锛屼箣鍚庢瘡閲嶈瘯澶辫触涓€娆?+1銆?
 * 棣栧彂 + 2 娆￠噸璇曢兘澶辫触锛坅ttempts 杈惧埌 3锛夋墠鎾姤銆?
 * @param {number} attempts 宸茬粡杩炵画澶辫触鐨勬鏁?
 * @returns {{ delayMs: number, notify: boolean, reset: boolean }}
 *   notify = 璇ョ敤銆屾秷鎭?+ 閫氱煡銆嶅憡鐭ョ敤鎴蜂簡锛況eset = 閫氱煡鍚庝笉鍐嶉噸澶嶆挱鎶?
 */
function nextSyncRetry(attempts) {
  const n = Number(attempts) || 0;
  return {
    delayMs: SYNC_RETRY_DELAY_MS,
    notify: n > SYNC_QUIET_RETRIES,
    reset: n > SYNC_QUIET_RETRIES,
  };
}

/**
 * 该以什么节奏轮询。
 * pendingCount>0  有待推送数据 → 8 秒快轮询。这是**往上传**本地改动,优先级最高,
 *                 与推送广播无关,必须保留。
 * 前台 + pushConnected
 *                 SSE 推送连着 → 0(不轮询)。前台页面活着,服务端广播一定收得到。
 * 其他一切情况    → 3 分钟慢速兜底。
 *                 关键:**只有前台才信任推送连接**。手机退后台后 WebView JS 冻结,
 *                 SSE 断流也无人察觉,此时 pushConnected 仍是 true(假象)——
 *                 若后台也信它,后台就彻底不轮询,后台同步名存实亡
 *                 (2026-10-06 实测回归,见 docs/m14-bg-sync-recovery.md 第 0 节)。
 *                 JS 真被冻结时定时器本来就不跑,这条兜底零成本;JS 没被冻结时,
 *                 它就是后台同步的生命线。
 * @param {number} pendingCount
 * @param {boolean} pushConnected
 * @param {boolean} documentHidden 页面是否在后台(document.visibilityState === 'hidden')
 * @returns {number} 毫秒;0 表示关掉轮询
 */
function pickIntervalMs(pendingCount, pushConnected, documentHidden = false) {
  if (pendingCount > 0) return SYNC_INTERVAL_BUSY_MS;
  if (!documentHidden && pushConnected) return 0;
  return SYNC_INTERVAL_FALLBACK_MS;
}

/**
 * 杩欎竴杞悓姝ワ紝鏄笉鏄妸銆岀潯鐫€鏈熼棿鐢佃剳绔敼杩囩殑涓滆タ銆嶈ˉ涓婁簡锛?
 *
 * 渚濇嵁鏄湇鍔＄鐨勬暟鎹増鏈彿 /api/sync/pull 鐨?data_version锛堟瘡娆″啓鍏?+1锛夛紝
 * 浣嗙増鏈彿鍙湪**鍚屼竴娆¤繘绋嬪唴**鍙瘮锛氭湇鍔＄涓€閲嶅惎瀹冨氨褰?1锛岃€屾墜鏈哄瓨鐫€鐨?
 * 杩樻槸涓婃閭ｄ釜澶ф暟锛屼簬鏄€屾湇鍔＄鐗堟湰 > 鎴戝瓨鐨勭増鏈€嶆案杩滀笉鎴愮珛锛?
 * 銆岃ˉ榻愩€嶉€氱煡浼氶潤榛樺け鏁堝ソ鍑犲ぉ銆傛墍浠ュ繀椤昏繛 boot_id 涓€璧锋瘮銆?
 *
 * 涓ゆ潯涓嶇畻銆岃ˉ榻愩€嶇殑鎯呭喌锛?
 *  1. 浠庢病鍚屾杩囷紙prevVersion 涓?0锛夆€斺€?娌℃湁"钀藉悗"鍙█锛?
 *  2. 鏈嶅姟绔噸鍚繃锛坆oot 瀵逛笉涓婏級鈥斺€?鐗堟湰鍙疯法杩涚▼涓嶅彲姣旓紝杩欎竴杞彧閲嶆柊瀵归綈銆?
 *     鑰佺増鏈?App 娌℃湁 bootId锛坧revBoot 涓虹┖锛夛紝鎸夋棫閫昏緫鍙瘮鐗堟湰鍙枫€?
 *
 * 绾嚱鏁帮細涓嶈鏃堕挓銆佷笉纰扮姸鎬併€佷笉鍙戠綉缁溿€?
 * @param {{ prevVersion?: number, prevBoot?: string, serverVersion?: number, serverBoot?: string }} o
 * @returns {boolean}
 */
function isCaughtUp({ prevVersion = 0, prevBoot = '', serverVersion = 0, serverBoot = '' } = {}) {
  if (!(prevVersion > 0)) return false;                                  // 浠庢病鍚屾杩?
  if (prevBoot && serverBoot && prevBoot !== serverBoot) return false;  // 鏈嶅姟绔噸鍚繃锛岀増鏈笉鍙瘮
  return serverVersion > prevVersion;
}

export { shouldAttemptSync, shouldRunBackgroundService, isBackgroundSyncOk, classifySyncResult, nextSyncRetry, pickIntervalMs, isCaughtUp, isClientOutdated, CLIENT_VERSION, SYNC_INTERVAL_FALLBACK_MS, SYNC_INTERVAL_BUSY_MS, SYNC_RETRY_DELAY_MS, SYNC_QUIET_RETRIES };
