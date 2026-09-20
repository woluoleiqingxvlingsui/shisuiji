/* ---------------- 组件：体感评价卡（主体素材 + 我的评价） ---------------- */
import { reactive, computed, watch } from '../vue-globals.js';

import { CONFIG } from '../../config.js';
import { formatDate } from '../util/date.js';
import { buildVerdictDraft, expenseCategoryMeta } from '../util/expense.js';
import { formatMoney } from '../util/money.js';

const InsightCard = {
  name: 'InsightCard',
  props: {
    insight: { type: Object, required: true },  // 自动凝练的素材：花费 / 类别拆分 / 原话摘录
    verdict: { type: Object, default: null },   // 已保存的我的评价（没保存过是 null）
  },
  emits: ['save', 'clear'],
  setup(props, { emit }) {

    // 本地可编辑副本：保存成功后根组件会换上 server 返回的新 verdict，watch 到了就同步，
    // 保证卡片上看到的永远是已保存的内容
    const form = reactive({ rating: null, decision: '', verdict: '' });
    function syncFromVerdict(v) {
      form.rating = v ? v.rating : null;
      form.decision = v ? v.decision || '' : '';
      form.verdict = v ? v.verdict || '' : '';
    }
    syncFromVerdict(props.verdict);
    watch(() => props.verdict, syncFromVerdict);

    const hasSaved = computed(() => !!props.verdict);
    const catSplits = computed(() => props.insight.categorySplit
      .map((c) => ({ ...c, meta: expenseCategoryMeta(c.id) })));

    function pickStar(n) {
      form.rating = form.rating === n ? null : n;
    }
    function pickDecision(id) {
      form.decision = form.decision === id ? '' : id;
    }
    // 没写过总评时，把凝练好的要点填进框里当草稿，改两笔就是自己的话了
    function fillDraft() {
      form.verdict = buildVerdictDraft(props.insight);
    }
    function save() {
      emit('save', {
        subject: props.insight.subject.id,
        rating: form.rating,
        decision: form.decision,
        verdict: form.verdict.trim(),
      });
    }

    return {
      form, hasSaved, catSplits, pickStar, pickDecision, fillDraft, save,
      decisions: CONFIG.expenses.decisions,
      defaultTag: CONFIG.expenses.insightDefaultTag,
      tagLabel(id) {
        return (CONFIG.expenses.insightTags.find((t) => t.id === id) || CONFIG.expenses.insightDefaultTag).label;
      },
      formatMoney, formatDate,
      clear: () => emit('clear'),
    };
  },
  template: `
  <article class="card insight-card">
    <div class="card-head">
      <h3 class="title">🧭 {{ insight.subject.label }}</h3>
      <span class="insight-total" v-if="insight.count">
        累计 <b class="money">{{ formatMoney(insight.total) }}</b> · {{ insight.count }} 笔
      </span>
      <span class="insight-total" v-else>还没有相关花销</span>
    </div>

    <div class="insight-facts" v-if="insight.count">
      <span class="cat-chip" v-for="c in catSplits" :key="c.id" :style="{ '--h': c.meta.hue }">
        {{ c.meta.emoji }} {{ formatMoney(c.amount) }}
      </span>
      <span class="insight-last">最近一笔 {{ formatDate(insight.lastDate) }}</span>
    </div>

    <div class="insight-quotes" v-if="insight.quotes.length">
      <p class="insight-label">📎 记录里的原话<sup v-if="insight.quoteTotal > insight.quotes.length">共 {{ insight.quoteTotal }} 句，显示最近的 {{ insight.quotes.length }} 句</sup></p>
      <div class="insight-quote" v-for="(q, i) in insight.quotes" :key="i"
           :title="'来自：' + q.title + ' · ' + formatDate(q.date)">
        <p class="quote-text"><span class="quote-tag">{{ tagLabel(q.tag) }}</span>“{{ q.sentence }}”</p>
        <p class="quote-src">{{ formatDate(q.date) }} · {{ q.title }} · {{ formatMoney(q.amount) }}</p>
      </div>
    </div>

    <div class="insight-mine">
      <p class="insight-label">🧠 我的评价</p>
      <div class="insight-controls">
        <div class="star-row" title="体感评分：点星打分，再点同一颗取消">
          <button v-for="n in 5" :key="n" type="button" class="star"
                  :class="{ on: form.rating >= n }" @click="pickStar(n)">★</button>
          <span class="star-num" v-if="form.rating">{{ form.rating }} / 5</span>
        </div>
        <div class="chip-picks insight-decisions">
          <button v-for="d in decisions" :key="d.id" type="button" class="chip-pick"
                  :class="{ on: form.decision === d.id }" @click="pickDecision(d.id)">{{ d.label }}</button>
        </div>
      </div>
      <textarea v-model="form.verdict" rows="4"
                placeholder="这家值不值、价格怎样、下次还买不买……点「✨ 依记录生成草稿」再改成自己的话"></textarea>
      <div class="insight-actions">
        <button class="btn small ghost" v-if="!form.verdict && insight.quotes.length" @click="fillDraft">✨ 依记录生成草稿</button>
        <button class="btn small ghost" v-if="hasSaved" @click="clear">🧹 清除</button>
        <span class="spacer"></span>
        <button class="btn small primary" @click="save">💾 保存</button>
      </div>
    </div>
  </article>
  `,
};

export { InsightCard };
