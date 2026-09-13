/* 拾穗集 shisuiji —— 全局配置
 * 想扩展？先看这里：平台列表、优惠类型、状态、提醒规则都在这。
 */
window.DANJI_CONFIG = {
  // 常用平台建议（表单里可自由输入，不限于这个列表）
  platforms: [
    'Kimi', 'DeepSeek', '豆包', '通义千问', '智谱清言', '文心一言',
    'Gemini', 'ChatGPT', 'Claude', 'Grok', 'MiniMax', '即梦', '可灵', '其他',
  ],

  // 优惠形式
  types: [
    { id: 'free_credits', label: '免费额度', icon: '💰' },
    { id: 'voucher', label: '代金券', icon: '🎟️' },
    { id: 'discount', label: '折扣', icon: '🔖' },
    { id: 'trial', label: '试用会员', icon: '🎁' },
    { id: 'merch', label: '周边', icon: '📦' },
    { id: 'other', label: '其他', icon: '🥚' },
  ],

  // 状态流转：待领取 → 已领取 → 已用完；没赶上就是 已过期 / 已错过
  statuses: [
    { id: 'pending', label: '待领取', emoji: '🥚' },
    { id: 'claimed', label: '已领取', emoji: '🧺' },
    { id: 'used', label: '已用完', emoji: '✅' },
    { id: 'expired', label: '已过期', emoji: '💤' },
    { id: 'missed', label: '已错过', emoji: '😢' },
  ],

  // 紧急度阈值（小时）：≤red 红 / ≤orange 橙 / ≤yellow 黄
  urgent: { red: 24, orange: 72, yellow: 168 },

  // 桌面通知：到期前 remindHours 小时内提醒，同一条目本轮会话只提醒一次
  remind: { hours: 24, checkIntervalSec: 60 },

  // 文献阅读记录：关联度档位 + 「最有用的部分」选项（表单里点选，词可以随时改）
  paperNote: {
    relevance: [
      { id: 'direct', emoji: '🎯', label: '直接可借鉴' },
      { id: 'baseline', emoji: '📊', label: '可作 baseline / 对比' },
      { id: 'idea', emoji: '💡', label: '提供思路视角' },
      { id: 'background', emoji: '📚', label: '只是背景' },
      { id: 'unrelated', emoji: '🚫', label: '与课题无关' },
    ],
    parts: [
      { id: 'method', label: 'Method' },
      { id: 'experiment', label: 'Experiment' },
      { id: 'discussion', label: 'Discussion' },
      { id: 'theory', label: '理论证明' },
      { id: 'related', label: 'Related Work' },
      { id: 'dataset', label: '数据集 / Benchmark' },
    ],
  },

  // 网页板块：类型 + 「用得上吗」+ 读完引导字段（表单按类型渲染，改词只动这里）
  siteNote: {
    kinds: [
      { id: 'tech', label: '技术', emoji: '🔧' },
      { id: 'misc', label: '杂项', emoji: '🧩' },
    ],
    // 用得上吗：检索时最有用的一个维度——立刻能用=待办，以后可能用=储备，长见识=开阔视野
    usage: [
      { id: 'now', emoji: '⚡', label: '立刻能用' },
      { id: 'later', emoji: '🌱', label: '以后可能用' },
      { id: 'wide', emoji: '👀', label: '长见识' },
    ],
    // 归档到「已读」前必须写满的字段：技术严、杂项松
    gate: { tech: ['gist', 'method', 'finding'], misc: ['gist'] },
    // 字段 schema：抽屉按 common + 所选类型渲染，key 就是存进笔记的字段名
    fields: {
      common: [
        { key: 'gist', label: '🧠 一句话：它讲了什么', rows: 2, placeholder: '例：用 X 解决 Y，结论是 Z' },
        { key: 'excerpt', label: '📖 值得原样记下的一句 / 一段', rows: 2, placeholder: '金句、定义、可直接复用的表述' },
        { key: 'next', label: '🧭 还想顺着查什么', rows: 2, placeholder: '例：它提到的 XXX 论文 / 那个库怎么用' },
      ],
      tech: [
        { key: 'method', label: '🔧 关键做法 / 机制', rows: 2, placeholder: '它到底怎么做的，步骤或原理' },
        { key: 'finding', label: '📈 结论 / 关键数据', rows: 2, placeholder: '例：比 baseline 快 3 倍；在 4 张卡上跑通' },
        { key: 'refs', label: '💻 提到的工具 / 库 / 项目', rows: 2, placeholder: '例：vLLM、FlashAttention-2、这个 GitHub 仓库' },
        { key: 'limits', label: '⚠️ 坑 / 局限', rows: 2, placeholder: '例：只支持 Linux；文档里没说的前提' },
      ],
      misc: [
        { key: 'facts', label: '✅ 关键事实 / 要点', rows: 3, placeholder: '一条一行，越具体越好（数字、时间、人名、条件）' },
        { key: 'use_when', label: '🗓 什么时候会用到', rows: 2, placeholder: '例：下次办签证 / 选路由器 / 写综述讲背景时' },
        { key: 'credibility', label: '🔍 来源可信度（谁说的、有没有出处）', rows: 2, placeholder: '例：官网政策原文；某博主转述，无出处，待核实' },
      ],
    },
  },

  // 花销板块：按条目记账；类别只用于归纳展示（年视图两级饼图）
  expenses: {
    currency: '¥',   // 金额前缀，想换币种改这里
    maxSlices: 24,   // 饼图最多几个扇区；超出时把最小的若干笔合并成「其余 N 笔」
    // 类别：id 或关键词改动时，记得同步 server.js 的 EXPENSE_CATEGORIES 与关键词表
    // 自动归类规则：套餐关键词优先（token 包、资源包算套餐），再匹配 API、算力租用，都没命中就归套餐
    categories: [
      {
        id: 'plan', label: '套餐', emoji: '📦', hue: 210,
        keywords: ['套餐', '会员', '订阅', '包月', '年费', '额度', 'token', '资源包', 'pro', 'plus'],
      },
      {
        id: 'api', label: 'API', emoji: '🔌', hue: 25,
        keywords: ['api', '接口', '调用'],
      },
      {
        id: 'compute', label: '算力租用', emoji: '🖥️', hue: 275,
        keywords: ['算力', '租用', 'autodl', 'gpu'],
      },
    ],
  },
};
